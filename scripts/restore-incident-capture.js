#!/usr/bin/env node
//
// 2026-10-01 incident — CAPTURE. Read only. Writes two local files, moves
// nothing, and contains no write path to Graph at all (its only POST is the
// token request).
//
//   node scripts/restore-incident-capture.js
//
// WHY THIS EXISTS. The step-1 scan read the 2,563 message ids into memory and
// printed only counts and five samples per folder — it saved nothing. The
// selector it used, lastModifiedDateTime inside a 35-minute window, then
// stopped working: something (almost certainly the mailbox assistant digesting
// the purge and the restore) has been rewriting lastModifiedDateTime all
// afternoon, so the same query returned 1,651 at 14:34, 565 at 16:10 and 222
// at 16:30 while the folders themselves did not change.
//
// A GRAPH MESSAGE ID DOES NOT DRIFT. It survives being read, flagged or
// re-indexed; it changes only when the message moves. So the fix is to capture
// ids now and move by id later, instead of re-running a query whose answer
// keeps shrinking.
//
// THE SELECTOR, and how far it can be trusted:
//
//   receivedDateTime BEFORE today  AND  lastModifiedDateTime >= 14:05Z today
//
// Everything the restore put back was received before today and has been
// touched today. The question is whether it catches anything else, and that is
// checkable rather than assumable: Arturo measured each folder's growth in
// Outlook this morning, and those thirteen numbers are an independent record of
// how many messages actually arrived. Run with the comparison printed, so the
// selector is judged against them every time.
//
// THE LOWER BOUND IS 14:05Z, NOT MIDNIGHT, and it is what makes this exact.
// "Modified today" alone over-selected: 912 in Archive against a measured 896,
// and 380 in MPM Team against 379. The extras had been modified at 04:27 and
// 13:52 — ordinary morning activity, hours before the restore began. Moving the
// bound to the moment the incident started removes exactly those, and the
// capture then matches all thirteen measurements with no residue: 2,563.
//
// The upper bound is deliberately open. lastModifiedDateTime keeps being
// rewritten to LATER times, so a restored message only ever moves further
// above the bound, never back below it.
//
// THIS SELECTOR EXPIRES TONIGHT. "Modified today" means nothing tomorrow. If
// the capture is not taken today it cannot be taken at all.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOX = process.env.MAILBOX_LYNDSAY;
const TODAY = new Date().toISOString().slice(0, 10);
// When the restore began. Anything touched before this is ordinary activity.
const INCIDENT_START = process.env.INCIDENT_START || '2026-10-01T14:05:00Z';
const OUT_JSON = path.join(__dirname, '..', 'exports', `restore-incident-ids-${TODAY}.json`);
const OUT_TXT = path.join(__dirname, '..', 'exports', `restore-incident-ids-${TODAY}.txt`);

// What Arturo measured in Outlook on the morning of 2026-10-01. The capture is
// judged against these, not the other way round.
const MEASURED = {
  'Inbox/MPM Team': 379, 'Inbox/Lyndsay Review': 227, 'Inbox/Client Emails': 92,
  "Inbox/Reminders Don't Need": 61, 'Inbox/Financial': 50, 'Inbox/Bekah Follow Up': 34,
  'Junk Email': 800, 'Archive': 896, 'Drafts': 16, 'Rule Creation Needed': 3,
  'Inbox/Need to File': 2, 'Inbox/Unsubscribe Needed': 2, 'Inbox/Personal': 1,
};
const SKIP = f => /^(deleted items|sent items)$/i.test(f.displayName || '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (!j.access_token) throw new Error('Token request failed (' + r.status + ')');
  return j.access_token;
}

// GET only. This helper cannot send another method.
async function get(url, token, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 503 || r.status === 504) {
      await sleep(Number(r.headers.get('retry-after') || 0) * 1000 || 2000 * (i + 1));
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

const who = m => {
  const e = m.from?.emailAddress || m.sender?.emailAddress || {};
  return { name: e.name || '', address: e.address || '' };
};

(async () => {
  if (!BOX || !process.env.GRAPH_CLIENT_ID) {
    console.error('MAILBOX_LYNDSAY or Graph credentials missing from .env');
    process.exit(1);
  }
  console.log('CAPTURE — read only. Nothing is moved, flagged or deleted.');
  console.log(`Mailbox  : ${BOX}`);
  console.log(`Selector : receivedDateTime < ${TODAY}  AND  lastModifiedDateTime on ${TODAY}\n`);

  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const folders = (await allFolders(token)).filter(f => !SKIP(f));

  const captured = {};
  const rows = [];
  let grand = 0;

  for (const f of folders) {
    // No $filter on lastModifiedDateTime here: it is the field that keeps being
    // rewritten, and a server-side filter would race the rewrites mid-page.
    // Read the folder and decide locally, from one consistent page set.
    let msgs;
    try {
      msgs = await getAll(`${base}/mailFolders/${f.id}/messages`
        + `?$select=id,subject,from,sender,receivedDateTime,lastModifiedDateTime&$top=100`, token);
    } catch (e) { console.log(`ERR   ${f.path}: ${e.message}`); continue; }

    const hits = msgs.filter(m =>
      String(m.receivedDateTime || '').slice(0, 10) < TODAY
      && String(m.lastModifiedDateTime || '') >= INCIDENT_START);
    if (!hits.length) continue;

    captured[f.path] = hits.map(m => ({
      id: m.id,
      folder: f.path,
      sender: who(m).name,
      senderAddress: who(m).address,
      subject: m.subject || '(no subject)',
      receivedDateTime: m.receivedDateTime,
      lastModifiedDateTime: m.lastModifiedDateTime,
    }));
    grand += hits.length;
    const measured = MEASURED[f.path];
    rows.push({ folder: f.path, total: f.totalItemCount, captured: hits.length, measured });
    await sleep(120);
  }

  rows.sort((a, b) => b.captured - a.captured);
  console.log('FOLDER'.padEnd(32) + 'HOLDS'.padStart(8) + 'CAPTURED'.padStart(10)
    + 'MEASURED'.padStart(10) + '   VERDICT');
  let matched = 0, over = 0;
  for (const r of rows) {
    let verdict;
    if (r.measured === undefined) { verdict = 'not measured this morning — REVIEW'; over++; }
    else if (r.captured === r.measured) { verdict = 'matches'; matched++; }
    else {
      const d = r.captured - r.measured;
      verdict = `${d > 0 ? '+' : ''}${d} vs measured — REVIEW`;
      over++;
    }
    console.log(r.folder.slice(0, 31).padEnd(32) + String(r.total).padStart(8)
      + String(r.captured).padStart(10) + String(r.measured ?? '—').padStart(10) + '   ' + verdict);
  }

  const measuredTotal = Object.values(MEASURED).reduce((a, b) => a + b, 0);
  console.log('─'.repeat(74));
  console.log(`Captured : ${grand} ids across ${rows.length} folder(s)`);
  console.log(`Measured : ${measuredTotal} across ${Object.keys(MEASURED).length} folder(s) (Arturo, Outlook, this morning)`);
  console.log(`Folders matching exactly: ${matched}/${rows.length}. Needing review: ${over}.`);

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    capturedAt: new Date().toISOString(),
    mailbox: BOX,
    selector: `receivedDateTime < ${TODAY} AND lastModifiedDateTime >= ${INCIDENT_START}`,
    note: 'Ids do not drift. Move by these ids, never by re-running a date query.',
    measuredThisMorning: MEASURED,
    totals: rows,
    byFolder: captured,
  }, null, 2));

  const lines = [];
  lines.push(`Restore incident — captured ${new Date().toISOString()}`);
  lines.push(`Selector: receivedDateTime < ${TODAY} AND lastModifiedDateTime >= ${INCIDENT_START}`);
  lines.push(`${grand} messages. READ ONLY — nothing has been moved.`);
  for (const r of rows) {
    lines.push('');
    lines.push('='.repeat(100));
    lines.push(`${r.folder} — captured ${r.captured}, measured this morning ${r.measured ?? '—'}`);
    lines.push('='.repeat(100));
    for (const m of captured[r.folder]) {
      lines.push([
        m.receivedDateTime.slice(0, 16).replace('T', ' '),
        (m.sender || m.senderAddress || '(no sender)').slice(0, 30).padEnd(30),
        (m.subject || '').slice(0, 60),
      ].join(' | '));
      lines.push(`    id ${m.id}`);
    }
  }
  fs.writeFileSync(OUT_TXT, lines.join('\n') + '\n');

  console.log(`\nIds + metadata : ${OUT_JSON}`);
  console.log(`Readable list  : ${OUT_TXT}`);
  console.log('\nNothing was moved. Both files are local and exports/ is gitignored.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
