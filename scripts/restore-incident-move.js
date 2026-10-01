#!/usr/bin/env node
//
// 2026-10-01 incident — STEP 2. Moves restored mail back to Deleted Items.
//
//   node scripts/restore-incident-move.js --batch A            (dry run)
//   node scripts/restore-incident-move.js --batch A --write
//   node scripts/restore-incident-move.js --batch B --write
//
// Emptying Deleted Items triggered a restore of ~2,600 messages and Exchange
// put them back in their ORIGINAL folders. Step 1 (restore-incident-scan.js)
// identified them; this moves them.
//
// IT MOVES. IT NEVER DELETES. The only write this file performs is
// POST /messages/{id}/move with destinationId "deleteditems". There is no
// DELETE anywhere in it, and nothing is permanently removed: Deleted Items is
// a folder, so every message stays recoverable afterwards.
//
// DRY RUN IS THE DEFAULT. Without --write it does the whole run — selection,
// batching, counting — and sends no move.
//
// WHAT IT SELECTS, and why it re-selects rather than trusting step 1:
//   * lastModifiedDateTime inside the incident window, and
//   * receivedDateTime NOT today.
// The second condition is the one that matters. 36 messages arrived today and
// were touched inside the same 35 minutes by Lyndsay or by an Outlook rule;
// they are new mail, not restored mail, and they must not move. Re-reading the
// mailbox now means an id list cannot go stale between the scan and the move.
//
// COLLECT FIRST, THEN MOVE. Moving while paginating mutates the collection
// underneath the pagination and silently skips messages. Every id for a folder
// is gathered before the first move is sent.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOX = process.env.MAILBOX_LYNDSAY;
const FROM = process.env.SCAN_FROM || '2026-10-01T14:05:00Z';
const TO   = process.env.SCAN_TO   || '2026-10-01T14:40:00Z';
const DEST = 'deleteditems';

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes('--write');
const BATCH = String(arg('batch') || '').toUpperCase();

// Named explicitly, not "everything the scan found". A typo in a folder name
// fails loudly here instead of quietly moving a folder nobody approved.
const BATCHES = {
  // Approved 2026-10-01: the seven folders whose counts matched Arturo's
  // measured deltas exactly, plus four small ones.
  A: ['Inbox/MPM Team', 'Inbox/Lyndsay Review', 'Inbox/Client Emails',
    "Inbox/Reminders Don't Need", 'Inbox/Financial', 'Inbox/Bekah Follow Up',
    'Junk Email', 'Rule Creation Needed', 'Inbox/Need to File',
    'Inbox/Unsubscribe Needed', 'Inbox/Personal'],
  // Held back for a look at the samples first. Archive's folder total rose
  // 29,008 -> 29,924 (+916 = 896 in-window + 21 received today), and Drafts
  // 16 -> 32 (+16), which is what settled that these arrived rather than
  // merely being touched.
  B: ['Archive', 'Drafts'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG = path.join(__dirname, '..', 'exports',
  `restore-incident-move-${BATCH || 'none'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`);
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
  const top = await getAll(`${base}/mailFolders?$select=id,displayName,totalItemCount,childFolderCount&$top=100`, token);
  const out = [], queue = top.map(f => ({ ...f, path: f.displayName })), seen = new Set();
  let guard = 0;
  while (queue.length && guard++ < 3000) {
    const f = queue.shift();
    if (!f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (f.childFolderCount) {
      const kids = await getAll(`${base}/mailFolders/${f.id}/childFolders?$select=id,displayName,totalItemCount,childFolderCount&$top=100`, token);
      for (const k of kids) queue.push({ ...k, path: f.path + '/' + k.displayName });
    }
  }
  return out;
}

async function folderCount(token, idOrName) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const j = await get(`${base}/mailFolders/${idOrName}?$select=displayName,totalItemCount`, token);
  return j.totalItemCount;
}

// One Graph $batch of up to 20 moves. Returns the ids that failed so the
// caller can retry only those — a whole-batch retry would re-move the ones
// that already succeeded against an id that no longer exists.
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
  if (!BATCHES[BATCH]) {
    console.error('Usage: --batch A|B [--write]');
    process.exit(2);
  }
  if (!BOX || !process.env.GRAPH_CLIENT_ID) {
    console.error('MAILBOX_LYNDSAY or Graph credentials missing from .env');
    process.exit(1);
  }

  log(`Batch ${BATCH} — ${WRITE ? 'WRITE: messages will be MOVED' : 'DRY RUN: nothing will be moved'}`);
  log(`Mailbox     : ${BOX}`);
  log(`Window      : lastModifiedDateTime ${FROM} .. ${TO}`);
  log(`Destination : ${DEST}   (a move, never a delete)`);
  log('');

  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const folders = await allFolders(token);
  const todayUTC = new Date().toISOString().slice(0, 10);

  const wanted = BATCHES[BATCH];
  const picked = [];
  for (const name of wanted) {
    const f = folders.find(x => x.path === name)
      || folders.find(x => x.displayName === name);
    if (!f) { log(`!! folder not found, SKIPPED: "${name}"`); continue; }
    if (/^(deleted items|sent items)$/i.test(f.displayName)) { log(`!! refusing ${f.path}`); continue; }
    picked.push(f);
  }
  if (picked.length !== wanted.length) {
    log(`\nABORTING: ${wanted.length - picked.length} named folder(s) could not be resolved.`);
    log('Nothing has been moved. Fix the names and re-run.');
    process.exit(1);
  }

  const delBefore = await folderCount(token, DEST);
  log(`Deleted Items before: ${delBefore}\n`);

  const before = {}, after = {}, moved = {}, errors = [];
  let grandMoved = 0, grandTargets = 0;

  for (const f of picked) {
    before[f.path] = await folderCount(token, f.id);
    const url = `${base}/mailFolders/${f.id}/messages`
      + `?$filter=lastModifiedDateTime ge ${FROM} and lastModifiedDateTime le ${TO}`
      + `&$select=id,receivedDateTime&$top=100`;
    const all = await getAll(url, token);
    // The 36 that arrived today stay where they are.
    const targets = all.filter(m => String(m.receivedDateTime || '').slice(0, 10) !== todayUTC);
    const skippedToday = all.length - targets.length;
    grandTargets += targets.length;
    log(`${f.path}`);
    log(`  before ${before[f.path]} · in window ${all.length} · to move ${targets.length}`
      + (skippedToday ? ` · ${skippedToday} received today, LEFT ALONE` : ''));

    if (!WRITE) { moved[f.path] = 0; after[f.path] = before[f.path]; log('  (dry run — no move sent)\n'); continue; }

    let queue = targets.map(m => m.id);
    let done = 0, rounds = 0;
    while (queue.length && rounds++ < 40) {
      const chunk = queue.splice(0, 20);
      const res = await moveChunk(token, chunk);
      done += res.done;
      if (res.failed.length) {
        res.failed.forEach(x => errors.push({ folder: f.path, ...x }));
        log(`  ${res.failed.length} failed permanently in this chunk (status ${res.failed[0].status})`);
      }
      if (res.retry.length) {
        log(`  throttled — retrying ${res.retry.length} after ${Math.round(res.wait / 1000)}s`);
        await sleep(res.wait);
        queue = res.retry.concat(queue);
      }
      // A pause between batches whether or not Graph complained.
      await sleep(400);
      if (done && done % 200 === 0) log(`  … ${done}/${targets.length}`);
    }
    moved[f.path] = done;
    grandMoved += done;
    after[f.path] = await folderCount(token, f.id);
    log(`  moved ${done} · after ${after[f.path]} (expected ${before[f.path] - done})`
      + (after[f.path] === before[f.path] - done ? ' ✓' : ' ⚠ MISMATCH'));
    log('');
  }

  const delAfter = await folderCount(token, DEST);
  log('═'.repeat(70));
  log(`${'FOLDER'.padEnd(34)}${'BEFORE'.padStart(8)}${'MOVED'.padStart(8)}${'AFTER'.padStart(8)}`);
  for (const f of picked) {
    log(`${f.path.slice(0, 33).padEnd(34)}${String(before[f.path]).padStart(8)}`
      + `${String(moved[f.path]).padStart(8)}${String(after[f.path]).padStart(8)}`);
  }
  log('─'.repeat(70));
  log(`Targets selected : ${grandTargets}`);
  log(`Moved            : ${grandMoved}`);
  log(`Deleted Items    : ${delBefore} -> ${delAfter}  (+${delAfter - delBefore})`);
  // The check that matters: mail that left the folders has to have ARRIVED
  // somewhere. A rise smaller than the number moved would mean something was
  // lost rather than relocated.
  log(grandMoved === delAfter - delBefore
    ? '✓ Deleted Items rose by exactly the number moved.'
    : `⚠ Deleted Items rose by ${delAfter - delBefore}, ${grandMoved} were moved — investigate before continuing.`);
  if (errors.length) {
    log(`\n${errors.length} message(s) failed and were NOT moved:`);
    errors.slice(0, 20).forEach(e => log(`  ${e.folder} ${e.status} ${e.error.slice(0, 90)}`));
  }

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, logLines.join('\n') + '\n');
  console.log(`\nLog written to ${LOG}`);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
