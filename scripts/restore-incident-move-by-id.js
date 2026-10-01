#!/usr/bin/env node
//
// 2026-10-01 incident — moves the captured messages to Deleted Items BY ID.
//
//   node scripts/restore-incident-move-by-id.js                      (dry run)
//   node scripts/restore-incident-move-by-id.js --skip <id,id,...>   (dry run, minus those)
//   node scripts/restore-incident-move-by-id.js --write
//
// WHY BY ID. The original selector was lastModifiedDateTime inside a 35-minute
// window. Something has been rewriting lastModifiedDateTime all afternoon, so
// the same query returned 1,651 at 14:34, 565 at 16:10 and 222 at 16:30 while
// the folders themselves did not change. A Graph message id survives being
// read, flagged or re-indexed; it changes only when the message moves. So the
// set was captured once, verified against thirteen independent counts Arturo
// took in Outlook this morning (2,563 = 2,563, exact in all thirteen folders),
// and this moves that list — it does not ask the question again.
//
// IT MOVES. IT NEVER DELETES. The only write is POST /messages/{id}/move with
// destinationId "deleteditems". There is no DELETE in this file. Deleted Items
// is a folder, so everything stays recoverable afterwards.
//
// DRY RUN IS THE DEFAULT. Without --write it locates every id, reports which
// folder each is in now, and sends no move.
//
// AN ID THAT HAS MOVED IS NOT MOVED. The dry run locates each captured id by
// listing the folders and intersecting — 13 folder reads rather than 2,563
// lookups. An id found somewhere unexpected, or not found at all, is reported
// and SKIPPED rather than chased: it means somebody or something handled that
// message after the capture, and a stale list has no business overruling them.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOX = process.env.MAILBOX_LYNDSAY;
const DEST = 'deleteditems';
const CAPTURE = path.join(__dirname, '..', 'exports', 'restore-incident-ids-2026-10-01.json');

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes('--write');
const SKIP = new Set(String(arg('skip') || '').split(',').map(s => s.trim()).filter(Boolean));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const logLines = [];
const log = s => { console.log(s); logLines.push(s); };

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch('https://login.microsoftonline.com/' + process.env.GRAPH_TENANT_ID + '/oauth2/v2.0/token',
    { method: 'POST', body });
  const j = await r.json();
  // Never echo the body: a token error can quote the request, which carries
  // the client secret.
  if (!j.access_token) throw new Error('Token request failed (' + r.status + ')');
  return j.access_token;
}

async function get(url, token, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 503 || r.status === 504) {
      const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 2000 * (i + 1);
      log(`    throttled (${r.status}) — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`GET ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }
  throw new Error('gave up: ' + url);
}

async function getAll(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const j = await get(next, token);
    out.push(...(j.value || []));
    next = j['@odata.nextLink'] || null;
    if (next) await sleep(120);
  }
  return out;
}

async function allFolders(token) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const sel = 'id,displayName,totalItemCount,childFolderCount';
  const top = await getAll(`${base}/mailFolders?$select=${sel}&$top=100`, token);
  const out = [], queue = top.map(f => ({ ...f, path: f.displayName })), seen = new Set();
  let guard = 0;
  while (queue.length && guard++ < 3000) {
    const f = queue.shift();
    if (!f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (f.childFolderCount) {
      const kids = await getAll(`${base}/mailFolders/${f.id}/childFolders?$select=${sel}&$top=100`, token);
      for (const k of kids) queue.push({ ...k, path: f.path + '/' + k.displayName });
    }
  }
  return out;
}

const folderCount = async (token, idOrName) =>
  (await get(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}/mailFolders/${idOrName}?$select=totalItemCount`, token)).totalItemCount;

// One Graph $batch of up to 20 moves. Returns the ids that failed so only those
// are retried — a whole-batch retry would re-move the ones that already
// succeeded, against ids that no longer exist.
async function moveChunk(token, ids) {
  const r = await fetch('https://graph.microsoft.com/v1.0/$batch', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: ids.map((id, i) => ({
        id: String(i), method: 'POST',
        url: `/users/${BOX}/messages/${encodeURIComponent(id)}/move`,
        headers: { 'Content-Type': 'application/json' },
        body: { destinationId: DEST },
      })),
    }),
  });
  if (r.status === 429 || r.status === 503 || r.status === 504) {
    const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 5000;
    return { retry: ids, done: 0, failed: [], wait };
  }
  if (!r.ok) throw new Error(`$batch ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const j = await r.json();
  const retry = [], failed = [];
  let done = 0;
  for (const resp of (j.responses || [])) {
    const id = ids[parseInt(resp.id, 10)];
    if (resp.status >= 200 && resp.status < 300) { done++; continue; }
    if (resp.status === 429 || resp.status === 503 || resp.status === 504) { retry.push(id); continue; }
    failed.push({ id, status: resp.status, error: resp.body?.error?.message || '' });
  }
  return { retry, done, failed, wait: 3000 };
}

(async () => {
  if (!BOX || !process.env.GRAPH_CLIENT_ID) {
    console.error('MAILBOX_LYNDSAY or Graph credentials missing from .env');
    process.exit(1);
  }
  if (!fs.existsSync(CAPTURE)) {
    console.error(`No capture at ${CAPTURE}. Run scripts/restore-incident-capture.js first.`);
    process.exit(2);
  }
  const cap = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));

  // id -> what the capture recorded about it
  const wanted = new Map();
  for (const [folder, list] of Object.entries(cap.byFolder)) {
    for (const m of list) {
      if (SKIP.has(m.id)) continue;
      wanted.set(m.id, { ...m, capturedFolder: folder });
    }
  }

  log(`Move by id — ${WRITE ? 'WRITE: messages will be MOVED' : 'DRY RUN: nothing will be moved'}`);
  log(`Mailbox     : ${BOX}`);
  log(`Capture     : ${cap.capturedAt}  (${Object.values(cap.byFolder).reduce((a, l) => a + l.length, 0)} ids)`);
  log(`Selector    : ${cap.selector}`);
  log(`Destination : ${DEST}   (a move, never a delete)`);
  if (SKIP.size) log(`Skipping    : ${SKIP.size} id(s) excluded on the command line`);
  log(`To act on   : ${wanted.size}\n`);

  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const folders = await allFolders(token);

  // ── Locate every id, by listing folders rather than 2,563 lookups ─────────
  const foundIn = new Map();        // id -> current folder path
  const before = {};
  for (const f of folders) {
    before[f.path] = f.totalItemCount;
    let ids;
    try { ids = await getAll(`${base}/mailFolders/${f.id}/messages?$select=id&$top=100`, token); }
    catch (e) { log(`ERR   ${f.path}: ${e.message}`); continue; }
    for (const m of ids) if (wanted.has(m.id)) foundIn.set(m.id, f.path);
    await sleep(100);
  }

  const byFolderNow = {};
  const moved_already = [];   // in Deleted Items already
  const relocated = [];       // somewhere other than where it was captured
  const missing = [];
  for (const [id, rec] of wanted) {
    const now = foundIn.get(id);
    if (!now) { missing.push(rec); continue; }
    if (/^deleted items$/i.test(now)) { moved_already.push({ ...rec, now }); continue; }
    if (now !== rec.capturedFolder) relocated.push({ ...rec, now });
    (byFolderNow[now] = byFolderNow[now] || []).push(id);
  }

  const rows = Object.entries(byFolderNow)
    .map(([folder, ids]) => ({ folder, n: ids.length, captured: (cap.byFolder[folder] || []).length, before: before[folder] }))
    .sort((a, b) => b.n - a.n);

  log('FOLDER'.padEnd(32) + 'HOLDS'.padStart(8) + 'TO MOVE'.padStart(9) + 'CAPTURED'.padStart(10));
  rows.forEach(r => log(r.folder.slice(0, 31).padEnd(32) + String(r.before).padStart(8)
    + String(r.n).padStart(9) + String(r.captured).padStart(10)));

  const toMove = rows.reduce((a, r) => a + r.n, 0);
  log('─'.repeat(60));
  log(`Found and movable      : ${toMove}`);
  log(`Already in Deleted Items: ${moved_already.length}`);
  log(`Moved elsewhere since capture (will be moved from where they are): ${relocated.length}`);
  log(`Not found at all        : ${missing.length}`);

  if (relocated.length) {
    log('\nThese are not where they were captured:');
    relocated.slice(0, 15).forEach(m => log(`  ${m.capturedFolder} -> ${m.now}  |  ${String(m.subject).slice(0, 48)}`));
    if (relocated.length > 15) log(`  … and ${relocated.length - 15} more`);
  }
  if (missing.length) {
    log('\nNot found anywhere — SKIPPED, not chased:');
    missing.slice(0, 15).forEach(m => log(`  ${m.capturedFolder}  |  ${String(m.subject).slice(0, 52)}`));
    if (missing.length > 15) log(`  … and ${missing.length - 15} more`);
  }

  if (!WRITE) {
    log('\nDRY RUN — nothing was moved. Re-run with --write.');
    log(`Deleted Items would go from ${await folderCount(token, DEST)} to `
      + `${await folderCount(token, DEST) + toMove}.`);
    return;
  }

  // ── Move ──────────────────────────────────────────────────────────────────
  const delBefore = await folderCount(token, DEST);
  log(`\nDeleted Items before: ${delBefore}`);
  const errors = [];
  let grandMoved = 0;
  const after = {};
  for (const r of rows) {
    const f = folders.find(x => x.path === r.folder);
    let queue = byFolderNow[r.folder].slice();
    let done = 0, rounds = 0;
    log(`\nmoving ${queue.length} from ${r.folder}`);
    while (queue.length && rounds++ < 500) {
      const chunk = queue.splice(0, 20);
      const res = await moveChunk(token, chunk);
      done += res.done;
      if (res.failed.length) {
        res.failed.forEach(x => errors.push({ folder: r.folder, ...x }));
        log(`  ${res.failed.length} failed permanently (status ${res.failed[0].status})`);
      }
      if (res.retry.length) {
        log(`  throttled — retrying ${res.retry.length} after ${Math.round(res.wait / 1000)}s`);
        await sleep(res.wait);
        queue = res.retry.concat(queue);
      }
      await sleep(400);
      if (done && done % 500 === 0) log(`  … ${done}/${r.n}`);
    }
    r.moved = done;
    after[r.folder] = await folderCount(token, f.id);
    grandMoved += done;
    log(`  moved ${done} · ${r.before} -> ${after[r.folder]} (expected ${r.before - done})`
      + (after[r.folder] === r.before - done ? ' ✓' : ' ⚠ MISMATCH'));
  }

  const delAfter = await folderCount(token, DEST);
  log(`\n${'═'.repeat(64)}`);
  log('FOLDER'.padEnd(32) + 'BEFORE'.padStart(9) + 'MOVED'.padStart(8) + 'AFTER'.padStart(9));
  rows.forEach(r => log(r.folder.slice(0, 31).padEnd(32) + String(r.before).padStart(9)
    + String(r.moved).padStart(8) + String(after[r.folder]).padStart(9)));
  log('─'.repeat(64));
  log(`Moved         : ${grandMoved}`);
  log(`Deleted Items : ${delBefore} -> ${delAfter}  (+${delAfter - delBefore})`);
  log(grandMoved === delAfter - delBefore
    ? '✓ Deleted Items rose by exactly the number moved.'
    : `⚠ Deleted Items rose by ${delAfter - delBefore} but ${grandMoved} were moved — investigate.`);
  if (errors.length) {
    log(`\n${errors.length} failed and were NOT moved:`);
    errors.slice(0, 20).forEach(e => log(`  ${e.folder} ${e.status} ${e.error.slice(0, 80)}`));
  }

  const LOG = path.join(__dirname, '..', 'exports',
    `restore-incident-moved-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.log`);
  fs.writeFileSync(LOG, logLines.join('\n') + '\n');
  console.log(`\nLog written to ${LOG}`);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
