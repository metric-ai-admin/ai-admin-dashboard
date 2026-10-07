// The combined KPI report — phase 2.
//
// Monday 2026-10-12 is the last side-by-side against Katie's Excel. After that
// the workbook and the HTML stop being used, so what this builds becomes the
// only copy. Two things follow, and they are most of this file:
//
//   The shape is hers. Six sections, her card labels, her Summary column
//   order. A report with different words on the same number is one people have
//   to learn instead of recognise.
//
//   A number that could not be worked out must not arrive as 0. Phase 1 lost
//   the work-order split exactly that way — computed, then silently dropped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kpi-report.js');
const WEEK = require('../lib/week.js');
const ACTS = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ROUTE = server.slice(server.indexOf("app.get('/api/kpi/report'"),
  server.indexOf("app.patch('/api/kpi/report/:week_ending'"));
const PATCH = server.slice(server.indexOf("app.patch('/api/kpi/report/:week_ending'"),
  server.indexOf("app.patch('/api/kpi/report/:week_ending'") + 2200);

// ---- the groups, read out of her HTML ---------------------------------------
t('Greystone is the four properties, and it is the ONLY virtual group', () => {
  assert.deepStrictEqual(Object.keys(K.VIRTUAL_GROUPS), ['Greystone']);
  assert.deepStrictEqual(K.VIRTUAL_GROUPS.Greystone,
    ['Hyde Park Square', 'The Chateau', 'Sunset Palms', 'The Highlander']);
});

t('Round Rock is a roll-up, not a virtual group', () => {
  // In her file it is a separate constant, and summaryColumnOrder places it
  // BEFORE the virtual groups. Same members, different slot.
  assert.ok(!Object.prototype.hasOwnProperty.call(K.VIRTUAL_GROUPS, 'Round Rock'));
  assert.deepStrictEqual(K.ROUND_ROCK.members, ['iConic Round Rock', 'iConic Downtown']);
});

t('the three excluded properties are excluded', () => {
  assert.deepStrictEqual(K.EXCLUDED_PROPERTIES, ['Brazos Lofts', 'Lily Pad Lane', 'The Sidney']);
  assert.ok(K.isExcluded('The Sidney'));
  assert.ok(!K.isExcluded('Ascent at Northgate'));
});

t('an excluded property never reaches a group', () => {
  const g = K.groupMembers('Greystone', ['Hyde Park Square', 'The Sidney', 'The Chateau']);
  assert.deepStrictEqual(g, ['Hyde Park Square', 'The Chateau']);
});

t('a member with no data this week is dropped, not counted as zero', () => {
  assert.deepStrictEqual(K.groupMembers('Round Rock', ['iConic Round Rock']), ['iConic Round Rock']);
});

// ---- the column order -------------------------------------------------------
t('the Summary column order is hers: real, Round Rock, groups, Portfolio', () => {
  const order = K.columnOrder(['Sunset Palms', 'Ascent at Northgate', 'The Sidney',
    'iConic Downtown', 'Hyde Park Square']);
  assert.deepStrictEqual(order, ['Ascent at Northgate', 'Hyde Park Square', 'Sunset Palms',
    'iConic Downtown', 'Round Rock', 'Greystone', 'Portfolio']);
  assert.ok(!order.includes('The Sidney'), 'an excluded property must not get a column');
});

// ---- roll-ups ---------------------------------------------------------------
t('percentages are recomputed from the totals, never averaged', () => {
  // A mean of 90% and 50% is 70%. The real answer for 112 units is 85.7%, and
  // averaging would weight a 12-unit property like a 200-unit one.
  const r = K.rollUp([{ units: 100, occupied: 90 }, { units: 12, occupied: 6 }],
    ['units', 'occupied']);
  assert.strictEqual(r.units, 112);
  assert.strictEqual(r.occupied, 96);
  assert.ok(Math.abs(r.occPct - 96 / 112) < 1e-12);
  assert.notStrictEqual(Math.round(r.occPct * 100), 70);
});

t('a roll-up over nothing is null, not a row of zeros', () => {
  assert.strictEqual(K.rollUp([], ['units']), null);
  assert.strictEqual(K.rollUp([null, undefined], ['units']), null);
});

t('a non-numeric metric does not poison the sum', () => {
  const r = K.rollUp([{ units: 10 }, { units: null }, { units: 'x' }], ['units']);
  assert.strictEqual(r.units, 10);
});

t('occPct is null rather than a divide-by-zero', () => {
  const r = K.rollUp([{ units: 0, occupied: 0 }], ['units', 'occupied']);
  assert.strictEqual(r.occPct, null);
});

// ---- the six sections -------------------------------------------------------
t('the six sections are hers, in her order', () => {
  assert.deepStrictEqual(K.SECTIONS.map(s => s.title), [
    'Occupancy', 'Leasing Activity', 'Renewals', 'Income Snapshot (MTD)',
    'Maintenance', 'Delinquency & Evictions',
  ]);
});

t('the card labels are hers, word for word', () => {
  const labels = K.SECTIONS.reduce((a, s) => a.concat((s.cards || []).map(c => c.label)), []);
  ['Occupied', 'Preleased', 'Move-Ins', 'Move-Outs', 'New Notices', 'Total Notices',
    'Vacant Rented', 'Vacant Unrented', 'Follow Ups Completed', 'Traffic Sources',
    'MTD Income (Cash Receipts)', 'MTD Expenses', 'New Work Orders',
    'Work Orders Closed This Week', 'Work Orders Open (Total)',
    'Labor Hours Billed (MTD)', 'Labor Hours Unbilled (MTD)',
    'DQ Total', 'Eviction $', 'Evictions Pending', 'Need To File Eviction',
  ].forEach(l => assert.ok(labels.includes(l), 'missing card: ' + l));
});

t('the leasing funnel keeps her six stages in order', () => {
  const funnel = K.SECTIONS.find(s => s.key === 'leasing').funnel.map(c => c.label);
  assert.deepStrictEqual(funnel, ['Leads', 'Tours', 'New Applications', 'Canceled',
    'Denied', 'Total Approved Apps with Signed Lease']);
});

// ---- provenance, which is the point -----------------------------------------
t('a number that could not be computed is unavailable, never 0', () => {
  const s = K.sectionsFor({}, {});
  const occupied = s[0].cards.find(c => c.metric === 'occupied');
  assert.strictEqual(occupied.value, null);
  assert.strictEqual(occupied.source, 'unavailable');
  assert.ok(occupied.reason, 'and it says why');
});

t('a computed number is marked as coming from AppFolio', () => {
  const s = K.sectionsFor({ occupied: 273 }, {});
  const c = s[0].cards.find(x => x.metric === 'occupied');
  assert.strictEqual(c.value, 273);
  assert.strictEqual(c.source, 'appfolio');
});

t('the MTD figures are marked as workbook, and say so when missing', () => {
  // income_statement returns 309 rows whatever you ask it and answers
  // portfolio totals only, so these stay on Katie's file.
  const s = K.sectionsFor({}, {});
  const income = s.find(x => x.key === 'income').cards.find(c => c.metric === 'mtdIncome');
  assert.strictEqual(income.source, 'unavailable');
  assert.ok(/workbook/.test(income.reason));
  const withWb = K.sectionsFor({}, { workbook: { mtdIncome: 125000 } });
  const got = withWb.find(x => x.key === 'income').cards.find(c => c.metric === 'mtdIncome');
  assert.strictEqual(got.value, 125000);
  assert.strictEqual(got.source, 'workbook');
});

t('an adjusted number carries the calculated one beside it', () => {
  const s = K.sectionsFor({ moveOuts: 17 },
    { overrides: { moveOuts: { value: 18, updated_by: 'Kara Garst', updated_at: '2026-10-09', note: 'one not in AppFolio yet' } } });
  const c = s[0].cards.find(x => x.metric === 'moveOuts');
  assert.strictEqual(c.value, 18);
  assert.strictEqual(c.computed, 17, 'an adjusted number must never be indistinguishable from a computed one');
  assert.strictEqual(c.source, 'manual');
  assert.strictEqual(c.adjusted_by, 'Kara Garst');
  assert.strictEqual(c.note, 'one not in AppFolio yet');
});

// ---- the week ---------------------------------------------------------------
t('the default week is the last COMPLETE week, same as the Goal Board', () => {
  assert.ok(/WEEK\.leasingLastCompleteWeekEnding\(\)/.test(ROUTE),
    'one function must decide what "this week" means across the dashboard');
  assert.ok(/WEEK\.addDaysYMD\(week_ending, -6\)/.test(ROUTE));
  // And that function is the one the Goal Board was verified against.
  assert.strictEqual(WEEK.leasingLastCompleteWeekEnding('2026-10-07'), '2026-10-03');
  assert.strictEqual(WEEK.leasingLastCompleteWeekEnding('2026-10-10'), '2026-10-03');
});

t('the response says whether the week was chosen or defaulted', () => {
  assert.ok(/defaulted: !isDay\(req\.query\.week_ending\)/.test(ROUTE));
});

// ---- manual edits, locked shut ----------------------------------------------
t('no field is adjustable yet', () => {
  assert.ok(/const KPI_EDITABLE_FIELDS = \[\];/.test(server),
    'it stays empty until Bekah and Kara say which numbers they need');
});

t('a PATCH is refused whatever field it names', () => {
  assert.ok(/KPI_EDITABLE_FIELDS\.includes\(field\)/.test(PATCH));
  assert.ok(/No KPI field is adjustable yet/.test(PATCH),
    'and the refusal explains itself rather than looking like a bug');
});

t('only Bekah and Kara, by name and not by role', () => {
  assert.ok(/KPI_EDITORS = \(process\.env\.KPI_EDITORS \|\| 'bekah,kara'\)/.test(server));
  assert.ok(/Only Bekah and Kara can adjust KPI figures/.test(PATCH));
  // These numbers go to owners; the next regional_director should not inherit
  // the ability to change them.
  const block = server.slice(server.indexOf('const KPI_EDITORS'), server.indexOf('const mayEditKpi') + 300);
  assert.ok(/user\.username/.test(block));
  assert.ok(!/\.role\b/.test(block));
});

t('an adjustment keeps the figure it replaced', () => {
  assert.ok(/computed: b\.computed === undefined \? null : b\.computed/.test(PATCH));
});

t('adjusting is named in Activity Logs', () => {
  const d = ACTS.describe('PATCH', '/api/kpi/report/2026-10-03');
  assert.strictEqual(d.label, 'Adjusted a KPI figure');
  assert.strictEqual(ACTS.sectionLabel('kpi'), 'KPI Report');
});

// ---- the sources ------------------------------------------------------------
t('the report reads the same tables the comparison script does', () => {
  // If they ever disagree it must be a bug in one of them, not in which
  // columns were asked for.
  const compare = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'kpi-compare-lyndsay.js'), 'utf8');
  ['leasing_occupancy', 'leasing_leads', 'leasing_showings', 'leasing_applications',
    'leasing_lease_history', 'maintenance_work_orders'].forEach(tbl => {
    assert.ok(ROUTE.includes(tbl), 'the route does not read ' + tbl);
    assert.ok(compare.includes(tbl), 'the comparison does not read ' + tbl);
  });
  assert.ok(/unit_turn_detail/.test(ROUTE), 'move-outs come from the saved-report store');
});

t('a source that cannot be read costs its own metrics, not the report', () => {
  assert.ok(/gaps\.push\(t \+ ': ' \+ error\.message\)/.test(ROUTE));
  assert.ok(/gaps: gaps,/.test(ROUTE), 'and the page can say which');
});

t('a missing workbook does not fail the report', () => {
  assert.ok(/wbRes\.error \? \[\] : \(wbRes\.data \|\| \[\]\)/.test(ROUTE),
    'saying "needs the workbook" beats a 500 on a Monday morning');
});

// ---- the migration ----------------------------------------------------------
t('the two tables are in a migration, not created on the fly', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '082_kpi_report.sql'), 'utf8');
  assert.ok(/create table if not exists kpi_manual_overrides/.test(sql));
  assert.ok(/create table if not exists kpi_workbook_data/.test(sql));
  assert.ok(/primary key \(week_ending, property, field\)/.test(sql));
  assert.ok(/computed\s+jsonb/.test(sql), 'the replaced figure must be storable');
});

console.log(`\n${pass} passing`);
