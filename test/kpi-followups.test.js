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

t('no goal is shown for follow ups', () => {
  // The formula is known and reproduces her 641 — but only with a preleased
  // count this week's workbook does not carry, so it is left out until that
  // is settled rather than shown as a target somebody is measured against.
  const labels = R.SECTIONS.flatMap(s => (s.cards || []).concat(s.funnel || []))
    .map(c => c.label);
  assert.ok(!labels.some(l => /follow ups goal|goal.*follow/i.test(l)),
    'a follow-ups goal is being displayed');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
