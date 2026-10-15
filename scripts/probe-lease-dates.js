#!/usr/bin/env node
//
// What AppFolio says about each lease, against what we stored.
// READ ONLY — one report read and one table read. Nothing is written.
//
//   node scripts/probe-lease-dates.js
//
// THE QUESTION. Leasing says The Chateau's move-in is 10/11; we stored
// 2026-11-10. A swapped date format was the obvious suspect, and the stored
// data rules it out on its own: 34 of 82 rows have a day past the 12th, which
// under a DD/MM-read-as-MM/DD swap would have produced a month past 12 and
// parsed to nothing. The months also cluster in September and October rather
// than spreading across the calendar the way day-numbers would.
//
// WHAT THE STORED DATA POINTS AT INSTEAD is staleness. That row's synced_at is
// 2026-10-02 while 31 others were refreshed on the 15th: the sync UPSERTS what
// the report returns and never removes or revisits what it does not, so a
// lease that leaves the report keeps its last known values for ever.
//
// THIS SETTLES IT WITH EVIDENCE RATHER THAN INFERENCE. It fetches the live
// report and compares, row by row:
//
//   SAME        stored matches the report
//   CHANGED     both have it, the dates differ   <- a real wrong date
//   GONE        we have a row the report does not return at all
//   NEW         the report has one we have never stored
//
// Only CHANGED is "a date that was wrong". GONE is a date we can no longer
// vouch for, which is a different thing and the one the brief now acts on.
//
// PRIVACY. No tenant names are printed. Lease ids, dates and statuses only.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const REPORT = process.env.APPFOLIO_LEASE_HISTORY_REPORT || 'lease_history';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

// The SAME conversion server.js uses, copied deliberately rather than
// imported: the point is to see what that conversion does to the raw value,
// and importing a different one would answer a different question.
const leasingDateOnly = v => {
  if (v === '' || v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA');
};

async function fetchReport() {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/' + REPORT + '.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ property_visibility: 'active', paginate_results: false }),
  });
  if (!r.ok) throw new Error('AppFolio ' + r.status + ' on ' + REPORT);
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. One report read, one table read. Nothing is written.\n');

  const raw = await fetchReport();
  const live = new Map();
  raw.forEach(r => {
    const id = clean(r.lease_uuid);
    if (id) live.set(id, r);
  });

  let stored = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('leasing_lease_history')
      .select('lease_uuid,property_name,move_in_date,move_out_date,status,synced_at')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    stored = stored.concat(data || []);
    if ((data || []).length < 1000) break;
  }

  console.log('report: ' + raw.length + ' rows   stored: ' + stored.length + ' rows\n');

  // ---- how the raw value actually looks -------------------------------------
  //
  // Printed before any verdict, because every conclusion below depends on it
  // and "MM/DD or DD/MM" is answerable by looking.
  const samples = raw.map(r => clean(r.move_in)).filter(Boolean).slice(0, 5);
  console.log('RAW move_in VALUES, as the report sends them');
  samples.forEach(v => console.log('   ' + pad(JSON.stringify(v), 26)
    + '-> leasingDateOnly -> ' + leasingDateOnly(v)));
  const anyDayOver12 = raw.map(r => clean(r.move_in))
    .filter(v => /^\d{1,2}\/\d{1,2}\//.test(v))
    .some(v => Number(v.split('/')[1]) > 12);
  if (/^\d{1,2}\/\d{1,2}\//.test(samples[0] || '')) {
    console.log('   Slash-formatted. A second component past 12 '
      + (anyDayOver12 ? 'IS present, so the first component is the MONTH (US order).'
        : 'is NOT present anywhere, so the order cannot be proven from the data.'));
  }

  // ---- the comparison --------------------------------------------------------
  const changed = [];
  const gone = [];
  let same = 0;
  stored.forEach(s => {
    const r = live.get(clean(s.lease_uuid));
    if (!r) { gone.push(s); return; }
    const theirs = leasingDateOnly(r.move_in);
    const ours = clean(s.move_in_date).slice(0, 10) || null;
    if (theirs === ours) { same += 1; return; }
    changed.push({ id: s.lease_uuid, property: s.property_name, ours, theirs,
      synced: clean(s.synced_at).slice(0, 10) });
  });
  const fresh = new Set(stored.map(s => clean(s.lease_uuid)));
  const added = raw.filter(r => clean(r.lease_uuid) && !fresh.has(clean(r.lease_uuid)));

  console.log('\nHOW MANY DATES WERE ACTUALLY WRONG');
  console.log('   SAME     ' + same);
  console.log('   CHANGED  ' + changed.length + '   <- stored a date the report disagrees with');
  console.log('   GONE     ' + gone.length + '   <- we hold rows the report no longer returns');
  console.log('   NEW      ' + added.length + '   <- in the report, never stored');

  if (changed.length) {
    console.log('\n   CHANGED, in full:');
    changed.forEach(c => console.log('      ' + pad(c.property, 24)
      + 'ours ' + pad(c.ours || '(none)', 13) + 'report ' + pad(c.theirs || '(none)', 13)
      + 'synced ' + c.synced));
  }
  if (gone.length) {
    console.log('\n   GONE, with a future move-in (these are the ones the brief now leaves out):');
    const today = new Date().toLocaleDateString('en-CA');
    const futures = gone.filter(g => clean(g.move_in_date).slice(0, 10) >= today);
    if (!futures.length) console.log('      none');
    futures.forEach(g => console.log('      ' + pad(g.property_name, 24)
      + pad(clean(g.move_in_date).slice(0, 10), 13) + 'status ' + pad(g.status, 22)
      + 'synced ' + clean(g.synced_at).slice(0, 10)));
  }

  console.log('\nWHAT TO MAKE OF IT');
  console.log('   CHANGED is the answer to "how many dates were wrong". If it is 0,');
  console.log('   nothing was ever parsed incorrectly and the Chateau row is GONE —');
  console.log('   a lease that left the report keeping its last known date for ever.');
  console.log('   That is a sync that never revisits what it has, not a format bug,');
  console.log('   and the fix is to mark or drop rows the report stops returning.');
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
