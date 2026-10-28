#!/usr/bin/env node
//
// Second copy of the rescued SOP images, on a SharePoint TEAM SITE.
//
//   node scripts/backup-sop-assets-sharepoint.js \
//     --site metricpropertymanagement.sharepoint.com:/sites/<Site> \
//     --folder "SOP Library/Images"                       # DRY RUN
//   …same flags… --write                                  # uploads
//
// WHY. These 501 files are the only copy of every screenshot in the SOP
// library: Slab is being decommissioned and the signed URLs they came from
// expire 2027-09-11. They live on one Render disk. A disk is not a backup.
//
// THE DISK STAYS PRIMARY. /api/sop/assets keeps serving from DATA_DIR and is
// not touched by this script. This is a copy, not a move: nothing is deleted,
// nothing on disk is modified, and the markdown is not rewritten. If the
// SharePoint copy is ever the one that is read, that is a separate decision
// and a separate change.
//
// A TEAM SITE, NOT A PERSONAL ONEDRIVE. The social screenshots went to
// admin@metricpropertymanagement.com's own OneDrive, and every link we stored
// answered "You need access" for everyone except admin@ — see migration 116.
// A personal drive is one person's permissions object and it leaves with the
// person. So --site is REQUIRED, it must be a real site, and a host or path
// that is a personal OneDrive is REFUSED rather than quietly uploaded to.
//
// THE DESTINATION IS A PARAMETER ON PURPOSE. Jay picks the folder at Friday's
// check-in. There is no default and there is no guess: a wrong default here
// would put 86 MB of operational screenshots somewhere nobody agreed to.
//
// VERIFIED BY COUNT AND BYTES, NOT BY A 200. Graph's PUT answers with the
// driveItem it created; this compares its `size` to the bytes we sent and
// records `id` in sop_assets.backup_item_id. A mismatch is a FAILURE, not a
// warning — a truncated screenshot is a hole in a procedure somebody is
// following, and it looks exactly like a good one until you open it.
//
// RE-RUNNABLE. A row that already carries a backup_item_id whose remote size
// matches the local file is skipped.
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const msal = require('@azure/msal-node');
const { createClient } = require('@supabase/supabase-js');
const DEST = require('../lib/sharepoint-destination.js');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const KNOWN = ['--site', '--folder', '--write', '--limit', '--dir'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN.includes(a));
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(', ') + '\nKnown: ' + KNOWN.join(' '));
  process.exit(2);
}

// DRY RUN IS THE DEFAULT. Uploading has to be asked for.
const WRITE = process.argv.includes('--write');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const SITE = String(arg('site', process.env.SOP_BACKUP_SITE) || '').trim();
const FOLDER = String(arg('folder', process.env.SOP_BACKUP_FOLDER) || '').trim()
  .replace(/^\/+|\/+$/g, '');

// Same as server.js and the fetcher: on Render this is the mounted disk
// (/var/data), and anything relative to the working directory is wiped by the
// next deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ASSET_DIR = arg('dir', path.join(DATA_DIR, 'sop-assets'));

const MIGRATION = 'supabase/migrations/117_sop_assets_backup_item_id.sql';
const pad = (s, w) => String(s).padEnd(w);
const mb = n => (n / 1048576).toFixed(1) + ' MB';

// The destination guard is lib/sharepoint-destination.js so that a test can
// CALL it. Mutation testing on the first version, where these checks lived
// inline, switched both of them off with every assertion still green.
function requireDestination() {
  if (!SITE || !FOLDER) {
    console.error('Both --site and --folder are required. There is no default:');
    console.error('  Jay picks the destination folder, and a wrong guess puts');
    console.error('  86 MB of operational screenshots somewhere nobody agreed to.\n');
    console.error('  node scripts/backup-sop-assets-sharepoint.js \\');
    console.error('    --site metricpropertymanagement.sharepoint.com:/sites/<Site> \\');
    console.error('    --folder "SOP Library/Images"');
    process.exit(2);
  }
  DEST.assertTeamSite(SITE);
}

async function graphToken() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) {
    throw new Error('GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET are not set. Run on Render.');
  }
  const app = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenant, clientSecret: secret },
  });
  // skipCache for the same reason the other Graph callers do it: a token
  // minted before a permission was added keeps being served with the old roles.
  const r = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'], skipCache: true,
  });
  return r.accessToken;
}

// Resolve the site to its id, and REPORT the drive we landed on. Printing the
// resolved webUrl is the check a human can actually make at the check-in:
// "is that the folder you meant" is answerable from a URL and not from a guid.
async function resolveDrive(token) {
  const r = await fetch('https://graph.microsoft.com/v1.0/sites/' + SITE,
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error('Graph ' + r.status + ' resolving the site — check the name and Sites.ReadWrite.All: '
      + ((j.error && j.error.message) || ''));
  }
  const d = await fetch('https://graph.microsoft.com/v1.0/sites/' + j.id + '/drive',
    { headers: { Authorization: 'Bearer ' + token } });
  const dj = await d.json().catch(() => ({}));
  if (!d.ok) throw new Error('Graph ' + d.status + ' reading the site drive: ' + ((dj.error && dj.error.message) || ''));
  DEST.assertTeamDrive(dj.webUrl);
  return { siteId: j.id, siteUrl: j.webUrl, driveId: dj.id, driveUrl: dj.webUrl };
}

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// The work list is sop_assets, not a directory listing: the row is what says
// which article an image belongs to, and a file on disk with no row is not
// something this script should invent a provenance for.
async function workList() {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('sop_assets')
      .select('id,stored_path,bytes,content_type,source_path,fetch_error')
      .order('id').range(from, from + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return rows;
}

// Read separately so a missing column is a clear instruction rather than a
// failed select. Same shape as the 116 handling in server.js.
async function backupIds() {
  const out = new Map();
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('sop_assets')
      .select('id,backup_item_id,backup_bytes').order('id').range(from, from + 499);
    if (error) {
      if (/backup_item_id|backup_bytes/.test(error.message || '')) return null;
      throw new Error(error.message);
    }
    (data || []).forEach(r => out.set(r.id, r));
    if (!data || data.length < 500) break;
  }
  return out;
}

async function uploadOne(token, driveId, remotePath, body, contentType) {
  const url = 'https://graph.microsoft.com/v1.0/drives/' + driveId + '/root:/'
    + remotePath.split('/').map(encodeURIComponent).join('/') + ':/content';
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType || 'application/octet-stream' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Graph ' + r.status));
  // THE ID IS THE READ HANDLE, and the size is the verification. A webUrl is
  // a browser link; /drives/{id}/items/{id}/content is an address the server
  // can call with its own credentials.
  if (!j.id) throw new Error('upload returned no item id');
  if (Number(j.size) !== body.length) {
    throw new Error('size mismatch: sent ' + body.length + ' bytes, SharePoint stored ' + j.size);
  }
  return { id: j.id, size: Number(j.size) };
}

(async () => {
  requireDestination();

  console.log('SOP IMAGE BACKUP -> SharePoint team site');
  console.log('  site   : ' + SITE);
  console.log('  folder : ' + FOLDER);
  console.log('  source : ' + ASSET_DIR + '   (stays primary; nothing is deleted or moved)');
  console.log(WRITE ? '  MODE   : WRITE — files will be uploaded\n'
    : '  MODE   : DRY RUN — nothing is uploaded, nothing is written to Supabase\n');

  const rows = await workList();
  const usable = rows.filter(r => r.stored_path && !r.fetch_error);
  console.log('sop_assets         : ' + rows.length + ' rows');
  console.log('  with a stored file: ' + usable.length);
  const broken = rows.length - usable.length;
  if (broken) console.log('  skipped (never fetched / fetch_error): ' + broken);

  // On disk NOW. A row pointing at a file the disk no longer has is not a
  // file that can be backed up, and saying "501" when 0 are present would be
  // the most expensive kind of wrong.
  let present = [], missing = 0, bytes = 0;
  for (const r of usable) {
    const local = path.join(ASSET_DIR, path.basename(r.stored_path));
    let st = null;
    try { st = fs.statSync(local); } catch (e) { st = null; }
    if (!st || !st.isFile()) { missing++; continue; }
    present.push({ ...r, local, size: st.size, name: path.basename(r.stored_path) });
    bytes += st.size;
  }
  console.log('\nON THIS MACHINE');
  console.log('  present : ' + present.length + '   ' + mb(bytes));
  console.log('  missing : ' + missing + (missing && !present.length
    ? '   <- this machine is not the one holding the disk; run on Render' : ''));
  // A recorded size that disagrees with the file is worth knowing before an
  // upload, not after.
  const drift = present.filter(p => p.bytes != null && Number(p.bytes) !== p.size);
  if (drift.length) console.log('  recorded bytes disagree with the file on disk: ' + drift.length);

  const ids = await backupIds();
  if (ids === null) {
    console.log('\nsop_assets has no backup_item_id column yet.');
    console.log('  Run ' + MIGRATION + ' before --write.');
    if (WRITE) { console.log('  Refusing to upload: there would be nowhere to record the item ids.'); process.exitCode = 2; return; }
  } else {
    const done = present.filter(p => (ids.get(p.id) || {}).backup_item_id).length;
    console.log('  already backed up: ' + done);
  }

  let work = present.filter(p => !(ids && (ids.get(p.id) || {}).backup_item_id
    && Number((ids.get(p.id) || {}).backup_bytes) === p.size));
  if (LIMIT) { work = work.slice(0, LIMIT); console.log('  --limit ' + LIMIT + ': ' + work.length + ' this run'); }

  if (!WRITE) {
    const total = work.reduce((n, w) => n + w.size, 0);
    console.log('\nWOULD UPLOAD');
    console.log('  files : ' + work.length);
    console.log('  bytes : ' + total + '   (' + mb(total) + ')');
    console.log('  into  : ' + SITE + '  ->  /' + FOLDER + '/');
    console.log('\nTARGET PATHS' + (work.length > 20 ? '  (first 20 of ' + work.length + ')' : ''));
    work.slice(0, 20).forEach(w => console.log('  ' + pad(String(w.size), 9) + FOLDER + '/' + w.name));
    if (work.length > 20) console.log('  … and ' + (work.length - 20) + ' more, same folder, one file each');
    console.log('\nNothing was uploaded. Nothing was written to Supabase. Nothing on disk was touched.');
    console.log('The site was NOT contacted: no destination is confirmed until Jay picks the folder.');
    return;
  }

  const token = await graphToken();
  const drive = await resolveDrive(token);
  console.log('\nresolved site : ' + drive.siteUrl);
  console.log('resolved drive: ' + drive.driveUrl + '\n');

  let ok = 0, failed = 0, sent = 0;
  const failures = [];
  for (const [i, w] of work.entries()) {
    const label = String(i + 1).padStart(4) + '/' + work.length;
    try {
      const body = fs.readFileSync(w.local);
      const r = await uploadOne(token, drive.driveId, FOLDER + '/' + w.name, body, w.content_type);
      const { error } = await db.from('sop_assets').update({
        backup_item_id: r.id, backup_bytes: r.size,
        backup_drive_id: drive.driveId, backup_path: FOLDER + '/' + w.name,
        backup_at: new Date().toISOString(),
      }).eq('id', w.id);
      // Recorded per file, not batched: an interrupted run must keep what it
      // verified. An upload we cannot record is a FAILURE — an unrecorded copy
      // is one nobody can find.
      if (error) throw new Error('uploaded but could not record: ' + error.message);
      ok++; sent += r.size;
      process.stdout.write('  ' + label + '  ok    ' + String(r.size).padStart(8) + '  ' + w.name + '\n');
    } catch (e) {
      failed++;
      failures.push({ name: w.name, source: w.source_path, error: e.message });
      process.stdout.write('  ' + label + '  FAIL  ' + e.message.slice(0, 70) + '\n');
    }
    await new Promise(r => setTimeout(r, 120));
  }

  console.log('\nSUMMARY');
  console.log('  uploaded and verified : ' + ok + '   ' + mb(sent));
  console.log('  failed                : ' + failed);
  console.log('  on disk, untouched    : ' + present.length + '   ' + mb(bytes));
  if (failures.length) {
    console.log('\nFAILURES — these have no second copy:');
    failures.slice(0, 40).forEach(f => console.log('  ' + pad(f.error.slice(0, 50), 52) + (f.source || '')));
    if (failures.length > 40) console.log('  … and ' + (failures.length - 40) + ' more');
  }
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('\nfailed: ' + e.message); process.exitCode = 1; });
