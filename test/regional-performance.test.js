// Tests for the Regional Performance aggregation.
// Run: node test/regional-performance.test.js

const assert = require('assert');
const R = require('../regional-performance.js');

const EXCLUDED = ['lily pad', 'wolf ridge', 'sidney', 'brazos', 'live with metric'];
const isExcludedProperty = n => EXCLUDED.some(f => String(n || '').toLowerCase().includes(f));
const TODAY = '2026-09-23';

const build = (src, extra) => R.buildRegionalPerformance(src, { today: TODAY, isExcludedProperty, ...extra });
const card = (r, name) => r.cards.find(c => c.property === name);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

console.log('\nVacancy');
t('counts Vacant-Unrented and sums their asking rent', () => {
  const r = build({ vacancy: [
    { property_name: 'Ascent', unit_status: 'Vacant-Unrented', advertised_rent: '1200.00' },
    { property_name: 'Ascent', unit_status: 'Vacant-Unrented', advertised_rent: '950.00' },
  ] });
  assert.strictEqual(card(r, 'Ascent').vacantUnits, 2);
  assert.strictEqual(card(r, 'Ascent').vacancyMonthly, 2150);
});
t('Vacant-Rented is NOT lost income', () => {
  // Already committed to a new resident.
  const r = build({ vacancy: [{ property_name: 'Ascent', unit_status: 'Vacant-Rented', advertised_rent: '1200' }] });
  assert.strictEqual(card(r, 'Ascent').vacantUnits, 0);
  assert.strictEqual(card(r, 'Ascent').vacancyMonthly, 0);
});
t('Notice-Unrented is tracked separately, not as vacant', () => {
  const r = build({ vacancy: [{ property_name: 'Ascent', unit_status: 'Notice-Unrented', advertised_rent: '1200' }] });
  assert.strictEqual(card(r, 'Ascent').vacantUnits, 0);
  assert.strictEqual(card(r, 'Ascent').onNotice, 1);
});
t('falls back through the rent columns', () => {
  const r = build({ vacancy: [
    { property_name: 'A', unit_status: 'Vacant-Unrented', advertised_rent: '', schd_rent: '800' },
    { property_name: 'A', unit_status: 'Vacant-Unrented', advertised_rent: '', schd_rent: '', computed_market_rent: '700' },
  ] });
  assert.strictEqual(card(r, 'A').vacancyMonthly, 1500);
});
t('occupancy is reported as unavailable, not guessed', () => {
  assert.strictEqual(build({}).occupancyAvailable, false);
});

console.log('\nDelinquency');
t('totals, counts and the highest single balance', () => {
  const r = build({ delinquency: [
    { property_name: 'Ascent', delinquent_rent: '900' },
    { property_name: 'Ascent', delinquent_rent: '2400' },
    { property_name: 'Ascent', delinquent_rent: '150' },
  ] });
  const c = card(r, 'Ascent');
  assert.strictEqual(c.delinquentBalance, 3450);
  assert.strictEqual(c.delinquentAccounts, 3);
  assert.strictEqual(c.highestBalance, 2400);
});
t('zero and credit balances are not delinquent accounts', () => {
  const r = build({ delinquency: [
    { property_name: 'A', delinquent_rent: '0' },
    { property_name: 'A', delinquent_rent: '-250' },
    { property_name: 'A', delinquent_rent: '600' },
  ] });
  assert.strictEqual(card(r, 'A').delinquentAccounts, 1);
  assert.strictEqual(card(r, 'A').delinquentBalance, 600);
});

console.log('\nWork orders');
t('ages from created_at_appfolio', () => {
  const r = build({ workOrders: [
    { property_name: 'A', created_at_appfolio: '2026-09-01' },   // 22 days
    { property_name: 'A', created_at_appfolio: '2026-09-09' },   // 14 days — boundary, counts
    { property_name: 'A', created_at_appfolio: '2026-09-20' },   // 3 days
  ] });
  assert.strictEqual(card(r, 'A').openWos, 3);
  assert.strictEqual(card(r, 'A').agedWos, 2, '14 days exactly is 14+');
});
t('counts urgent priority', () => {
  const r = build({ workOrders: [
    { property_name: 'A', priority: 'Urgent', created_at_appfolio: TODAY },
    { property_name: 'A', priority: 'Normal', created_at_appfolio: TODAY },
  ] });
  assert.strictEqual(card(r, 'A').urgentWos, 1);
});
t('code violations need the exact phrase', () => {
  // /violation/ alone matched "Daily Groundskeeping" rows whose description
  // mentions the word — 38 instead of 13 in live data.
  const r = build({ workOrders: [
    { property_name: 'A', issue: 'CODE VIOLATION - ELECTRICAL', created_at_appfolio: TODAY },
    { property_name: 'A', issue: 'Daily Groundskeeping', description: 'no violation here', created_at_appfolio: TODAY },
  ] });
  assert.strictEqual(card(r, 'A').codeViolations, 1);
});

console.log('\nThresholds and ordering');
t('delinquency bands', () => {
  const mk = v => build({ delinquency: [{ property_name: 'A', delinquent_rent: String(v) }] }).cards[0].bands.delinquency;
  assert.strictEqual(mk(2500), 'red');
  assert.strictEqual(mk(2000), 'yellow', '2000 is the top of the yellow band, not red');
  assert.strictEqual(mk(500), 'yellow');
  assert.strictEqual(mk(499), 'green');
});
t('aged work-order bands', () => {
  const mk = n => build({ workOrders: Array.from({ length: n }, () => ({ property_name: 'A', created_at_appfolio: '2026-08-01' })) }).cards[0].bands.agedWos;
  assert.strictEqual(mk(6), 'red');
  assert.strictEqual(mk(5), 'yellow');
  assert.strictEqual(mk(3), 'yellow');
  assert.strictEqual(mk(2), 'green');
});
t('worst properties sort first', () => {
  const r = build({ delinquency: [
    { property_name: 'Healthy', delinquent_rent: '100' },
    { property_name: 'Bad', delinquent_rent: '5000' },
    { property_name: 'Watch', delinquent_rent: '800' },
  ] });
  assert.deepStrictEqual(r.cards.map(c => c.property), ['Bad', 'Watch', 'Healthy']);
});

console.log('\nProperty filtering');
t('excluded properties never appear', () => {
  const r = build({ vacancy: [
    { property_name: 'Brazos Lofts', unit_status: 'Vacant-Unrented', advertised_rent: '900' },
    { property_name: 'Ascent', unit_status: 'Vacant-Unrented', advertised_rent: '900' },
  ] });
  assert.deepStrictEqual(r.cards.map(c => c.property), ['Ascent']);
});
t('the management company is not a property', () => {
  // Real value seen in the work-order data.
  const r = build({ workOrders: [{ property_name: 'Metric Property Management of Texas LLC', created_at_appfolio: TODAY }] });
  assert.strictEqual(r.cards.length, 0);
});
t('one card per property across all sources', () => {
  const r = build({
    vacancy: [{ property_name: 'Ascent', unit_status: 'Vacant-Unrented', advertised_rent: '900' }],
    delinquency: [{ property_name: 'ascent', delinquent_rent: '600' }],
    workOrders: [{ property_name: 'Ascent ', created_at_appfolio: TODAY }],
  });
  assert.strictEqual(r.cards.length, 1, 'case and trailing space must not split a property');
  assert.strictEqual(r.cards[0].vacantUnits, 1);
  assert.strictEqual(r.cards[0].delinquentBalance, 600);
  assert.strictEqual(r.cards[0].openWos, 1);
});

console.log('\nLeasing funnel');
const funnelSrc = {
  leads: [{ interest_received: '2026-09-22' }, { interest_received: '2026-09-23' }, { interest_received: '2026-09-15' }],
  showings: [
    { showing_date: '2026-09-22', status: 'Completed' },
    { showing_date: '2026-09-23', status: 'Canceled' },
    { showing_date: '2026-09-16', status: 'Completed' },
  ],
  applications: [
    { application_date: '2026-09-22', status: 'Approved' },
    { application_date: '2026-09-23', status: 'Decision Pending' },
    { application_date: '2026-09-15', status: 'Approved' },
  ],
  moveIns: [{ move_in_date: '2026-09-22' }, { move_in_date: '2026-09-14' }],
};
const weeks = { weekStart: '2026-09-21', weekEnd: '2026-09-27', prevStart: '2026-09-14', prevEnd: '2026-09-20' };
t('counts each stage for this week', () => {
  const f = build(funnelSrc, weeks).funnel.thisWeek;
  assert.deepStrictEqual(f, { traffic: 2, tours: 1, applications: 2, approved: 1, moveIns: 1 });
});
t('cancelled tours do not count', () => {
  assert.strictEqual(build(funnelSrc, weeks).funnel.thisWeek.tours, 1, 'the Canceled showing is excluded');
});
t('last week is counted separately', () => {
  const f = build(funnelSrc, weeks).funnel.lastWeek;
  assert.deepStrictEqual(f, { traffic: 1, tours: 1, applications: 1, approved: 1, moveIns: 1 });
});
t('no funnel without a week range', () => {
  assert.strictEqual(build(funnelSrc).funnel, null);
});

console.log('\nTotals and edge cases');
t('totals add the cards up', () => {
  const r = build({
    vacancy: [{ property_name: 'A', unit_status: 'Vacant-Unrented', advertised_rent: '1000' },
      { property_name: 'B', unit_status: 'Vacant-Unrented', advertised_rent: '500' }],
    delinquency: [{ property_name: 'A', delinquent_rent: '300' }],
  });
  assert.strictEqual(r.totals.properties, 2);
  assert.strictEqual(r.totals.vacantUnits, 2);
  assert.strictEqual(r.totals.vacancyMonthly, 1500);
  assert.strictEqual(r.totals.delinquentBalance, 300);
});
t('empty input does not throw', () => {
  const r = build({});
  assert.deepStrictEqual(r.cards, []);
  assert.strictEqual(r.totals.properties, 0);
});
t('money strings with $ and commas parse', () => {
  const r = build({ delinquency: [{ property_name: 'A', delinquent_rent: '$2,450.00' }] });
  assert.strictEqual(card(r, 'A').delinquentBalance, 2450);
});
t('a missing created date does not crash the ageing', () => {
  const r = build({ workOrders: [{ property_name: 'A' }] });
  assert.strictEqual(card(r, 'A').openWos, 1);
  assert.strictEqual(card(r, 'A').agedWos, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
