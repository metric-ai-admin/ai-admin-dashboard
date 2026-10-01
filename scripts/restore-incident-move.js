#!/usr/bin/env node
//
// 2026-10-01 incident — moves restored mail back to Deleted Items.
//
//   node scripts/restore-incident-move.js --snapshot                  (before the PowerShell restore)
//   node scripts/restore-incident-move.js --batch A                   (dry run)
//   node scripts/restore-incident-move.js --batch A --write
//   node scripts/restore-incident-move.js --batch B --write
//   node scripts/restore-incident-move.js --batch RESTORE --from 2026-10-01T16:00:00Z --to 2026-10-01T17:30:00Z
//
// Emptying Deleted Items triggered a restore of ~2,600 messages and Exchange
// put them back in their ORIGINAL folders. Batches A and B move those. The
// purge then ran to completion and took ~78,000 messages to Recoverable Items;
// Restore-RecoverableItems brings those back the same way — to their original
// folders — and batch RESTORE moves that second wave.
//
// IT MOVES. IT NEVER DELETES. The only write is POST /messages/{id}/move with
// destinationId "deleteditems". There is no DELETE in this file, and Deleted
// Items is a folder, so everything stays recoverable afterwards.
//
// DRY RUN IS THE DEFAULT. Without --write it selects, batches and counts, and
// sends no move.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY --snapshot EXISTS, AND WHY RESTORE REFUSES TO RUN WITHOUT ONE
//
// Selection is "modified inside the window, not received today". At 2,600
// messages over 35 minutes that was nearly exact: 36 false positives, all of
// them mail that had ARRIVED that day.
//
// At ~78,000 over an hour or more it is not. Reading a message, flagging it,
// or filing it rewrites lastModifiedDateTime, so every message Lyndsay touches
// during the restore looks restored — and if it arrived before today, the
// received-today filter does not catch it. The exposure grows with the LENGTH
// of the window, not with the number of messages in it.
//
// So RESTORE does not trust the window alone. --snapshot records every folder's
// totalItemCount before the restore; afterwards, the number that ARRIVED in a
// folder is its delta. If the window selects more than the delta in a folder,
// the extra are messages that were already there and merely got touched, and
// the batch stops rather than sweeping them up. The snapshot is read-only and
// takes under a minute; run it immediately before the PowerShell restore.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOX = process.env.MAILBOX_LYNDSAY;
const DEST = 'deleteditems';
const SNAPSHOT = path.join(__dirname, '..', 'exports', 'restore-incident-snapshot.json');

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes('--write');
const DO_SNAPSHOT = process.argv.includes('--snapshot');
const BATCH = String(arg('batch') || '').toUpperCase();

// The first incident's window. RESTORE takes its own from --from/--to.
const FROM = arg('from') || process.env.SCAN_FROM || '2026-10-01T14:05:00Z';
const TO = arg('to') || process.env.SCAN_TO || '2026-10-01T14:40:00Z';

const BATCHES = {
  // Approved 2026-10-01: the seven folders whose counts matched the measured
  // deltas exactly, plus four small ones. 1,651 messages.
  A: ['Inbox/MPM Team', 'Inbox/Lyndsay Review', 'Inbox/Client Emails',
    "Inbox/Reminders Don't Need", 'Inbox/Financial', 'Inbox/Bekah Follow Up',
    'Junk Email', 'Rule Creation Needed', 'Inbox/Need to File',
    'Inbox/Unsubscribe Needed', 'Inbox/Personal'],
  // Archive 29,008 -> 29,924 (+916 = 896 in-window + 21 received today) and
  // Drafts 16 -> 32 (+16): the totals rose, so these ARRIVED rather than being
  // touched in place. 912 messages.
  B: ['Archive', 'Drafts'],
  // Every folder except the destination and Sent Items — resolved at run time,
  // because nobody knows in advance where Exchange will put 78,000 messages.
  RESTORE: null,
};

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

async function folderCount(token, idOrName) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  return (await get(`${base}/mailFolders/${idOrName}?$select=totalItemCount`, token)).totalItemCount;
}

const isDest = f => /^(deleted items|sent items)$/i.test(f.displayName || '');

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

  // ── --snapshot: read only, writes one local file ──────────────────────────
  if (DO_SNAPSHOT) {
    const token = await getToken();
    const folders = await allFolders(token);
    const snap = {
      takenAt: new Date().toISOString(),
      mailbox: BOX,
      counts: Object.fromEntries(folders.map(f => [f.path, f.totalItemCount])),
    };
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2));
    console.log(`Snapshot of ${folders.length} folders written to ${SNAPSHOT}`);
    console.log(`Taken at ${snap.takenAt}. Run the PowerShell restore now.`);
    console.log('Nothing was moved — this is a read.');
    return;
  }

  if (!(BATCH in BATCHES)) {
    console.error('Usage: --snapshot | --batch A|B|RESTORE [--from ISO --to ISO] [--write]');
    process.exit(2);
  }

  log(`Batch ${BATCH} — ${WRITE ? 'WRITE: messages will be MOVED' : 'DRY RUN: nothing will be moved'}`);
  log(`Mailbox     : ${BOX}`);
  log(`Window      : lastModifiedDateTime ${FROM} .. ${TO}`);
  log(`Destination : ${DEST}   (a move, never a delete)`);

  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const folders = await allFolders(token);
  const todayUTC = new Date().toISOString().slice(0, 10);

  // ── Which folders ─────────────────────────────────────────────────────────
  let picked, snapshot = null;
  if (BATCH === 'RESTORE') {
    if (!arg('from') || !arg('to')) {
      console.error('\nRESTORE needs --from and --to: the window the PowerShell restore actually ran in.');
      console.error('A window wider than the restore sweeps up every message anyone touched inside it.');
      process.exit(2);
    }
    if (!fs.existsSync(SNAPSHOT)) {
      console.error(`\nNo snapshot at ${SNAPSHOT}.`);
      console.error('RESTORE will not run without one. The window alone cannot tell a restored message');
      console.error('from one Lyndsay happened to read during the restore; the per-folder delta can.');
      console.error('Run --snapshot BEFORE the restore, not after — afterwards the counts have moved.');
      process.exit(2);
    }
    snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (snapshot.takenAt > FROM) {
      console.error(`\nThe snapshot was taken at ${snapshot.takenAt}, which is AFTER the window opens (${FROM}).`);
      console.error('It cannot describe the mailbox before the restore. Aborting.');
      process.exit(2);
    }
    picked = folders.filter(f => !isDest(f));
    log(`Snapshot    : ${snapshot.takenAt}, ${Object.keys(snapshot.counts).length} folders`);
    log(`Folders     : all ${picked.length} except Deleted Items and Sent Items`);
  } else {
    const wanted = BATCHES[BATCH];
    picked = [];
    for (const name of wanted) {
      const f = folders.find(x => x.path === name) || folders.find(x => x.displayName === name);
      if (!f) { log(`!! folder not found, SKIPPED: "${name}"`); continue; }
      if (isDest(f)) { log(`!! refusing ${f.path}`); continue; }
      picked.push(f);
    }
    if (picked.length !== wanted.length) {
      log(`\nABORTING: ${wanted.length - picked.length} named folder(s) could not be resolved.`);
      log('Nothing has been moved. Fix the names and re-run.');
      process.exit(1);
    }
  }

  const delBefore = await folderCount(token, DEST);
  log(`\nDeleted Items before: ${delBefore}\n`);

  // ── Select, folder by folder, before anything moves ───────────────────────
  // Collected first on purpose: moving while paginating mutates the collection
  // underneath the pagination and silently skips messages.
  const plan = [];
  const overshoot = [];
  let grandTargets = 0, grandToday = 0;

  for (const f of picked) {
    const before = f.totalItemCount;
    const url = `${base}/mailFolders/${f.id}/messages`
      + `?$filter=lastModifiedDateTime ge ${FROM} and lastModifiedDateTime le ${TO}`
      + `&$select=id,receivedDateTime&$top=100`;
    let all;
    try { all = await getAll(url, token); }
    catch (e) { log(`ERR   ${f.path}: ${e.message}`); continue; }
    if (!all.length) continue;

    // Mail that ARRIVED today is new mail somebody touched, not restored mail.
    const targets = all.filter(m => String(m.receivedDateTime || '').slice(0, 10) !== todayUTC);
    const today = all.length - targets.length;
    grandToday += today;
    if (!targets.length) {
      log(`${f.path}: ${today} in window, all received today — nothing to move`);
      continue;
    }

    // The delta check. Only RESTORE has a snapshot to check against.
    let delta = null;
    if (snapshot) {
      const was = snapshot.counts[f.path];
      if (was === undefined) {
        // A folder that did not exist before the restore is entirely new, so
        // everything in it arrived. Nothing to compare against, and nothing
        // that could have been "merely touched".
        delta = before;
        log(`${f.path}: new folder since the snapshot`);
      } else {
        delta = before - was;
      }
      if (targets.length > delta) {
        overshoot.push({ folder: f.path, selected: targets.length, delta, extra: targets.length - delta });
      }
    }

    plan.push({ f, before, ids: targets.map(m => m.id), today, delta });
    grandTargets += targets.length;
    log(`${f.path}`);
    log(`  holds ${before} · in window ${all.length} · to move ${targets.length}`
      + (today ? ` · ${today} received today, LEFT ALONE` : '')
      + (delta !== null ? ` · arrived since snapshot: ${delta}` : ''));
    await sleep(100);
  }

  log(`\n${'─'.repeat(70)}`);
  log(`Selected: ${grandTargets} message(s) across ${plan.length} folder(s).`);
  log(`Received today and left alone: ${grandToday}.`);

  // ── The stop ──────────────────────────────────────────────────────────────
  if (overshoot.length) {
    log(`\n${'!'.repeat(70)}`);
    log('STOPPING. In these folders the window selects MORE than arrived:');
    overshoot.forEach(o => log(`  ${o.folder}: selected ${o.selected}, only ${o.delta} arrived — ${o.extra} extra`));
    log('');
    log('Those extras were already in the folder and were touched during the window —');
    log('read, flagged or filed. They are not restored mail and moving them to Deleted');
    log('Items would be deleting somebody\'s live mail.');
    log('');
    log('Narrow --from/--to to when the restore actually ran, or move those folders');
    log('by hand. Nothing has been moved.');
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT.replace('.json', `-overshoot-${Date.now()}.log`), logLines.join('\n'));
    process.exit(3);
  }

  if (!WRITE) {
    log('\nDRY RUN — nothing was moved. Re-run with --write to move the above.');
    return;
  }

  // ── Move ──────────────────────────────────────────────────────────────────
  const errors = [];
  let grandMoved = 0;
  for (const p of plan) {
    let queue = p.ids.slice();
    let done = 0, rounds = 0;
    log(`\nmoving ${p.ids.length} from ${p.f.path}`);
    while (queue.length && rounds++ < 500) {
      const chunk = queue.splice(0, 20);
      const res = await moveChunk(token, chunk);
      done += res.done;
      if (res.failed.length) {
        res.failed.forEach(x => errors.push({ folder: p.f.path, ...x }));
        log(`  ${res.failed.length} failed permanently (status ${res.failed[0].status})`);
      }
      if (res.retry.length) {
        log(`  throttled — retrying ${res.retry.length} after ${Math.round(res.wait / 1000)}s`);
        await sleep(res.wait);
        queue = res.retry.concat(queue);
      }
      await sleep(400);
      if (done && done % 500 === 0) log(`  … ${done}/${p.ids.length}`);
    }
    p.moved = done;
    p.after = await folderCount(token, p.f.id);
    grandMoved += done;
    log(`  moved ${done} · ${p.before} -> ${p.after} (expected ${p.before - done})`
      + (p.after === p.before - done ? ' ✓' : ' ⚠ MISMATCH'));
  }

  const delAfter = await folderCount(token, DEST);
  log(`\n${'═'.repeat(70)}`);
  log(`${'FOLDER'.padEnd(36)}${'BEFORE'.padStart(9)}${'MOVED'.padStart(9)}${'AFTER'.padStart(9)}`);
  plan.forEach(p => log(`${p.f.path.slice(0, 35).padEnd(36)}${String(p.before).padStart(9)}`
    + `${String(p.moved).padStart(9)}${String(p.after).padStart(9)}`));
  log('─'.repeat(70));
  log(`Selected      : ${grandTargets}`);
  log(`Moved         : ${grandMoved}`);
  log(`Deleted Items : ${delBefore} -> ${delAfter}  (+${delAfter - delBefore})`);
  // Mail that left the folders has to have ARRIVED somewhere. A rise smaller
  // than the number moved would mean something was lost rather than relocated.
  log(grandMoved === delAfter - delBefore
    ? '✓ Deleted Items rose by exactly the number moved.'
    : `⚠ Deleted Items rose by ${delAfter - delBefore} but ${grandMoved} were moved — investigate.`);
  if (errors.length) {
    log(`\n${errors.length} message(s) failed and were NOT moved:`);
    errors.slice(0, 20).forEach(e => log(`  ${e.folder} ${e.status} ${e.error.slice(0, 90)}`));
  }

  const LOG = path.join(__dirname, '..', 'exports',
    `restore-incident-move-${BATCH}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.log`);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, logLines.join('\n') + '\n');
  console.log(`\nLog written to ${LOG}`);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
