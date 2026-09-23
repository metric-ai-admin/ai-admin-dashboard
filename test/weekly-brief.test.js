// Monday Morning Brief — rules that decide what lands in the digest.
// Fixtures mirror the live shapes captured on 2026-09-23.
const assert = require('assert');
const { buildWeeklyBrief, weekOf, firstPhone } = require('../weekly-brief.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// Wednesday of the week 2026-09-21 (Mon) .. 2026-09-27 (Sun).
const TODAY = '2026-09-23';
const excluded = n => /brazos|wolf ridge/i.test(n);
const build = (src, opts) => buildWeeklyBrief(src, { today: TODAY, isExcludedProperty: excluded, ...opts });

console.log('weekOf');
t('Wednesday resolves to its Monday and Sunday', () => {
  assert.deepStrictEqual(weekOf(TODAY), { start: '2026-09-21', end: '2026-09-27' });
});
t('Monday is its own week start', () => {
  assert.strictEqual(weekOf('2026-09-21').start, '2026-09-21');
});
t('Sunday belongs to the week that just ended, not the next one', () => {
  assert.deepStrictEqual(weekOf('2026-09-27'), { start: '2026-09-21', end: '2026-09-27' });
});
t('the week rolls at the month boundary', () => {
  assert.deepStrictEqual(weekOf('2026-10-01'), { start: '2026-09-28', end: '2026-10-04' });
});

console.log('phones');
t('the first of several numbers is taken', () => {
  assert.strictEqual(firstPhone('Mobile: (512) 550-2682, Mobile: (505) 545-7629'), '(512) 550-2682');
});
t('no number yields empty, not "null"', () => {
  assert.strictEqual(firstPhone(null), '');
});

console.log('move-ins');
const LH = [
  { property_name: 'Ascent at Northgate', tenant_name: 'Ojeda, Jesus', move_in_date: '2026-09-23', renewal: 'No', status: 'Pending' },
  { property_name: 'Hyde Park Square', tenant_name: 'Reed, Ana', move_in_date: '2026-09-27', renewal: 'Yes', status: 'Completed' },
  { property_name: 'Hyde Park Square', tenant_name: 'Old, Tenant', move_in_date: '2026-09-20', renewal: 'No', status: 'Completed' },
  { property_name: 'Hyde Park Square', tenant_name: 'Next, Week', move_in_date: '2026-09-28', renewal: 'No', status: 'Pending' },
  { property_name: 'Brazos Lofts', tenant_name: 'Excluded, Ed', move_in_date: '2026-09-23', renewal: 'No', status: 'Pending' },
];
t('only Mon-Sun of the current week is included', () => {
  assert.deepStrictEqual(build({ leaseHistory: LH }).moveIns.map(r => r.tenant), ['Ojeda, Jesus', 'Reed, Ana']);
});
t('excluded properties are dropped', () => {
  assert.ok(!build({ leaseHistory: LH }).moveIns.some(r => r.property === 'Brazos Lofts'));
});
t('move-ins sort by date', () => {
  const d = build({ leaseHistory: LH }).moveIns.map(r => r.date);
  assert.deepStrictEqual(d, [...d].sort());
});
t('the unit number comes from the tickler when property, tenant and date all agree', () => {
  const out = build({ leaseHistory: LH, tickler: [
    { property_name: 'Ascent at Northgate', tenant: 'Ojeda, Jesus', move_in_date: '2026-09-23', unit: '8-112' },
  ] }).moveIns;
  assert.strictEqual(out[0].unit, '8-112');
});
t('a tickler row for a different date does not lend its unit', () => {
  const out = build({ leaseHistory: LH, tickler: [
    { property_name: 'Ascent at Northgate', tenant: 'Ojeda, Jesus', move_in_date: '2026-09-01', unit: '8-112' },
  ] }).moveIns;
  assert.strictEqual(out[0].unit, '');
});
t('a same-name tenant at another property does not lend its unit', () => {
  const out = build({ leaseHistory: LH, tickler: [
    { property_name: 'Sunset Palms', tenant: 'Ojeda, Jesus', move_in_date: '2026-09-23', unit: '999' },
  ] }).moveIns;
  assert.strictEqual(out[0].unit, '');
});
t('renewal is exposed as a boolean', () => {
  const out = build({ leaseHistory: LH }).moveIns;
  assert.strictEqual(out.find(r => r.tenant === 'Reed, Ana').renewal, true);
  assert.strictEqual(out.find(r => r.tenant === 'Ojeda, Jesus').renewal, false);
});
t('a missing tenant name renders as a dash, never "undefined"', () => {
  const out = build({ leaseHistory: [{ property_name: 'Hyde Park Square', move_in_date: '2026-09-23' }] }).moveIns;
  assert.strictEqual(out[0].tenant, '—');
});

console.log('move-outs');
const TICK_OUT = [
  { property_name: 'iConic Round Rock', unit: '211', tenant: 'Boaton, Yausmel', move_out_date: '2026-09-25',
    tenant_phone_number: 'Mobile: (512) 111-2222', move_out_reason: 'Relocating', tenant_status: 'Notice' },
  { property_name: 'Sunset Palms', unit: '111', tenant: 'Hernandez, Michael M.', move_out_date: '2026-09-17', tenant_status: 'Past' },
  { property_name: 'Brazos Lofts', unit: '310', tenant: 'Excluded, Ed', move_out_date: '2026-09-25', tenant_status: 'Notice' },
];
t('a move-out inside the week is listed and one before it is not', () => {
  const out = build({ tickler: TICK_OUT }).moveOuts;
  assert.deepStrictEqual(out.map(r => r.unit), ['211']);
});
t('the resident phone is carried through for the call Bekah has to make', () => {
  assert.strictEqual(build({ tickler: TICK_OUT }).moveOuts[0].phone, '(512) 111-2222');
});
t('a notice unit from unit_vacancy appears even with no tickler row', () => {
  const out = build({ vacancy: [
    { property_name: 'Hyde Park Square', unit: '107', unit_status: 'Notice-Unrented', last_move_out: '2026-09-24' },
  ] }).moveOuts;
  assert.deepStrictEqual(out.map(r => [r.property, r.unit, r.date]), [['Hyde Park Square', '107', '2026-09-24']]);
});
t('a vacant unit is not a scheduled move-out', () => {
  const out = build({ vacancy: [
    { property_name: 'Hyde Park Square', unit: '117', unit_status: 'Vacant-Unrented', last_move_out: '2026-09-24' },
  ] }).moveOuts;
  assert.strictEqual(out.length, 0);
});
t('the same unit in both sources is listed once, keeping the resident name', () => {
  const out = build({
    tickler: TICK_OUT,
    vacancy: [{ property_name: 'iConic Round Rock', unit: '211', unit_status: 'Notice-Unrented', last_move_out: '2026-09-25' }],
  }).moveOuts;
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tenant, 'Boaton, Yausmel');
});
t('a vacancy-only move-out still shows a dash rather than a blank name', () => {
  const out = build({ vacancy: [
    { property_name: 'Hyde Park Square', unit: '107', unit_status: 'Notice-Rented', last_move_out: '2026-09-24' },
  ] }).moveOuts;
  assert.strictEqual(out[0].tenant, '—');
  assert.strictEqual(out[0].rented, true);
});
t('excluded properties are dropped from both sources', () => {
  const out = build({
    tickler: TICK_OUT,
    vacancy: [{ property_name: 'Brazos Lofts', unit: '310', unit_status: 'Notice-Unrented', last_move_out: '2026-09-25' }],
  }).moveOuts;
  assert.ok(!out.some(r => r.property === 'Brazos Lofts'));
});

console.log('tours');
const SHOW = [
  { property_name: 'iConic Downtown', unit: '103', prospect: 'Ceotanzo, Dominic', showing_date: '2026-09-23', status: 'Scheduled', type: 'In-Person' },
  { property_name: 'Hyde Park Square', unit: '117', prospect: 'LEWIS, CRAIG', showing_date: '2026-09-21', status: 'No Show', type: 'In-Person' },
  { property_name: 'The Chateau', unit: '109', prospect: 'Reusch, Bianca', showing_date: '2026-09-26', status: 'Scheduled', type: 'Virtual' },
  { property_name: 'iConic Round Rock', unit: '116', prospect: 'Lozano, Viktoria', showing_date: '2026-09-22', status: 'Prospect Canceled', type: 'In-Person' },
  { property_name: 'iConic Round Rock', unit: '116', prospect: 'Done, Deal', showing_date: '2026-09-22', status: 'Completed', type: 'In-Person' },
  { property_name: 'The Chateau', unit: '110', prospect: 'Later, Leo', showing_date: '2026-10-02', status: 'Scheduled', type: 'In-Person' },
];
t('cancellations and no-shows are dropped', () => {
  const out = build({ showings: SHOW }).tours.map(r => r.prospect);
  assert.deepStrictEqual(out, ['Done, Deal', 'Ceotanzo, Dominic', 'Reusch, Bianca']);
});
t('a tour earlier in the week is kept but marked past', () => {
  const out = build({ showings: SHOW }).tours;
  assert.strictEqual(out.find(r => r.prospect === 'Done, Deal').past, true);
  assert.strictEqual(out.find(r => r.prospect === 'Ceotanzo, Dominic').past, false);
});
t('next week is out of range', () => {
  assert.ok(!build({ showings: SHOW }).tours.some(r => r.prospect === 'Later, Leo'));
});

const TICK_EXP = [
  { property_name: 'Hyde Park Square', unit: '209', tenant: 'Guerrero, Jabes', lease_to: '2026-09-30', tenant_status: 'Current' },
];

console.log('expirations');
// rent_roll is the complete set; lease_expiration_detail supplies renewal
// status only. Shapes taken from the live reports on 2026-09-23.
const RR = [
  { property_name: 'Ascent at Northgate', unit: '4-117', unit_id: 2541, tenant: 'Gabriel Jean', lease_to: '2026-09-30', status: 'Current', rent: '875.00', additional_tenants: null },
  { property_name: 'Ascent at Northgate', unit: '6-201', unit_id: 2600, tenant: 'Williams Bustamante', lease_to: '2026-10-08', status: 'Notice-Unrented', rent: '900.00', additional_tenants: 'Arminda F. Rodriguez Mendoza, Carmelo Bustamente Morales' },
  { property_name: 'The Chateau', unit: '203', unit_id: 3100, tenant: 'Zane Conlin', lease_to: '2026-09-30', status: 'Notice-Rented', rent: '1200.00', additional_tenants: null },
  { property_name: 'Hyde Park Square', unit: '112', unit_id: 2200, tenant: 'Gloria Romero', lease_to: '2026-10-02', status: 'Current', rent: '1100.00', additional_tenants: null },
  { property_name: 'Brazos Lofts', unit: '210', unit_id: 4000, tenant: 'Zachary Hoereth', lease_to: '2026-09-30', status: 'Current', rent: '1300.00', additional_tenants: null },
  { property_name: 'Hyde Park Square', unit: '999', unit_id: 2999, tenant: 'Far, Future', lease_to: '2027-06-30', status: 'Current', rent: '1000.00', additional_tenants: null },
  { property_name: 'Hyde Park Square', unit: '998', unit_id: 2998, tenant: 'Al, Ready', lease_to: '2026-08-31', status: 'Current', rent: '1000.00', additional_tenants: null },
  { property_name: 'Hyde Park Square', unit: '997', unit_id: 2997, tenant: 'No, Lease', lease_to: null, status: 'Vacant-Unrented', rent: null, additional_tenants: null },
];
const LED = [
  { property_name: 'Ascent at Northgate', unit: '4-117', unit_id: 2541, lease_expires: '2026-09-30', status: 'Eligible' },
  { property_name: 'Hyde Park Square', unit: '112', unit_id: 2200, lease_expires: '2026-10-02', status: 'Pending' },
  { property_name: 'Ascent at Northgate', unit: '4-217', unit_id: 2300, lease_expires: '2026-10-02', status: 'Not Eligible' },
];
const exp = () => build({ rentRoll: RR, leaseExpirations: LED }).expirations;

t('every lease expiring in the window is listed, not only the renewal pipeline', () => {
  assert.deepStrictEqual(exp().map(r => r.unit), ['4-117', '203', '112', '6-201']);
});
t('a lease on notice is still listed — the pipeline omits it, this does not', () => {
  assert.ok(exp().some(r => r.unit === '6-201'));
});
t('soonest first', () => {
  const d = exp().map(r => r.date);
  assert.deepStrictEqual(d, [...d].sort());
});
t('a lease past its end date is not upcoming', () => {
  assert.ok(!exp().some(r => r.unit === '998'));
});
t('a lease beyond the horizon is excluded', () => {
  assert.ok(!exp().some(r => r.unit === '999'));
});
t('a unit with no lease end date is skipped rather than crashing', () => {
  assert.ok(!exp().some(r => r.unit === '997'));
});
t('renewal status is joined from lease_expiration_detail on unit and date', () => {
  assert.strictEqual(exp().find(r => r.unit === '4-117').renewalStatus, 'Eligible');
  assert.strictEqual(exp().find(r => r.unit === '112').renewalStatus, 'Pending');
});
t('a pipeline row for a different date does not lend its status', () => {
  const out = build({ rentRoll: RR, leaseExpirations: [{ unit_id: 2541, lease_expires: '2027-01-01', status: 'Renewed' }] }).expirations;
  assert.strictEqual(out.find(r => r.unit === '4-117').renewalStatus, '');
});
t('notice outranks any renewal status', () => {
  const out = build({ rentRoll: RR, leaseExpirations: LED.concat([{ unit_id: 2600, lease_expires: '2026-10-08', status: 'Eligible' }]) }).expirations;
  const r = out.find(x => x.unit === '6-201');
  assert.strictEqual(r.onNotice, true);
  assert.strictEqual(r.renewalStatus, '');
});
t('a lease absent from the pipeline reports no status rather than a guessed one', () => {
  assert.strictEqual(exp().find(r => r.unit === '203').renewalStatus, '');
});
t('roommates on the lease are carried so the wrong person is not called', () => {
  assert.strictEqual(exp().find(r => r.unit === '6-201').alsoOnLease,
    'Arminda F. Rodriguez Mendoza, Carmelo Bustamente Morales');
});
t('excluded properties are dropped', () => {
  assert.ok(!exp().some(r => r.property === 'Brazos Lofts'));
});
t('the same lease appearing twice in the rent roll yields one row', () => {
  const out = build({ rentRoll: RR.concat([{ ...RR[0] }]), leaseExpirations: LED }).expirations;
  assert.strictEqual(out.filter(r => r.unit === '4-117').length, 1);
});
t('days out is counted from today', () => {
  assert.strictEqual(exp().find(r => r.unit === '4-117').daysOut, 7);
});
t('a lease ending today counts as upcoming', () => {
  const out = build({ rentRoll: [{ property_name: 'X', unit: '1', unit_id: 1, tenant: 'A', lease_to: TODAY, status: 'Current' }] }).expirations;
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].daysOut, 0);
});
t('the horizon is configurable', () => {
  const out = buildWeeklyBrief({ rentRoll: RR }, { today: TODAY, isExcludedProperty: excluded, expiryDays: 365 }).expirations;
  assert.ok(out.some(r => r.unit === '999'));
});
t('tenant_tickler no longer feeds this section', () => {
  assert.strictEqual(build({ tickler: TICK_EXP }).expirations.length, 0);
});

console.log('shape');
t('counts match the arrays', () => {
  const out = build({ leaseHistory: LH, tickler: TICK_OUT, vacancy: [], showings: SHOW, rentRoll: RR, leaseExpirations: LED });
  assert.deepStrictEqual(out.counts, {
    moveIns: out.moveIns.length, moveOuts: out.moveOuts.length,
    tours: out.tours.length, expirations: out.expirations.length,
  });
});
t('no sources at all is an empty brief, not a crash', () => {
  const out = build({});
  assert.deepStrictEqual(out.counts, { moveIns: 0, moveOuts: 0, tours: 0, expirations: 0 });
  assert.strictEqual(out.week.start, '2026-09-21');
});
t('the horizon end is 30 days out by default', () => {
  assert.deepStrictEqual(build({}).horizon, { end: '2026-10-23', days: 30 });
});

console.log(`\n${pass} passing`);
