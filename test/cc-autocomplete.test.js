// Command Center cards that close themselves.
//
// The dangerous failure here is not a card that stays open — Erick sees that.
// It is a card that closes when it should not: the work order is in a status
// nobody checked for, or the id was joined to the wrong record, and a real job
// disappears off the board looking handled. Most of what follows is about
// refusing to close rather than about closing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/cc-autocomplete.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cc = fs.readFileSync(path.join(__dirname, '..', 'public', 'command-center.js'), 'utf8');

const wo = (id, status, on) => [String(id), { work_order_id: id, status, completed_on: on }];
const WOS = new Map([
  wo(24231, 'Completed', '2026-09-17'),
  wo(24063, 'Completed No Need To Bill', '2026-09-10'),
  wo(22933, 'Canceled', '2026-09-29'),
  wo(22934, 'Canceled', '2026-09-29'),
  wo(24401, 'Assigned', null),
  wo(24022, 'Waiting', null),
  wo(24500, 'Work Done', null),
  wo(24501, 'Ready to Bill', null),
  wo(24502, 'Unknown — not in feed', null),
  wo(24503, 'Completed', null),            // closed, but no date
]);
const INSP = new Map([
  ['1430', { inspection_id: '1430', status: 'NEW', marked_done_on: null }],
  ['1431', { inspection_id: '1431', status: 'DONE', marked_done_on: '2026-10-02' }],
  ['1432', { inspection_id: '1432', status: 'IN PROGRESS', marked_done_on: null }],
]);
const SRC = { wos: WOS, inspections: INSP };
const card = (id, cat, woId) => ({ id, cat, wo: woId ? { woId: String(woId) } : {} });

// ---- what closes ------------------------------------------------------------
t('Completed closes a card, and says when', () => {
  const a = A.autoFor(card('pest:24231', 'pest', 24231), SRC);
  assert.strictEqual(a.kind, 'closed');
  assert.strictEqual(a.at, '2026-09-17');
});

t('Completed No Need To Bill closes it too', () => {
  assert.strictEqual(A.autoFor(card('urgent:24063', 'urgent', 24063), SRC).kind, 'closed');
});

t('Canceled closes it, but as cancelled — not as done', () => {
  const a = A.autoFor(card('pest:22933', 'pest', 22933), SRC);
  assert.strictEqual(a.kind, 'cancelled');
});

// ---- what must NOT close ----------------------------------------------------
t('Work Done does not close the card that exists to QC it', () => {
  assert.strictEqual(A.autoFor(card('workdone:24500', 'workdone', 24500), SRC), null);
});

t('Ready to Bill does not close it either', () => {
  assert.strictEqual(A.autoFor(card('workdone:24501', 'workdone', 24501), SRC), null);
});

t('"Unknown — not in feed" is the absence of an answer, never a closure', () => {
  assert.strictEqual(A.autoFor(card('urgent:24502', 'urgent', 24502), SRC), null);
});

t('an open status leaves the card alone', () => {
  assert.strictEqual(A.autoFor(card('assign:24401', 'assign', 24401), SRC), null);
  assert.strictEqual(A.autoFor(card('waiting:24022', 'waiting', 24022), SRC), null);
});

t('a work order that is not on file is unknown, not finished', () => {
  assert.strictEqual(A.autoFor(card('pest:99999', 'pest', 99999), SRC), null);
});

t('closed with no completion date does not close the card', () => {
  // There would be nothing to show and nothing to compare against the board's
  // day, so "closed, date unknown" stays open rather than closing silently.
  assert.strictEqual(A.autoFor(card('pest:24503', 'pest', 24503), SRC), null);
});

t('hours and inspreview never close, whatever the data says', () => {
  assert.strictEqual(A.autoFor({ id: 'hours:Andres Luevano', cat: 'hours', wo: {} }, SRC), null);
  // Even handed an inspection that IS done.
  assert.strictEqual(A.autoFor({ id: 'insprev:1431', cat: 'inspreview', wo: {} }, SRC), null);
  assert.ok(A.NEVER_AUTO.has('inspreview') && A.NEVER_AUTO.has('hours'));
});

// ---- inspections ------------------------------------------------------------
t('a pending inspection closes once it is DONE', () => {
  assert.strictEqual(A.autoFor({ id: 'insppend:1430', cat: 'insppending', wo: {} }, SRC), null);
  const a = A.autoFor({ id: 'insppend:1431', cat: 'insppending', wo: {} }, SRC);
  assert.strictEqual(a.kind, 'closed');
  assert.strictEqual(a.reason, 'inspection');
});

t('IN PROGRESS is not DONE', () => {
  assert.strictEqual(A.autoFor({ id: 'insppend:1432', cat: 'insppending', wo: {} }, SRC), null);
});

t('an inspection id is only read off an inspection card', () => {
  // 'pest:24231' and inspection 24231 are unrelated records that happen to
  // share a number. Reading the id off every card would join them.
  assert.strictEqual(A.cardInspectionId(card('pest:1431', 'pest', 1431)), null);
  assert.strictEqual(A.cardInspectionId({ id: 'insppend:1431', cat: 'insppending' }), '1431');
  // And a card whose inspection had no id falls back to property+unit+template.
  assert.strictEqual(A.cardInspectionId({ id: 'insppend:Ascent3-109Move In' }), null);
});

// ---- duplicates -------------------------------------------------------------
t('a duplicates card closes only when EVERY work order under it is closed', () => {
  assert.deepStrictEqual(A.cardWorkOrderIds({ id: 'dup:24231_24063', cat: 'duplicates' }),
    ['24231', '24063']);
  assert.ok(A.autoFor({ id: 'dup:24231_24063', cat: 'duplicates' }, SRC));
  // One still open -> the card stays.
  assert.strictEqual(A.autoFor({ id: 'dup:24231_24401', cat: 'duplicates' }, SRC), null);
  // One not on file -> unknown, so it stays.
  assert.strictEqual(A.autoFor({ id: 'dup:24231_99999', cat: 'duplicates' }, SRC), null);
});

t('a pair that was all cancelled reads cancelled; a mixed pair reads closed', () => {
  assert.strictEqual(A.autoFor({ id: 'dup:22933_22934', cat: 'duplicates' }, SRC).kind, 'cancelled');
  assert.strictEqual(A.autoFor({ id: 'dup:22933_24231', cat: 'duplicates' }, SRC).kind, 'closed');
});

// ---- the board's own day ----------------------------------------------------
t('a work order closed AFTER the board date did not close that board', () => {
  const c = card('pest:24231', 'pest', 24231);           // closed 2026-09-17
  assert.ok(A.autoFor(c, { ...SRC, on: '2026-09-18' }));
  assert.strictEqual(A.autoFor(c, { ...SRC, on: '2026-09-16' }), null);
  assert.ok(A.autoFor(c, { ...SRC, on: '2026-09-17' }), 'same day counts');
});

// ---- the override -----------------------------------------------------------
t('a manual tick wins, and an explicit un-tick beats the automatic one', () => {
  const tasks = [card('pest:24231', 'pest', 24231)];
  const auto = A.autoMap(tasks, SRC);
  assert.deepStrictEqual(A.stateOf(tasks[0], {}, auto),
    { done: true, by: 'auto', kind: 'closed', at: '2026-09-17', status: 'Completed' });
  assert.deepStrictEqual(A.stateOf(tasks[0], { 'pest:24231': 1 }, auto), { done: true, by: 'manual' });
  // 0, not a deleted key: deleting it would let the automatic tick come back
  // on the next read and Erick could never un-tick it at all.
  assert.deepStrictEqual(A.stateOf(tasks[0], { 'pest:24231': 0 }, auto), { done: false, by: 'override' });
});

t('the override is falsy, so every old !!checks[id] reader still agrees', () => {
  assert.ok(!({ 'pest:24231': 0 })['pest:24231']);
});

// ---- the counts -------------------------------------------------------------
t('manual, automatic and routine are counted apart', () => {
  const tasks = [
    card('pest:24231', 'pest', 24231),     // auto
    card('urgent:24063', 'urgent', 24063), // auto
    card('assign:24401', 'assign', 24401), // open
    card('waiting:24022', 'waiting', 24022),
  ];
  const auto = A.autoMap(tasks, SRC);
  const c = A.countsFor(tasks, { 'assign:24401': 1, 'routine:qc': 1, 'routine:parts': 1 }, auto);
  assert.deepStrictEqual(c, {
    completed_tasks: 3, completed_manual: 1, completed_auto: 2, completed_routine: 2,
  });
});

t('an overridden auto-tick counts as nothing at all', () => {
  const tasks = [card('pest:24231', 'pest', 24231)];
  const auto = A.autoMap(tasks, SRC);
  const c = A.countsFor(tasks, { 'pest:24231': 0 }, auto);
  assert.strictEqual(c.completed_tasks, 0);
  assert.strictEqual(c.completed_auto, 0);
  assert.strictEqual(c.completed_manual, 0);
});

t('the routines are what completed_tasks had been missing all along', () => {
  // Eight boards, every one reading 0, because the only ticks were routine:*
  // and the routines are not in tasks. Counted now, in their own column.
  const c = A.countsFor([], { 'routine:qc': 1, 'routine:texts': 1 }, {});
  assert.strictEqual(c.completed_routine, 2);
  assert.strictEqual(c.completed_tasks, 0, 'routines are not report tasks');
});

t('a tick on a card that is no longer on the board is not a report task', () => {
  const c = A.countsFor([card('pest:24231', 'pest', 24231)], { 'pest:00000': 1 }, {});
  assert.strictEqual(c.completed_manual, 0);
  assert.strictEqual(c.completed_routine, 1, 'it is counted somewhere, never dropped');
});

// ---- the join, which is the thing most likely to be got wrong ---------------
t('cards join on work_order_id — the number and the request id are not it', () => {
  assert.deepStrictEqual(A.cardWorkOrderIds(card('pest:24231', 'pest', 24231)), ['24231']);
  const sel = server.slice(server.indexOf('async function ccClosureSources'));
  const body = sel.slice(0, sel.indexOf('app.get('));
  assert.ok(/work_order_id, status, completed_on/.test(body));
  assert.ok(/set\(String\(r\.work_order_id\)/.test(body));
  assert.ok(!/work_order_number/.test(body),
    'matching on work_order_number finds nothing and looks like "nothing ever closes"');
});

// ---- the server ------------------------------------------------------------
t('the automatic ticks are computed on read, never stored', () => {
  const get = server.slice(server.indexOf("app.get('/api/maintenance/command-center/state'"));
  const body = get.slice(0, get.indexOf("app.post('/api/maintenance/command-center/state'"));
  assert.ok(/ccAuto\.autoMap\(data\.tasks/.test(body));
  const row = server.slice(server.indexOf('const row = {'), server.indexOf('upsert(row'));
  assert.ok(!/\bauto\b\s*,/.test(row), 'the auto map must not be written into the row');
});

t('a feed that cannot be read is reported, not silently treated as "nothing closed"', () => {
  assert.ok(/autoError/.test(server));
  assert.ok(/could not check AppFolio, tick by hand/.test(cc),
    'the board has to say so, or Erick cannot tell it apart from a quiet day');
});

t('the four counts are stored, and the prune is gone', () => {
  assert.ok(/\.\.\.counts,/.test(server));
  assert.ok(!/CC_STATE_RETENTION_DAYS/.test(server), 'the retention constant should be gone');
  assert.ok(!/cc_daily_state'\)\.delete\(\)/.test(server), 'nothing may delete from cc_daily_state');
});

t('a save survives the window before the new columns exist', () => {
  const post = server.slice(server.indexOf("app.post('/api/maintenance/command-center/state'"));
  assert.ok(/completed_\(manual\|auto\|routine\)/.test(post),
    'the retry must be keyed on the missing-column error');
  assert.ok(/console\.warn/.test(post), 'and it must say that it degraded');
});

// ---- the client ------------------------------------------------------------
t('un-ticking an automatic card records 0 rather than deleting the key', () => {
  assert.ok(/} else if \(ccAuto\[t\.id\]\) \{[\s\S]{0,400}ccChecks\[t\.id\] = 0;/.test(cc),
    'deleting it would let the automatic tick return on the next read');
});

t('cancelled is shown apart from closed', () => {
  assert.ok(/cancelled in AppFolio/.test(cc));
  assert.ok(/closed in AppFolio/.test(cc));
  assert.ok(/\.cc-auto\.cancelled/.test(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8')),
    'and it must not wear the colour that means done well');
});

t('the open counts read the three states, not the raw checks object', () => {
  assert.ok(!/filter\(t => !ccChecks\[t\.id\]\)/.test(cc),
    'a card closed in AppFolio would otherwise still be counted as open');
  assert.ok(/const ccIsDone = t => ccStateOf\(t\)\.done;/.test(cc));
});


// ---- inspreview stopped being a task ---------------------------------------
//
// The probe on 2026-10-06 read inspection_detail directly: beyond the eleven
// columns the sync keeps it returns only inspected_on, occupancy_id, unit_id
// and unit_turn_id -- nothing about a review, an approval or an update -- and
// "Erick" appears in no column of any row. marked_done_by holds whoever marked
// it FIRST, always the tech. So the review can be done perfectly and the card
// can never clear, and a checkbox that doing the job cannot satisfy teaches
// the person to ignore the board.
t('inspreview is no longer a task category at all', () => {
  assert.ok(!/key:\s*'inspreview'/.test(cc), 'it must not be in CC_CATS');
  assert.ok(/cat: 'insppending'/.test(cc), 'pending inspections are still tasks');
});

t('reviewed inspections go to their own list, not into the task list', () => {
  assert.ok(/CC_INSP_REVIEW\.push\(/.test(cc));
  const fn = cc.slice(cc.indexOf('function ccInspectionTasks'));
  const body = fn.slice(0, fn.indexOf('function ccRenderInspReview'));
  assert.ok(!/insprev:/.test(body),
    'nothing may be pushed onto the task list for a reviewed inspection');
});

t('the list is rendered without a checkbox', () => {
  const fn = cc.slice(cc.indexOf('function ccRenderInspReview'));
  const body = fn.slice(0, fn.indexOf('host.appendChild(c);', 10) + 20);
  assert.ok(!/cc-tck|type="checkbox"/.test(body), 'a tick here could never be satisfied');
  assert.ok(/Inspections marked by techs/.test(body));
  assert.ok(/Not a task and not counted/.test(body), 'the page has to say why');
});

t('an entry drops off seven days after it was marked done', () => {
  assert.ok(/const CC_INSP_REVIEW_DAYS = 7;/.test(cc));
  assert.ok(/age != null && age > CC_INSP_REVIEW_DAYS/.test(cc));
});

t('an entry with NO date is kept, not silently dropped', () => {
  // There is no clock to have run out, and hiding it would repeat the failure
  // this whole change is about.
  assert.ok(/age != null &&/.test(cc),
    'the expiry must require a date rather than treating null as expired');
  assert.ok(/no date/.test(cc), 'and it must say so on screen');
});

t('the date it counts from is carried through the sync path too', () => {
  assert.ok(/markedDoneOn:\['markeddoneon'/.test(cc), 'a column candidate');
  assert.ok(/'Marked Done On': r\.marked_done_on/.test(cc),
    'without this the sync-fed board has no clock and nothing would ever expire');
  const hdr = cc.slice(cc.indexOf('CC_INSP_HEADERS'), cc.indexOf('CC_INSP_HEADERS') + 400);
  assert.ok(/'Marked Done On'/.test(hdr), 'the header list must offer it, or ccIngest will not map it');
});

t('old boards stop contributing invisible tasks', () => {
  // Eight stored boards carry 46 inspreview cards each. Left in CC_TASKS they
  // would render nowhere and still count against the day's total.
  assert.ok(/state\.tasks\.filter\(t => t && t\.cat !== 'inspreview'\)/.test(cc));
});

t('the auto-close guard still refuses inspreview, for the stored boards', () => {
  assert.ok(A.NEVER_AUTO.has('inspreview'));
  assert.strictEqual(A.autoFor({ id: 'insprev:1431', cat: 'inspreview', wo: {} },
    { wos: WOS, inspections: INSP }), null);
});


// ---- the closure loop, which is what makes any of this move -----------------
//
// Until 2026-10-06 nothing wrote a closed status into maintenance_work_orders.
// The 06:00 sync asks for OPEN codes only and drops anything closed before it
// writes; wo_completed went to the disk store, not the table; and
// reconcileWorkOrders was on no schedule. The auto-tick read that column, so a
// card could never tick itself -- every closure the dry run found came from one
// manual sweep.
t('the loop runs the three steps in the order each one needs', () => {
  const fn = server.slice(server.indexOf('async function workOrderClosureLoop'));
  const body = fn.slice(0, fn.indexOf('cron.schedule'));
  const open = body.indexOf("syncReport('wo_all')");
  const comp = body.indexOf("syncReport('wo_completed')");
  const rec = body.indexOf("'/api/maintenance/reconcile'");
  assert.ok(open > 0 && comp > open && rec > comp,
    'wo_all, then wo_completed, then reconcile -- each needs the one before it');
});

t('the reconcile step actually writes, since dryRun is the route default', () => {
  const fn = server.slice(server.indexOf('async function workOrderClosureLoop'));
  assert.ok(/'\/api\/maintenance\/reconcile', \{ write: true \}/.test(fn.slice(0, 1600)),
    'without write:true the loop would do the measuring and none of the writing');
});

t('every AppFolio call in the loop is spaced, not fired together', () => {
  const fn = server.slice(server.indexOf('async function workOrderClosureLoop'));
  const body = fn.slice(0, fn.indexOf('cron.schedule'));
  // Counted against the calls rather than fixed at a number, so adding a
  // fourth feed one day cannot quietly skip its gap.
  const calls = (body.match(/af\.syncReport\(/g) || []).length;
  assert.strictEqual(calls, 3, 'open, completed, canceled');
  assert.strictEqual(body.split('await sleep(WO_LOOP_GAP_MS)').length - 1, calls,
    'one gap after each call, including the last before the reconcile');
  assert.ok(/const WO_LOOP_GAP_MS = 2500;/.test(server));
});

t('cancellations have their own feed and are not folded into completions', () => {
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  assert.ok(/id: 'wo_canceled'/.test(reports));
  assert.ok(/work_order_statuses: \['5'\]/.test(reports));
  // wo_completed must stay 4 + 7: the EOD counts today's completions out of
  // that store and the scheduling feed measures cycle time from it. A
  // cancellation is neither.
  assert.ok(/params: \{ work_order_statuses: \['4', '7'\] \}/.test(reports));
});

t('the reconciliation reads the cancellations, and survives an empty store', () => {
  const fn = server.slice(server.indexOf('async function reconcileWorkOrders'));
  const body = fn.slice(0, fn.indexOf('const { data: table'));
  assert.ok(/readReportData\('wo_canceled'\)/.test(body));
  assert.ok(!/canceledRows\.length\) return/.test(body),
    'an unsynced cancellation store must not stop the work orders it already can close');
  assert.ok(/canceledRows\.forEach[\s\S]{0,160}!closedBy\.has\(k\)/.test(body),
    'completed wins a collision');
});

t('a click plus the hourly job stays under the limit', () => {
  const batch = Number(/const CC_SYNC_BATCH = (\d+);/.exec(cc)[1]);
  assert.ok(batch + 3 <= 7, batch + ' + 3 calls from the loop exceeds 7 per 15s');
});

t('the nightly snapshot names the Central day, not the server one', () => {
  const fn = server.slice(server.indexOf('async function ccNightlySnapshot'));
  const head = fn.slice(0, fn.indexOf('const { data: existing'));
  assert.ok(/WEEK\.toChicagoYMD\(new Date\(\)\)/.test(head));
  // Comments stripped first: the note above this line explains the bug by
  // NAMING reportDateStr(), and an assertion that matched my own prose would
  // pass or fail on how the comment is worded.
  const code = head.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/reportDateStr\(\)/.test(code),
    'Render runs on UTC: at 23:30 CT reportDateStr() is already tomorrow, and the '
    + 'first run wrote a board_opened:false row for a day that had not happened yet');
});

t('a board that someone opened stops claiming nobody did', () => {
  const post = server.slice(server.indexOf("app.post('/api/maintenance/command-center/state'"));
  const row = post.slice(post.indexOf('const row = {'), post.indexOf('upsert(row'));
  assert.ok(/board_opened: true/.test(row));
});

t('it runs hourly through the working day, in Central time', () => {
  assert.ok(/cron\.schedule\('0 7-19 \* \* \*'/.test(server));
  const at = server.indexOf("cron.schedule('0 7-19 * * *'");
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(server.slice(at, at + 700)),
    'on UTC this would run 02:00-14:00 CT, which is the wrong half of the day');
});

t('a failure is logged where the other jobs report, not only to console', () => {
  const at = server.indexOf("cron.schedule('0 7-19 * * *'");
  assert.ok(/logLine\(`\[wo-loop\] FAILED/.test(server.slice(at, at + 900)));
});

// ---- the nightly snapshot ---------------------------------------------------
t('the day gets a row even when nobody opened the board', () => {
  const fn = server.slice(server.indexOf('async function ccNightlySnapshot'));
  const body = fn.slice(0, fn.indexOf('cron.schedule'));
  assert.ok(/if \(!existing\)/.test(body));
  assert.ok(/board_opened: false/.test(body),
    'a missing row and a quiet day must not look the same in the history');
  assert.ok(/completed_routine: 0/.test(body), 'zeros, not nulls -- nothing was ticked');
});

t('an opened board is recounted against the work orders as they stand now', () => {
  const fn = server.slice(server.indexOf('async function ccNightlySnapshot'));
  const body = fn.slice(0, fn.indexOf('cron.schedule'));
  assert.ok(/ccAuto\.autoMap\(existing\.tasks/.test(body),
    'the last save can be hours and several closure runs old');
  assert.ok(/ccAuto\.countsFor\(existing\.tasks/.test(body));
});

t('if the closure data cannot be read, the stored counts are left alone', () => {
  const fn = server.slice(server.indexOf('async function ccNightlySnapshot'));
  const body = fn.slice(0, fn.indexOf('cron.schedule'));
  const c = body.indexOf('catch (e)');
  assert.ok(/return \{[\s\S]{0,200}skipped:/.test(body.slice(c)),
    'overwriting with counts built from no closure data would be a wrong number, not a gap');
});

t('it runs at 23:30 Central, before midnight rolls the date', () => {
  assert.ok(/cron\.schedule\('30 23 \* \* \*'/.test(server));
  const at = server.indexOf("cron.schedule('30 23 * * *'");
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(server.slice(at, at + 400)));
});

t('the snapshot degrades if board_opened has not been added yet', () => {
  const fn = server.slice(server.indexOf('async function ccNightlySnapshot'));
  assert.ok(/\/board_opened\/\.test/.test(fn.slice(0, 2500)),
    'the column is added by hand, and a missing one must not cost the whole row');
});

// ---- the false comment ------------------------------------------------------
t('the comment that said the sync reconciles is gone', () => {
  assert.ok(!/Runs AFTER the sync, inside the same request/.test(server));
  assert.ok(/IT DOES NOT RUN AFTER THE SYNC/.test(server));
  // And it is still true: the sync route must not call it.
  const sync = server.slice(server.indexOf("app.post('/api/maintenance/sync'"));
  const body = sync.slice(0, sync.indexOf('// ── Work-order reconciliation'));
  assert.ok(!/reconcileWorkOrders/.test(body));
});

// ---- the rate limit ---------------------------------------------------------
t('the Sync button goes in batches, not all seven at once', () => {
  assert.ok(/const CC_SYNC_BATCH = \d+;/.test(cc));
  assert.ok(!/Promise\.all\(CC_SYNC_DEFS\.map/.test(cc),
    'seven at once sat exactly on the AppFolio limit with no headroom');
  assert.ok(/CC_SYNC_BATCH_PAUSE_MS/.test(cc), 'and the next batch waits out the window');
});

t('a click plus the hourly job stays under seven in any fifteen seconds', () => {
  // The loop makes three calls now, so the batch came down from four to three.
  const m = cc.match(/const CC_SYNC_BATCH = (\d+);/);
  assert.ok(Number(m[1]) + 3 <= 7, 'a click and the job must be able to overlap safely');
});

// ---- attribution ------------------------------------------------------------
t('the three kinds of done are shown apart and never summed into one', () => {
  const fn = cc.slice(cc.indexOf('function ccUpdateProgress'));
  const body = fn.slice(0, fn.indexOf('const CC_ROUTINE'));
  assert.ok(/closed in AppFolio/.test(body));
  assert.ok(/ticked here/.test(body));
  assert.ok(/daily routine/.test(body));
});

t('a closure is attributed to nobody, because AppFolio does not say', () => {
  const fn = cc.slice(cc.indexOf('function ccUpdateProgress'));
  const body = fn.slice(0, fn.indexOf('const CC_ROUTINE'));
  assert.ok(!/by (a tech|the tech|Erick)/i.test(body),
    'there is no field for who closed a work order; assigned_user is who it went to');
  assert.ok(/no field for who closed/.test(body), 'and the reason is written down');
});

t('cancelled is broken out of the automatic figure', () => {
  const fn = cc.slice(cc.indexOf('function ccUpdateProgress'));
  const body = fn.slice(0, fn.indexOf('const CC_ROUTINE'));
  assert.ok(/st\.kind === 'cancelled'/.test(body));
  assert.ok(/cancelled\)/.test(body));
});

console.log(`\n${pass} passing`);
