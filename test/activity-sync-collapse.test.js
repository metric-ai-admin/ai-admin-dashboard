// Collapsing a sync burst.
//
// One click on the Command Center's sync fires SEVEN endpoints — /api/
// maintenance/sync plus six under /sync/<what> — each logged as its own write.
// That is what Erick's "36 actions in Maintenance" was: five rows sharing the
// timestamp 14:43:16, four sharing 14:43:26. The count was of requests.
//
// Two halves, and they are separate on purpose: the LOGGER stops new rows at
// the source, and groupRuns folds the ones already written for reading. No
// audit row is deleted or rewritten — an audit log that discards rows is no
// longer one.
const assert = require('assert');
const LOG = require('../lib/activity-log.js');
const ACTS = require('../lib/activity-actions.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// The seven labels the seven endpoints really carry.
const LABELS = [
  'Synced work orders from AppFolio', 'Synced maintenance data from AppFolio',
  'Synced maintenance data from AppFolio', 'Synced maintenance data from AppFolio',
  'Synced maintenance data from AppFolio', 'Synced maintenance data from AppFolio',
  'Synced maintenance data from AppFolio',
];
const syncRow = (i, section) => ({
  user_email: 'erick@metricpropertymanagement.com', event: 'write',
  section: section || 'maintenance', entity_type: 'sync', action: LABELS[i % LABELS.length],
});
const mkLogger = clock => LOG.createLogger(() => Promise.resolve(),
  { setInterval: () => 0, now: () => clock.t });

console.log('sync collapse — the logger');

t('one seven-endpoint click becomes ONE row', () => {
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  for (let i = 0; i < 7; i++) { clock.t += 5000; L.log(syncRow(i)); }
  assert.strictEqual(L.stats().queued, 1);
  assert.strictEqual(L.stats().collapsed, 6);
});

t('the surviving row carries ONE canonical label, not whichever fired first', () => {
  const rows = [];
  const clock = { t: 1e6 };
  const L = LOG.createLogger(b => { rows.push(...b); return Promise.resolve(); },
    { setInterval: () => 0, now: () => clock.t });
  for (let i = 0; i < 7; i++) { clock.t += 5000; L.log(syncRow(i)); }
  L.flushNow();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].action, LOG.SYNC_LABEL);
  assert.strictEqual(rows[0].action, 'Synced from AppFolio');
});

t('a DELIBERATE second sync, minutes later, is a second row', () => {
  // The whole point is to stop counting requests, not to stop counting work.
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  L.log(syncRow(0));
  clock.t += LOG.COLLAPSE_MS + 1000;
  L.log(syncRow(0));
  assert.strictEqual(L.stats().queued, 2);
});

t('a long burst cannot extend its own window one row at a time', () => {
  // The run keeps the FIRST timestamp. Rows every 30s for five minutes would
  // otherwise never close the window and a later real sync would vanish.
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  for (let i = 0; i < 12; i++) { L.log(syncRow(i)); clock.t += 30000; }
  assert.ok(L.stats().queued >= 2,
    'a six-minute run collapsed into one row: the window is extending itself');
});

t('two sections are two bursts', () => {
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  L.log(syncRow(0, 'maintenance'));
  L.log(syncRow(0, 'leasing'));
  assert.strictEqual(L.stats().queued, 2);
});

t('two people syncing at once are not collapsed into one', () => {
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  L.log(syncRow(0));
  L.log(Object.assign(syncRow(0), { user_email: 'jay@metricpropertymanagement.com' }));
  assert.strictEqual(L.stats().queued, 2);
});

t('REAL WRITES ARE NEVER COLLAPSED', () => {
  // Marking five tasks done is five things somebody did. Only entity_type
  // 'sync' folds.
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  for (let i = 0; i < 5; i++) {
    L.log({ user_email: 'erick@x.com', event: 'write', section: 'maintenance',
      entity_type: 'task', action: 'Completed a task' });
  }
  assert.strictEqual(L.stats().queued, 5);
  assert.strictEqual(L.stats().collapsed, 0);
});

t('the recently-seen map stays bounded', () => {
  const clock = { t: 1e6 };
  const L = mkLogger(clock);
  for (let i = 0; i < 400; i++) {
    L.log(Object.assign(syncRow(0), { user_email: 'u' + i + '@x.com' }));
    clock.t += 1000;
  }
  // Nothing to assert but that it did not throw or stall; a map that only
  // grows is the same bug as an unbounded queue, just slower.
  assert.strictEqual(L.stats().queued, 400);
});

console.log('\nsync collapse — the history already written');

const burst = ['14:43:16', '14:43:16', '14:43:16', '14:43:26', '14:43:36', '14:43:46', '14:44:06']
  .map((hhmmss, i) => ({
    at: '2026-10-05T' + hhmmss + 'Z', user_email: 'erick@x.com', event: 'write',
    entity_type: 'sync', action: LABELS[i], section: 'maintenance',
  }));

t("Erick's real burst folds to one line with a count", () => {
  // Three rows share 14:43:16 and the run crosses a minute boundary, which is
  // exactly why "same action, same minute" could not fold it.
  const g = ACTS.groupRuns(burst);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].groupCount, 7);
  assert.strictEqual(g[0].action, 'Synced from AppFolio');
});

t('a sync five minutes later stays its own line', () => {
  const g = ACTS.groupRuns(burst.concat([{
    at: '2026-10-05T14:50:00Z', user_email: 'erick@x.com', event: 'write',
    entity_type: 'sync', action: LABELS[0], section: 'maintenance',
  }]));
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].groupCount, 7);
  assert.strictEqual(g[1].groupCount, 1);
});

t('the existing same-action-same-minute rule still works for everything else', () => {
  const rows = [
    { at: '2026-10-05T14:43:16Z', user_email: 'e@x', event: 'write', entity_type: 'task', action: 'Completed a task' },
    { at: '2026-10-05T14:43:17Z', user_email: 'e@x', event: 'write', entity_type: 'task', action: 'Completed a task' },
    { at: '2026-10-05T14:44:30Z', user_email: 'e@x', event: 'write', entity_type: 'task', action: 'Completed a task' },
  ];
  const g = ACTS.groupRuns(rows);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].groupCount, 2);
  assert.strictEqual(g[1].groupCount, 1);
});

t('two people are never folded together, sync or not', () => {
  const g = ACTS.groupRuns([
    { at: '2026-10-05T14:43:16Z', user_email: 'e@x', event: 'write', entity_type: 'sync', action: LABELS[0] },
    { at: '2026-10-05T14:43:17Z', user_email: 'jay@x', event: 'write', entity_type: 'sync', action: LABELS[1] },
  ]);
  assert.strictEqual(g.length, 2);
});

t('grouping is for READING — no row is dropped from the table', () => {
  // groupRuns returns a view. The count has to account for every input row, or
  // something was silently discarded.
  const g = ACTS.groupRuns(burst);
  assert.strictEqual(g.reduce((n, r) => n + r.groupCount, 0), burst.length);
  // And the helpers it uses internally are not leaked onto the row.
  assert.ok(!('_min' in g[0]) && !('_first' in g[0]));
});

t('an unparseable timestamp does not fold a run by accident', () => {
  const g = ACTS.groupRuns([
    { at: 'not a date', user_email: 'e@x', event: 'write', entity_type: 'sync', action: LABELS[0] },
    { at: 'also not', user_email: 'e@x', event: 'write', entity_type: 'sync', action: LABELS[1] },
  ]);
  assert.strictEqual(g.length, 2, 'rows with no usable time were folded on a guess');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
