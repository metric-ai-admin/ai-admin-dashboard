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

console.log(`\n${pass} passing`);
