// lib/kpi-lyndsay.js — Lyndsay's KPI rules, reproduced from her HTML.
//
// These are not arbitrary definitions. Each one is what she reads every Monday,
// so a test here is the record of what her report means. A "better" rule is a
// different number, and she would be the one to notice.
const assert = require('assert');
const K = require('../lib/kpi-lyndsay.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const W = { weekStart: '2026-09-20', weekEnd: '2026-09-26' };

console.log('occupancy');
t('occPct sums the rows — it does not average the percentages', () => {
  // Two unit types at one property: 4 units 100% occupied, 96 units 50%.
  // Averaging the percentages gives 75%; the right answer is 52%.
  const r = K.occupancyFrom([
    { property_name: 'X', total_units: 4, occupied_units: 4, vacant_rented: 0, notice_units: 0 },
    { property_name: 'X', total_units: 96, occupied_units: 48, vacant_rented: 0, notice_units: 0 },
  ]).byProperty.X;
  assert.strictEqual(r.units, 100);
  assert.strictEqual(r.occupied, 52);
  assert.strictEqual(r.occPct, 0.52);
});
t('preleased = occupied + vacant rented, not a projection', () => {
  const r = K.occupancyFrom([
    { property_name: 'X', total_units: 50, occupied_units: 40, vacant_rented: 3, notice_units: 5 },
  ]).byProperty.X;
  assert.strictEqual(r.preleased, 43);
  assert.strictEqual(r.prePct, 43 / 50);
  // Notices are NOT subtracted: a unit on notice is still occupied today.
  assert.strictEqual(r.occupied, 40);
});
t('vacant unrented is derived, and matches her 09/26 totals', () => {
  // Her sheet totals 398 units, 273 occupied, 11 vacant rented, 114 unrented.
  const r = K.occupancyFrom([
    { property_name: 'P', total_units: 398, occupied_units: 273, vacant_rented: 11, notice_units: 11 },
  ]).byProperty.P;
  assert.strictEqual(r.vacantUnrented, 114);
});
t('the as_of dates actually used are reported, not assumed', () => {
  // leasing_occupancy is a snapshot keyed on property, not a history. Asking
  // it for a date it does not hold would silently answer with another day.
  const r = K.occupancyFrom([
    { property_name: 'X', total_units: 1, occupied_units: 1, as_of: '2026-09-28' },
    { property_name: 'Y', total_units: 1, occupied_units: 1, as_of: '2026-09-16' },
  ]);
  assert.deepStrictEqual(r.asOfDates, ['2026-09-16', '2026-09-28']);
});

console.log('\ntours');
t('a tour is a Status STARTING with "Completed"', () => {
  const rows = [
    { property_name: 'X', showing_date: '2026-09-22', status: 'Completed' },
    { property_name: 'X', showing_date: '2026-09-22', status: 'Completed (Unconfirmed)' },
    { property_name: 'X', showing_date: '2026-09-22', status: 'Scheduled' },
    { property_name: 'X', showing_date: '2026-09-22', status: 'Canceled' },
    { property_name: 'X', showing_date: '2026-09-22', status: 'Prospect Canceled' },
    { property_name: 'X', showing_date: '2026-09-22', status: 'No Show' },
  ];
  const r = K.toursFrom(rows, W.weekStart, W.weekEnd).X;
  assert.strictEqual(r.showings, 6);
  // Prefix, not equality: "Completed (Unconfirmed)" counts. In the 09/20-09/26
  // week that distinction is 19 showings.
  assert.strictEqual(r.tours, 2);
});
t('a showing outside the week is not counted at all', () => {
  const r = K.toursFrom([
    { property_name: 'X', showing_date: '2026-09-19', status: 'Completed' },
    { property_name: 'X', showing_date: '2026-09-27', status: 'Completed' },
  ], W.weekStart, W.weekEnd);
  assert.deepStrictEqual(r, {});
});

console.log('\napplications');
t('Vacant Rented is a STATE, counted over every application', () => {
  // Her parseApps has no date filter: Vacant Rented is "every application
  // currently Converting", which is the right shape for a unit that is leased
  // but not yet moved into. Filtering it to the reporting week would count only
  // the ones applied for in those seven days — across her whole workbook, 8 are
  // Converting and NONE were received in 09/20-09/26, so a week filter would
  // report zero where the truth is eight.
  const rows = [
    { property_name: 'X', application_date: '2026-08-01', status: 'Approved', detailed_status: 'Converting' },
    { property_name: 'X', application_date: '2026-09-22', status: 'Approved', detailed_status: 'Converted' },
    { property_name: 'X', application_date: '2026-07-15', status: 'Approved', detailed_status: 'Converting' },
  ];
  assert.strictEqual(K.vacantRentedFrom(rows).X.vacantRented, 2,
    'applications outside the week were dropped');
  // appsFrom, which IS weekly, must not also count it.
  assert.strictEqual(K.appsFrom(rows, W.weekStart, W.weekEnd).X.vacantRented, undefined);
});
t('"Converted" is not "Converting" — the move-in already happened', () => {
  const r = K.vacantRentedFrom([
    { property_name: 'X', detailed_status: 'Converted' },
    { property_name: 'X', detailed_status: 'Approved' },
  ]).X;
  assert.ok(!r.vacantRented, 'Converted or Approved counted as Vacant Rented');
});
t('a row with no detailed_status is unknown, not "not converting"', () => {
  // Rows synced before migration 075 have none. Reading null as "no" would
  // under-report silently; counting it separately makes the answer say it is
  // incomplete.
  const r = K.vacantRentedFrom([
    { property_name: 'X', detailed_status: null },
    { property_name: 'X' },
    { property_name: 'X', detailed_status: 'Converting' },
  ]).X;
  assert.strictEqual(r.vacantRented, 1);
  assert.strictEqual(r.vacantRentedUnknown, 2);
});
t('each status lands in exactly one bucket', () => {
  const r = K.appsFrom([
    { property_name: 'X', application_date: '2026-09-22', status: 'Approved' },
    { property_name: 'X', application_date: '2026-09-22', status: 'Canceled' },
    { property_name: 'X', application_date: '2026-09-22', status: 'Denied' },
    { property_name: 'X', application_date: '2026-09-22', status: 'Decision Pending' },
    { property_name: 'X', application_date: '2026-09-22', status: 'In Screening' },
  ], W.weekStart, W.weekEnd).X;
  assert.strictEqual(r.applications, 5);
  assert.strictEqual(r.approved + r.canceled + r.denied + r.pending, 5);
  assert.strictEqual(r.pending, 2);
});

console.log('\nmove-ins and move-outs');
t('a lease counts in the week its date falls in, on each side separately', () => {
  const r = K.leaseActivityFrom([
    { property_name: 'X', move_in_date: '2026-09-22', move_out_date: null, renewal: 'No' },
    { property_name: 'X', move_in_date: null, move_out_date: '2026-09-24', renewal: 'No' },
    // One lease that both ended and restarted inside the week counts once each.
    { property_name: 'X', move_in_date: '2026-09-25', move_out_date: '2026-09-21', renewal: 'Yes' },
    { property_name: 'X', move_in_date: '2026-08-01', move_out_date: '2026-08-02', renewal: 'Yes' },
  ], W.weekStart, W.weekEnd).X;
  assert.strictEqual(r.moveIns, 2);
  assert.strictEqual(r.renewals, 1);
  assert.strictEqual(r.didNotRenew, 2);
  // lease_history no longer contributes move-outs. It has three in its ENTIRE
  // history against a 398-unit portfolio, so counting it alongside
  // unit_turn_detail would double whichever ones it does happen to carry.
  assert.strictEqual(r.moveOuts, undefined, 'lease_history is still counting move-outs');
  assert.strictEqual(r.moveOutsFromLeaseHistory, 2, 'the backup count is gone');
});

console.log('\nmove-outs come from unit_turn_detail');
t('a turn counts in the week its move_out_date falls in', () => {
  // The three in Lyndsay's box score for 09/20-09/26, which unit_turn_detail
  // found 3 of 3 when probed on 2026-10-02.
  const r = K.moveOutsFrom([
    { property_name: 'Ascent at Northgate', unit: '5-127', move_out_date: '2026-09-21' },
    { property_name: 'Hyde Park Square', unit: '107', move_out_date: '2026-09-23' },
    { property_name: 'iConic Round Rock', unit: '106', move_out_date: '2026-09-25' },
    { property_name: 'Ascent at Northgate', unit: '9-001', move_out_date: '2026-09-19' },
    { property_name: 'Ascent at Northgate', unit: '9-002', move_out_date: '2026-09-27' },
  ], W.weekStart, W.weekEnd);
  assert.strictEqual(r['Ascent at Northgate'].moveOuts, 1, 'the days either side leaked in');
  assert.strictEqual(r['Hyde Park Square'].moveOuts, 1);
  assert.strictEqual(r['iConic Round Rock'].moveOuts, 1);
  assert.strictEqual(Object.keys(r).length, 3);
});
t('a turn with no move-out date is not a move-out', () => {
  // The report carries turns in progress too; only a dated move-out counts.
  assert.deepStrictEqual(K.moveOutsFrom([
    { property_name: 'X', unit: '1', move_out_date: null },
    { property_name: 'X', unit: '2' },
  ], W.weekStart, W.weekEnd), {});
});
t('the address is stripped here too, so both feeds bucket alike', () => {
  const r = K.moveOutsFrom([
    { property_name: 'Hyde Park Square - 206 W 38th St', move_out_date: '2026-09-23' },
  ], W.weekStart, W.weekEnd);
  assert.strictEqual(r['Hyde Park Square'].moveOuts, 1);
});

console.log('\ndates');
t('a YYYY-MM-DD string is never shifted by a timezone', () => {
  // A Date built from "2026-09-26" is UTC midnight; read in Central it is the
  // 25th, which would move a Saturday move-in into the previous week.
  assert.strictEqual(K.ymd('2026-09-26'), '2026-09-26');
  assert.strictEqual(K.ymd('2026-09-26T00:00:00Z'), '2026-09-26');
  assert.strictEqual(K.ymd(new Date('2026-09-26T00:00:00Z')), '2026-09-26');
  assert.strictEqual(K.ymd('9/26/2026'), '2026-09-26');
  assert.strictEqual(K.ymd(''), null);
});
t('the address is stripped so both sides bucket alike', () => {
  assert.strictEqual(K.canonicalProperty('Sunset Palms - 902 Romeria Drive'), 'Sunset Palms');
  assert.strictEqual(K.canonicalProperty('Sunset Palms'), 'Sunset Palms');
  assert.strictEqual(K.canonicalProperty('Total'), null);
  assert.strictEqual(K.canonicalProperty(''), null);
});

console.log('\nassembly');
const BUILT = K.build({
  occupancy: [{ property_name: 'X', total_units: 10, occupied_units: 8, vacant_rented: 1, notice_units: 2, as_of: '2026-09-26' }],
  leads: [{ property: 'X', interest_received: '2026-09-22' }],
  showings: [{ property_name: 'X', showing_date: '2026-09-22', status: 'Completed' }],
  applications: [
    { property_name: 'X', application_date: '2026-09-22', status: 'Approved', detailed_status: 'Converted' },
    { property_name: 'X', application_date: '2026-07-01', status: 'Approved', detailed_status: 'Converting' },
  ],
  leaseHistory: [{ property_name: 'Y', move_in_date: '2026-09-22', renewal: 'No' }],
  unitTurns: [{ property_name: 'X', unit: '101', move_out_date: '2026-09-24' }],
  workOrders: [{ property_name: 'X', status: 'New', created_at_appfolio: '2026-09-22' }],
}, W);
t('a measured zero and an uncounted thing never look the same', () => {
  // X has no move-ins: that is zero, a measurement.
  assert.strictEqual(BUILT.byProperty.X.moveIns, 0);
  // Its move-out comes from unit_turn_detail, not from lease_history.
  assert.strictEqual(BUILT.byProperty.X.moveOuts, 1);
  // Vacant Rented counts the July application, which is outside the week —
  // it is a state, not a weekly event.
  assert.strictEqual(BUILT.byProperty.X.vacantRented, 1);
  assert.strictEqual(BUILT.byProperty.X.vacantRentedUnknown, 0);
});
t('a property present in only one source still appears', () => {
  assert.ok(BUILT.byProperty.Y, 'Y has lease history and no occupancy row, and vanished');
  assert.strictEqual(BUILT.byProperty.Y.moveIns, 1);
  // No occupancy row means no percentage — not 0%, which would read as empty.
  assert.strictEqual(BUILT.byProperty.Y.occPct, null);
});
t('the portfolio sums counts and recomputes the ratio', () => {
  assert.strictEqual(BUILT.portfolio.units, 10);
  assert.strictEqual(BUILT.portfolio.occupied, 8);
  assert.strictEqual(BUILT.portfolio.occPct, 0.8);
  assert.strictEqual(BUILT.portfolio.moveIns, 1);
});
t('a missing week is an error, not a silent default to today', () => {
  assert.throws(() => K.build({}, {}), /weekStart and weekEnd/);
});

console.log('\nwhere the module is wired in');
t('the server builds the report from it; the browser still does not', () => {
  // Phase 1 was backend only and this asserted that NOTHING imported it.
  // Phase 2 (2026-10-07) is exactly the wiring-up: /api/kpi/report builds from
  // this module, and scripts/kpi-compare-lyndsay.js validates it against
  // Katie's workbook. Both must keep using the SAME module, or the comparison
  // stops being evidence about the report.
  const fs = require('fs'), path = require('path');
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.ok(/kpi-lyndsay/.test(read('server.js')), 'the report route must build from this module');
  assert.ok(/kpi-lyndsay/.test(read('scripts/kpi-compare-lyndsay.js')),
    'and so must the comparison that validates it');
  // The page renders what the route returns. A second implementation in the
  // browser is how two numbers for one metric start.
  ['public/app.js', 'public/index.html'].forEach(f => {
    assert.ok(!/kpi-lyndsay/.test(read(f)), `${f} should render the route's answer, not recompute it`);
  });
});

console.log(`\n${pass} passing`);
