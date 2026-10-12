// Windy Hill's building 3, which has no certificate of occupancy.
//
// Kara, 2026-10-12. Counting its 30 units as vacancy makes a property that
// cannot lease them look like a property that is failing to.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EB = require('../lib/excluded-buildings.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const WH = 'Windy Hill Apartment';
// A rent roll shaped like the real one: one row per lease, so a unit that has
// turned appears twice.
const row = (unit, status, extra) => Object.assign({ unit, status, property_name: WH }, extra || {});

console.log('excluded buildings');

// ---- the rule -------------------------------------------------------------

t('the rule lives in exactly one place', () => {
  assert.strictEqual(EB.RULES.length, 1);
  const r = EB.RULES[0];
  assert.strictEqual(r.property, WH);
  assert.strictEqual(r.prefix, '3');
  assert.ok(r.reason && r.since, 'a temporary rule must say why and since when');
});

t('only Windy Hill is affected', () => {
  assert.deepStrictEqual(EB.rulesFor('Sunset Palms'), []);
  assert.strictEqual(EB.isExcludedUnit('Sunset Palms', '301'), false,
    'another property with a 301 must not lose it');
  assert.strictEqual(EB.isExcludedUnit(WH, '301'), true);
});

t('the property name is matched regardless of case and space', () => {
  assert.strictEqual(EB.rulesFor('  windy hill apartment ').length, 1);
});

t('the prefix is text, not a number', () => {
  // "3" and "300" are both building 3; a numeric compare would make them
  // different questions and would drop "3A" entirely.
  ['3', '30', '301', '3-104', '3A'].forEach(u =>
    assert.strictEqual(EB.matchesPrefix(u, '3'), true, u + ' should be in building 3'));
  ['112', '233', '213', ''].forEach(u =>
    assert.strictEqual(EB.matchesPrefix(u, '3'), false, u + ' should not be'));
});

t('a unit with a 3 somewhere else is not in building 3', () => {
  // THE ONE THAT WOULD BITE. Windy Hill really has 131, 132, 134, 136, 137,
  // 138, 233, 234, 235 — nine units with a 3 in them that belong to buildings
  // 1 and 2. A substring match would move them and make the exclusion wrong by
  // nine units.
  ['131', '132', '134', '136', '137', '138', '233', '234', '235'].forEach(u =>
    assert.strictEqual(EB.isExcludedUnit(WH, u), false, u + ' was moved into building 3'));
});

// ---- occupied vs vacant ---------------------------------------------------

t('a unit on notice is still occupied', () => {
  // The resident has not left. This is the same rule the occupancy report
  // uses, and it is why the two figures reconcile.
  ['Current', 'Notice-Rented', 'Notice-Unrented', 'Occupied'].forEach(s =>
    assert.strictEqual(EB.looksOccupied(s), true, s + ' should count as occupied'));
  ['Vacant-Rented', 'Vacant-Unrented', 'vacant', '', null].forEach(s =>
    assert.strictEqual(EB.looksOccupied(s), false, String(s) + ' should not'));
});

// ---- the two figures ------------------------------------------------------

const rentRoll = []
  .concat(['112', '117', '122', '125', '126', '131', '132', '134'].map(u => row(u, 'Current')))
  .concat(['136', '137'].map(u => row(u, 'Notice-Unrented')))
  .concat(['138', '211'].map(u => row(u, 'Vacant-Unrented')))
  .concat(['301', '302', '303', '304'].map(u => row(u, 'Vacant-Unrented')));

t('the total is unchanged and the rentable figure is additional', () => {
  const r = EB.rentable(WH, rentRoll);
  assert.strictEqual(r.units, 16);
  assert.strictEqual(r.occupied, 10);
  assert.strictEqual(r.occPct, 10 / 16, 'the total must be what it always was');
  assert.strictEqual(r.excludedUnits, 4);
  assert.strictEqual(r.rentableUnits, 12);
  assert.strictEqual(r.rentableOccupied, 10);
  assert.strictEqual(r.rentablePct, 10 / 12);
  assert.ok(r.rentablePct > r.occPct, 'excluding unlettable units must raise the figure');
});

t('one row per lease, so a turned unit is not counted twice', () => {
  const withHistory = rentRoll.concat([row('112', 'Vacant-Unrented'), row('301', 'Current')]);
  const r = EB.rentable(WH, withHistory);
  assert.strictEqual(r.units, 16, 'a second lease on a known unit added a unit');
  assert.strictEqual(r.excludedUnits, 4);
});

t('an occupied unit inside the excluded building is named, never subtracted quietly', () => {
  // THE ONE THAT MATTERS. Somebody living in a building with no certificate of
  // occupancy is not a reporting question. Dropping it from the denominator
  // would hide it in the one number a regional manager reads every week.
  const r = EB.rentable(WH, rentRoll.concat([row('305', 'Current', { tenant: 'A. Resident' })]));
  assert.deepStrictEqual(r.occupiedExcluded, ['305']);
  assert.strictEqual(r.occupied, 11, 'it still counts in the total — somebody lives there');
  assert.strictEqual(r.rentableOccupied, 10, 'but not in the rentable figure');
});

t('units are named in a human order', () => {
  const r = EB.rentable(WH, [row('310', 'Current'), row('32', 'Current'), row('3', 'Current')]);
  assert.deepStrictEqual(r.occupiedExcluded, ['3', '32', '310'], 'sorted as strings, not as numbers');
});

t('no rows is null, not "nothing is excluded"', () => {
  // "We could not work this out" and "there is no building 3" are different
  // statements, and only one of them is safe to print beside an occupancy
  // figure on an owner's report.
  assert.strictEqual(EB.rentable(WH, []), null);
  assert.strictEqual(EB.rentable(WH, null), null);
  assert.strictEqual(EB.rentable(WH, [{ unit: '', status: 'Current' }]), null,
    'rows with no unit number cannot answer this');
});

t('a property with no rule gets the same number twice, not an error', () => {
  const r = EB.rentable('Sunset Palms', [row('101', 'Current'), row('301', 'Vacant-Unrented')]);
  assert.strictEqual(r.excludedUnits, 0);
  assert.strictEqual(r.rentableUnits, r.units);
  assert.strictEqual(r.rentablePct, r.occPct);
  assert.deepStrictEqual(r.rules, []);
});

t('a property where everything is excluded has no rentable occupancy, not 0%', () => {
  const r = EB.rentable(WH, [row('301', 'Vacant-Unrented'), row('302', 'Vacant-Unrented')]);
  assert.strictEqual(r.rentableUnits, 0);
  assert.strictEqual(r.rentablePct, null, '0% would read as total failure');
});

t('the caller can say where unit and status live', () => {
  const r = EB.rentable(WH, [{ u: '301', s: 'Current' }, { u: '112', s: 'Current' }],
    { unit: x => x.u, status: x => x.s });
  assert.strictEqual(r.units, 2);
  assert.strictEqual(r.excludedUnits, 1);
});

// ---- the probe ------------------------------------------------------------

t('the probe reads and never writes', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'windy-hill-units.js'), 'utf8');
  // Printed lines stripped first: the probe TELLS the reader how to sync the
  // store when it is missing, and that help text is not a call. Without this
  // the test fails on the script's own instructions, which is the test being
  // wrong rather than the script.
  const code = s.split('\n').filter(l => !/^\s*console\.(log|error|warn)\(/.test(l)).join('\n');
  assert.ok(!/\.upsert\(|\.insert\(|\.update\(|\.delete\(|syncReport\(/.test(code),
    'the probe must not write anything');
  assert.ok(/readReportData\('rent_roll'\)/.test(s));
  assert.ok(/No rent_roll store on this machine/.test(s),
    'a missing store must be said, not printed as an empty inventory');
  assert.ok(/READ AS OCCUPIED/.test(s),
    'an occupied unit in the excluded building must be shouted about');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
