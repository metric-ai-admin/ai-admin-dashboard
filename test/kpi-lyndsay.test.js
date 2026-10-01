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
t('vacantRented is null, not a stand-in', () => {
  // Her report counts apps whose detailed status is "Converting". Ours holds
  // the rolled-up status and cannot express it. "Approved" is a different
  // population and would look like agreement.
  const r = K.appsFrom([
    { property_name: 'X', application_date: '2026-09-22', status: 'Approved' },
  ], W.weekStart, W.weekEnd).X;
  assert.strictEqual(r.approved, 1);
  assert.strictEqual(r.vacantRented, null);
  assert.ok(/Converting/.test(K.UNAVAILABLE.vacantRented), 'the reason is not recorded');
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
  assert.strictEqual(r.moveOuts, 2);
  assert.strictEqual(r.renewals, 1);
  assert.strictEqual(r.didNotRenew, 2);
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
  applications: [{ property_name: 'X', application_date: '2026-09-22', status: 'Approved' }],
  leaseHistory: [{ property_name: 'Y', move_in_date: '2026-09-22', renewal: 'No' }],
  workOrders: [{ property_name: 'X', status: 'New', created_at_appfolio: '2026-09-22' }],
}, W);
t('zero and "cannot compute" never look the same', () => {
  // X has no move-ins: that is zero, a measurement.
  assert.strictEqual(BUILT.byProperty.X.moveIns, 0);
  // X's vacantRented cannot be computed at all: that stays null.
  assert.strictEqual(BUILT.byProperty.X.vacantRented, null);
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

console.log('\nnothing user-facing was wired up');
t('the module is not imported by the server or the browser yet', () => {
  // Phase 1 is backend only: no tab, no change to the KPI Report or Goal Board.
  const fs = require('fs'), path = require('path');
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  ['server.js', 'public/app.js', 'public/index.html'].forEach(f => {
    assert.ok(!/kpi-lyndsay/.test(read(f)), `${f} already wires the module in`);
  });
});

console.log(`\n${pass} passing`);
