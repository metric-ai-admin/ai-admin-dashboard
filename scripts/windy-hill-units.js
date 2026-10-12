#!/usr/bin/env node
//
// Windy Hill's units, by building. READ ONLY — nothing is written anywhere.
//
//   node scripts/windy-hill-units.js
//   node scripts/windy-hill-units.js --property "Windy Hill Apartment" --prefix 3
//
// WHY. Kara, 2026-10-12: "all the units that start with 3 are that building",
// and it has no certificate of occupancy, so those units cannot be rented.
// Reporting Windy Hill's occupancy against all 72 units counts 30 units nobody
// is allowed to lease as vacancy, which reads as a leasing failure.
//
// Before anything is built on that rule, two things have to be true and only
// the rent roll can say so: that the units starting with 3 really are 30, and
// that NONE of them is occupied. An occupied unit in a building with no
// certificate is not a reporting question — it is something somebody needs to
// know about today, which is why this script says so loudly rather than
// quietly subtracting it.
//
// Reads the rent_roll store, which lives on the Render disk. On a laptop with
// no store it says so instead of printing an empty inventory.
require('dotenv').config();

const EB = require('../lib/excluded-buildings.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const PROPERTY = arg('property', EB.RULES.length ? EB.RULES[0].property : 'Windy Hill Apartment');
const PREFIX = arg('prefix', EB.RULES.length ? EB.RULES[0].prefix : '3');

const clean = s => String(s == null ? '' : s).trim();

(async () => {
  let rows;
  try {
    const data = await require('../appfolio-reports.js').readReportData('rent_roll');
    rows = (data && data.rows) || null;
    if (!rows) {
      console.error('No rent_roll store on this machine. Run this on Render, or sync it first:');
      console.error("  node -e \"require('./appfolio-reports.js').syncReport('rent_roll').then(r=>console.log(r))\"");
      process.exit(2);
    }
    console.log('rent_roll: ' + rows.length + ' rows, fetched ' + (data.fetchedAt || '(unknown)'));
  } catch (e) { console.error('Could not read rent_roll: ' + e.message); process.exit(1); }

  const mine = rows.filter(r => clean(r.property_name).toLowerCase() === PROPERTY.toLowerCase());
  console.log('\n' + PROPERTY + ': ' + mine.length + ' rent-roll rows');
  if (!mine.length) {
    const names = [...new Set(rows.map(r => clean(r.property_name)).filter(Boolean))].sort();
    console.error('No rows for that property. Names in the report:\n   ' + names.join('\n   '));
    process.exit(2);
  }

  // One row per LEASE, so a unit with a past and a current lease appears twice.
  // Counting rows instead of units would inflate the building.
  const byUnit = new Map();
  mine.forEach(r => {
    const u = clean(r.unit);
    if (!u) return;
    if (!byUnit.has(u)) byUnit.set(u, []);
    byUnit.get(u).push(r);
  });

  const units = [...byUnit.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const inBuilding = units.filter(u => EB.matchesPrefix(u, PREFIX));
  const rest = units.filter(u => !EB.matchesPrefix(u, PREFIX));

  const stateOf = u => {
    // The unit's own state, as rent_roll reports it: Current, Notice-Rented,
    // Notice-Unrented, Vacant-Rented, Vacant-Unrented.
    const s = byUnit.get(u).map(r => clean(r.status)).filter(Boolean);
    return [...new Set(s)].join(' / ') || '(no status)';
  };
  const occupied = u => byUnit.get(u).some(r => EB.looksOccupied(r.status));

  const tally = list => {
    const t = {};
    list.forEach(u => { const s = stateOf(u); t[s] = (t[s] || 0) + 1; });
    return Object.entries(t).sort((a, b) => b[1] - a[1]);
  };

  console.log('\ndistinct units: ' + units.length);
  console.log('  starting with "' + PREFIX + '": ' + inBuilding.length);
  console.log('  everything else           : ' + rest.length);

  console.log('\nBUILDING ' + PREFIX + ' — ' + inBuilding.length + ' units');
  tally(inBuilding).forEach(([s, n]) => console.log('   ' + String(n).padStart(3) + '  ' + s));
  console.log('   units: ' + inBuilding.join(', '));

  console.log('\nTHE REST — ' + rest.length + ' units');
  tally(rest).forEach(([s, n]) => console.log('   ' + String(n).padStart(3) + '  ' + s));

  // ---- the two things that have to be true --------------------------------

  console.log('\n--- what Kara said, checked ---');
  const EXPECTED = Number(arg('expect', 30));
  console.log('  units starting with "' + PREFIX + '" = ' + inBuilding.length
    + (inBuilding.length === EXPECTED ? '   matches the ' + EXPECTED + ' she named'
      : '   SHE SAID ' + EXPECTED + ' — this does not match'));

  const live = inBuilding.filter(occupied);
  if (!live.length) {
    console.log('  none of them is occupied   as expected for a building with no certificate');
  } else {
    console.log('\n  *** ' + live.length + ' UNIT' + (live.length === 1 ? '' : 'S')
      + ' IN BUILDING ' + PREFIX + ' READ AS OCCUPIED ***');
    live.forEach(u => {
      byUnit.get(u).forEach(r => console.log('      unit ' + u + '  status ' + clean(r.status)
        + '  tenant ' + (clean(r.tenant) || '—') + '  lease to ' + (clean(r.lease_to) || '—')));
    });
    console.log('\n  Do not subtract this building from occupancy until somebody explains these.');
    console.log('  Either the rule is not "starts with ' + PREFIX + '", or somebody is living in');
    console.log('  a building with no certificate of occupancy. Both need a person, not a patch.');
  }

  // What the two occupancy figures would be. Printed, not stored.
  const occAll = units.filter(occupied).length;
  const occRest = rest.filter(occupied).length;
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
  console.log('\n--- the two figures this would produce ---');
  console.log('  total occupancy      ' + occAll + '/' + units.length + '  ' + pct(occAll, units.length)
    + '   (unchanged, matches Lyndsay)');
  console.log('  rentable occupancy   ' + occRest + '/' + rest.length + '  ' + pct(occRest, rest.length)
    + '   (excluding building ' + PREFIX + ')');
  console.log('\nNothing was written. This script only reads.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
