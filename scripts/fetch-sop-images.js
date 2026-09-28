#!/usr/bin/env node
//
// Rescue the images out of the Slab export before their URLs expire.
//
//   node scripts/fetch-sop-images.js --zip "C:/Users/artur/Downloads/<export>.zip"
//   node scripts/fetch-sop-images.js --zip <path> --dry-run
//   node scripts/fetch-sop-images.js --zip <path> --limit 20
//
// WHY THIS RUNS BEFORE THE IMPORT. Every image in the export is a
// static.slab.com / slabstatic.com URL signed with a JWT that expires
// 2027-09-11, and Slab is being decommissioned before then. The ZIP import is
// blocked on a department mapping; the images are not, and they are on a clock.
// So this reads the ZIP directly and records the files with no document
// attached — sop_assets.source_path remembers which article each came from, and
// the ZIP importer attaches them later.
//
// Measured from the 2026-09-11 export: 763 image references resolving to 501
// distinct files, across two hosts, 750 png / 12 jpg / 1 jpeg.
//
// NON-DESTRUCTIVE AND RE-RUNNABLE. A file already on disk is skipped, not
// re-fetched. Nothing is deleted, no markdown is modified, and the ZIP is only
// ever read. A failure is RECORDED in sop_assets.fetch_error rather than
// logged and forgotten: a missing image is a hole in a procedure somebody is
// following, and it has to be findable afterwards.

require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const DRY = process.argv.includes('--dry-run');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ZIP = arg('zip');
// Read the work list from sop_assets instead of from the export.
//
// This is how the images reach RENDER. Every row already carries the signed
// URL it was first found at, so the ZIP — which lives on a laptop — is not
// needed: the server reads the database it already reads, downloads to its own
// disk, and nothing has to move 86 MB between machines.
const FROM_DB = process.argv.includes('--from-db');

const KNOWN = ['--zip', '--dry-run', '--limit', '--out', '--from-db'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN.includes(a));
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(', ') + '\nKnown: ' + KNOWN.join(' '));
  process.exit(2);
}
if (!ZIP && !FROM_DB) {
  console.error('Usage: node scripts/fetch-sop-images.js --zip <path-to-slab-export.zip> [--dry-run] [--limit N]');
  console.error('   or: node scripts/fetch-sop-images.js --from-db          (reads sop_assets; use this on Render)');
  process.exit(2);
}
if (ZIP && FROM_DB) {
  console.error('Pass --zip or --from-db, not both.');
  process.exit(2);
}
if (ZIP && !fs.existsSync(ZIP)) {
  console.error('No such file: ' + ZIP);
  process.exit(2);
}

// Must honour DATA_DIR the way server.js does — on Render that is the mounted
// disk, and anything written relative to the working directory is wiped by the
// next deploy. These files are the only copy once Slab is gone.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ASSET_DIR = arg('out', path.join(DATA_DIR, 'sop-assets'));

// The expiring signature is what makes two references to one image look like
// two images. Stripping it is what "the same image" means here.
const canonical = url => String(url).split('?')[0];

const EXT_OK = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

// Named from the canonical URL's own hash, not from its filename: Slab's names
// are already unique but a collision would silently overwrite a screenshot, and
// the file has to be findable from the URL alone when the importer rewrites the
// markdown.
function storedName(url, contentType) {
  const hash = crypto.createHash('sha1').update(canonical(url)).digest('hex').slice(0, 16);
  const fromUrl = (canonical(url).match(/\.(png|jpe?g|gif|webp)$/i) || [])[0];
  const ext = EXT_OK[String(contentType || '').split(';')[0].trim()] || (fromUrl ? fromUrl.toLowerCase() : '.bin');
  return hash + (ext === '.jpeg' ? '.jpg' : ext);
}

function readZip(zipPath) {
  // No zip dependency in this project, and adding one to read 708 text files
  // is not worth it — Node ships zlib, and the entries we need are all DEFLATE
  // or STORE. Parsed from the central directory, which is the only part of the
  // format that reliably tells you what is in the archive.
  const zlib = require('zlib');
  const buf = fs.readFileSync(zipPath);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.md')) continue;

    // The local header repeats the name and extra lengths, and they can differ
    // from the central directory's — reading them from the central record is a
    // classic way to land mid-file.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    const text = method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
    out.push({ name, text });
  }
  return out;
}

const IMG_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

async function fetchOne(url) {
  // redirect: 'follow' matters — static.slab.com answers 301 to slabstatic.com
  // and a fetch that does not follow records 167 bytes of HTML as an image.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`not an image (content-type ${type || 'missing'})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length) throw new Error('empty response');
  return { body, type };
}

(async () => {
  console.log(`Slab image rescue — ${FROM_DB ? 'work list from sop_assets' : ZIP}`);
  console.log(`storing under ${ASSET_DIR}${DRY ? '   (DRY RUN — nothing written)' : ''}\n`);

  const dbEarly = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  let work;

  if (FROM_DB) {
    // Every row, not only the ones the imported articles reference. The extra
    // handful costs a couple of megabytes and means an excluded folder brought
    // back later does not need a second pass against URLs that may by then have
    // expired.
    const rows = [];
    for (let from = 0; ; from += 500) {
      const { data, error } = await dbEarly.from('sop_assets')
        .select('id,original_url,canonical_url,stored_path,source_path').range(from, from + 499);
      if (error) {
        if (/canonical_url/.test(error.message)) {
          throw new Error('sop_assets is missing canonical_url — run '
            + 'supabase/migrations/063_sop_assets_preimport.sql first.');
        }
        throw new Error(error.message);
      }
      rows.push(...(data || []));
      if (!data || data.length < 500) break;
    }
    if (!rows.length) {
      throw new Error('sop_assets is empty. Run with --zip on a machine that has the export first, '
        + 'so the URLs are recorded, then --from-db here.');
    }
    work = rows.map(r => ({ url: r.original_url, canonical: r.canonical_url || canonical(r.original_url), source_path: r.source_path }));
    console.log(`${work.length} images recorded in sop_assets`);
  } else {
    const files = readZip(ZIP);
    console.log(`read ${files.length} markdown files from the export`);

    // url -> the first article that referenced it. First, not all: source_path
    // records provenance, and an image used in six articles came from one place.
    const refs = new Map();
    let total = 0;
    for (const f of files) {
      let m;
      IMG_RE.lastIndex = 0;
      while ((m = IMG_RE.exec(f.text))) {
        total++;
        const c = canonical(m[1]);
        if (!refs.has(c)) refs.set(c, { url: m[1], canonical: c, source_path: f.name });
      }
    }
    work = [...refs.values()];
    console.log(`${total} image references resolving to ${work.length} distinct images`);
  }
  if (LIMIT) { work = work.slice(0, LIMIT); console.log(`--limit ${LIMIT}: fetching the first ${work.length}`); }

  if (DRY) {
    console.log('\n--dry-run: nothing fetched or written. First five:');
    work.slice(0, 5).forEach(w => console.log('  ' + w.canonical.slice(0, 96)));
    return;
  }

  await fsp.mkdir(ASSET_DIR, { recursive: true });
  const db = dbEarly;

  // What is already recorded, so a re-run is a no-op rather than 501 duplicate
  // rows. Read in one query; matched on the canonical url.
  const known = new Map();
  // 40, not 200. PostgREST puts `in` lists in the QUERY STRING, and these URLs
  // are ~90 characters each — a batch of 200 builds a 17 KB request URL and the
  // fetch is rejected outright with an unhelpful "TypeError: fetch failed".
  // Measured: 80 works, 200 does not. 40 leaves room for longer URLs.
  const BATCH = 40;
  for (let i = 0; i < work.length; i += BATCH) {
    const { data, error } = await db.from('sop_assets')
      .select('id,canonical_url,stored_path,fetch_error')
      .in('canonical_url', work.slice(i, i + BATCH).map(w => w.canonical));
    if (error) {
      if (/canonical_url/.test(error.message)) {
        throw new Error('sop_assets is missing canonical_url / source_path — run '
          + 'supabase/migrations/063_sop_assets_preimport.sql first.');
      }
      throw new Error(error.message);
    }
    (data || []).forEach(r => known.set(r.canonical_url, r));
  }
  console.log(`${known.size} already recorded in sop_assets\n`);

  let fetched = 0, skipped = 0, failed = 0, bytes = 0;
  const failures = [];

  for (const [i, item] of work.entries()) {
    const prior = known.get(item.canonical);
    // Already fetched AND the file is still on disk. Both conditions: a row
    // pointing at a file the disk no longer has is not a rescued image.
    if (prior && prior.stored_path && fs.existsSync(path.join(ASSET_DIR, path.basename(prior.stored_path)))) {
      skipped++;
      continue;
    }

    const label = `${String(i + 1).padStart(4)}/${work.length}`;
    let row = {
      canonical_url: item.canonical,
      original_url: item.url,
      source_path: item.source_path,
      document_id: null,
      fetched_at: new Date().toISOString(),
    };
    try {
      const { body, type } = await fetchOne(item.url);
      const name = storedName(item.canonical, type);
      await fsp.writeFile(path.join(ASSET_DIR, name), body);
      row = { ...row, stored_path: 'sop-assets/' + name, content_type: type.split(';')[0].trim(), bytes: body.length, fetch_error: null };
      fetched++; bytes += body.length;
      process.stdout.write(`  ${label}  ok    ${String(body.length).padStart(8)}  ${name}\n`);
    } catch (e) {
      row = { ...row, stored_path: null, content_type: null, bytes: null, fetch_error: e.message.slice(0, 300) };
      failed++;
      failures.push({ url: item.canonical, source: item.source_path, error: e.message });
      process.stdout.write(`  ${label}  FAIL  ${e.message.slice(0, 60)}\n`);
    }

    // Written per image rather than batched at the end: a run interrupted
    // halfway should keep what it rescued, and this is the only copy.
    const q = prior
      ? db.from('sop_assets').update(row).eq('id', prior.id)
      : db.from('sop_assets').insert(row);
    const { error } = await q;
    if (error) console.log(`        (could not record: ${error.message})`);

    // Slab is being shut down, not stress-tested.
    await new Promise(r => setTimeout(r, 120));
  }

  console.log('\nSUMMARY');
  console.log(`  fetched : ${fetched}  (${(bytes / 1048576).toFixed(1)} MB)`);
  console.log(`  skipped : ${skipped}  (already on disk)`);
  console.log(`  failed  : ${failed}`);
  console.log(`  stored  : ${ASSET_DIR}`);
  if (failures.length) {
    console.log('\nFAILURES — these images are gone unless they are recovered by hand:');
    failures.slice(0, 40).forEach(f => console.log(`  ${f.error.slice(0, 50).padEnd(52)} ${f.source}`));
    if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
    console.log('\n  They are recorded in sop_assets with fetch_error set:');
    console.log("    select source_path, original_url, fetch_error from sop_assets where fetch_error is not null;");
  }
  // A non-zero exit on failures, so a scheduled or scripted run cannot report
  // success while images are missing.
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
