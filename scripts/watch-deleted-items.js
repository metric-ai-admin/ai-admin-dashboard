#!/usr/bin/env node
//
// 2026-10-01 incident — READ ONLY watcher.
//
//   node scripts/watch-deleted-items.js
//
// Emptying Deleted Items is asynchronous in Exchange, and on a 78,000-item
// folder it runs for a long time. Moving the restored mail back in while the
// purge is still running would feed it straight to Recoverable Items, so this
// watches the count until it stops falling.
//
// Reads one number every 5 minutes and exits when two consecutive readings are
// identical. The only request it makes other than the token is
// GET /mailFolders/deleteditems?$select=totalItemCount.
//
// A fresh token every reading: these run for hours and a client-credentials
// token expires in about one.

require('dotenv').config();

const BOX = process.env.MAILBOX_LYNDSAY;
const EVERY_MS = 5 * 60 * 1000;
const MAX_HOURS = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19) + 'Z';

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

async function count() {
  const token = await getToken();
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BOX)}/mailFolders/deleteditems?$select=totalItemCount`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('GET ' + r.status);
  const j = await r.json();
  // A reading that is not a number is not a reading. Returning undefined here
  // and comparing it to the previous undefined would declare the purge
  // finished because two failures matched.
  if (typeof j.totalItemCount !== 'number') throw new Error('no count in response');
  return j.totalItemCount;
}

(async () => {
  if (!BOX || !process.env.GRAPH_CLIENT_ID) {
    console.error('MAILBOX_LYNDSAY or Graph credentials missing from .env');
    process.exit(1);
  }
  console.log(`Watching Deleted Items in ${BOX} — read only, every 5 minutes.`);
  console.log('Stops when two consecutive readings match.\n');

  let prev = null;
  const deadline = Date.now() + MAX_HOURS * 3600 * 1000;
  let fails = 0;

  while (Date.now() < deadline) {
    let n;
    try { n = await count(); fails = 0; }
    catch (e) {
      // A failed read is not a reading, and must not reset or satisfy the
      // comparison. Try again on the next tick.
      fails++;
      console.log(`${stamp()}  read failed (${e.message})${fails >= 5 ? ' — giving up' : ', retrying next tick'}`);
      if (fails >= 5) process.exit(1);
      await sleep(EVERY_MS);
      continue;
    }

    const delta = prev === null ? '' : `   (${n - prev > 0 ? '+' : ''}${n - prev})`;
    console.log(`${stamp()}  Deleted Items = ${n}${delta}`);

    if (prev !== null && n === prev) {
      console.log(`\nSTABLE at ${n} — two consecutive readings match. The purge has stopped.`);
      console.log('Safe to run: node scripts/restore-incident-move.js --batch A --write');
      process.exit(0);
    }
    prev = n;
    await sleep(EVERY_MS);
  }
  console.log(`\nStopped after ${MAX_HOURS}h without two matching readings. Last count: ${prev}.`);
  process.exit(2);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
