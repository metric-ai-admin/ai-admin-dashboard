// Tests for the Collections Decision Queue rules.
// Run: node test/collections-triggers.test.js
//
// Fixtures use the real delinquency_as_of column names as observed on the live
// report (2026-09-22), including the digit-leading aging buckets and the
// this_month / last_month / month_before_last history.

const assert = require('assert');
const C = require('../collections-triggers.js');

const EXCLUDED = ['lily pad', 'wolf ridge', 'sidney', 'brazos', 'live with metric', 'cedar and sage'];
const isExcludedProperty = n => EXCLUDED.some(f => String(n || '').toLowerCase().includes(f));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const row = (over = {}) => ({
  unit_id: 1001, occupancy_id: 5001, name: 'Doe, Jane', unit: '101',
  property_name: 'Ascent at Northgate', tenant_status: 'Current',
  delinquent_rent: '100.00', amount_receivable: '100.00',
  this_month: '100.00', last_month: '100.00', month_before_last: '100.00',
  '00_to30': '100.00', '30_to60': '0.00', '60_to90': '0.00', '90_plus': '0.00',
  delinquency_notes: '', phone_numbers: '', ...over,
});
const build = (rows, opts) => C.buildDecisionQueue(rows, { isExcludedProperty, ...opts });
// Helper: as-of snapshots keyed the way the builder keys accounts.
const hist = (last, before) => ({
  priorBalances: {
    lastMonth: new Map(Object.entries(last || {})),
    monthBeforeLast: new Map(Object.entries(before || {})),
  },
});
const K = '5001';   // occupancy_id used by row()
const firedIds = a => a.triggers.map(x => x.id).sort().join(',');

console.log('\nTrigger 1 — large balance at risk');
t('over $1,500 on Notice fires', () => {
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Notice' })]);
  assert.strictEqual(r.queue.length, 1);
  assert.ok(firedIds(r.queue[0]).includes('big_balance_at_risk'));
});
t('over $1,500 while Current does NOT fire', () => {
  // Deliberate: a big balance on a current resident is Karla's job, not an
  // escalation. The trigger is balance AND at-risk status, not balance alone.
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Current' })]);
  assert.strictEqual(r.queue.length, 0);
});
t('exactly $1,500 does not fire (strictly greater)', () => {
  const r = build([row({ delinquent_rent: '1500.00', tenant_status: 'Notice' })]);
  assert.strictEqual(r.queue.length, 0);
});
t('Eviction status also qualifies', () => {
  const r = build([row({ delinquent_rent: '1600.00', tenant_status: 'Eviction' })]);
  assert.ok(firedIds(r.queue[0]).includes('big_balance_at_risk'));
});

console.log('\nTrigger 2 — rising two months running');
t('strictly rising across three snapshots fires', () => {
  const r = build([row({ delinquent_rent: '300.00' })], hist({ [K]: 200 }, { [K]: 100 }));
  assert.ok(firedIds(r.queue[0]).includes('rising_two_months'));
});
t('flat then rising does NOT fire', () => {
  const r = build([row({ delinquent_rent: '300.00' })], hist({ [K]: 200 }, { [K]: 200 }));
  assert.ok(!r.queue.some(a => firedIds(a).includes('rising_two_months')));
});
t('rising then falling does NOT fire', () => {
  const r = build([row({ delinquent_rent: '200.00' })], hist({ [K]: 300 }, { [K]: 100 }));
  assert.ok(!r.queue.some(a => firedIds(a).includes('rising_two_months')));
});
t('reason quotes all three months', () => {
  const r = build([row({ delinquent_rent: '300.00' })], hist({ [K]: 200 }, { [K]: 100 }));
  const reason = r.queue[0].triggers.find(x => x.id === 'rising_two_months').reason;
  assert.match(reason, /100.*200.*300/);
});

console.log('\nTrigger 3 — 90+ days');
t('positive 90_plus fires', () => {
  const r = build([row({ '90_plus': '450.00' })]);
  assert.ok(firedIds(r.queue[0]).includes('aged_90'));
});
t('zero 90_plus does not fire', () => {
  assert.strictEqual(build([row({ '90_plus': '0.00' })]).queue.length, 0);
});
t('90+ with a $0 overall balance does not fire', () => {
  // Real case: $450 in the 90+ bucket, offset by a credit, $0 owed overall.
  const r = build([row({ '90_plus': '450.00', delinquent_rent: '0.00' })]);
  assert.strictEqual(r.queue.length, 0, 'not delinquent, so not a decision');
});
t('NEGATIVE 90_plus does not fire', () => {
  // Aging buckets go negative when the account holds a credit. Live data had
  // -33.56 and -250.00; a "!= 0" test would have flagged residents who are AHEAD.
  assert.strictEqual(build([row({ '90_plus': '-250.00' })]).queue.length, 0);
});

console.log('\nTrigger 4 — new this cycle');
t('zero a month ago, owing a material amount now, fires', () => {
  const r = build([row({ delinquent_rent: '900.00' })], hist({}, {}));
  assert.ok(firedIds(r.queue[0]).includes('new_delinquency'));
});
t('owed something a month ago does not fire', () => {
  const r = build([row({ delinquent_rent: '900.00' })], hist({ [K]: 50 }, { [K]: 900 }));
  assert.ok(!r.queue.some(a => firedIds(a).includes('new_delinquency')));
});
t('credit balance a month ago still counts as new', () => {
  const r = build([row({ delinquent_rent: '900.00' })], hist({ [K]: -40 }, { [K]: 0 }));
  assert.ok(firedIds(r.queue[0]).includes('new_delinquency'));
});

console.log('\nHistory guard');
t('without prior snapshots the history triggers do NOT evaluate', () => {
  // The failure this prevents: with no history, lastMonthBalance would default
  // to 0 and new_delinquency would fire on every account with a balance. That
  // is exactly what happened when this_month/last_month were misread as
  // history — 63 of 65 accounts were flagged.
  const r = build([row({ delinquent_rent: '300.00' })]);   // no hist()
  assert.strictEqual(r.queue.length, 0);
  assert.strictEqual(r.stats.hasHistory, false);
});
t('with history, a material new balance does fire', () => {
  const r = build([row({ delinquent_rent: '900.00' })], hist({}, {}));
  assert.strictEqual(r.queue.length, 1);
  assert.strictEqual(r.stats.hasHistory, true);
});
t('a failed prior pull degrades to fewer cards, never wrong ones', () => {
  // Same account, big balance on Notice: the non-history trigger still fires,
  // so the queue stays useful even when the as-of pulls fail.
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Notice' })]);
  assert.strictEqual(r.queue.length, 1);
  assert.deepStrictEqual(r.queue[0].triggers.map(x => x.id), ['big_balance_at_risk']);
});

console.log('\nTrigger 5 — ready to file (no data source yet)');
t('never fires on real rows, because the column does not exist', () => {
  const r = build([row({ delinquent_rent: '5000.00', tenant_status: 'Notice' })]);
  assert.ok(!r.queue.some(a => firedIds(a).includes('ready_to_file')));
});
t('fires the moment an eviction_status field appears', () => {
  const r = build([row({ eviction_status: 'Ready to File' })]);
  assert.ok(firedIds(r.queue[0]).includes('ready_to_file'), 'wired up in advance');
});

console.log('\nFiltering and shaping');
t('accounts firing nothing are left out', () => {
  assert.strictEqual(build([row()]).queue.length, 0);
});
t('excluded properties never reach the queue', () => {
  const r = build([row({ property_name: 'Brazos Lofts', delinquent_rent: '9000.00', tenant_status: 'Notice' })]);
  assert.strictEqual(r.queue.length, 0);
  assert.strictEqual(r.stats.considered, 0);
});
t('one account can fire several triggers', () => {
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Notice', '90_plus': '300.00' })], hist({ [K]: 200 }, { [K]: 100 }));
  assert.strictEqual(r.queue[0].triggers.length, 3);
});
t('sorted by balance descending', () => {
  const r = build([
    row({ name: 'Small', delinquent_rent: '1600.00', tenant_status: 'Notice' }),
    row({ name: 'Big', delinquent_rent: '9000.00', tenant_status: 'Notice' }),
    row({ name: 'Mid', delinquent_rent: '3000.00', tenant_status: 'Notice' }),
  ]);
  assert.deepStrictEqual(r.queue.map(a => a.name), ['Big', 'Mid', 'Small']);
});
t('change is balance minus last month snapshot', () => {
  const r = build([row({ delinquent_rent: '450.00', '90_plus': '450.00' })], hist({ [K]: 100 }, { [K]: 0 }));
  assert.strictEqual(r.queue[0].change, 350);
});
t('money strings with $ and commas parse', () => {
  const r = build([row({ delinquent_rent: '$2,500.00', tenant_status: 'Notice' })]);
  assert.strictEqual(r.queue[0].balance, 2500);
});
t('stats count by status and trigger', () => {
  const r = build([
    row({ name: 'A', delinquent_rent: '2000.00', tenant_status: 'Notice' }),
    row({ name: 'B', delinquent_rent: '2000.00', tenant_status: 'Eviction' }),
  ]);
  assert.strictEqual(r.stats.notice, 1);
  assert.strictEqual(r.stats.eviction, 1);
  assert.strictEqual(r.stats.byTrigger.big_balance_at_risk, 2);
});

console.log('\nPhone matching for last inbound call');
t('extracts 10-digit numbers from the AppFolio phone string', () => {
  const a = C.shapeAccount(row({ phone_numbers: 'Mobile: (512) 227-5574 / Home: 512-419-8217' }));
  assert.deepStrictEqual(C.phoneDigits(a).sort(), ['5122275574', '5124198217']);
});
t('ignores short fragments', () => {
  const a = C.shapeAccount(row({ phone_numbers: 'ext 1110' }));
  assert.deepStrictEqual(C.phoneDigits(a), []);
});
t('attaches the most recent matching inbound call', () => {
  const r = build(
    [row({ delinquent_rent: '2000.00', tenant_status: 'Notice', phone_numbers: 'Mobile: (512) 227-5574' })],
    { lastInboundByPhone: new Map([['5122275574', '2026-09-18']]) },
  );
  assert.strictEqual(r.queue[0].lastInboundCall, '2026-09-18');
});
t('no match leaves it null rather than guessing', () => {
  const r = build(
    [row({ delinquent_rent: '2000.00', tenant_status: 'Notice', phone_numbers: 'Mobile: (512) 000-0000' })],
    { lastInboundByPhone: new Map([['5122275574', '2026-09-18']]) },
  );
  assert.strictEqual(r.queue[0].lastInboundCall, null);
});

console.log('\nprimaryPhone — real AppFolio strings');
t('a single mobile', () => {
  assert.deepStrictEqual(C.primaryPhone('Mobile: (512) 227-5574'),
    { label: 'Mobile', display: '(512) 227-5574', tel: '+15122275574' });
});
t('prefers Mobile over Phone', () => {
  // Real row: "Phone: (512) 673-9783, Mobile: (737) 393-1285". A mobile is the
  // one likely to be answered on a collections call.
  assert.strictEqual(C.primaryPhone('Phone: (512) 673-9783, Mobile: (737) 393-1285').display, '(737) 393-1285');
});
t('strips a +1 country code', () => {
  assert.deepStrictEqual(C.primaryPhone('Phone: +1 (512) 507-4916'),
    { label: 'Phone', display: '(512) 507-4916', tel: '+15125074916' });
});
t('Office ranks last', () => {
  assert.strictEqual(C.primaryPhone('Office: (512) 111-1111, Mobile: (512) 222-2222').display, '(512) 222-2222');
});
t('three numbers pick the mobile', () => {
  assert.strictEqual(C.primaryPhone('Phone: (512) 111-1111, Office: (512) 222-2222, Mobile: (512) 333-3333').display, '(512) 333-3333');
});
t('an unlabelled bare number still works', () => {
  assert.strictEqual(C.primaryPhone('(254) 498-5990').display, '(254) 498-5990');
});
t('too-short junk yields null, not a broken link', () => {
  assert.strictEqual(C.primaryPhone('ext 1110'), null);
  assert.strictEqual(C.primaryPhone('n/a'), null);
});
t('blank, null and undefined are safe', () => {
  assert.strictEqual(C.primaryPhone(''), null);
  assert.strictEqual(C.primaryPhone(null), null);
  assert.strictEqual(C.primaryPhone(undefined), null);
});
t('the queue attaches a parsed phone to each card', () => {
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Notice', phone_numbers: 'Mobile: (512) 227-5574' })]);
  assert.strictEqual(r.queue[0].phone.display, '(512) 227-5574');
  assert.strictEqual(r.queue[0].phone.tel, '+15122275574');
});
t('an account with no phone gets null, not a placeholder', () => {
  const r = build([row({ delinquent_rent: '2000.00', tenant_status: 'Notice', phone_numbers: '' })]);
  assert.strictEqual(r.queue[0].phone, null);
});

console.log('\nEdge cases');
t('empty input does not throw', () => {
  const r = build([]);
  assert.strictEqual(r.queue.length, 0);
  assert.strictEqual(r.stats.flagged, 0);
});
t('missing money fields are treated as zero, not NaN', () => {
  const r = build([row({ delinquent_rent: null, this_month: undefined, last_month: '' })]);
  assert.strictEqual(r.queue.length, 0, 'nothing should fire on blanks');
});
t('statusLabel normalises what the report actually returns', () => {
  assert.strictEqual(C.statusLabel('Current'), 'Current');
  assert.strictEqual(C.statusLabel('Notice'), 'Notice');
  assert.strictEqual(C.statusLabel(''), 'Unknown');
  assert.strictEqual(C.statusLabel('Notice - Eviction'), 'Eviction');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
