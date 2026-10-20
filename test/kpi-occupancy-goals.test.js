// The Occupancy Goals tab.
//
// Katie's workbook for week 2026-10-17 was refused with "nothing could be read
// from them" over a tab that was perfectly fine. The goals were formatted as
// percentages, the route reads every sheet with raw:false, so each cell
// arrived as the string "90%" — and this file's num() strips $ and commas but
// not %, so Number("90%") was NaN, which became 0, which was dropped as "not a
// goal", which emptied the sheet and rejected the whole upload.
//
// Three failures in one, and these guard all three:
//   * a number the reader cannot see is read as zero
//   * a property named the way a person writes it attaches to no column
//   * one unreadable row rejects the other six
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/kpi-workbook.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('occupancy goals');

// Katie's sheet, exactly as she sent it for week 2026-10-17.
const HER_SHEET = [
  ['Property', 'Goal'],
  ['Hyde Park Square', '90%'],
  ['Sunset Palms', '90%'],
  ['The Chateau', '95%'],
  ['The Highlander', '90%'],
  ['iConic at Round Rock', '92%'],
  ['iConic Downtown', '92%'],
  ['Windy Hill', '57.6%'],
  ['Ascent at Northgate', ''],
];

t('the week that was refused now reads', () => {
  const g = W.parseOccupancyGoals(HER_SHEET);
  assert.strictEqual(Object.keys(g).length, 7, 'got ' + JSON.stringify(g));
});

t('a percentage is read as the ratio it is', () => {
  // "90%" is 0.9. Stripping the sign and keeping 90 would be worse than
  // failing: a goal of 9000%.
  const g = W.parseOccupancyGoals(HER_SHEET);
  assert.strictEqual(g['Hyde Park Square'], 0.9);
  assert.strictEqual(g['The Chateau'], 0.95);
  assert.strictEqual(g['Windy Hill Apartment'], 0.576, 'and rounded, not 0.5760000000000001');
});

t('a plain ratio still reads the same', () => {
  // Both spellings reach this parser depending on how the cell is formatted,
  // and they have to agree.
  const g = W.parseOccupancyGoals([['Property', 'Goal'], ['The Chateau', '0.95']]);
  assert.strictEqual(g['The Chateau'], 0.95);
});

t('the properties are named the way the report names them', () => {
  // Her sheet says "iConic at Round Rock" and "Windy Hill"; the report's
  // columns are "iConic Round Rock" and "Windy Hill Apartment". Stored as
  // written, those two goals attach to no column and vanish without a word.
  const g = W.parseOccupancyGoals(HER_SHEET);
  assert.ok(g['iConic Round Rock'] !== undefined, 'iConic did not resolve');
  assert.ok(g['Windy Hill Apartment'] !== undefined, 'Windy Hill did not resolve');
  assert.ok(g['iConic at Round Rock'] === undefined, 'stored under the sheet spelling too');
  const R = require('../lib/kpi-report.js');
  const cols = R.columnOrder(Object.keys(g));
  Object.keys(g).forEach(p => assert.ok(cols.includes(p), p + ' is not a column'));
});

t('a property with no goal is a blank cell, not a rejected sheet', () => {
  // Ascent has none. That is the row that used to take the other six with it.
  const g = W.parseOccupancyGoals(HER_SHEET);
  assert.strictEqual(g['Ascent at Northgate'], undefined);
  assert.strictEqual(Object.keys(g).length, 7);
  const sk = g.__skipped.find(r => r.property === 'Ascent at Northgate');
  assert.ok(sk, 'it was dropped without a word');
  assert.match(sk.reason, /empty/);
});

t('every skipped row says which row and why', () => {
  const g = W.parseOccupancyGoals([
    ['Property', 'Goal'],
    ['Hyde Park Square', '90%'],
    ['Sunset Palms', '90'],
    ['The Chateau', 'abc'],
    ['The Highlander', '0'],
  ]);
  const by = {};
  g.__skipped.forEach(r => { by[r.property] = r; });
  assert.strictEqual(by['Sunset Palms'].row, 3, 'the row number is not the sheet’s own');
  assert.match(by['Sunset Palms'].reason, /more than 100%/);
  assert.match(by['The Chateau'].reason, /could not read "abc"/);
  assert.match(by['The Highlander'].reason, /is 0/);
  // And the one good row survived all three.
  assert.deepStrictEqual(Object.keys(g), ['Hyde Park Square']);
});

t('a bare number over 1 is reported, never quietly divided', () => {
  // 90 might be a percentage typed without its sign or a goal somebody
  // fat-fingered. Guessing makes the wrong one look right.
  const g = W.parseOccupancyGoals([['Property', 'Goal'], ['Sunset Palms', '90']]);
  assert.deepStrictEqual(Object.keys(g), []);
  assert.strictEqual(g.__skipped.length, 1);
});

t('__skipped does not count as a goal', () => {
  // The route decides "nothing could be read" from Object.keys().length, so a
  // visible __skipped would make an empty sheet look like one goal.
  const g = W.parseOccupancyGoals([['Property', 'Goal'], ['X', '']]);
  assert.deepStrictEqual(Object.keys(g), []);
  assert.ok(g.__skipped.length > 0, 'and it is still there to read');
});

t('the tab name is matched however it is capitalised', () => {
  // Hers is "occupancy goals", lower case.
  const m = W.matchSheets(['MTD Cash', 'MTD Accrual', 'occupancy goals']);
  assert.strictEqual(m.sheets.occupancy_goals, 'occupancy goals');
  assert.deepStrictEqual(m.missing, []);
});

// ---- the route ---------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('a refusal names the rows it could not read', () => {
  // "nothing could be read from them" sent somebody to open a tab that looked
  // perfectly fine.
  const at = server.indexOf("app.post('/api/kpi/workbook'");
  const body = server.slice(at, server.indexOf('// Compare with Katie', at));
  assert.match(body, /__skipped/);
  assert.match(body, /'row ' \+ r\.row/);
});

t('a success reports the rows it left out', () => {
  const at = server.indexOf("app.post('/api/kpi/workbook'");
  const body = server.slice(at, server.indexOf('// Compare with Katie', at));
  assert.match(body, /skipped: parsed\.occupancy_goals\.__skipped/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /Rows left out:/);
});

// ---- where the goals go ----------------------------------------------------------

t('occupancy goals are NOT reported as Follow Ups Completed', () => {
  // They were. A goal of 0.9 arrived on an owner's report labelled "Follow Ups
  // Completed: 0.9" — a number taken from a sheet about something else.
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  const at = build.indexOf('const map = {');
  const map = build.slice(at, build.indexOf('}[r.sheet]', at));
  assert.ok(!/occupancy_goals: 'followUps'/.test(map), 'goals are still filed as follow ups');
  assert.match(map, /occupancy_goals: 'occupancyGoal'/);
});

t('Follow Ups Completed has no source, and says so by having none', () => {
  // No sheet in the workbook carries it. Unavailable is the truth; a goal
  // wearing its label was not.
  const R = require('../lib/kpi-report.js');
  const card = R.SECTIONS.flatMap(s => (s.cards || []).concat(s.funnel || []))
    .find(c => c.metric === 'followUps');
  assert.ok(card, 'the card is gone');
  assert.strictEqual(card.source, 'workbook');
  const built = R.sectionsFor({}, { workbook: {}, overrides: {} });
  const got = built.flatMap(s => (s.cards || []).concat(s.funnel || []))
    .find(c => c.metric === 'followUps');
  assert.strictEqual(got.value, null, 'it came out as something other than empty');
});

t('a goal is never summed into the portfolio', () => {
  // Seven ratios added together is 6.1. occupancyGoal is deliberately absent
  // from the roll-up list for that reason.
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  const at = build.indexOf("rollUp(members.map(m => workbook[m])");
  const list = build.slice(at, build.indexOf(']', at));
  assert.ok(!/occupancyGoal/.test(list), 'goals are being summed across a portfolio');
});

// ---- the Occupancy Goal row ---------------------------------------------------

t('Occupancy Goal is a row in the Occupancy section, from the workbook', () => {
  const R = require('../lib/kpi-report.js');
  const occ = R.SECTIONS.find(s => s.key === 'occupancy');
  const card = occ.cards.find(c => c.metric === 'occupancyGoal');
  assert.ok(card, 'there is no Occupancy Goal row');
  assert.strictEqual(card.source, 'workbook');
  assert.strictEqual(card.percent, true, 'it would print as 0.9 instead of 90%');
  // Beside the occupancy it qualifies, not in some other section.
  const i = occ.cards.findIndex(c => c.metric === 'occupancyGoal');
  const j = occ.cards.findIndex(c => c.metric === 'occPct');
  assert.strictEqual(i, j + 1, 'it is not next to Occupancy %');
});

t('a property shows its goal; the portfolio shows none', () => {
  const R = require('../lib/kpi-report.js');
  const prop = R.sectionsFor({ units: 48, occupied: 45 },
    { workbook: { occupancyGoal: 0.9 }, overrides: {} });
  assert.strictEqual(prop[0].cards.find(c => c.metric === 'occupancyGoal').value, 0.9);

  // A portfolio goal would be a number nobody set: seven ratios summed is 6.1,
  // and a weighted one is an invention.
  const rolled = R.rollUp([{ units: 48, occupied: 45 }, { units: 30, occupied: 30 }],
    R.CARD_METRICS.concat(['units']));
  const port = R.sectionsFor(rolled, { workbook: {}, overrides: {} });
  assert.strictEqual(port[0].cards.find(c => c.metric === 'occupancyGoal').value, null,
    'the portfolio invented a goal');
});

t('the roll-up does not produce a workbook metric at all', () => {
  // Not merely unread: a 0 sitting in the portfolio's metrics under a real
  // metric name is one changed card away from being displayed.
  const R = require('../lib/kpi-report.js');
  const rolled = R.rollUp([{ units: 48 }], R.CARD_METRICS.concat(['units']));
  assert.ok(!Object.prototype.hasOwnProperty.call(rolled, 'occupancyGoal'));
  assert.ok(!Object.prototype.hasOwnProperty.call(rolled, 'mtdIncome'));
  assert.ok(Object.prototype.hasOwnProperty.call(rolled, 'units'), 'it dropped a real one');
});

// ---- two goal tables -------------------------------------------------------------

t('every disagreement with the Goal Board is listed, not just Windy Hill', () => {
  // Windy Hill is the one somebody noticed. Five of the seven differ, and a
  // note that mentioned one would make the other four look settled.
  const B = require('../lib/kpi-build.js');
  const d = B.occupancyGoalDiffs({
    'Hyde Park Square': { occupancyGoal: 0.9 },
    'Sunset Palms': { occupancyGoal: 0.9 },
    'The Chateau': { occupancyGoal: 0.95 },
    'The Highlander': { occupancyGoal: 0.9 },
    'iConic Round Rock': { occupancyGoal: 0.92 },
    'iConic Downtown': { occupancyGoal: 0.92 },
    'Windy Hill Apartment': { occupancyGoal: 0.576 },
    'Ascent at Northgate': {},
  });
  assert.deepStrictEqual(d.map(x => x.property),
    ['Hyde Park Square', 'Sunset Palms', 'The Chateau', 'The Highlander', 'Windy Hill Apartment']);
  const wh = d.find(x => x.property === 'Windy Hill Apartment');
  assert.strictEqual(wh.workbook, 57.6);
  assert.strictEqual(wh.dashboard, 90);
});

t('a goal that agrees is not reported as a difference', () => {
  const B = require('../lib/kpi-build.js');
  assert.deepStrictEqual(B.occupancyGoalDiffs({ 'iConic Downtown': { occupancyGoal: 0.92 } }), []);
  // And a property with no goal is not a disagreement either.
  assert.deepStrictEqual(B.occupancyGoalDiffs({ 'Ascent at Northgate': {} }), []);
});

t('the page says which table is which, and settles neither', () => {
  const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appjs, /TWO OCCUPANCY GOALS/);
  assert.match(appjs, /goalDiffs/);
  assert.match(appjs, /which table is right is Kara/);
});

t('the printed file stops guessing a percentage from its size', () => {
  // The Chateau is at 100% occupancy and its owner's PDF printed "1". The page
  // and the comparison panel were both fixed to read the card's own flag; the
  // file an owner keeps was still guessing.
  const at = server.indexOf('FORMATTED BY THE METRIC, NOT BY THE MAGNITUDE');
  assert.ok(at > 0, 'the PDF still guesses');
  const block = server.slice(at, at + 800);
  assert.match(block, /card\.percent \? \(f\.value \* 100\)/);
  assert.ok(!/Math\.abs\(f\.value\) < 1/.test(block), 'the magnitude guess is still there');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
