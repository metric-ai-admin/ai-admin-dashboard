#!/usr/bin/env node
//
// Do the phone numbers on SimpleVoIP calls match residents we know about?
// READ ONLY. COUNTS AND PERCENTAGES ONLY — no phone number, name or address
// is ever printed.
//
//   node scripts/call-resident-match.js
//   node scripts/call-resident-match.js --from 2026-09-29
//
// WHY. Step 1 stores the external number on each call. Step 2 is whether that
// number can be turned into "this delinquent resident called / was called",
// which is only worth building if the match rate is high enough to be useful
// and honest. This measures it before anything is built on it.
//
// THE WINDOW IS NOT "THE LAST 30 DAYS". counterparty_number only exists from
// 2026-09-29 — before that it is empty on every row, and including those days
// would report a match rate of about half the real one by counting calls that
// never had a number to match. The default start is the first day with
// coverage, and the script says so.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const CF = require('../lib/custom-fields.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const FROM = arg('from', '2026-09-29');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// Last ten digits, no country code. "+1 (512) 555-0100", "512-555-0100" and
// "15125550100" are one number; anything that does not reduce to ten digits is
// not a US phone and is counted as unusable rather than quietly dropped.
function norm(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

// Every phone-looking field on a row, so a source that carries two numbers
// (home and mobile) contributes both. Matched on the FIELD NAME.
const PHONE_FIELD = /phone|mobile|cell|tel\b/i;
function phonesOf(row) {
  const out = [];
  Object.keys(row || {}).forEach(k => {
    if (!PHONE_FIELD.test(k)) return;
    const v = row[k];
    // `phones` on a projected tenant_directory row is already a list. Without
    // this it fell through the string/number check and the whole source
    // reported zero numbers — which is one of the two reasons the directory
    // contributed nothing.
    const parts = Array.isArray(v) ? v
      : ((typeof v === 'string' || typeof v === 'number')
        // One field can hold several numbers separated by / , or ;
        ? String(v).split(/[,;/]| and /i) : []);
    parts.forEach(part => {
      const n = norm(part);
      if (n) out.push(n);
    });
  });
  return out;
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
const pad = (s, w) => String(s).padEnd(w);

(async () => {
  // ---- the calls ----------------------------------------------------------
  const allCalls = await selectAll(() => db.from('simplevoip_daily_calls')
    .select('call_date,call_direction,counterparty_number,recording_id,duration'), { label: 'calls' });
  const calls = allCalls.filter(c => String(c.call_date).slice(0, 10) >= FROM);
  const withNum = calls.filter(c => norm(c.counterparty_number));

  console.log('Window from ' + FROM + ' (the first day counterparty_number is populated).');
  console.log('calls in window           : ' + calls.length);
  console.log('  with a usable number    : ' + withNum.length + '  ' + pct(withNum.length, calls.length));
  console.log('  distinct external numbers: ' + new Set(withNum.map(c => norm(c.counterparty_number))).size);
  if (!withNum.length) { console.log('\nNothing to match.'); return; }

  // ---- the resident side --------------------------------------------------
  // Each source contributes {number -> Set(propertyName)}. A number is matched
  // to ONE resident only when every source agrees on one property.
  const byNumber = new Map();
  const sourceStats = [];
  const addNumbers = (label, rows, propOf) => {
    let numbers = 0, rowsWithNumber = 0;
    (rows || []).forEach(r => {
      const p = String(propOf(r) || '').split(' - ')[0].trim() || '(no property)';
      const found = phonesOf(r);
      if (found.length) rowsWithNumber++;
      found.forEach(n => {
        numbers++;
        if (!byNumber.has(n)) byNumber.set(n, { props: new Set(), sources: new Set() });
        byNumber.get(n).props.add(p);
        byNumber.get(n).sources.add(label);
      });
    });
    // ROWS WITH A NUMBER, not just how many numbers came out. A source that
    // syncs 411 rows and contributes 3 numbers has a projection problem, and
    // the old output could not tell that apart from a source with 411 rows
    // that each carry one.
    sourceStats.push({ label, rows: (rows || []).length, numbers, rowsWithNumber });
  };

  const af = require('../appfolio-reports.js');
  const store = async id => {
    try { const d = await af.readReportData(id); return (d && d.rows) || []; }
    catch (e) { return []; }
  };

  const rentRoll = await store('rent_roll');
  addNumbers('rent_roll', rentRoll, r => r.property_name || r.property);

  // delinquency_kpi is the one that matters for Collections: these ARE the
  // delinquent residents the feature would be about.
  const dq = await store('delinquency_kpi');
  addNumbers('delinquency_kpi', dq, r => r.property_name || r.property);
  const dqNumbers = new Set();
  dq.forEach(r => phonesOf(r).forEach(n => dqNumbers.add(n)));

  // tenant_directory is the one source that exists TO carry phone numbers:
  // one row per current tenant, with phone and mobile. It is stored through a
  // projection that drops resident dates of birth (see appfolio-reports.js),
  // and the projection is why `rows with a number` is printed below — a
  // projection that dropped the phone columns would look exactly like a report
  // nobody had synced.
  const directory = await store('tenant_directory');
  addNumbers('tenant_directory', directory, r => r.property_name || r.property);

  const tickler = await store('tenant_tickler');
  addNumbers('tenant_tickler', tickler, r => r.property_name || r.property);

  // Custom fields can carry a phone too, and arrive nested.
  const ocf = CF.flattenAll(await store('occupancy_custom_fields'));
  addNumbers('occupancy_custom_fields', ocf, r => r.property_name || r.property_id);

  // Leads are NOT residents. Kept separate so a prospect is never reported as
  // "a delinquent resident called".
  const leads = await selectAll(() => db.from('leasing_leads').select('phone,property'), { label: 'leads' });
  const leadNumbers = new Set();
  leads.forEach(l => phonesOf(l).forEach(n => leadNumbers.add(n)));

  console.log('\nresident phone sources:');
  sourceStats.forEach(s => console.log('   ' + pad(s.label, 26)
    + pad(s.rows + ' rows', 14)
    + pad(s.rowsWithNumber + ' with a number', 22)
    + s.numbers + ' numbers'));
  console.log('   ' + pad('leasing_leads (not residents)', 26)
    + pad(leads.length + ' rows', 14) + leadNumbers.size + ' numbers');
  console.log('   distinct resident numbers : ' + byNumber.size);

  // ---- the match ----------------------------------------------------------
  let one = 0, many = 0, none = 0;
  const byDir = {}, byProp = {};
  const unmatched = { lead: 0, other: 0 };
  let dqHits = 0;

  // VENDORS AND OUR OWN LINES CANNOT BE TOLD APART HERE, and saying so beats a
  // category that is always zero. Separating them needs a list of Metric's own
  // DIDs and a vendor list, and neither exists in this database — so they fall
  // into "neither lead nor resident" together, which is what that bucket
  // honestly is.

  const grades = await selectAll(() => db.from('call_grades').select('recording_id,property_name'), { label: 'grades' });
  const propOfCall = new Map();
  grades.forEach(g => { if (g.recording_id) propOfCall.set(String(g.recording_id), g.property_name); });

  withNum.forEach(c => {
    const n = norm(c.counterparty_number);
    const hit = byNumber.get(n);
    const dir = c.call_direction || '(unknown)';
    const prop = propOfCall.get(String(c.recording_id)) || '(not graded)';
    byDir[dir] = byDir[dir] || { n: 0, hit: 0 };
    byProp[prop] = byProp[prop] || { n: 0, hit: 0 };
    byDir[dir].n++; byProp[prop].n++;

    if (!hit) {
      none++;
      if (leadNumbers.has(n)) unmatched.lead++;
      else unmatched.other++;
      return;
    }
    byDir[dir].hit++; byProp[prop].hit++;
    if (hit.props.size === 1) one++; else many++;
    if (dqNumbers.has(n)) dqHits++;
  });

  const blocked = calls.length - withNum.length;
  console.log('\nMATCH, over the ' + withNum.length + ' calls with a usable number:');
  console.log('   exactly one resident      : ' + pad(one, 6) + pct(one, withNum.length));
  console.log('   several (shared number)   : ' + pad(many, 6) + pct(many, withNum.length));
  console.log('   no resident               : ' + pad(none, 6) + pct(none, withNum.length));
  console.log('   of the matched, on the delinquency list: ' + dqHits + '  ' + pct(dqHits, withNum.length) + ' of all calls');

  console.log('\nwhat the unmatched are:');
  console.log('   a known lead / prospect   : ' + pad(unmatched.lead, 6) + pct(unmatched.lead, none));
  console.log('   neither lead nor resident : ' + pad(unmatched.other, 6) + pct(unmatched.other, none));
  console.log('     (vendors, our own lines and everything else — telling those');
  console.log('      apart needs a roster of Metric DIDs and a vendor list, and');
  console.log('      neither is in this database)');
  console.log('   no number on the call     : ' + pad(blocked, 6) + '(blocked or withheld; outside the matched set)');

  console.log('\nby direction:');
  Object.entries(byDir).sort((a, b) => b[1].n - a[1].n).forEach(([d, x]) =>
    console.log('   ' + pad(d, 12) + pad(x.hit + '/' + x.n, 12) + pct(x.hit, x.n)));

  console.log('\nby property (from call_grades; "(not graded)" has no property):');
  Object.entries(byProp).sort((a, b) => b[1].n - a[1].n).slice(0, 16).forEach(([p, x]) =>
    console.log('   ' + pad(p, 28) + pad(x.hit + '/' + x.n, 12) + pct(x.hit, x.n)));

  console.log('\nNothing was written, and no phone number, name or address was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
