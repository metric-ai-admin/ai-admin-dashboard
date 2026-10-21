// Final Account Statements, measured through the deposit.
//
// The signal is an absence: AppFolio's security_deposit_funds_detail lists
// what is held TODAY, with no settlement date and no history, so a deposit
// that stops coming back has been settled. Everything that can go wrong here
// goes wrong quietly:
//
//   * a feed that comes back short settles every deposit missing from it
//   * a scheduled move-out is not a late one
//   * "settled within 15 days" computed over two days of history reads like
//     one computed over a year
//   * a deposit we cannot place is a deposit that disappears
const assert = require('assert');
const F = require('../lib/fas-deposits.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('FAS — deposits');

const row = o => Object.assign({
  occupancy_id: 'o1', unit: '101', property: 'Ascent at Northgate',
  property_source: 'occupancy_custom_fields', tenant_status: 'Past',
  move_in: '2024-01-01', move_out: '2026-10-01', amount: '750.00',
  first_seen_on: '2026-10-22', last_seen_on: '2026-10-22', in_feed: true,
  gone_first_seen_on: null,
}, o);

// ---- the clock ----------------------------------------------------------------

t('calendar days are the default', () => {
  assert.strictEqual(F.DEFAULT_DEADLINE.days, 15);
  assert.strictEqual(F.DEFAULT_DEADLINE.basis, 'calendar');
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-16', 'calendar'), 15);
});

t('business days skip the weekend', () => {
  // Thursday 10/01 to Thursday 10/15 is 14 calendar days and 10 working ones.
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-15', 'calendar'), 14);
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-15', 'business'), 10);
  // The move-out day itself is day 0 on both bases.
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-01', 'business'), 0);
});

t('exactly on the deadline is still in time', () => {
  // 15 days is the deadline, so day 15 is not late. An off-by-one here is a
  // property called out on a day it had not missed anything.
  const c = F.classify(row({ move_out: '2026-10-01' }), '2026-10-16');
  assert.strictEqual(c.days, 15);
  assert.strictEqual(c.bucket, 'withinWindow');
  const d = F.classify(row({ move_out: '2026-10-01' }), '2026-10-17');
  assert.strictEqual(d.bucket, 'overdue');
});

t('the deadline is configurable', () => {
  const c = F.classify(row({ move_out: '2026-10-01' }), '2026-10-09',
    { days: 5, basis: 'calendar' });
  assert.strictEqual(c.bucket, 'overdue');
  const b = F.classify(row({ move_out: '2026-10-01' }), '2026-10-09',
    { days: 15, basis: 'business' });
  assert.strictEqual(b.bucket, 'withinWindow');
});

// ---- the move-out ---------------------------------------------------------------

t('a scheduled move-out is not an overdue one', () => {
  // THE BUG THAT PROMPTED THIS. A probe sorted by move_out_date reported a
  // move-out "-251 days ago": the report carries scheduled dates, and a
  // negative age is an error wearing a number.
  const c = F.classify(row({ move_out: '2027-06-01' }), '2026-10-22');
  assert.strictEqual(c.bucket, 'future');
  assert.strictEqual(c.inDays, 222);
});

t('a row with no move-out is counted, not dropped', () => {
  // A current resident's deposit. It belongs in no FAS bucket and the totals
  // still have to add up to the rows we hold.
  assert.strictEqual(F.classify(row({ move_out: '' }), '2026-10-22').bucket, 'noMoveOut');
  assert.strictEqual(F.classify(row({ move_out: null }), '2026-10-22').bucket, 'noMoveOut');
  assert.strictEqual(F.classify(row({ move_out: 'nonsense' }), '2026-10-22').bucket, 'noMoveOut');
});

// ---- settled, and how precisely ---------------------------------------------------

t('a deposit still in the list is not settled', () => {
  assert.strictEqual(F.settlement(row({})), null);
});

t('a settlement is a bracket, never one date', () => {
  // The run that last saw it and the run that first did not. A single date
  // would be a precision the data does not have.
  // Daily runs make a one-day bracket, which is the NORMAL case and not an
  // uncertainty worth flagging.
  const s = F.settlement(row({ last_seen_on: '2026-11-03', gone_first_seen_on: '2026-11-04' }));
  assert.deepStrictEqual(s, { from: '2026-11-03', to: '2026-11-04', spanDays: 1 });
  // Two missed runs widen it, and the bracket says so.
  const w = F.settlement(row({ last_seen_on: '2026-11-03', gone_first_seen_on: '2026-11-06' }));
  assert.strictEqual(w.spanDays, 3);
  assert.strictEqual(w.from, '2026-11-03');
  assert.strictEqual(w.to, '2026-11-06');
});

t('days to settlement are measured to the EARLIER end', () => {
  // So a settlement is never reported as later than it might have been — the
  // direction that would call somebody late who was not.
  const c = F.classify(row({
    move_out: '2026-10-20', last_seen_on: '2026-11-03', gone_first_seen_on: '2026-11-06',
  }), '2026-11-10');
  assert.strictEqual(c.days, 14);
  assert.strictEqual(c.bucket, 'settledInTime');
});

t('a settlement after the deadline is its own bucket', () => {
  const c = F.classify(row({
    move_out: '2026-10-01', last_seen_on: '2026-10-30', gone_first_seen_on: '2026-10-31',
  }), '2026-11-10');
  assert.strictEqual(c.bucket, 'settledLate');
  assert.strictEqual(c.days, 29);
});

// ---- no deposit -------------------------------------------------------------------

t('no deposit is neither done nor late', () => {
  // Kara has not said which it is. Calling it settled invents a statement
  // nobody sent; calling it overdue accuses somebody of not sending one that
  // was never owed.
  ['0', '0.00', 0, '', null].forEach(amount => {
    const c = F.classify(row({ amount, move_out: '2026-09-01' }), '2026-10-22');
    assert.strictEqual(c.bucket, 'noDeposit', JSON.stringify(amount));
  });
});

t('a settled deposit is still settled even if the amount reads zero', () => {
  // The absence is the signal. An amount that went to zero before the row
  // disappeared must not turn a real settlement into "no deposit".
  const c = F.classify(row({
    amount: '0', move_out: '2026-10-01',
    last_seen_on: '2026-10-05', gone_first_seen_on: '2026-10-06',
  }), '2026-10-22');
  assert.strictEqual(c.bucket, 'settledInTime');
});

// ---- by property --------------------------------------------------------------------

t('an unplaceable deposit is counted apart, never dropped', () => {
  // The report has no property column. One that will not resolve is a real
  // move-out we cannot group — the count is the only thing that stops it
  // disappearing.
  const r = F.byProperty([
    row({ occupancy_id: 'a' }),
    row({ occupancy_id: 'b', property: '', property_source: 'unresolved' }),
    row({ occupancy_id: 'c', property: 'Somewhere', property_source: 'unresolved' }),
  ], '2026-10-22');
  assert.strictEqual(r.unresolvedCount, 2);
  assert.deepStrictEqual(Object.keys(r.properties), ['Ascent at Northgate']);
  assert.strictEqual(r.unresolved.withinWindow + r.unresolved.overdue, 2);
});

t('every row lands in exactly one bucket', () => {
  // The totals have to add up to the rows we hold, or a disappearing row is
  // indistinguishable from a quiet week.
  const rows = [
    row({ occupancy_id: '1', move_out: '2026-10-20' }),                      // within
    row({ occupancy_id: '2', move_out: '2026-09-01' }),                      // overdue
    row({ occupancy_id: '3', move_out: '2027-01-01' }),                      // future
    row({ occupancy_id: '4', move_out: '' }),                                // no move-out
    row({ occupancy_id: '5', move_out: '2026-09-01', amount: '0' }),         // no deposit
    row({ occupancy_id: '6', move_out: '2026-10-01', last_seen_on: '2026-10-10', gone_first_seen_on: '2026-10-11' }),
  ];
  const r = F.byProperty(rows, '2026-10-22');
  const b = r.properties['Ascent at Northgate'];
  const total = b.settledInTime + b.settledLate + b.withinWindow + b.overdue
    + b.noDeposit + b.future + b.noMoveOut;
  assert.strictEqual(total, rows.length, JSON.stringify(b));
  assert.strictEqual(b.overdue, 1);
  assert.strictEqual(b.future, 1);
  assert.strictEqual(b.noMoveOut, 1);
  assert.strictEqual(b.noDeposit, 1);
  assert.strictEqual(b.settledInTime, 1);
  assert.strictEqual(b.withinWindow, 1);
});

t('overdue units are named, worst first', () => {
  const r = F.byProperty([
    row({ occupancy_id: '1', unit: '108', move_out: '2026-09-29' }),
    row({ occupancy_id: '2', unit: '311', move_out: '2026-10-03' }),
  ], '2026-10-22');
  const b = r.properties['Ascent at Northgate'];
  assert.deepStrictEqual(b.overdueUnits.map(u => u.unit), ['108', '311']);
  assert.strictEqual(b.overdueUnits[0].days, 23);
});

// ---- the guard ---------------------------------------------------------------------

t('a feed that falls off a cliff settles nothing', () => {
  // THE FAILURE THAT WOULD RUIN IT. Zero rows back — rate limit, a changed
  // filter, an expired token — and every held deposit "settles" on the same
  // day. The brief would report a perfect week on the morning the sync broke.
  const g = F.feedGuard(0, 215);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.status, 'suspect');
  assert.match(g.reason, /settles every deposit missing from it/);
});

t('the guard trips at more than a fifth', () => {
  assert.strictEqual(F.feedGuard(172, 215).ok, true, '20% exactly is allowed');
  assert.strictEqual(F.feedGuard(171, 215).ok, false, 'more than 20% is not');
  assert.strictEqual(F.feedGuard(215, 215).ok, true);
  assert.strictEqual(F.feedGuard(230, 215).ok, true, 'growth is never suspect');
});

t('the limit is configurable but defaults to 20', () => {
  assert.strictEqual(F.feedGuard(171, 215, 50).ok, true);
  assert.strictEqual(F.feedGuard(100, 215, 5).ok, false);
});

t('the first run ever settles nothing and says so', () => {
  const g = F.feedGuard(215, 0);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.first, true);
});

t('a fetch that did not come back is failed, not suspect', () => {
  const g = F.feedGuard(null, 215);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.status, 'failed');
});

// ---- what it cannot say ---------------------------------------------------------------

t('the cold start is stated, not papered over', () => {
  // "3 settled in time" over two days of history reads exactly like one over
  // a year. Overdue, by contrast, is complete from the first run.
  const c = F.caveats({ snapshotsStart: '2026-10-22' });
  assert.ok(c.some(l => /stands in for/.test(l)), 'it does not say it is a stand-in');
  assert.ok(c.some(l => /Snapshots start 2026-10-22/.test(l)));
  assert.ok(c.some(l => /OVERDUE is complete from day/.test(l)));
});

t('a day nobody looked is reported', () => {
  const c = F.caveats({ snapshotsStart: '2026-10-22', runs: { missedDays: 3 } });
  assert.ok(c.some(l => /3 day\(s\)/.test(l)));
});

t('a suspect last run is said out loud', () => {
  const c = F.caveats({ runs: { lastStatus: 'suspect', lastGoodOn: '2026-11-02' } });
  assert.ok(c.some(l => /THE LAST SNAPSHOT WAS NOT USED/.test(l)));
  assert.ok(c.some(l => /2026-11-02/.test(l)));
});

// ---- tenant_status ---------------------------------------------------------------------

t('statuses are counted, with no names', () => {
  // 215 deposits against 283 occupied units only makes sense if current
  // residents are in the list too. The counts settle it on the record.
  const c = F.statusCounts([
    { tenant_status: 'Current', tenant_name: 'should not matter' },
    { tenant_status: 'Current' },
    { tenant_status: 'Past' },
    { tenant_status: '' },
  ]);
  assert.deepStrictEqual(c, { Current: 2, Past: 1, '(blank)': 1 });
});

// ---- the projection ----------------------------------------------------------------

t('names, emails and phones never reach the disk', () => {
  const p = F.projectFeedRow({
    tenant_name: 'Jane Doe', co_tenant_name: 'John Doe', tenant_email: 'j@x.com',
    phone: '512-555-1212', mobile: '512-555-1213', ssn: '000-00-0000',
    street_address: '1 Main St', date_of_birth: '1990-01-01',
    tenant_status: 'Past', move_in: '2024-01-01', move_out: '2026-10-01',
    amount: '750.00', occupancy_id: '123', unit: '101',
  });
  assert.deepStrictEqual(Object.keys(p).sort(),
    ['amount', 'move_in', 'move_out', 'occupancy_id', 'tenant_status', 'unit']);
});

t('the deposit amount is KEPT', () => {
  // tenant-directory's projection drops /amount|deposit/ because its copy of a
  // balance is a stale second answer. Here the amount is the measurement. Same
  // word, opposite decision — which is why that projection is not reused.
  const TD = require('../lib/tenant-directory.js');
  assert.ok(typeof TD.project === 'function');
  assert.strictEqual(F.projectFeedRow({ amount: '750' }).amount, '750');
});

t('a column nobody has seen that looks like a name is dropped', () => {
  // Drop wins and drop is checked first, so a new column does not need
  // anybody to edit this file.
  const p = F.projectFeedRow({ guarantor_name: 'X', some_new_total: '5' });
  assert.ok(!('guarantor_name' in p));
  assert.strictEqual(p.some_new_total, '5');
});

// ---- the wiring ----------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

t('the section is PREVIEW ONLY — the 06:00 email is untouched', () => {
  // A section that starts appearing in a live email because a flag defaulted
  // the other way is how a half-checked number reaches Kara.
  const gather = read('lib/kara-brief-gather.js');
  assert.match(gather, /if \(d\.fas\) \{/, 'the FAS gather is not behind a flag');
  const preview = read('scripts/kara-brief-preview.js');
  assert.match(preview, /fas: true/, 'the preview does not turn it on');
  // server.js renders the real brief; it must not pass the flag.
  const server = read('server.js');
  const at = server.indexOf('karaBriefRender');
  assert.ok(at > 0);
  assert.ok(!/fas:\s*true/.test(server), 'the live brief turns the FAS section on');
});

t('the brief reads, and the snapshot is taken by the cron', () => {
  const gather = read('lib/kara-brief-gather.js');
  const fn = gather.slice(gather.indexOf('async function gatherFas'),
    gather.indexOf('async function gather(deps)'));
  assert.ok(!/insert\(|upsert\(|update\(|syncReport/.test(fn),
    'the brief writes or fetches — it reports what is on file');
});

t('an empty table is NOT MEASURABLE, never a clean week', () => {
  // The first morning the cron has not run. An empty table reading as "nothing
  // overdue" is the exact failure the old NOT MEASURABLE note existed to avoid.
  const gather = read('lib/kara-brief-gather.js');
  assert.match(gather, /No deposit snapshot has been taken yet/);
  assert.match(gather, /measurable: false/);
});

t('the sync refuses to settle from a short feed', () => {
  const sync = read('scripts/sync-deposit-snapshot.js');
  assert.match(sync, /if \(!guard\.ok\)/);
  assert.match(sync, /nothing settled/);
  // The refusal is recorded. A refusal nobody can see is a day nobody noticed.
  const block = sync.slice(sync.indexOf('if (!guard.ok)'), sync.indexOf('const idx = await propertyIndex'));
  assert.match(block, /deposit_sync_runs'\)\.insert\(run\)/);
});

t('first_seen_on is never overwritten', () => {
  // It is the first day we ever saw this deposit. Overwriting it with today
  // would make every row look new and every settlement look instant.
  const sync = read('scripts/sync-deposit-snapshot.js');
  assert.match(sync, /was && was\.first_seen_on \? \{ \.\.\.r, first_seen_on: was\.first_seen_on \}/);
});

t('the tombstone is written once', () => {
  // If the row already left, THAT earlier date is the one bracketing the
  // settlement — not the date of whichever run noticed it again.
  const sync = read('scripts/sync-deposit-snapshot.js');
  assert.match(sync, /if \(!r\.gone_first_seen_on\) patch\.gone_first_seen_on = day;/);
});

t('the cron runs at 04:00 Central, clear of the full 05:00 hour', () => {
  // 05:00 to 05:55 is taken five minutes apart and the delinquency_kpi comment
  // says 05:55 is the last slot before the brief: anything else has to
  // displace something, not squeeze between.
  const server = read('server.js');
  const at = server.indexOf("cron.schedule('0 4 * * *'");
  assert.ok(at > 0, 'the deposit cron is not at 04:00');
  const call = server.slice(at, at + 700);
  assert.match(call, /syncDepositSnapshot/);
  assert.match(call, /timezone: LYNDSAY_TIMEZONE/, 'it would run in UTC');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
