#!/usr/bin/env node
//
// Import the Slab export into SOP Library v2.
//
//   node scripts/import-slab-zip.js --zip <export.zip> --dry-run
//   node scripts/import-slab-zip.js --zip <export.zip>
//
// RUNS LOCALLY, NOT ON RENDER. It writes sop_documents rows to Supabase, which
// is the same database Render reads — so the ZIP never needs to leave the
// machine it is already on. Only the IMAGES need to reach Render's disk, and
// those are fetched there straight from sop_assets (see fetch-sop-images.js
// --from-db); nothing needs an 86 MB transfer.
//
// WHAT THE EXPORT IS. 708 markdown files with no frontmatter at all — no title,
// no author, no dates, no post id. The title comes from the filename and the
// department from the top folder, because that is the whole of the structure
// Slab gives you. Anything else would be invented.
//
// WHAT GETS DROPPED, and why each one is a decision rather than a filter:
//   * four folders belonging to other entities (confirmed 2026-09-28): 20 Mile
//     Accounting is Charles Rushman's firm, plus Restorative, Sphere rocket and
//     Corporate Property Management Solutions
//   * empty articles and stubs under 200 bytes — a Slab page somebody created
//     and never wrote
//   * byte-identical copies: Slab lets one post live in several topics and the
//     export writes it once per location, so 708 files are ~411 documents
//
// RE-RUNNABLE. Matched on content_hash + source='slab', so a second run updates
// rather than duplicating. A document a person has edited since the import is
// SKIPPED — the whole point of the library is that a human version outranks an
// import.

require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const ZIP = arg('zip');
const KNOWN = ['--zip', '--dry-run', '--force'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN.includes(a));
if (unknown.length) { console.error('Unknown flag(s): ' + unknown.join(', ')); process.exit(2); }
if (!ZIP || !fs.existsSync(ZIP)) {
  console.error('Usage: node scripts/import-slab-zip.js --zip <path-to-export.zip> [--dry-run]');
  process.exit(2);
}

// Case-insensitive: the spec says "Sphere Rocket", the export says "Sphere
// rocket", and an exact match would have excluded nothing while reporting
// success.
const EXCLUDED_FOLDERS = ['restorative', 'sphere rocket', '20 mile accounting',
  'corporate property management solutions'];

// The Slab top folder as a first guess at the department. Only where the
// mapping is unambiguous — Support (98 articles) is Metric's catch-all and
// could be half the departments, so it goes to Operations for Jay to sort.
const DEPARTMENT_BY_FOLDER = {
  accounting: 'Accounting',
  leasing: 'Leasing',
  maintenance: 'Maintenance',
  'human resources': 'Human Resources',
};
const DEFAULT_DEPARTMENT = 'Operations';
const MIN_BYTES = 200;

const slugify = s => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
  .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

// The signature differs per export, so it must not count as a content change.
const canonicalBody = t => String(t || '').replace(/\?jwt=[A-Za-z0-9._-]+/g, '').trim();
const hash = t => crypto.createHash('sha1').update(canonicalBody(t)).digest('hex');

function readZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file.');
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
    // The local header's lengths can differ from the central directory's.
    const lN = buf.readUInt16LE(localOff + 26), lE = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lN + lE;
    const raw = buf.subarray(start, start + compSize);
    out.push({ name, text: method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8') });
  }
  return out;
}

const segments = p => p.split('/').slice(1, -1);          // drops "slab/" and the filename
const topFolder = p => (segments(p)[0] || '').toLowerCase();
const titleOf = p => p.split('/').pop().replace(/\.md$/i, '').trim();
const departmentOf = p => DEPARTMENT_BY_FOLDER[topFolder(p)] || DEFAULT_DEPARTMENT;

(async () => {
  const files = readZip(ZIP);
  console.log(`${files.length} markdown files in ${ZIP}\n`);

  const dropped = { excluded: [], empty: [], tiny: [] };
  const usable = [];
  for (const f of files) {
    const segs = segments(f.name).map(s => s.toLowerCase());
    if (segs.some(s => EXCLUDED_FOLDERS.includes(s))) { dropped.excluded.push(f.name); continue; }
    const body = f.text.trim();
    if (!body) { dropped.empty.push(f.name); continue; }
    if (body.length < MIN_BYTES) { dropped.tiny.push(f.name); continue; }
    usable.push({ ...f, body });
  }

  // De-duplicate. Where one article was filed in several topics, the copy under
  // a MAPPED department wins — putting a shared policy in Accounting is more
  // useful than putting it in the Operations catch-all — then the shallowest
  // path, then alphabetical so the result is stable between runs.
  const byHash = new Map();
  for (const f of usable) {
    const h = hash(f.body);
    const prev = byHash.get(h);
    if (!prev) { byHash.set(h, { ...f, alsoFiledUnder: [] }); continue; }
    const better = (a, b) => {
      const am = DEPARTMENT_BY_FOLDER[topFolder(a.name)] ? 0 : 1;
      const bm = DEPARTMENT_BY_FOLDER[topFolder(b.name)] ? 0 : 1;
      if (am !== bm) return am < bm ? a : b;
      const ad = segments(a.name).length, bd = segments(b.name).length;
      if (ad !== bd) return ad < bd ? a : b;
      return a.name.localeCompare(b.name) <= 0 ? a : b;
    };
    const winner = better(prev, f);
    const loser = winner === prev ? f : prev;
    winner.alsoFiledUnder = [...new Set([...(prev.alsoFiledUnder || []), ...(f.alsoFiledUnder || []), loser.name])];
    byHash.set(h, winner);
  }
  const docs = [...byHash.values()];

  console.log('WHAT CAME OUT');
  console.log(`  excluded by folder      : ${dropped.excluded.length}`);
  console.log(`  empty                   : ${dropped.empty.length}`);
  console.log(`  under ${MIN_BYTES} bytes         : ${dropped.tiny.length}`);
  console.log(`  content duplicates      : ${usable.length - docs.length}`);
  console.log(`  -> documents            : ${docs.length}`);

  const byDept = {};
  docs.forEach(d => { const k = departmentOf(d.name); byDept[k] = (byDept[k] || 0) + 1; });
  console.log('\nBY DEPARTMENT');
  Object.entries(byDept).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  const { data: existing, error } = await db.from('sop_documents').select('id,slug,title,content_hash,source,updated_by,department');
  if (error) throw new Error('sop_documents: ' + error.message);

  const bySourceHash = new Map(existing.filter(d => d.source === 'slab').map(d => [d.content_hash, d]));
  const usedSlugs = new Set(existing.map(d => d.slug));
  // The 89 curated SOPs already in the library. A Slab article with the same
  // title is NOT merged automatically — the dashboard copy has been reviewed
  // and the Slab one may be staler. Reported for a person to decide.
  const curatedTitles = new Map(existing.filter(d => d.source === 'sop_review')
    .map(d => [d.title.toLowerCase().trim(), d]));

  const now = new Date().toISOString();
  const toInsert = [], toUpdate = [], skipped = [], titleClashes = [];

  for (const d of docs) {
    const title = titleOf(d.name);
    const h = hash(d.body);
    const prior = bySourceHash.get(h);
    if (prior && prior.updated_by && !FORCE) { skipped.push({ title: prior.title, by: prior.updated_by }); continue; }

    if (curatedTitles.has(title.toLowerCase().trim())) {
      titleClashes.push({ title, slab: d.name, curated: curatedTitles.get(title.toLowerCase().trim()).id });
    }

    let slug = slugify(title);
    if (!prior) {
      const base = slug; let n = 2;
      while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
      usedSlugs.add(slug);
    }

    const segs = segments(d.name);
    const row = {
      title,
      body_md: d.body,
      content_hash: h,
      department: departmentOf(d.name),
      // The deepest Slab folder, which is the closest thing to a category the
      // export carries.
      category: segs.length > 1 ? segs[segs.length - 1] : (segs[0] || null),
      // Provenance the folder structure would otherwise lose: the original
      // topic, and every other topic the same article was filed under.
      tags: [...new Set(['slab-import', ...segs, ...(d.alsoFiledUnder || []).map(p => segments(p)[0]).filter(Boolean)])]
        .map(String).slice(0, 25),
      // Needs Review, not Current. Nobody in this system has verified any of
      // these; calling 411 unread articles "Current" would make the status
      // column meaningless on the day the library opens.
      status: 'Needs Review',
      source: 'slab',
      source_path: d.name,
      archived: false,
      updated_at: now,
    };
    if (prior) toUpdate.push({ id: prior.id, ...row });
    else toInsert.push({ ...row, slug, created_at: now });
  }

  console.log(`\nto insert : ${toInsert.length}`);
  console.log(`to update : ${toUpdate.length}`);
  console.log(`skipped   : ${skipped.length}  (edited by a person since the last import)`);
  if (titleClashes.length) {
    console.log(`\nSAME TITLE AS A CURATED SOP — ${titleClashes.length}. Both are imported; a person`);
    console.log('decides which survives. The dashboard copy has been reviewed, the Slab one may be older.');
    titleClashes.slice(0, 12).forEach(c => console.log(`  ${c.title}`));
    if (titleClashes.length > 12) console.log(`  … and ${titleClashes.length - 12} more`);
  }

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    toInsert.slice(0, 6).forEach(d => console.log(`  ${d.department.padEnd(18)}${d.slug.slice(0, 46).padEnd(48)}${d.source_path}`));
    return;
  }

  let ins = 0, upd = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const chunk = toInsert.slice(i, i + 50);
    const { error: e } = await db.from('sop_documents').insert(chunk);
    if (e) throw new Error(`insert at ${i}: ${e.message}`);
    ins += chunk.length;
    process.stdout.write(`\r  inserted ${ins}/${toInsert.length}`);
  }
  for (const d of toUpdate) {
    const { id, ...patch } = d;
    const { error: e } = await db.from('sop_documents').update(patch).eq('id', id);
    if (e) throw new Error(`update ${id}: ${e.message}`);
    upd++;
  }
  console.log(`\n\ninserted ${ins}, updated ${upd}`);
  console.log('The 89 curated SOPs and sop_review were not touched.');
  console.log('\nNext: images. They are fetched on RENDER, from sop_assets, not from this ZIP:');
  console.log('  node scripts/fetch-sop-images.js --from-db');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
