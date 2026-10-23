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
  // Counted off the rent roll on 2026-10-12: 23, not the 30 Kara named. Kept
  // as what was MEASURED so a change is visible, with the disagreement
  // recorded rather than resolved by whoever edits this next.
  assert.strictEqual(r.expectedUnits, 23);
  assert.ok(/30/.test(r.expectedNote), 'the disagreement with Kara must stay written down');
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

// ---- the real Windy Hill, as the rent roll had it on 2026-10-12 ------------

const REAL = [];
for (let i = 1; i <= 22; i++) REAL.push(row('3' + String(i).padStart(2, '0'), 'Vacant-Unrented'));
REAL.push(row('399', 'Vacant-Rented'));                       // signed, in building 3
for (let i = 1; i <= 40; i++) REAL.push(row('1' + String(i).padStart(2, '0'), 'Current'));
for (let i = 1; i <= 8; i++) REAL.push(row('2' + String(i).padStart(2, '0'), 'Vacant-Unrented'));
REAL.push(row('299', 'Vacant-Rented'));

t('it reproduces the figures the probe printed on Render', () => {
  const r = EB.rentable(WH, REAL);
  assert.strictEqual(r.units, 72);
  assert.strictEqual(r.occupied, 40);
  assert.strictEqual((100 * r.occPct).toFixed(1), '55.6', 'the total must stay what Lyndsay reports');
  assert.strictEqual(r.excludedUnits, 23);
  assert.strictEqual(r.rentableUnits, 49);
  assert.strictEqual(r.rentableOccupied, 40);
  assert.strictEqual((100 * r.rentablePct).toFixed(1), '81.6');
});

t('a signed lease inside the excluded building is an ALARM, not a footnote', () => {
  // A lease on a unit in a building with no certificate of occupancy is a
  // unit that cannot legally be handed over on the move-in date.
  const r = EB.rentable(WH, REAL);
  assert.deepStrictEqual(r.preleasedExcluded, ['399']);
  assert.deepStrictEqual(r.occupiedExcluded, [], 'nobody is living there — that part was confirmed');
  const a = EB.alerts(r);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'alarm');
  assert.ok(/399/.test(a[0].text), 'the alert must name the unit');
  assert.ok(/cannot be handed over/.test(a[0].text));
});

t('a preleased unit OUTSIDE the building raises nothing', () => {
  // 299 is Vacant-Rented too and is perfectly normal. An alert that fired on
  // ordinary preleasing would be ignored within a week.
  const a = EB.alerts(EB.rentable(WH, REAL));
  assert.ok(!a.some(x => /299/.test(x.text)));
});

t('the count changing is a note, and the figure still moves with it', () => {
  // 23 is itself unconfirmed. If the building grows or shrinks, the rentable
  // number must follow the rent roll — and say that it did.
  const grown = REAL.concat([row('324', 'Vacant-Unrented')]);
  const r = EB.rentable(WH, grown);
  assert.strictEqual(r.excludedUnits, 24);
  assert.strictEqual(r.expectedUnits, 23);
  assert.strictEqual(r.countChanged, true);
  assert.strictEqual(r.rentableUnits, 49, 'the rest of the property is unchanged');
  const note = EB.alerts(r).find(x => x.severity === 'note');
  assert.ok(note && /24 units today against the 23/.test(note.text));
});

t('a count that matches raises nothing', () => {
  assert.strictEqual(EB.rentable(WH, REAL).countChanged, false);
  assert.ok(!EB.alerts(EB.rentable(WH, REAL)).some(a => a.severity === 'note'));
});

t('an occupied unit in the building outranks everything else', () => {
  const r = EB.rentable(WH, REAL.concat([row('305', 'Current')]));
  const a = EB.alerts(r);
  assert.strictEqual(a[0].severity, 'alarm');
  assert.ok(/occupied/.test(a[0].text), 'somebody living there must be the first thing said');
});

// ---- it reaches the report and the board ----------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');

t('the report carries it without touching a single card', () => {
  assert.ok(/\n      rentable,/.test(build), 'the report does not carry the rentable block');
  assert.ok(/\n      rentableAlerts,/.test(build), 'the alerts never leave the builder');
  // The cards are Lyndsay's and the totals are hers. Nothing here may write
  // into them.
  const kpiReport = require('../lib/kpi-report.js');
  assert.ok(!kpiReport.CARD_METRICS.some(m => /rentable/i.test(m)),
    'a rentable card would change the Summary every owner reads');
});

t('a missing rent roll is a named gap, never a zero', () => {
  assert.ok(/no rent-roll rows/.test(build),
    'a property with no rows must be reported, not silently skipped');
});

t('the Excel puts it under Occupancy and nowhere else', () => {
  const sheet = server.slice(server.indexOf('function kpiSummarySheet'),
    server.indexOf('function kpiBackupSheet'));
  assert.ok(/sec\.key === 'occupancy'/.test(sheet), 'it is not pinned to the Occupancy block');
  assert.ok(/Rentable Occupancy %/.test(sheet));
  assert.ok(/units excluded/.test(sheet), 'the sheet must say why the two numbers differ');
});

t('the PDF warns in red, so the printed page is not the quieter one', () => {
  const pdf = server.slice(server.indexOf('kpiReport.SECTIONS.forEach((sec, si) => {'),
    server.indexOf('no value for this week'));
  assert.ok(/Rentable Occupancy %/.test(pdf));
  assert.ok(/#b00020/.test(pdf), 'an alarm must be visible on paper');
});

t('the Goal Board total is not touched', () => {
  // Bounded by the NEXT route rather than by a character count: this handler
  // is 200 lines long and a fixed window silently stopped short of the totals
  // block, so the assertion below passed by not reaching what it was checking.
  const from = server.indexOf("app.get('/api/leasing/goal-board'");
  const rest = server.slice(from + 10);
  const next = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
  const route = server.slice(from, next < 0 ? server.length : from + 10 + next);
  assert.ok(/rentable: rentableBy\[name\] \|\| null/.test(route), 'the board never receives it');
  // totals is built by reducing `properties`; rentable must stay out of it.
  const at = route.indexOf('const totals = properties.reduce');
  assert.ok(at > 0, 'the totals block moved');
  assert.ok(!/rentable/.test(route.slice(at, at + 600)),
    'the portfolio total must keep matching her report');
});

t('the board shows it as its own row, under the property', () => {
  const fn = appjs.slice(appjs.indexOf('const rentableRow = p =>'),
    appjs.indexOf('const rowsHtml = props.map'));
  assert.ok(/rentablePct/.test(fn) && /rentableUnits/.test(fn));
  assert.ok(/esc\(a\.text\)/.test(fn), 'alert text reaches the page unescaped');
  assert.ok(/esc\(why\)/.test(fn), 'the reason reaches the page unescaped');
  // This pinned the literal #b91c1c. That hex is a light-theme red and measured
  // 2.91 on the dark card — the alarm was the hardest line on the board to read,
  // and the test was holding it there. What it means to assert is that the alarm
  // branch is coloured differently from the quiet one, so that is what it asks.
  assert.ok(fn.includes('color:var(--critical)'), 'an alarm must be visible on the board');
  assert.ok(fn.includes('color:var(--muted)'), 'a non-alarm note must stay quiet');
  assert.ok(/\+ rentableRow\(p\)/.test(appjs), 'the row is built but never appended');
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
