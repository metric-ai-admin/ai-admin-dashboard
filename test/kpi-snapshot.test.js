// Kara's week-on-week comparison, and the figures behind it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/kpi-snapshot.js');
const kpiReport = require('../lib/kpi-report.js');
const kpiBuild = require('../lib/kpi-build.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('kpi snapshot');

// ---- projected occupancy ---------------------------------------------------
// Kara: current occupancy taking notices and preleases into account.

t('the real 10/02 portfolio comes out where the arithmetic says', () => {
  // The eight in-scope properties on 2026-10-02: 397 units, 279 occupied,
  // 4 vacant-but-leased (so preleased 283), 10 on notice.
  const m = { units: 397, occupied: 279, preleased: 283, notices: 10 };
  assert.strictEqual(S.occupancy(m), 279 / 397);
  assert.strictEqual(S.projectedOccupancy(m), 273 / 397);
  assert.strictEqual((100 * S.projectedOccupancy(m)).toFixed(1), '68.8');
});

t('a notice pulls the projection down and a prelease pushes it up', () => {
  const base = { units: 100, occupied: 90, preleased: 90, notices: 0 };
  assert.strictEqual(S.projectedOccupancy(base), 0.9);
  assert.strictEqual(S.projectedOccupancy({ ...base, notices: 5 }), 0.85);
  assert.strictEqual(S.projectedOccupancy({ ...base, preleased: 95 }), 0.95);
});

t('projected occupancy is not the same number as occupancy', () => {
  // If it ever is for every property, the notices column is not being read —
  // which is what the current report's "Preleased" card does today.
  const m = { units: 111, occupied: 59, preleased: 59, notices: 3 };
  assert.notStrictEqual(S.projectedOccupancy(m), S.occupancy(m));
});

t('nothing is clamped — an impossible input stays visible', () => {
  // preleased above units means the sources disagree. A clamp to 100% would
  // make a data problem read as a full building.
  assert.ok(S.projectedOccupancy({ units: 10, occupied: 10, preleased: 12, notices: 0 }) > 1);
});

t('a missing part yields null, never a confident zero', () => {
  assert.strictEqual(S.projectedOccupancy({ units: 100, preleased: 90 }), null, 'no notices');
  assert.strictEqual(S.projectedOccupancy({ units: 0, preleased: 0, notices: 0 }), null, 'no units');
  assert.strictEqual(S.projectedOccupancy(null), null);
  assert.strictEqual(S.occupancy({ units: 100 }), null);
});

// ---- rows from a report ----------------------------------------------------

const fakeReport = {
  week_ending: '2026-10-03',
  properties: {
    'Sunset Palms': [
      { key: 'occupancy', cards: [
        { label: 'Units', metric: 'units', value: 36, source: 'appfolio' },
        { label: 'Occupied', metric: 'occupied', value: 32, source: 'appfolio', pct: 0.888 },
        { label: 'Preleased', metric: 'preleased', value: 32, source: 'appfolio' },
        { label: 'Total Notices', metric: 'notices', value: 1, source: 'appfolio' },
      ] },
      { key: 'renewals', cards: [
        { label: 'Renewals', metric: 'renewals', value: 2, source: 'manual' },
        { label: 'Did Not Renew', metric: 'didNotRenew', value: 1, source: 'appfolio' },
      ] },
      { key: 'income', cards: [{ label: 'MTD', metric: 'mtdIncome', value: 51000, source: 'workbook' }] },
      { key: 'delinquency', cards: [{ label: 'DQ', metric: 'dqTotal', value: 4200, source: 'appfolio' }] },
      { key: 'violations', cards: [
        { label: 'Open', metric: 'cvOpen', value: 16, source: 'appfolio' },
        { label: 'Closed (All Time)', metric: 'cvClosedTotal', value: 0, source: 'appfolio' },
      ] },
    ],
  },
  portfolio: [{ key: 'occupancy', cards: [
    { label: 'Units', metric: 'units', value: 397, source: 'appfolio' },
    { label: 'Occupied', metric: 'occupied', value: 279, source: 'appfolio' },
    { label: 'Preleased', metric: 'preleased', value: 283, source: 'appfolio' },
    { label: 'Total Notices', metric: 'notices', value: 10, source: 'appfolio' },
  ] }],
};

t('a row carries all five of Kara’s figures plus the parts behind them', () => {
  const rows = S.rowsFromReport(fakeReport, { captured_by: 'kara' });
  const sp = rows.find(r => r.property === 'Sunset Palms');
  assert.strictEqual(sp.week_ending, '2026-10-03');
  assert.strictEqual(sp.units, 36);
  assert.strictEqual(sp.occupied, 32);
  assert.strictEqual(sp.notices, 1);
  assert.strictEqual(sp.renewals, 2);
  assert.strictEqual(sp.did_not_renew, 1);
  assert.strictEqual(sp.rent_collected, 51000);
  assert.strictEqual(sp.delinquency_total, 4200);
  assert.strictEqual(sp.cv_open, 16);
  assert.strictEqual(sp.occupancy_pct, 32 / 36);
  assert.strictEqual(sp.occupancy_projected, 31 / 36);
  assert.strictEqual(sp.captured_by, 'kara');
});

t('the Portfolio row is captured too, and is last', () => {
  const rows = S.rowsFromReport(fakeReport);
  assert.strictEqual(rows[rows.length - 1].property, 'Portfolio');
  assert.strictEqual(rows[rows.length - 1].units, 397);
});

t('a hand-adjusted figure is recorded as hand-adjusted', () => {
  const sp = S.rowsFromReport(fakeReport).find(r => r.property === 'Sunset Palms');
  assert.strictEqual(sp.sources.renewals, 'manual');
  assert.strictEqual(sp.sources.mtdIncome, 'workbook');
  assert.strictEqual(sp.sources.units, 'appfolio');
});

// ---- the comparison --------------------------------------------------------

const prev = [
  { property: 'Sunset Palms', occupancy_pct: 0.85, occupancy_projected: 0.83, delinquency_total: 5000, rent_collected: 48000, renewals: 1 },
  { property: 'Portfolio', occupancy_pct: 0.69, occupancy_projected: 0.67, delinquency_total: 20000, rent_collected: 300000, renewals: 4 },
];
const cur = [
  { property: 'Sunset Palms', occupancy_pct: 0.888, occupancy_projected: 0.861, delinquency_total: 4200, rent_collected: 51000, renewals: 2 },
  { property: 'Hyde Park Square', occupancy_pct: 0.917, occupancy_projected: 0.896, delinquency_total: 0, rent_collected: 9000, renewals: 0 },
  { property: 'Portfolio', occupancy_pct: 0.70, occupancy_projected: 0.68, delinquency_total: 19000, rent_collected: 310000, renewals: 5 },
];

t('a figure that moved reports the move, in the right direction', () => {
  const rows = S.compare(prev, cur);
  const sp = rows.find(r => r.property === 'Sunset Palms');
  assert.ok(Math.abs(sp.fields.occupancy_pct.delta - 0.038) < 1e-9);
  assert.strictEqual(sp.fields.delinquency_total.delta, -800, 'delinquency fell, so the delta is negative');
  assert.strictEqual(sp.fields.renewals.delta, 1);
});

t('a property with no previous week is NOT reported as a change of zero', () => {
  // THE ONE THAT MATTERS. "0" and "we never captured this" read identically on
  // a printed report and mean opposite things.
  const hp = S.compare(prev, cur).find(r => r.property === 'Hyde Park Square');
  assert.strictEqual(hp.fields.occupancy_pct.delta, null);
  assert.strictEqual(hp.fields.occupancy_pct.had, false);
  assert.strictEqual(hp.fields.occupancy_pct.previous, null);
  assert.strictEqual(hp.fields.occupancy_pct.current, 0.917);
  assert.strictEqual(hp.onlyIn, 'current');
});

t('a property that disappeared still appears, marked', () => {
  const rows = S.compare(prev.concat([{ property: 'The Sidney', occupancy_pct: 0.8 }]), cur);
  const s = rows.find(r => r.property === 'The Sidney');
  assert.strictEqual(s.onlyIn, 'previous');
  assert.strictEqual(s.fields.occupancy_pct.current, null);
});

t('Portfolio is last, after the properties, which are alphabetical', () => {
  const rows = S.compare(prev, cur);
  assert.deepStrictEqual(rows.map(r => r.property),
    ['Hyde Park Square', 'Sunset Palms', 'Portfolio']);
});

t('the five compared fields are the five Kara named, in her order', () => {
  assert.deepStrictEqual(S.COMPARED.map(f => f.key),
    ['occupancy_pct', 'occupancy_projected', 'delinquency_total', 'rent_collected', 'renewals']);
});

// ---- the report side -------------------------------------------------------

t('Code Violations is on the report, open AND closed', () => {
  const sec = kpiReport.SECTIONS.find(s => s.key === 'violations');
  assert.ok(sec, 'there is no Code Violations section');
  const metrics = sec.cards.map(c => c.metric);
  assert.ok(metrics.includes('cvOpen') && metrics.includes('cvClosedThisWeek'),
    'open on its own cannot show work being finished');
  assert.ok(kpiReport.CARD_METRICS.includes('cvOpen'),
    'a metric no card asks for is computed and then silently dropped');
});

t('the editable fields are no longer empty, and are the report’s own cards', () => {
  assert.ok(kpiBuild.KPI_EDITABLE_FIELDS.length > 0);
  assert.ok(kpiBuild.KPI_EDITABLE_FIELDS.includes('leadsByInterest'), 'traffic must be adjustable — Kara asked for it by name');
  assert.ok(kpiBuild.KPI_EDITABLE_FIELDS.includes('occupied'));
  kpiBuild.KPI_EDITABLE_FIELDS.forEach(f =>
    assert.ok(kpiReport.CARD_METRICS.includes(f), f + ' is adjustable but is not on the report'));
  assert.strictEqual(new Set(kpiBuild.KPI_EDITABLE_FIELDS).size, kpiBuild.KPI_EDITABLE_FIELDS.length,
    'a duplicated field would be a metric counted twice');
});

t('notes are a separate list and are not adjustable numbers', () => {
  assert.deepStrictEqual(kpiBuild.KPI_NOTE_FIELDS,
    ['renewal_comment', 'delinquency_note', 'traffic_adjustment', 'unit_transfer']);
  kpiBuild.KPI_NOTE_FIELDS.forEach(f =>
    assert.ok(!kpiBuild.KPI_EDITABLE_FIELDS.includes(f), f + ' must not be an override'));
});

// ---- the routes ------------------------------------------------------------

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

t('the calculated figure beside an adjustment is worked out by the server', () => {
  const at = SERVER.indexOf("app.patch('/api/kpi/report/:week_ending'");
  assert.ok(at >= 0);
  const body = SERVER.slice(at, at + 1400);
  assert.ok(/computed = await kpiComputedValue\(/.test(body),
    'the computed figure must come from the report, not from the request');
  assert.ok(!/computed: b\.computed/.test(body),
    'the client must not be able to supply the figure its edit is judged against');
});

t('a snapshot never overwrites a week already captured', () => {
  const at = SERVER.indexOf('async function kpiCaptureSnapshot');
  assert.ok(at >= 0);
  const body = SERVER.slice(at, at + 900);
  assert.ok(/ignoreDuplicates: true/.test(body),
    'a snapshot that is rewritten each time is just the live report with an old date on it');
});

t('an unwritable snapshot costs the comparison, not the report', () => {
  const at = SERVER.indexOf('async function kpiCaptureSnapshot');
  const body = SERVER.slice(at, at + 900);
  assert.ok(/catch/.test(body) && /console\.warn/.test(body));
});

t('a captured row says which projection definition it was computed under', () => {
  // Checked against kpi_dashboard_17.html on 2026-10-09: her page has no
  // per-property projected-occupancy figure, and her nine-week projection
  // needs lease expiry dates this dashboard does not sync. So this number is
  // ours and provisional, and the row has to say so — otherwise a week
  // captured under one definition and a week captured under the next get
  // compared to each other with nothing to show they are different questions.
  const sp = S.rowsFromReport(fakeReport).find(r => r.property === 'Sunset Palms');
  assert.strictEqual(sp.sources.__projection_basis, S.PROJECTION_BASIS);
  assert.ok(/@\d{4}-\d{2}-\d{2}$/.test(S.PROJECTION_BASIS),
    'the basis must carry the date it was fixed, so a change is visible');
  assert.strictEqual(sp.sources.units, 'appfolio', 'the real provenances must survive');
});

t('the comparison compares against the last week actually captured', () => {
  const at = SERVER.indexOf("app.get('/api/kpi/compare/:week_ending'");
  assert.ok(at >= 0);
  const body = SERVER.slice(at, at + 1800);
  assert.ok(/order\('week_ending', \{ ascending: false \}\)/.test(body),
    'week-7 may not exist; the previous SNAPSHOT is what can be compared');
  assert.ok(/previous_week_ending/.test(body), 'the reader must be told which week this is against');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
