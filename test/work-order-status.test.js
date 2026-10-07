// What a work order's status means, and the reconciliation that uses it.
//
// THE BUG. Four screens each decided "is this closed" with
// s === 'completed' || s === 'cancelled' || s === 'canceled'. AppFolio also
// returns "Completed No Need To Bill" — 113 rows of it — and that test calls
// every one OPEN. Combined with a sync that only asks for open work orders and
// never learns that one closed, Erick's Command Center showed 436 where
// AppFolio had 95.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WOS = require('../lib/work-order-status.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

console.log('what counts as closed');
t('every closed spelling AppFolio actually returns', () => {
  ['Completed', 'completed', 'Complete', 'Canceled', 'Cancelled',
   'Completed No Need To Bill',          // the 113 the old test missed
   '  Completed  ',
  ].forEach(s => assert.strictEqual(WOS.isClosed(s), true, JSON.stringify(s)));
});
t('every open status stays open', () => {
  ['New', 'Assigned', 'Assigned by AppFolio', 'Scheduled', 'Waiting',
   'Estimate Requested', 'Estimated', 'Work Done', 'Ready to Bill', '', null, undefined,
  ].forEach(s => assert.strictEqual(WOS.isClosed(s), false, JSON.stringify(s)));
});
t('"Work Done" and "Ready to Bill" are NOT closed', () => {
  // They are money not yet billed. Treating them as finished would hide work
  // that still has to be invoiced — the Billable Labor Report exists for them.
  assert.strictEqual(WOS.isOpen('Work Done'), true);
  assert.strictEqual(WOS.isOpen('Ready to Bill'), true);
});

console.log('\nunknown is a third state, not a flavour of either');
t('it is neither open nor closed', () => {
  assert.strictEqual(WOS.isUnknown(WOS.UNKNOWN), true);
  assert.strictEqual(WOS.isClosed(WOS.UNKNOWN), false, 'counted as closed — claims something we do not know');
  assert.strictEqual(WOS.isOpen(WOS.UNKNOWN), false, 'counted as open — overstates the work');
});
t('tally splits all three and loses nothing', () => {
  const rows = [
    { status: 'Assigned' }, { status: 'Scheduled' },
    { status: 'Completed' }, { status: 'Completed No Need To Bill' }, { status: 'Canceled' },
    { status: WOS.UNKNOWN }, { status: WOS.UNKNOWN },
  ];
  const c = WOS.tally(rows);
  assert.deepStrictEqual(c, { open: 2, closed: 3, unknown: 2, total: 7, awaitingBilling: 0, fieldWork: 2 });
  assert.strictEqual(c.open + c.closed + c.unknown, c.total, 'a row fell through the cracks');
});

console.log('\nawaiting billing is a split of open, not a fourth bucket');
t('"Work Done" and "Ready to Bill" are the ones', () => {
  ['Work Done', 'work done', 'Ready to Bill', '  Ready To Bill  ']
    .forEach(s => assert.strictEqual(WOS.isAwaitingBilling(s), true, JSON.stringify(s)));
  ['Assigned', 'Scheduled', 'New', 'Waiting', '', null]
    .forEach(s => assert.strictEqual(WOS.isAwaitingBilling(s), false, JSON.stringify(s)));
});
t('they are still OPEN — the money is not collected', () => {
  // Counting them as closed would drop them out of the board entirely, and
  // they are precisely the rows the Billable Labor Report is for.
  ['Work Done', 'Ready to Bill'].forEach(s => {
    assert.strictEqual(WOS.isOpen(s), true, s + ' stopped being open');
    assert.strictEqual(WOS.isClosed(s), false, s + ' counted as closed');
    assert.strictEqual(WOS.isFieldWork(s), false, s + ' counted as work still to do on site');
  });
});
t('a closed or unknown row is never awaiting billing', () => {
  assert.strictEqual(WOS.isAwaitingBilling(WOS.UNKNOWN), false);
  assert.strictEqual(WOS.isAwaitingBilling('Completed'), false);
});
t('the split never double-counts', () => {
  const rows = [{ status: 'Assigned' }, { status: 'Work Done' }, { status: 'Ready to Bill' },
    { status: 'Completed' }, { status: WOS.UNKNOWN }];
  const c = WOS.tally(rows);
  assert.strictEqual(c.awaitingBilling + c.fieldWork, c.open, 'the split does not add up to open');
  assert.strictEqual(c.open + c.closed + c.unknown, c.total, 'the total stopped being the total');
  assert.strictEqual(c.awaitingBilling, 2);
  assert.strictEqual(c.fieldWork, 1);
});

console.log('\nthe screens use the shared rule');
t('the maintenance summary no longer defines its own isClosed', () => {
  assert.ok(!/const isClosed = st => \{[^}]*=== 'completed'/.test(server),
    'a screen still decides "closed" with an exact-match list of its own');
  assert.ok(/openWos = wos\.filter\(w => WOS\.isOpen\(w\.status\)\)/.test(server));
});
t('unknown rows are counted and listed, not hidden', () => {
  assert.ok(/unknownWos = wos\.filter\(w => WOS\.isUnknown\(w\.status\)\)/.test(server));
  assert.ok(/notInFeed: unknownWos\.length/.test(server), 'the count never reaches the payload');
  assert.ok(/notInFeedList/.test(server), 'there is a count but no way to look any of them up');
});
t('the EOD prints its own line for them', () => {
  assert.ok(/Not in AppFolio feed:/.test(server), 'the EOD folds them into open or drops them');
  assert.ok(/\$\{m5\.notInFeed\} — verify/.test(server), 'the line does not ask anyone to act');
});

console.log('\nthe reconciliation');
const REC = server.slice(server.indexOf('async function reconcileWorkOrders('),
  server.indexOf('// ── Supporting maintenance reports'));
t('it is a dry run unless told otherwise', () => {
  assert.ok(/\{ dryRun = true/.test(REC), 'it writes by default');
  assert.ok(/if \(dryRun \|\| !changes\.length\) return/.test(REC), 'dryRun does not short-circuit the write');
});
t('it NEVER deletes a row', () => {
  assert.ok(!/\.delete\(/.test(REC), 'the reconciliation deletes');
});
t('a row already settled is left alone', () => {
  // Re-running must not rewrite a row that is already closed.
  assert.ok(/if \(WOS\.isClosed\(r\.status\)\) return;/.test(REC),
    'a closed row can be rewritten');
});
t('an Unknown row is never rewritten as Unknown', () => {
  // Until 2026-10-07 this was enforced by skipping Unknown rows entirely
  // unless a sweep was running. That also meant a stored feed could not
  // resolve one: four rows sat in Unknown while wo_canceled held the answer
  // for all four. The invariant that mattered was never "do not look at
  // them", it was "do not churn them", and this is the line that holds it.
  assert.ok(/if \(WOS\.isUnknown\(r\.status\)\) return;\s*\/\/ still unresolved/.test(REC),
    'a row in neither feed must fall out rather than be stamped Unknown again');
});
t('a work order newer than the feed is not called a ghost', () => {
  // The feed is a snapshot. 21 work orders existed in AppFolio and not in our
  // table on 2026-10-05 simply because the sync had not run since the 2nd.
  assert.ok(/created > feedDay/.test(REC), 'rows created after the snapshot would be marked unknown');
});
t('nothing is written before the backup succeeds', () => {
  const backupAt = REC.indexOf('writeJSON(backupPath');
  const writeAt = REC.indexOf("from('maintenance_work_orders').update(");
  assert.ok(backupAt > 0 && writeAt > backupAt, 'rows change before the backup exists');
  assert.ok(/backup to disk failed, nothing written/.test(REC),
    'a failed backup does not stop the write');
});
t('a missing log table does not block the fix', () => {
  // The disk backup is what gates the write. Refusing to fix 362 rows because
  // a convenience log is missing would be the wrong trade.
  assert.ok(/backupTable = error \?/.test(REC));
  assert.ok(REC.indexOf('work_order_reconcile_log') < REC.indexOf("update(patch)"),
    'the table write is not attempted before the row writes');
});
t('it refuses to run on an empty feed', () => {
  // An empty feed would mark every open work order unknown in one pass.
  assert.ok(/no open feed available/.test(REC));
  assert.ok(/wo_completed store is empty/.test(REC));
});

console.log('\nthe sync stamps what it saw');
t('every synced row carries last_seen_in_feed', () => {
  const i = server.indexOf('const syncStamp = new Date().toISOString();');
  assert.ok(i > 0, 'there is no stamp');
  assert.ok(/rec\.last_seen_in_feed = syncStamp;/.test(server), 'rows are written without it');
});

console.log('\nthe reconcile log is writable');
t('the log insert does not spread the change object', () => {
  // It carries the work order's own `id`, a uuid, and the log's id is a
  // bigserial. Spreading it made Postgres try to parse a uuid as a bigint and
  // reject the whole batch — the disk backup was fine and the queryable log
  // was empty, which is the half somebody reaches for first. The columns are
  // listed explicitly so a new field on `changes` cannot break it again.
  const i = REC.indexOf("from('work_order_reconcile_log')");
  assert.ok(i > 0, 'the log insert is gone');
  const body = REC.slice(i, i + 700);
  assert.ok(!/\.\.\.c,/.test(body), 'the change object is spread into the log insert');
  ['work_order_number', 'status_before', 'status_after', 'reason'].forEach(f =>
    assert.ok(new RegExp(f + ':').test(body), `${f} is not written to the log`));
  assert.ok(!/\bid: /.test(body), 'the work order id is written into the log primary key');
});
t('a run can be undone from the log alone', () => {
  // status_before plus work_order_number is the whole undo. If either stopped
  // being written, the backup would be unusable without saying so.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '077_work_order_reconcile_log.sql'), 'utf8');
  assert.ok(/status_before/.test(sql) && /work_order_number/.test(sql));
  assert.ok(/set status = l\.status_before/.test(sql), 'the undo is not written down anywhere');
});

console.log('\nthe Billable Labor Report is untouched');
t('it never reads the work-order table or this rule', () => {
  // It is built from four CSVs Lyndsay uploads, because the API returns only
  // Completed work orders and "Work Done" / "Ready to Bill" are the two
  // statuses that represent money not yet billed.
  const br = fs.readFileSync(path.join(__dirname, '..', 'billable-report.js'), 'utf8');
  assert.ok(!/maintenance_work_orders/.test(br), 'it now reads the work-order table');
  assert.ok(!/isClosed|work-order-status/.test(br), 'it now shares the closed rule');
});

console.log(`\n${pass} passing`);
