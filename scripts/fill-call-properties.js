#!/usr/bin/env node
//
// Fill in the property on calls the grader could not place, from WHOSE NUMBER
// IT WAS. No AI, no re-grading.
//
//   node scripts/fill-call-properties.js            # DRY RUN
//   node scripts/fill-call-properties.js --write
//
// THE RULE, and the reason it is this narrow:
//
//   The call's counterparty_number belongs to EXACTLY ONE resident, and that
//   resident is at exactly ONE property  ->  use it, marked 'resident_match'.
//   Shared between residents, no match, or two properties               -> leave it.
//
// A shared number is left alone rather than attributed to whichever resident
// sorts first. 18 of them crossed the directory on 2026-10-13, and each one is
// a case where somebody would otherwise read a confident property off a call
// that might have been the other household's. A wrong attribution looks exactly
// like a right one, which is the whole reason the grader's free-text answers
// had to be thrown out in the first place.
//
// "Not property-specific" is NOT touched: it is a finished answer. Overwriting
// a correct "this was a vendor" with the property of whoever owns the phone
// number would be inventing a fact, not completing one.
//
// Nothing is re-graded. The score, the rubric and every word the model wrote
// stay exactly as they are — only property_name and property_source change.
//
// Requires migration 092. Without it the write fails on property_source and
// says so; the dry run only reads.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const CM = require('../lib/call-match.js');
const CP = require('../lib/call-property.js');
const AFP = require('../lib/appfolio-properties.js');
const PA = require('../lib/property-aliases.js');

const WRITE = process.argv.includes('--write');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

// A resident row's property, canonicalised, or null. Both sources are read
// through the same two mappers the rest of the dashboard uses, so a property
// this script fills in is spelled the way every report spells it.
function propertyOf(row) {
  const raw = clean(row.property_name || row.property);
  return PA.canonical(raw) || AFP.resolveProperty(raw) || null;
}

(async () => {
  const af = require('../appfolio-reports.js');
  const store = async id => {
    try { const d = await af.readReportData(id); return (d && d.rows) || []; }
    catch (e) { return []; }
  };

  // ---- number -> property, but only where there is exactly one -------------
  const props = new Map();   // number -> Set(property)
  const owners = new Map();  // number -> Set(resident name)
  const addSource = (rows, label) => {
    let used = 0;
    rows.forEach(r => {
      const p = propertyOf(r);
      const who = require('../lib/tenant-directory.js').nameOf(r) || clean(r.name);
      CM.indexResidents([r]).forEach((names, n) => {
        if (!props.has(n)) { props.set(n, new Set()); owners.set(n, new Set()); }
        if (p) props.get(n).add(p);
        (who ? [who] : names).forEach(x => owners.get(n).add(x));
        used++;
      });
    });
    console.log('   ' + pad(label, 22) + pad(rows.length + ' rows', 12) + used + ' numbers');
  };

  console.log('resident sources:');
  addSource(await store('tenant_directory'), 'tenant_directory');
  addSource(await store('delinquency_kpi'), 'delinquency_kpi');
  console.log('   ' + pad('distinct numbers', 22) + props.size);

  // ---- the calls ----------------------------------------------------------
  const calls = await selectAll(() => db.from('simplevoip_daily_calls')
    .select('recording_id,counterparty_number'), { label: 'calls' });
  const numberOfCall = new Map();
  calls.forEach(c => {
    const n = CM.normPhone(c.counterparty_number);
    if (n && c.recording_id) numberOfCall.set(String(c.recording_id), n);
  });

  const grades = await selectAll(() => db.from('call_grades')
    .select('id,recording_id,property_name'), { label: 'call_grades' });

  console.log('\ncall_grades: ' + grades.length + ' rows');

  const open = grades.filter(g => CP.needsProperty(g.property_name));
  console.log('   without a usable property : ' + open.length);
  console.log('   already placed            : ' + (grades.length - open.length));

  // ---- the verdicts --------------------------------------------------------
  const fill = [];
  const skipped = { noRecording: 0, noNumber: 0, noResident: 0, shared: 0, twoProperties: 0 };

  open.forEach(g => {
    if (!g.recording_id) { skipped.noRecording++; return; }
    const n = numberOfCall.get(String(g.recording_id));
    if (!n) { skipped.noNumber++; return; }
    const who = owners.get(n);
    if (!who) { skipped.noResident++; return; }
    // More than one resident on the number: left alone, deliberately.
    if (who.size > 1) { skipped.shared++; return; }
    const p = props.get(n);
    if (!p || p.size !== 1) { skipped.twoProperties++; return; }
    fill.push({ id: g.id, to: [...p][0] });
  });

  const byProperty = {};
  fill.forEach(f => { byProperty[f.to] = (byProperty[f.to] || 0) + 1; });

  console.log('\nWOULD FILL: ' + fill.length + ' of ' + open.length);
  Object.entries(byProperty).sort((a, b) => b[1] - a[1])
    .forEach(([p, n]) => console.log('   ' + String(n).padStart(5) + '  ' + p));

  console.log('\nLEFT ALONE: ' + (open.length - fill.length));
  console.log('   ' + pad('no recording id', 30) + skipped.noRecording);
  console.log('   ' + pad('no number on the call', 30) + skipped.noNumber
    + '   (blocked, withheld, or before 2026-09-29)');
  console.log('   ' + pad('number is nobody we know', 30) + skipped.noResident
    + '   (vendors, our own lines, prospects)');
  console.log('   ' + pad('number shared by residents', 30) + skipped.shared
    + '   (deliberately not attributed)');
  console.log('   ' + pad('resident at two properties', 30) + skipped.twoProperties);

  const after = grades.length - open.length + fill.length;
  console.log('\nAfter this run, ' + after + ' of ' + grades.length + ' calls ('
    + ((100 * after) / grades.length).toFixed(0) + '%) have a property.');
  console.log('The rest mostly have no number to match: a property for those needs');
  console.log('the transcript, which is the grader\'s job and not this script\'s.');

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }
  if (!fill.length) { console.log('\nNothing to do.'); return; }

  // The backup is every row's CURRENT property and source, not just the ones
  // about to change — the case a backup is for is the one where the plan was
  // wrong about more than it listed.
  const fs = require('fs');
  const pathm = require('path');
  const dir = pathm.join(__dirname, '..', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = pathm.join(dir, 'call_grades_property_fill_' + stamp + '.json');
  fs.writeFileSync(backup, JSON.stringify(
    grades.map(g => ({ id: g.id, property_name: g.property_name })), null, 0));
  console.log('\nbackup: ' + backup + ' (' + grades.length + ' rows)');
  console.log('undo:   node scripts/restore-call-properties.js "' + backup + '"');

  // One update per property, not per row: the ids are grouped so 900 fills are
  // eight round trips.
  let done = 0;
  for (const [p, n] of Object.entries(byProperty)) {
    const ids = fill.filter(f => f.to === p).map(f => f.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await db.from('call_grades')
        .update({ property_name: p, property_source: CP.SOURCE.MATCH })
        .in('id', chunk).select('id');
      if (error) {
        console.log('FAILED ' + p + ': ' + error.message);
        if (/property_source/.test(error.message || '')) {
          console.log('   run supabase/migrations/092_call_grades_property_source.sql first.');
          return;
        }
        continue;
      }
      done += (data || []).length;
    }
    console.log('   ' + pad(p, 24) + n + ' rows');
  }
  console.log('\nfilled: ' + done + ' rows, marked ' + CP.SOURCE.MATCH);
  console.log('No call was re-graded: scores, rubrics and summaries are untouched.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
