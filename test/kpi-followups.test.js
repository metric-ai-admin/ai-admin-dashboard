// Follow Ups Completed, and where it comes from.
//
// It had no source and showed empty. Arturo traced it to the workbook's
// `guest card inquiries` tab — columns "Follow Ups" and "Overdue Follow Ups",
// header on row 6 — and week 2026-10-17 sums to 377 follow-ups and 10 overdue,
// which is what Lyndsay's card shows.
//
// The numbers below are that week, per property, taken from her card. They are
// the point of this file: a parser that reads the right columns of the wrong
// sheet, or sums rows it should skip, produces a plausible total and nothing
// says otherwise.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/kpi-workbook.js');
const R = require('../lib/kpi-report.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('follow ups');

// Her sheet's shape: a five-row preamble, the header on row 6, the property
// carrying its address, and rows with no property at all.
const SHEET = [
  ['Audit: Guest Card Inquiries'], ['Exported On: 10/18/2026'],
  ['Date Range: 10/11/2026 - 10/17/2026'], ['Property Groups: All'], ['headerSize=5'],
  ['Property', 'Name', 'Touch Points', 'Follow Ups', 'Overdue Follow Ups'],
  ['Ascent at Northgate - 9315 Northgate Blvd Austin, TX 78758', 'x', '5', '91', '1'],
  ['Hyde Park Square - 4300 Ave A Austin, TX', 'x', '3', '51', '1'],
  ['Sunset Palms - 1 Palm Dr', 'x', '1', '6', '0'],
  ['The Chateau - 2 Chateau Ln', 'x', '1', '6', '1'],
  ['The Highlander - 803 Tirado Street Austin, TX 78752', 'x', '2', '24', '2'],
  ['Windy Hill - 4 Windy Rd', 'x', '9', '151', '3'],
  ['iConic Downtown - 5 Main St', 'x', '2', '14', '2'],
  ['iConic at Round Rock - 6 RR Blvd', 'x', '4', '34', '0'],
  ['', 'no property on this row', '1', '99', '9'],
  ['   ', 'nor this one', '1', '99', '9'],
];

t('week 10/17 sums to 377 follow ups and 10 overdue', () => {
  const g = W.parseGuestCardInquiries(SHEET);
  const total = k => Object.keys(g).reduce((n, p) => n + g[p][k], 0);
  assert.strictEqual(total('followUps'), 377);
  assert.strictEqual(total('overdue'), 10);
});

t('every property matches her card', () => {
  // A wrong total is obvious; a right total made of wrong properties is not.
  const g = W.parseGuestCardInquiries(SHEET);
  const want = {
    'Windy Hill Apartment': [151, 3], 'Ascent at Northgate': [91, 1],
    'Hyde Park Square': [51, 1], 'iConic Round Rock': [34, 0],
    'The Highlander': [24, 2], 'iConic Downtown': [14, 2],
    'Sunset Palms': [6, 0], 'The Chateau': [6, 1],
  };
  Object.keys(want).forEach(p => {
    assert.ok(g[p], p + ' is missing');
    assert.deepStrictEqual([g[p].followUps, g[p].overdue], want[p], p);
  });
  assert.strictEqual(Object.keys(g).length, 8, 'extra properties: ' + Object.keys(g).join(', '));
});

t('the address is cut off and the name resolved', () => {
  // "Windy Hill - 4 Windy Rd" has to land on "Windy Hill Apartment", the name
  // every other column uses, or the figure attaches to nothing.
  const g = W.parseGuestCardInquiries(SHEET);
  assert.ok(g['Windy Hill Apartment'], 'Windy Hill did not resolve');
  assert.ok(!g['Windy Hill'], 'it is also filed under the sheet spelling');
  assert.ok(g['iConic Round Rock'], 'iConic at Round Rock did not resolve');
  const cols = R.columnOrder(Object.keys(g));
  Object.keys(g).forEach(p => assert.ok(cols.includes(p), p + ' is not a column'));
});

t('rows with no property are skipped and counted', () => {
  // 23 of them in the real export. They contribute nothing, and "23 rows had
  // no property" is a fact about the export that silence would hide.
  const g = W.parseGuestCardInquiries(SHEET);
  assert.strictEqual(g.__stats.noProperty, 2);
  const total = Object.keys(g).reduce((n, p) => n + g[p].followUps, 0);
  assert.strictEqual(total, 377, 'the orphan rows were counted');
});

t('the header is found below the preamble, not assumed to be row 1', () => {
  const g = W.parseGuestCardInquiries(SHEET);
  assert.strictEqual(g.__stats.headerRow, 6);
});

t('the columns are found by name, never by position', () => {
  // The sheet is sixty columns wide — "Follow Ups" is BG this week. A column
  // number works until the export changes, and then it reports somebody
  // else's column as follow-ups.
  const moved = SHEET.map(r => r.slice());
  moved[5] = ['Property', 'Name', 'Touch Points', 'Overdue Follow Ups', 'Follow Ups'];
  moved.slice(6).forEach((r, i) => {
    if (r.length >= 5) { const tmp = moved[6 + i][3]; moved[6 + i][3] = moved[6 + i][4]; moved[6 + i][4] = tmp; }
  });
  const g = W.parseGuestCardInquiries(moved);
  const total = k => Object.keys(g).reduce((n, p) => n + g[p][k], 0);
  assert.strictEqual(total('followUps'), 377, 'it read the column by position');
  assert.strictEqual(total('overdue'), 10);
});

t('a sheet with no header produces nothing, not zeros', () => {
  const g = W.parseGuestCardInquiries([['something else'], ['a', 'b']]);
  assert.deepStrictEqual(Object.keys(g), []);
});

// ---- the tab is optional ---------------------------------------------------------

t('the tab is optional: a workbook without it still uploads', () => {
  // The three financial tabs are required — without them the Income Snapshot
  // has no source and a half-worked upload is worse than a refusal. This one
  // is new, so a workbook that predates it must not take the file down.
  const m = W.matchSheets(['MTD Cash', 'MTD Accrual', 'occupancy goals']);
  assert.deepStrictEqual(m.missing, [], 'it was made a required tab');
  assert.deepStrictEqual(m.optionalMissing, ['guest_card_inquiries']);
  const m2 = W.matchSheets(['MTD Cash', 'MTD Accrual', 'occupancy goals', 'guest card inquiries']);
  assert.strictEqual(m2.sheets.guest_card_inquiries, 'guest card inquiries');
  assert.deepStrictEqual(m2.optionalMissing, []);
});

// ---- through the report ------------------------------------------------------------

const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
const reshape = new Function(build.slice(build.indexOf('function kpiWorkbookByProperty'),
  build.indexOf('function kpiWorkbookStatus')) + '\nreturn kpiWorkbookByProperty;')();

t('both numbers reach the cards, marked as the workbook’s', () => {
  const g = W.parseGuestCardInquiries(SHEET);
  const wbk = reshape([{ sheet: 'guest_card_inquiries', data: g }]);
  const cards = R.sectionsFor({}, { workbook: wbk['The Highlander'], overrides: {} })
    .flatMap(s => (s.cards || []).concat(s.funnel || []));
  const fu = cards.find(c => c.metric === 'followUps');
  const od = cards.find(c => c.metric === 'overdueFollowUps');
  assert.ok(od, 'there is no Overdue Follow Ups row');
  assert.strictEqual(fu.value, 24);
  assert.strictEqual(od.value, 2);
  assert.strictEqual(fu.source, 'workbook', 'it would not carry the ·w mark');
  assert.strictEqual(od.source, 'workbook');
});

t('Overdue sits beside the number it qualifies', () => {
  const sec = R.SECTIONS.find(s => (s.cards || []).some(c => c.metric === 'followUps'));
  const i = sec.cards.findIndex(c => c.metric === 'followUps');
  const j = sec.cards.findIndex(c => c.metric === 'overdueFollowUps');
  assert.strictEqual(j, i + 1);
});

t('the portfolio totals 377 and 10', () => {
  // This is the number on her card, so it is the one that gets compared.
  const g = W.parseGuestCardInquiries(SHEET);
  const wbk = reshape([{ sheet: 'guest_card_inquiries', data: g }]);
  const real = Object.keys(wbk);
  const rolled = R.rollUp(real.map(p => wbk[p]), R.WORKBOOK_ROLLUP_METRICS);
  assert.strictEqual(rolled.followUps, 377);
  assert.strictEqual(rolled.overdueFollowUps, 10);
});

t('Greystone totals its four members', () => {
  const g = W.parseGuestCardInquiries(SHEET);
  const wbk = reshape([{ sheet: 'guest_card_inquiries', data: g }]);
  const members = R.groupMembers('Greystone', Object.keys(wbk));
  const rolled = R.rollUp(members.map(p => wbk[p]), R.WORKBOOK_ROLLUP_METRICS);
  // Hyde Park 51 + The Chateau 6 + Sunset Palms 6 + The Highlander 24
  assert.strictEqual(rolled.followUps, 87);
  assert.strictEqual(rolled.overdue === undefined ? rolled.overdueFollowUps : rolled.overdue, 4);
});

t('the group and the portfolio read one list', () => {
  // Two copies drift, and the half that drifts is the column nobody opens.
  assert.ok(R.WORKBOOK_ROLLUP_METRICS.includes('followUps'));
  assert.ok(R.WORKBOOK_ROLLUP_METRICS.includes('overdueFollowUps'));
  assert.ok(!R.WORKBOOK_ROLLUP_METRICS.includes('occupancyGoal'),
    'a ratio is being summed across properties');
  const uses = build.match(/WORKBOOK_ROLLUP_METRICS/g) || [];
  assert.ok(uses.length >= 2, 'only one column uses the shared list');
});

t('a week with no guest card tab reports nothing, not zero', () => {
  const rolled = R.rollUp([{}, {}], R.WORKBOOK_ROLLUP_METRICS);
  assert.strictEqual(rolled.followUps, null);
  assert.strictEqual(rolled.overdueFollowUps, null);
});

// ---- the goal is deliberately absent ------------------------------------------------

// ---- the goal -----------------------------------------------------------------------
//
// kpi_dashboard_17.html lines 1977-1991:
//   target = ceil(units x occupancy goal); needed = max(0, target - preleased);
//   leads  = needed / (0.25 x 0.75 x 0.75); goal = ceil(leads x 5)
//
// Week 2026-10-17 gives 677: The Highlander 534 and iConic Downtown 143, every
// other property already at its target. Her card reads 641 because it was
// produced from a snapshot with The Highlander one unit further ahead —
// 31 preleased, not 30 — which is a different reading of the week, not a
// different formula.

const CONV = 0.25 * 0.75 * 0.75;
const goalFor = (units, goalFrac, preleased) =>
  Math.ceil((Math.max(0, Math.ceil(units * goalFrac) - preleased) / CONV) * 5);

t('the formula reproduces her card to the unit', () => {
  // 31 preleased is the number her card was built on.
  assert.strictEqual(goalFor(49, 0.90, 31) + goalFor(19, 0.92, 14), 641);
  // 30 is what this week's workbook says.
  assert.strictEqual(goalFor(49, 0.90, 30) + goalFor(19, 0.92, 14), 677);
});

t('week 10/17 totals 677', () => {
  const week = [
    ['Hyde Park Square', 48, 0.90, 45], ['Sunset Palms', 36, 0.90, 33],
    ['The Chateau', 30, 0.95, 30], ['The Highlander', 49, 0.90, 30],
    ['Windy Hill Apartment', 72, 0.576, 43], ['iConic Downtown', 19, 0.92, 14],
    ['iConic Round Rock', 32, 0.92, 30],
  ];
  const total = week.reduce((n, [, u, g, p]) => n + goalFor(u, g, p), 0);
  assert.strictEqual(total, 677);
  // Only two properties are short of their target this week.
  const contributing = week.filter(([, u, g, p]) => goalFor(u, g, p) > 0).map(w => w[0]);
  assert.deepStrictEqual(contributing, ['The Highlander', 'iConic Downtown']);
});

t('a property already at its goal needs nothing, not a negative', () => {
  // The Chateau is at 100% against a 95% goal. Without the max(0, …) the
  // target would come out below zero and the portfolio would be reduced by a
  // property that is doing well.
  assert.strictEqual(goalFor(30, 0.95, 30), 0);
  assert.strictEqual(goalFor(72, 0.576, 43), 0);
});

t('the server computes it the same way, from one named constant', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  assert.match(build, /FOLLOW_UP_CONVERSION = 0\.25 \* 0\.75 \* 0\.75/);
  assert.match(build, /Math\.ceil\(m\.units \* goalFrac\) - \(m\.preleased \|\| 0\)/);
  assert.match(build, /Math\.ceil\(\(needed \/ FOLLOW_UP_CONVERSION\) \* 5\)/);
  assert.match(build, /Math\.max\(0,/);
});

t('a property with no occupancy goal shows blank, not 0', () => {
  // Ascent is that property: 111 units, the furthest from any target, and no
  // goal on file. A 0 there would read as "nothing needed".
  const cards = R.sectionsFor({ units: 111, preleased: 59 }, { workbook: {}, overrides: {} })
    .flatMap(s => (s.cards || []).concat(s.funnel || []));
  const card = cards.find(c => c.metric === 'followUpsGoal');
  assert.ok(card, 'there is no Follow Ups Goal row');
  assert.strictEqual(card.value, null);
});

const NO_GOAL = 'No occupancy goal in the workbook — Follow Ups Goal not calculated';

t('the blank cell says WHY, in its own words', () => {
  // The generic reason — "needs Katie's workbook for this week" — is wrong
  // here and actively misleading: the workbook is loaded, it simply has no
  // goal for this property, and re-uploading it changes nothing.
  const cards = R.sectionsFor({ units: 111, preleased: 59 },
    { workbook: {}, overrides: {}, reasons: { followUpsGoal: NO_GOAL } })
    .flatMap(s => (s.cards || []).concat(s.funnel || []));
  const card = cards.find(c => c.metric === 'followUpsGoal');
  assert.strictEqual(card.reason, NO_GOAL);
  // And the generic one still applies to the metrics that do need the file.
  const fu = cards.find(c => c.metric === 'followUps');
  assert.match(fu.reason, /needs Katie/);
});

t('the note is only raised when a workbook is actually loaded', () => {
  // With no workbook at all every property is missing a goal, and naming
  // eight of them is noise rather than information.
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  assert.match(build, /const wbLoaded = [\s\S]{0,180}r\.sheet === 'occupancy_goals'/);
  assert.match(build, /if \(wbLoaded\) \{/);
  assert.match(build, /goalNotes\.push\(\{ property: p, text: NO_GOAL \}\)/);
});

t('the note reaches the page, the Excel and the PDF', () => {
  // A caveat that lives only on the screen is the one that gets lost: the
  // file is what an owner keeps.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /NOT IN THE FOLLOW UPS GOAL/);
  assert.match(app, /krReport\.goalNotes/);

  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Once for the Excel and once for the PDF, both filtered by column.
  const hits = server.match(/report\.goalNotes \|\| \[\]\)\.filter\(n => scope\.mine\(n\.property\)\)/g) || [];
  assert.strictEqual(hits.length, 2, 'the note is in ' + hits.length + ' of the two exports');
});

t('the note follows the same scoping as every other row', () => {
  // Ascent's note belongs in Ascent's file and in the combined one, and
  // nowhere else — the same rule that keeps Windy Hill out of Greystone's.
  const XL = require('xlsx');
  const WEEK = require('../lib/week.js');
  const mk = (units, prel, wbk, reasons) => R.sectionsFor(
    { units, preleased: prel, occupied: prel },
    { workbook: wbk || {}, overrides: {}, reasons: reasons || null });
  const report = {
    week_ending: '2026-10-17', range: { from: '2026-10-11', to: '2026-10-17' },
    columns: ['Ascent at Northgate', 'The Highlander', 'Portfolio'],
    properties: {
      'Ascent at Northgate': mk(111, 59, { followUps: 91 }, { followUpsGoal: NO_GOAL }),
      'The Highlander': mk(49, 30, { followUps: 24, followUpsGoal: 534 }),
    },
    portfolio: mk(160, 89, { followUps: 115, followUpsGoal: 534 }),
    rentable: {}, rentableAlerts: [],
    goalNotes: [{ property: 'Ascent at Northgate', text: NO_GOAL }],
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.slice(src.indexOf('// WHOSE ROWS BELONG IN THIS FILE.'),
    src.indexOf('function kpiPdf(')) + '\nreturn { kpiSummarySheet };';
  const M = new Function('XLSX', 'kpiReport', 'WEEK', 'report', code)(XL, R, WEEK, report);
  const text = cols => XL.utils.sheet_to_json(M.kpiSummarySheet(report, cols),
    { header: 1, raw: true, defval: '' }).map(r => r.join(' ')).join('\n');

  assert.match(text(['Ascent at Northgate']), /No occupancy goal in the workbook/);
  assert.match(text(report.columns), /No occupancy goal in the workbook/);
  assert.ok(!/No occupancy goal/.test(text(['The Highlander'])),
    'another property’s note is in The Highlander’s file');
});

t('the goal is a row beside the two it is read against', () => {
  const sec = R.SECTIONS.find(s => (s.cards || []).some(c => c.metric === 'followUps'));
  const order = sec.cards.map(c => c.metric);
  const i = order.indexOf('followUps');
  assert.deepStrictEqual(order.slice(i, i + 3),
    ['followUps', 'overdueFollowUps', 'followUpsGoal']);
});

t('the portfolio sums the per-property goals, never recomputes from totals', () => {
  // A goal computed from portfolio units and portfolio preleased is a
  // different number: 397 units at a blended goal is not the sum of eight
  // properties each measured against its own.
  assert.ok(R.WORKBOOK_ROLLUP_METRICS.includes('followUpsGoal'));
  const rolled = R.rollUp(
    [{ followUpsGoal: 534 }, { followUpsGoal: 143 }, { followUpsGoal: 0 }],
    R.WORKBOOK_ROLLUP_METRICS);
  assert.strictEqual(rolled.followUpsGoal, 677);
});

t('a week with no occupancy goals at all gives no goal, not 0', () => {
  const rolled = R.rollUp([{ followUps: 10 }, { followUps: 5 }], R.WORKBOOK_ROLLUP_METRICS);
  assert.strictEqual(rolled.followUps, 15);
  assert.strictEqual(rolled.followUpsGoal, null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
