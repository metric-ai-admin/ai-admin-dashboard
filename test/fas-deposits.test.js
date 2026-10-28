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

t('five business days is the default, because Kara confirmed it', () => {
  // 2026-10-28. It lives in code rather than in an environment variable on
  // purpose: a decided rule kept in config reverts the first time somebody
  // runs this where the variable is not set, and reverts SILENTLY, to a
  // deadline three times longer.
  assert.strictEqual(F.DEFAULT_DEADLINE.days, 5);
  assert.strictEqual(F.DEFAULT_DEADLINE.basis, 'business');
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-16', 'calendar'), 15);
});

t('the refund deadline is recorded, and is NOT this one', () => {
  // Both numbers are real and they measure different things: 5 business days
  // for the statement, 15 calendar for the refund. The file used to call them
  // two readings of one rule, which is what made "OVERDUE: 2" ambiguous.
  assert.strictEqual(F.REFUND_DEADLINE.days, 15);
  assert.strictEqual(F.REFUND_DEADLINE.basis, 'calendar');
  assert.notStrictEqual(F.REFUND_DEADLINE.days, F.DEFAULT_DEADLINE.days);
  assert.match(F.REFUND_DEADLINE.source, /refund/i);
});

t('business days skip the weekend', () => {
  // Thursday 10/01 to Thursday 10/15 is 14 calendar days and 10 working ones.
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-15', 'calendar'), 14);
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-15', 'business'), 10);
  // The move-out day itself is day 0 on both bases.
  assert.strictEqual(F.daysBetween('2026-10-01', '2026-10-01', 'business'), 0);
});

t('exactly on the deadline is still in time', () => {
  // Day N is not late; day N+1 is. An off-by-one here is a property called
  // out on a day it had not missed anything.
  //
  // THE CLOCK IS PASSED IN, not left to the default. These dates were picked
  // for calendar arithmetic, and reading the default would make this test
  // about whatever the default happens to be rather than about the boundary.
  const CAL = { days: 15, basis: 'calendar' };
  const c = F.classify(row({ move_out: '2026-10-01' }), '2026-10-16', CAL);
  assert.strictEqual(c.days, 15);
  assert.strictEqual(c.bucket, 'withinWindow');
  const d = F.classify(row({ move_out: '2026-10-01' }), '2026-10-17', CAL);
  assert.strictEqual(d.bucket, 'overdue');
});

t('the boundary holds on the clock Kara actually chose', () => {
  // 5 business days from Thursday 2026-10-01: Fri 2, Mon 5, Tue 6, Wed 7,
  // Thu 8. So Thursday the 8th is day 5 and still in time, and Friday the
  // 9th is day 6 and late — a weekend sits inside the window, which is the
  // whole reason the basis matters.
  const c = F.classify(row({ move_out: '2026-10-01' }), '2026-10-08');
  assert.strictEqual(c.days, 5);
  assert.strictEqual(c.bucket, 'withinWindow');
  const d = F.classify(row({ move_out: '2026-10-01' }), '2026-10-09');
  assert.strictEqual(d.days, 6);
  assert.strictEqual(d.bucket, 'overdue');
  // And the same move-out is comfortably inside the 15 calendar refund clock
  // on that day. Two deadlines, not two readings of one.
  assert.strictEqual(
    F.classify(row({ move_out: '2026-10-01' }), '2026-10-09', F.REFUND_DEADLINE).bucket,
    'withinWindow');
});

// ---- which deadline Kara means --------------------------------------------------
//
// Five business days (2026-10-09, for the statement) or fifteen calendar
// (2026-10-14, for the refund). Arturo is confirming. They are not close
// enough to shrug at.

t('the two candidates sort the same move-out differently', () => {
  // A move-out on Friday 10/09, read on 10/20: inside one window, nine days
  // past the other. "OVERDUE: 2" means nothing without the clock beside it.
  const r = row({ move_out: '2026-10-09', unit: '108' });
  assert.strictEqual(F.classify(r, '2026-10-20', { days: 15, basis: 'calendar' }).bucket,
    'withinWindow');
  assert.strictEqual(F.classify(r, '2026-10-20', { days: 5, basis: 'business' }).bucket,
    'overdue');
});

t('both candidates are written down, with where each came from', () => {
  assert.strictEqual(F.DEADLINE_CANDIDATES.length, 2);
  const five = F.DEADLINE_CANDIDATES.find(c => c.days === 5);
  assert.strictEqual(five.basis, 'business');
  assert.match(five.source, /confirmed 2026-10-28/);
  const fifteen = F.DEADLINE_CANDIDATES.find(c => c.days === 15);
  assert.strictEqual(fifteen.basis, 'calendar');
  assert.match(fifteen.source, /2026-10-14/);
});

t('the caveat names the clock it USED, not a position in a list', () => {
  // "the first of those two" was wrong the moment the default was the second
  // one. A caveat that misreports which clock it used is worse than none.
  const five = F.caveats({ deadline: { days: 5, basis: 'business' }, deadlineUnconfirmed: true });
  assert.ok(five.some(l => /These counts use 5 business/.test(l)));
  assert.ok(five.some(l => /under 15 calendar/.test(l)));
  const fifteen = F.caveats({ deadline: { days: 15, basis: 'calendar' }, deadlineUnconfirmed: true });
  assert.ok(fifteen.some(l => /These counts use 15 calendar/.test(l)));
  assert.ok(fifteen.some(l => /under 5 business/.test(l)));
});

t('the deadline is always stated, confirmed or not', () => {
  const c = F.caveats({ deadline: { days: 5, basis: 'business' } });
  assert.ok(c.some(l => /Deadline used: 5 business days/.test(l)));
  assert.ok(!c.some(l => /NOT CONFIRMED/.test(l)), 'it nags after she has answered');
});

t('a deadline read from a flag or the environment is normalised', () => {
  // A typo must become the default, never NaN days — which would make every
  // comparison false and every move-out look fine.
  assert.deepStrictEqual(F.readDeadline('5', 'business'), { days: 5, basis: 'business' });
  assert.deepStrictEqual(F.readDeadline(5, 'BUSINESS'), { days: 5, basis: 'business' });
  assert.deepStrictEqual(F.readDeadline(undefined, undefined), F.DEFAULT_DEADLINE);
  assert.deepStrictEqual(F.readDeadline('abc', 'weekdays'), F.DEFAULT_DEADLINE);
  assert.deepStrictEqual(F.readDeadline('0', ''), F.DEFAULT_DEADLINE, 'zero days is not a deadline');
  assert.deepStrictEqual(F.readDeadline('-3', ''), F.DEFAULT_DEADLINE);
});

t('it can be changed without a deploy', () => {
  // The answer is one message from Kara away; editing a number in code and
  // redeploying to apply it is how it waits a week instead.
  // Required locally: the file's own `fs` const is declared further down, and
  // a const is in its temporal dead zone until then.
  const preview = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'kara-brief-preview.js'), 'utf8');
  assert.match(preview, /FAS_DEADLINE_DAYS/);
  assert.match(preview, /FAS_DEADLINE_BASIS/);
  assert.match(preview, /FAS\.readDeadline\(/);
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
  // Calendar clock, passed in: the 14 below is a calendar count.
  const c = F.classify(row({
    move_out: '2026-10-20', last_seen_on: '2026-11-03', gone_first_seen_on: '2026-11-06',
  }), '2026-11-10', { days: 15, basis: 'calendar' });
  assert.strictEqual(c.days, 14);
  assert.strictEqual(c.bucket, 'settledInTime');
  // On the deadline Kara chose, the SAME settlement is late — 10 business
  // days against a window of 5. The bucket follows the clock, as it must.
  const live = F.classify(row({
    move_out: '2026-10-20', last_seen_on: '2026-11-03', gone_first_seen_on: '2026-11-06',
  }), '2026-11-10');
  assert.strictEqual(live.bucket, 'settledLate');
});

t('a settlement after the deadline is its own bucket', () => {
  const c = F.classify(row({
    move_out: '2026-10-01', last_seen_on: '2026-10-30', gone_first_seen_on: '2026-10-31',
  }), '2026-11-10', { days: 15, basis: 'calendar' });
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
    // Thu 10-01 to Mon 10-05 is 2 business days, inside the 5 Kara chose.
    row({ occupancy_id: '6', move_out: '2026-10-01', last_seen_on: '2026-10-05', gone_first_seen_on: '2026-10-06' }),
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
  // BUSINESS days, on the default clock: 2026-09-29 to 2026-10-22 is 23
  // calendar days and 17 working ones. The order is what this test is for,
  // and it does not change with the basis — but the number printed beside
  // the unit does, and Kara reads that number.
  assert.strictEqual(b.overdueUnits[0].days, 17);
  assert.strictEqual(
    F.byProperty([row({ occupancy_id: '1', unit: '108', move_out: '2026-09-29' })],
      '2026-10-22', { deadline: { days: 15, basis: 'calendar' } })
      .properties['Ascent at Northgate'].overdueUnits[0].days, 23);
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

// ---- the parameter, and the blind spot it created --------------------------

t('THE DEPOSIT REPORT ASKS FOR EVERY TENANT STATUS', () => {
  // Probed 2026-10-27: without tenant_statuses the report answers for CURRENT
  // residents only — 216 rows, zero past move-outs. Since settlement is
  // derived from a row STOPPING coming back, every move-out read as a
  // returned deposit. This is the fix, asserted where it lives.
  const reports = read('appfolio-reports.js');
  const at = reports.indexOf("id: 'security_deposit_funds_detail'");
  assert.ok(at > 0, 'the deposit report registration moved');
  const block = reports.slice(at, reports.indexOf('project:', at));
  assert.match(block, /tenant_statuses:/, 'the deposit sync still asks for current residents only');
  // All thirteen. Asking for only the four that return rows today re-creates
  // the bug one category down, which is the whole argument for the list.
  for (let i = 0; i <= 12; i++) {
    assert.ok(new RegExp("'" + i + "'").test(block), 'tenant_status ' + i + ' is not asked for');
  }
  assert.match(block, /property_visibility: 'active'/, 'the visibility filter was lost');
});

t('258 -> 216: THE OLD GUARD MISSES IT, THE NEW ONE CATCHES IT', () => {
  // The exact regression the fix created. If the tenant_statuses parameter is
  // ever lost, the feed falls 258 -> 216 — 16.3%, UNDER the 20% threshold —
  // and the size guard waves through a run that settles 42 deposits.
  const before = { Current: 212, Past: 35, Evict: 7, Notice: 4 };   // 258
  const after = { Current: 212, Notice: 4 };                        // 216

  const size = F.feedGuard(216, 258, 20);
  assert.strictEqual(size.ok, true,
    'this test is no longer reproducing the blind spot — check the threshold');
  assert.ok(size.dropPct < 20 && size.dropPct > 15, 'the drop should be ~16%, got ' + size.dropPct);

  const shape = F.compositionGuard(after, before);
  assert.strictEqual(shape.ok, false, 'a vanished tenant status was not caught');
  assert.deepStrictEqual(shape.vanished, ['Evict', 'Past']);
  assert.match(shape.reason, /Past \(35 last time, none now\)/);
  assert.match(shape.reason, /Nothing was settled/);
});

t('the composition guard does not fire on ordinary movement', () => {
  const before = { Current: 212, Past: 35, Evict: 7, Notice: 4 };
  // Small statuses genuinely bounce. Seven becoming three is a Tuesday.
  assert.strictEqual(F.compositionGuard({ Current: 210, Past: 40, Evict: 3, Notice: 9 }, before).ok, true);
  // A status appearing for the first time is not a vanishing.
  assert.strictEqual(F.compositionGuard({ ...before, Renewal: 2 }, before).ok, true);
  // And the growth that the fix itself causes must pass, or the first run
  // after the parameter lands refuses itself.
  assert.strictEqual(F.compositionGuard(before, { Current: 212, Notice: 4 }).ok, true,
    'the day the fix lands, the guard blocks its own improvement');
  assert.strictEqual(F.feedGuard(258, 216, 20).ok, true, 'the size guard blocked a RISE');
});

t('a status that was already zero cannot vanish', () => {
  // Only statuses that HAD rows count. A zero going to zero is not evidence.
  const g = F.compositionGuard({ Current: 5 }, { Current: 5, Past: 0, Evict: 0 });
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(g.vanished, []);
});

t('NO PREVIOUS SHAPE IS NOT A FAILED CHECK', () => {
  // The first run, or a run recorded before status_counts existed. Absence of
  // a comparison must read as "cannot say", never as "something vanished" —
  // a guard that refuses on its first morning is a guard nobody keeps.
  [null, undefined, {}, 'nonsense', 5].forEach(prev => {
    const g = F.compositionGuard({ Current: 212 }, prev);
    assert.strictEqual(g.ok, true, String(prev) + ' was treated as evidence');
    assert.strictEqual(g.reason, null);
  });
  // And a feed that returned nothing at all is the size guard's business,
  // not this one's: it still reports the vanishing rather than inventing a
  // different verdict.
  assert.strictEqual(F.compositionGuard({}, { Current: 212 }).ok, false);
});

t('EITHER GUARD REFUSES, AND THE SYNC WIRES BOTH', () => {
  const sync = read('scripts/sync-deposit-snapshot.js');
  assert.match(sync, /compositionGuard\(counts, previousCounts\)/,
    'the sync never calls the composition guard');
  assert.match(sync, /status_counts/, 'the previous run\'s shape is not read back');
  // The combined verdict must be a refusal when EITHER says so, and must not
  // throw away the size guard's `first` flag — the first run settles nothing.
  assert.match(sync, /sizeGuard\.ok && !shapeGuard\.ok/);
  assert.match(sync, /first: sizeGuard\.first/,
    'the first-run flag is dropped when the composition guard fires');
  // And nothing is settled on a refusal: that logic is shared, so this
  // asserts the refusal path still gates the settle.
  assert.match(sync, /if \(!guard\.ok\)/);
});

// ---- the brief reads what is there, all of it ------------------------------

t('THE BRIEF PAGES deposit_held, AND ORDERS IT BY THE RIGHT COLUMN', () => {
  // PostgREST caps a response at 1000 rows and .limit() does not raise it, so
  // a plain select returns a plausible short answer as the table grows — and
  // a deposit missing from the read is a deposit the brief does not report as
  // overdue. deposit_held is keyed on occupancy_id and has NO id column, so
  // the default order would page it unordered.
  const gather = read('lib/kara-brief-gather.js');
  const fn = gather.slice(gather.indexOf('async function gatherFas'),
    gather.indexOf('async function gather(deps)'));
  assert.match(fn, /order: 'occupancy_id'/, 'deposit_held is paged unordered, or not paged');
  assert.ok(!/await db\.from\('deposit_held'\)\s*\n?\s*\.select\([^)]*\);/.test(fn),
    'the unpaged select is still there');
  assert.match(gather, /gatherFas\(d\.db, todayCT, d\.fasDeadline, d\.fasDeadlineUnconfirmed, d\.selectAll\)/,
    'the caller does not hand gatherFas a pager');
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

// ---- the two renderers say the same thing -------------------------------------------
//
// The measurable branch was written into the text renderer and not the HTML
// one, so the moment the section became measurable the HTML dropped it
// entirely — and the HTML is the version Kara receives. An absent section
// reads as "no FAS is overdue", which is the one thing this alert exists to
// prevent. The preview's own text-vs-HTML check caught it; this pins it.

const H = require('../lib/kara-brief-html.js');
const BR = require('../lib/kara-brief.js');
const baseBrief = {
  properties: [], portfolio: {}, thresholds: [], collections: null, calls: null,
  occupancy: null, moveOuts: null, freshness: { asOf: 'x', lines: [] },
};
const bothFor = fas => {
  const built = BR.build({ ...baseBrief, fas });
  return {
    text: String(BR.render(built)),
    html: String(H.renderHtml(BR.build({ ...baseBrief, fas }))),
  };
};

t('measurable: the section is in BOTH renderers', () => {
  const fas = {
    measurable: true, deadline: F.DEFAULT_DEADLINE, snapshotsStart: '2026-10-22',
    statusCounts: { Current: 210, Notice: 5 },
    ...F.byProperty([row({ unit: '108', move_out: '2026-09-29' })], '2026-10-22'),
    caveats: F.caveats({ snapshotsStart: '2026-10-22', deadline: F.DEFAULT_DEADLINE }),
  };
  const r = bothFor(fas);
  assert.match(r.text, /FINAL ACCOUNT STATEMENTS/);
  assert.match(r.html, /Final account statements/,
    'the HTML dropped the section — this is the version Kara receives');
});

t('measurable: the numbers appear in both, not only the heading', () => {
  // A heading with an empty body is the other way this goes wrong.
  const fas = {
    measurable: true, deadline: F.DEFAULT_DEADLINE, snapshotsStart: '2026-10-22',
    ...F.byProperty([row({ unit: '108', move_out: '2026-09-29' })], '2026-10-22'),
    caveats: [],
  };
  const r = bothFor(fas);
  assert.match(r.text, /OVERDUE/);
  assert.match(r.html, /OVERDUE/);
  assert.match(r.text, /108/);
  assert.match(r.html, /108/);
  assert.match(r.text, /Ascent at Northgate/);
  assert.match(r.html, /Ascent at Northgate/);
});

t('not measurable: a reason-shaped object renders in both', () => {
  // gatherFas returns {measurable:false, reason:…}; the HTML read only `note`
  // and printed the heading with nothing under it.
  const r = bothFor({ measurable: false, reason: 'No deposit snapshot has been taken yet.' });
  assert.match(r.text, /No deposit snapshot has been taken yet/);
  assert.match(r.html, /No deposit snapshot has been taken yet/,
    'the HTML shows an empty section');
});

t('not measurable: an error-shaped object renders in both', () => {
  const r = bothFor({ measurable: false, error: 'relation deposit_held does not exist' });
  assert.match(r.text, /deposit_held does not exist/);
  assert.match(r.html, /deposit_held does not exist/);
});

t('the preview would no longer report a disagreement', () => {
  // The exact check the preview runs, over every shape the section takes.
  const shapes = [
    { measurable: false, reason: 'not yet' },
    { measurable: false, error: 'boom' },
    {
      measurable: true, deadline: F.DEFAULT_DEADLINE, snapshotsStart: '2026-10-22',
      ...F.byProperty([row({ move_out: '2026-09-29' })], '2026-10-22'), caveats: [],
    },
    // Measurable with nothing to report: still a section, because silence is
    // what it must never be.
    { measurable: true, deadline: F.DEFAULT_DEADLINE, properties: {}, unresolvedCount: 0, caveats: [] },
  ];
  shapes.forEach((fas, i) => {
    const r = bothFor(fas);
    const inText = /^FINAL ACCOUNT STATEMENTS/m.test(r.text);
    const inHtml = />Final account statements</.test(r.html);
    assert.strictEqual(inText, inHtml,
      'shape ' + i + ': text ' + inText + ' html ' + inHtml + ' — THEY DISAGREE');
  });
});

// ---- Kara's rules, confirmed 2026-10-28 ------------------------------------

t('a move-out with no deposit stays in the alert, with its age', () => {
  // HER RULE, IN HER WORDS: "no deposit — FAS still required", the charges go
  // to collections. The old line read "no deposit on file", which sounds like
  // a row with nothing to do — the opposite of what she asked for.
  const B = require('../lib/kara-brief.js');
  const brief = B.build({
    properties: [], portfolio: null, thresholds: null,
    fas: {
      measurable: true, deadline: F.DEFAULT_DEADLINE, snapshotsStart: '2026-10-22',
      unresolvedCount: 0, caveats: [],
      properties: {
        'Ascent at Northgate': {
          settledInTime: 0, settledLate: 0, withinWindow: 0, overdue: 0,
          noDeposit: 2, future: 0, noMoveOut: 0,
          overdueUnits: [], withinUnits: [],
          noDepositUnits: [{ unit: '108', days: 9 }, { unit: '311', days: 2 }],
        },
      },
    },
  });
  const text = B.render(brief, { testMode: true });
  assert.ok(/no deposit — FAS still required: 2/.test(text), text.slice(0, 400));
  // The units and HOW LONG. A move-out from last week and one from March are
  // not the same job, which is why the overdue line carries the age too.
  assert.ok(/108, 9 days/.test(text), 'the age is missing from the no-deposit line');
  assert.ok(/311, 2 days/.test(text));
  assert.ok(/charges go to collections/.test(text), 'the reason is not on the page');
  // And it is not quietly folded into the overdue count, which would put a
  // deadline figure on a clock this data cannot read.
  assert.ok(!/OVERDUE/.test(text), 'a no-deposit move-out was counted as overdue');
});

t('both renderers word it the same', () => {
  // They go to the same person. A difference between them is a question Kara
  // has to ask somebody.
  const B = require('../lib/kara-brief.js');
  const H = require('../lib/kara-brief-html.js');
  const input = {
    properties: [], portfolio: null, thresholds: null,
    fas: {
      measurable: true, deadline: F.DEFAULT_DEADLINE, snapshotsStart: '2026-10-22',
      unresolvedCount: 0, caveats: [],
      properties: {
        'The Chateau': {
          settledInTime: 0, settledLate: 0, withinWindow: 0, overdue: 0,
          noDeposit: 1, future: 0, noMoveOut: 0,
          overdueUnits: [], withinUnits: [], noDepositUnits: [{ unit: '12B', days: 4 }],
        },
      },
    },
  };
  const brief = B.build(input);
  assert.ok(/no deposit — FAS still required/.test(B.render(brief, { testMode: true })));
  assert.ok(/no deposit — FAS still required/.test(H.renderHtml(brief, { testMode: true })),
    'the HTML still says something else');
});

t('the confirmed caveat names the refund clock as a DIFFERENT rule', () => {
  const c = F.caveats({ deadline: F.DEFAULT_DEADLINE, deadlineUnconfirmed: false });
  assert.ok(c.some(l => /5 business days from move-out, confirmed by Kara/.test(l)));
  assert.ok(c.some(l => /REFUND deadline and is not what this section measures/.test(l)));
  // And it no longer asks for an answer it has.
  assert.ok(!c.some(l => /NOT CONFIRMED YET/.test(l)),
    'the section still says the deadline is open');
  assert.ok(!c.some(l => /sort differently/.test(l)),
    'the two deadlines are still offered as rival readings of one rule');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
