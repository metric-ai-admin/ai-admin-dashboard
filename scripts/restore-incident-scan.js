#!/usr/bin/env node
//
// 2026-10-01 incident — DRY RUN, READ ONLY.
//
//   node scripts/restore-incident-scan.js
//
// Emptying Deleted Items in Lyndsay's mailbox triggered a restore of ~2,600
// messages, and Exchange put them back in their ORIGINAL folders rather than in
// Deleted Items. This script finds them so somebody can decide what to move; it
// moves nothing.
//
// THERE IS NO WRITE PATH IN THIS FILE. No POST, no PATCH, no DELETE, no /move,
// and no --write flag that could be passed by accident. The move is a separate
// script, written only after this output has been approved.
//
// HOW THEY ARE IDENTIFIED. A restore rewrites lastModifiedDateTime and leaves
// receivedDateTime alone, so the restored set is "modified inside the incident
// window, received whenever". The window is narrow and given on the command
// line defaults below; nothing outside it is reported.
//
// THE FALSE POSITIVE TO WORRY ABOUT is a message Lyndsay or an Outlook rule
// touched during those same 35 minutes — reading it, flagging it and moving it
// all rewrite lastModifiedDateTime too. Those are not restored mail and must
// not be swept up, so anything RECEIVED today is reported separately and never
// counted in the main totals.

require('dotenv').config();

const BOX = process.env.MAILBOX_LYNDSAY;
const FROM = process.env.SCAN_FROM || '2026-10-01T14:05:00Z';
const TO   = process.env.SCAN_TO   || '2026-10-01T14:40:00Z';

// Where restored mail must NOT be hunted: Deleted Items is the destination and
// Sent Items is excluded by the brief.
const SKIP = ['deleteditems', 'sentitems'];

// The deltas Arturo measured in Outlook, to check this scan against. A folder
// that disagrees badly means the window is wrong, not that the folder is odd.
const EXPECTED = {
  'Lyndsay Review': 227, 'MPM Team': 379, 'Client Emails': 92, 'Bekah Follow Up': 34,
  'Financial': 50, "Reminders Don't Need": 61, 'Junk Email': 803,
};

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
  // Never echo the body on failure: a token error can quote the request back,
  // and the request carries the client secret.
  if (!j.access_token) throw new Error('Token request failed (' + r.status + ')');
  return j.access_token;
}

// GET with a couple of retries on throttling. Read-only by construction: this
// helper has no way to send a method other than GET.
async function get(url, token, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 503 || r.status === 504) {
      const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 2000 * (i + 1);
      await sleep(wait);
      continue;
    }
    const t = await r.text().catch(() => '');
    throw new Error(`GET ${r.status}: ${t.slice(0, 200)}`);
  }
  throw new Error('gave up after ' + tries + ' tries: ' + url);
}

async function getAll(url, token, cap = 5000) {
  const out = [];
  let next = url;
  while (next && out.length < cap) {
    const j = await get(next, token);
    out.push(...(j.value || []));
    next = j['@odata.nextLink'] || null;
    if (next) await sleep(120);
  }
  return out;
}

// Every folder, at every depth. Graph's top-level listing is not enough: most
// of Lyndsay's folders are nested under Inbox.
async function allFolders(token) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const top = await getAll(`${base}/mailFolders?$select=id,displayName,parentFolderId,totalItemCount,childFolderCount&$top=100`, token);
  const out = [], queue = top.map(f => ({ ...f, path: f.displayName })), seen = new Set();
  let guard = 0;
  while (queue.length && guard++ < 3000) {
    const f = queue.shift();
    if (!f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (f.childFolderCount) {
      const kids = await getAll(`${base}/mailFolders/${f.id}/childFolders?$select=id,displayName,parentFolderId,totalItemCount,childFolderCount&$top=100`, token);
      for (const k of kids) queue.push({ ...k, path: f.path + '/' + k.displayName });
    }
  }
  return out;
}

const iso = d => String(d || '').slice(0, 16).replace('T', ' ');
// Keep the sender's NAME — it is what makes the sample readable — and mask the
// local part of the address. Nothing here needs a routable address.
const who = m => {
  const e = m.from?.emailAddress || m.sender?.emailAddress || {};
  const a = String(e.address || '');
  const masked = a ? a[0] + '***@' + (a.split('@')[1] || '?') : '(no address)';
  return `${e.name || '(no name)'} <${masked}>`;
};

(async () => {
  if (!BOX || !process.env.GRAPH_CLIENT_ID) {
    console.error('MAILBOX_LYNDSAY or Graph credentials missing from .env');
    process.exit(1);
  }
  console.log(`DRY RUN — read only. Nothing is moved, flagged or deleted.`);
  console.log(`Mailbox : ${BOX}`);
  console.log(`Window  : lastModifiedDateTime ${FROM} .. ${TO}\n`);

  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}`;
  const folders = await allFolders(token);

  // "Today" in UTC, matching the window's own clock. A message RECEIVED today
  // is new mail somebody touched, not restored mail.
  const todayUTC = new Date().toISOString().slice(0, 10);

  const rows = [];
  const todays = [];
  let scanned = 0;

  for (const f of folders) {
    const wellKnown = String(f.displayName || '').toLowerCase().replace(/\s+/g, '');
    if (SKIP.includes(wellKnown)) { console.log(`skip  ${f.path}`); continue; }
    if (/^deleted items$|^sent items$/i.test(f.displayName || '')) { console.log(`skip  ${f.path}`); continue; }

    const url = `${base}/mailFolders/${f.id}/messages`
      + `?$filter=lastModifiedDateTime ge ${FROM} and lastModifiedDateTime le ${TO}`
      + `&$select=id,subject,from,sender,receivedDateTime,lastModifiedDateTime,isRead`
      + `&$top=100`;
    let msgs;
    try { msgs = await getAll(url, token); }
    catch (e) { console.log(`ERR   ${f.path}: ${e.message}`); continue; }
    scanned++;
    if (!msgs.length) continue;

    const fresh = msgs.filter(m => String(m.receivedDateTime || '').slice(0, 10) === todayUTC);
    const restored = msgs.filter(m => String(m.receivedDateTime || '').slice(0, 10) !== todayUTC);
    fresh.forEach(m => todays.push({ folder: f.path, m }));
    if (!restored.length) continue;

    const dates = restored.map(m => m.receivedDateTime).filter(Boolean).sort();
    rows.push({
      folder: f.path, name: f.displayName, n: restored.length, fresh: fresh.length,
      from: dates[0], to: dates[dates.length - 1],
      samples: restored.slice(0, 5),
      total: f.totalItemCount,
    });
    await sleep(100);
  }

  rows.sort((a, b) => b.n - a.n);
  let grand = 0;

  for (const r of rows) {
    grand += r.n;
    const exp = EXPECTED[r.name];
    const delta = exp === undefined ? '' :
      (r.n === exp ? `  ✓ matches the +${exp} delta`
        : `  ⚠ expected +${exp}, scan found ${r.n} (${r.n - exp > 0 ? '+' : ''}${r.n - exp})`);
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${r.folder}   ${r.n} message(s) in the window${delta}`);
    console.log(`  folder holds ${r.total} in total`);
    console.log(`  received between ${iso(r.from)} and ${iso(r.to)}`);
    if (r.fresh) console.log(`  (${r.fresh} more received TODAY — listed separately, NOT counted)`);
    r.samples.forEach(m => console.log(
      `    · ${who(m)}  |  ${String(m.subject || '(no subject)').slice(0, 58)}  |  ${iso(m.receivedDateTime)}`));
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`TOTAL to move: ${grand} message(s) across ${rows.length} folder(s). ${scanned} folders scanned.`);

  const expTotal = Object.values(EXPECTED).reduce((a, b) => a + b, 0);
  console.log(`The folders Arturo measured account for ${expTotal} of them.`);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`RECEIVED TODAY — excluded from every count above: ${todays.length}`);
  console.log('These were modified inside the window but arrived today, so they are');
  console.log('probably new mail that Lyndsay or an Outlook rule touched. They must');
  console.log('NOT be moved without someone looking at them.');
  const byFolder = {};
  todays.forEach(x => (byFolder[x.folder] = byFolder[x.folder] || []).push(x.m));
  Object.entries(byFolder).sort((a, b) => b[1].length - a[1].length).forEach(([folder, list]) => {
    console.log(`\n  ${folder} — ${list.length}`);
    list.slice(0, 10).forEach(m => console.log(
      `    · ${who(m)}  |  ${String(m.subject || '(no subject)').slice(0, 52)}  |  rcvd ${iso(m.receivedDateTime)}  mod ${iso(m.lastModifiedDateTime)}`));
    if (list.length > 10) console.log(`    … and ${list.length - 10} more`);
  });
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
