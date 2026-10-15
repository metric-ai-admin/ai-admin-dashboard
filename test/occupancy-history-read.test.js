// Reading the occupancy history: excluded properties out, stored rows intact.
//
// Arturo, 2026-10-15: leasing_occupancy_history holds one row per property per
// week, and the two captured weeks include The Sidney at 29/40 — a property
// Metric stopped managing on 2026-10-07. Do not rewrite the rows; filter on
// the way OUT, so 334/478 reads as 279/398 without putting a different number
// under a date that has already been reported.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EX = require('../lib/excluded-properties.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('occupancy history, read side');

// The real shape, taken from the two stored weeks on 2026-10-15.
const WEEK_ROWS = [
  ['The Sidney', 40, 29], ['Brazos Lofts', 29, 25], ['Lily Pad Lane', 1, 1],
  ['513 Wolf Ridge Georgetown, TX 78628', 1, 0], ['Live With Metric', 9, 0],
  ['Ascent at Northgate', 111, 58], ['Hyde Park Square', 48, 45],
  ['iConic Downtown', 19, 14], ['iConic Round Rock', 32, 29],
  ['Sunset Palms', 36, 33], ['The Chateau', 30, 30], ['The Highlander', 49, 29],
  ['Windy Hill Apartment', 72, 41], ['Cedar and Sage', 1, 0],
];
const rowsFor = (as_of, source_as_of) => WEEK_ROWS.map(([property_name, total_units, occupied_units]) =>
  ({ as_of, property_name, total_units, occupied_units, source_as_of }));
const STORED = rowsFor('2026-10-03', '2026-10-02').concat(rowsFor('2026-10-10', '2026-10-02'));

t('the stored total is the one we are correcting', () => {
  // Without the filter: 334/478, 69.87%. This pins what the problem was.
  const all = rowsFor('2026-10-03', '2026-10-02');
  const units = all.reduce((a, r) => a + r.total_units, 0);
  const occ = all.reduce((a, r) => a + r.occupied_units, 0);
  assert.strictEqual(units, 478);
  assert.strictEqual(occ, 334);
});

t('read through the filter it is 279/398', () => {
  const p = EX.portfolio(rowsFor('2026-10-03', '2026-10-02'));
  assert.strictEqual(p.occupied, 279);
  assert.strictEqual(p.units, 398);
  assert.strictEqual(p.excluded, 5);
  assert.strictEqual((p.pct * 100).toFixed(2), '70.10');
});

t('all five excluded properties are caught, including the address-shaped one', () => {
  // "513 Wolf Ridge Georgetown, TX 78628" is how AppFolio spells it in
  // leasing_occupancy. An equality test would miss it.
  ['The Sidney', 'Brazos Lofts', 'Lily Pad Lane', 'Live With Metric',
    '513 Wolf Ridge Georgetown, TX 78628'].forEach(n =>
    assert.ok(EX.propertyIsExcluded(n), n));
  ['Ascent at Northgate', 'Cedar and Sage', 'The Chateau'].forEach(n =>
    assert.ok(!EX.propertyIsExcluded(n), n));
});

t('nothing is rewritten — the helper only reads', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'excluded-properties.js'), 'utf8');
  assert.ok(!/\.update\(|\.upsert\(|\.delete\(|\.insert\(/.test(src));
});

t('the portfolio is sum over sum, not the mean of the percentages', () => {
  // The mean would weight a 1-unit property like a 111-unit one.
  const p = EX.portfolio([
    { property_name: 'A', total_units: 100, occupied_units: 50 },
    { property_name: 'B', total_units: 2, occupied_units: 2 },
  ]);
  assert.ok(Math.abs(p.pct - 52 / 102) < 1e-9);
  const mean = (0.5 + 1) / 2;
  assert.ok(Math.abs(p.pct - mean) > 1e-6);
});

t('week over week is newest first and filtered per week', () => {
  const ws = EX.weeks(STORED);
  assert.deepStrictEqual(ws.map(w => w.as_of), ['2026-10-10', '2026-10-03']);
  ws.forEach(w => {
    assert.strictEqual(w.occupied, 279);
    assert.strictEqual(w.units, 398);
    assert.strictEqual(w.excluded, 5);
  });
});

t('a week copied from older data SAYS so', () => {
  // Both stored weeks carry source_as_of 2026-10-02: the snapshot copied
  // leasing_occupancy, and until the 05:00 Sunday sync existed it copied
  // whatever was last there. Two weeks of identical occupancy is a sync gap,
  // not a fact about the portfolio, and a comparison that does not say so is
  // reporting the gap as flat performance.
  const ws = EX.weeks(STORED);
  ws.forEach(w => {
    assert.deepStrictEqual(w.sourceAsOf, ['2026-10-02']);
    assert.strictEqual(w.copiedFromEarlier, true);
  });
});

t('a week captured from its own day is not flagged', () => {
  const ws = EX.weeks(rowsFor('2026-10-17', '2026-10-17'));
  assert.strictEqual(ws[0].copiedFromEarlier, false);
});

t('a week with no source recorded is not claimed to be copied', () => {
  // Absent is not the same as earlier, and guessing would put a warning on a
  // week nobody can check.
  const ws = EX.weeks(rowsFor('2026-10-17', null));
  assert.deepStrictEqual(ws[0].sourceAsOf, []);
  assert.strictEqual(ws[0].copiedFromEarlier, false);
});

// ---- the write side, going forward ------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('both snapshots stop archiving excluded properties', () => {
  // Every leasing VIEW filtered this list already. Snapshots write HISTORY and
  // were copying their source unfiltered — the occupancy one and the unit
  // vacancy one both.
  const occ = server.slice(server.indexOf('EXCLUDED PROPERTIES ARE NOT ARCHIVED'),
    server.indexOf('let { error: wErr }'));
  assert.match(occ, /!propertyIsExcluded\(r\.property_name\)/);

  const uv = server.slice(server.indexOf('async function captureUnitVacancySnapshot'));
  const body = uv.slice(0, uv.indexOf('.upsert('));
  assert.match(body, /if \(propertyIsExcluded\(property\)\) continue;/,
    'the unit vacancy snapshot had the same gap');
});

t('the maintenance script reports the portfolio through the filter', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'mark-occupancy-history.js'), 'utf8');
  assert.match(src, /EXCLUDED\.liveRows\(list\)/);
  assert.match(src, /not counted/, 'and names what it left out');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
