#!/usr/bin/env node
//
// The signed-but-empty units at Windy Hill, and which building they are in.
// READ ONLY — nothing is written anywhere.
//
//   node scripts/windy-hill-prelease.js
//
// WHY. The 2026-10-12 inventory found building 3 — the one with no
// certificate of occupancy — holding one unit at Vacant-Rented: a signed lease
// on a unit that cannot legally be handed over. That is not a reporting
// question. This prints which unit, when the lease starts and when the move-in
// is set for, so somebody can go and look at it today.
//
// NO RESIDENT NAMES. The question is which unit and which dates; the name adds
// nothing to it and this output gets pasted into chats. Every field that could
// carry a person is dropped, by name and by pattern, rather than selected
// around — a report that gains a column should not start leaking one.
require('dotenv').config();

const EB = require('../lib/excluded-buildings.js');
const { createClient } = require('@supabase/supabase-js');

const PROPERTY = 'Windy Hill Apartment';
const clean = s => String(s == null ? '' : s).trim();

// Dropped from every printed row. Matched on the FIELD NAME, so a column we
// have never seen that is called "co_tenant" or "applicant_name" is dropped
// too — the default has to be "do not print" for this to be worth anything.
const PERSONAL = /tenant|resident|applicant|occupant|name|email|phone|contact|guarantor/i;
const SAFE = r => Object.fromEntries(
  Object.entries(r).filter(([k, v]) => !PERSONAL.test(k) && v !== '' && v != null));

(async () => {
  let rows;
  try {
    const data = await require('../appfolio-reports.js').readReportData('rent_roll');
    rows = (data && data.rows) || null;
    if (!rows) {
      console.error('No rent_roll store on this machine — run this on Render.');
      process.exit(2);
    }
    console.log('rent_roll: ' + rows.length + ' rows, fetched ' + (data.fetchedAt || '(unknown)'));
  } catch (e) { console.error('Could not read rent_roll: ' + e.message); process.exit(1); }

  const mine = rows.filter(r => clean(r.property_name).toLowerCase() === PROPERTY.toLowerCase());
  const preleased = mine.filter(r => /^vacant-rented/i.test(clean(r.status)));

  console.log('\n' + PROPERTY + ': ' + mine.length + ' rows, '
    + preleased.length + ' at Vacant-Rented (signed, nobody in yet)');

  if (!preleased.length) {
    console.log('Nothing is preleased right now. Whatever was here has moved in or fallen through.');
    return;
  }

  preleased
    .sort((a, b) => clean(a.unit).localeCompare(clean(b.unit), undefined, { numeric: true }))
    .forEach(r => {
      const unit = clean(r.unit);
      const inBuilding = EB.isExcludedUnit(PROPERTY, unit);
      console.log('\n' + '='.repeat(66));
      console.log('UNIT ' + unit + (inBuilding
        ? '   *** BUILDING 3 — NO CERTIFICATE OF OCCUPANCY ***'
        : '   (not building 3)'));
      // Every remaining field, rather than four hand-picked ones: the exact
      // spelling of the date columns differs between AppFolio reports and a
      // guess that misses would print "—" for the one fact being asked for.
      Object.entries(SAFE(r)).forEach(([k, v]) => console.log('   ' + k.padEnd(26) + String(v)));
    });

  // ---- cross-reference against lease_history ------------------------------
  // The only Windy Hill lease with a future move-in on 2026-10-12 was one set
  // for 10/16, carrying the status "Status Cannot Be Determined". Whether that
  // is this unit is the question; lease_history has no unit column, so the
  // match is on dates and has to be read as a match, not proved by one.
  if (!process.env.SUPABASE_URL) {
    console.log('\n(no Supabase config here — skipping the lease_history cross-reference)');
    return;
  }
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });
  const { data: lh, error } = await db.from('leasing_lease_history')
    .select('property_name,move_in_date,move_out_date,status,renewal')
    .ilike('property_name', '%Windy Hill%');
  if (error) { console.log('\nlease_history unavailable: ' + error.message); return; }

  const today = new Date().toISOString().slice(0, 10);
  const future = (lh || []).filter(r => r.move_in_date && r.move_in_date >= today);
  console.log('\n' + '='.repeat(66));
  console.log('lease_history — Windy Hill leases with a move-in from ' + today + ' on: ' + future.length);
  future.sort((a, b) => String(a.move_in_date).localeCompare(String(b.move_in_date)))
    .forEach(r => console.log('   move_in ' + r.move_in_date
      + '   status ' + clean(r.status) + '   renewal ' + clean(r.renewal)));
  console.log('\nlease_history carries no unit number, so this is matched on dates only.');
  console.log('If exactly one lease and one preleased unit line up, that is the one —');
  console.log('but AppFolio is where it gets confirmed, not here.');
  console.log('\nNothing was written. This script only reads.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
