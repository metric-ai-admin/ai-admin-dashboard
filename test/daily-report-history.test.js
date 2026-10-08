// Reading a past day of the Daily Report.
//
// The rule Jay set is the whole point: if a figure was not written down that
// day, say "no record for this day" — never a number derived from how things
// look now. So most of this file is about the ways a missing measurement can
// disguise itself as a zero.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/daily-report-history.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const maint = content => ({
  key: 'maintenance', icon: '🔧', owner: 'Erick Frey', title: 'Maintenance',
  status: 'auto', content,
});
const row = (date, sections) => ({ report_date: date, sections, created_at: date + 'T22:00:00Z' });

console.log('daily report history');

// ---- a day that was never saved -----------------------------------------
t('a day with no stored report says so, and shows no figures at all', () => {
  const v = H.dayView(null);
  assert.strictEqual(v.exists, false);
  assert.strictEqual(v.note, H.NO_RECORD);
  assert.deepStrictEqual(v.people, []);
});

t('a section that exists but was never filled in is a DIFFERENT answer', () => {
  // "nobody wrote this section" and "there is no report for this day" are both
  // honest, and they are not the same thing.
  const v = H.dayView(row('2026-10-07', [
    { key: 'urgent', owner: 'Jay Manuel', title: 'Urgent', status: 'pending', content: null },
  ]));
  assert.strictEqual(v.exists, true);
  assert.strictEqual(v.people[0].filled, false);
  assert.strictEqual(v.people[0].note, 'pending — never filled in');
});

// ---- the zeroes that are not zeroes -------------------------------------
t('board.completed_today before 2026-10-07 is NOT MEASURED, not zero', () => {
  // It reads 0 on all sixteen reports from 08/28 to 10/06 and first carries a
  // real number (9) on 10/07. Printing those as 0 would read as "Erick closed
  // nothing all September".
  const before = H.personCard(maint({ board: { total_open: 33, completed_today: 0 } }), '2026-09-29');
  assert.strictEqual(before.board.completed_today, H.NO_RECORD);
  const after = H.personCard(maint({ board: { total_open: 40, completed_today: 9 } }), '2026-10-07');
  assert.strictEqual(after.board.completed_today, 9);
});

t('the OTHER completion counter is left alone — its zeroes are real', () => {
  // commandCenter.completed_tasks carries 34 on 09/03, 68 on 09/07 and 1 on
  // 09/25. Blanking those as "no record" would hide figures that really were
  // measured — the same sin in the other direction.
  const c = H.personCard(maint({ commandCenter: { total_tasks: 179, completed_tasks: 68 } }), '2026-09-07');
  assert.strictEqual(c.commandCenter.completed_tasks, 68);
  const z = H.personCard(maint({ commandCenter: { total_tasks: 243, completed_tasks: 0 } }), '2026-10-02');
  assert.strictEqual(z.commandCenter.completed_tasks, 0, 'a genuine quiet day was blanked');
});

t('completed_manual is never shown — it has only ever been zero', () => {
  const c = H.personCard(maint({
    commandCenter: { total_tasks: 182, completed_tasks: 5, completed_manual: 0 },
  }), '2026-10-07');
  assert.ok(!('completed_manual' in c.commandCenter),
    'a counter that has only ever been 0 describes adoption, not work');
  assert.deepStrictEqual(H.SUPPRESSED_COUNTERS, ['completed_manual']);
});

t('a missing value is "no record", and a real zero stays zero', () => {
  assert.strictEqual(H.recorded(undefined), H.NO_RECORD);
  assert.strictEqual(H.recorded(null), H.NO_RECORD);
  assert.strictEqual(H.recorded(0), 0);
  assert.strictEqual(H.recorded(5), 5);
});

t('a section with no commandCenter block does not invent one', () => {
  const c = H.personCard(maint({ asana: { open: 20 } }), '2026-10-07');
  assert.ok(!('commandCenter' in c));
});

// ---- the card ------------------------------------------------------------
t('Erick\'s card carries the three blocks that were stored', () => {
  const c = H.personCard(maint({
    severity: 'red',
    asana: { open: 20, overdue: 1, completed_today: 8, titles: ['a', 'b'] },
    board: { total_open: 40, completed_today: 9, severity: 'red', critical: ['x'], followup: ['y', 'z'] },
    commandCenter: { total_tasks: 182, completed_tasks: 5, pct: 3, byCategory: { pest: 26 } },
  }), '2026-10-07');
  assert.strictEqual(c.owner, 'Erick Frey');
  assert.strictEqual(c.asana.completed_today, 8);
  assert.deepStrictEqual(c.board.critical, ['x']);
  assert.deepStrictEqual(c.board.followup, ['y', 'z']);
  assert.deepStrictEqual(c.commandCenter.byCategory, { pest: 26 });
  assert.strictEqual(c.severity, 'red');
});

// ---- the seven-day comparison -------------------------------------------
const WEEK = [
  row('2026-10-07', [maint({ commandCenter: { total_tasks: 182, completed_tasks: 5 }, board: { total_open: 40, completed_today: 9 } })]),
  row('2026-10-06', [maint({ commandCenter: { total_tasks: 161, completed_tasks: 1 }, board: { total_open: 47, completed_today: 0 } })]),
  row('2026-10-02', [maint({ commandCenter: { total_tasks: 243, completed_tasks: 0 }, board: { total_open: 40, completed_today: 0 } })]),
];

t('it compares only the days that have a record, and SAYS how many are missing', () => {
  // An average over three of seven days is not a week's average, and
  // presenting it as one is how a gap becomes a trend.
  const c = H.sevenDay(WEEK, 'maintenance', '2026-10-08');
  assert.strictEqual(c.daysWithRecord, 3);
  assert.strictEqual(c.daysMissing, 4);
  assert.deepStrictEqual(c.missingDates.sort(),
    ['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05']);
});

t('each average says how many days it is over', () => {
  const c = H.sevenDay(WEEK, 'maintenance', '2026-10-08');
  assert.strictEqual(c.averages.total_tasks.over, 3);
  assert.strictEqual(c.averages.total_tasks.value, Math.round(((182 + 161 + 243) / 3) * 10) / 10);
  // board_completed: only 10/07 is measured; the other two are before the
  // field was populated, so the average must be over ONE day, not three.
  assert.strictEqual(c.averages.board_completed.over, 1);
  assert.strictEqual(c.averages.board_completed.value, 9);
});

t('an average with nothing to average on is "no record", not 0', () => {
  const c = H.sevenDay([row('2026-10-07', [maint({ board: { total_open: 40, completed_today: 0 } })])],
    'maintenance', '2026-10-08');
  assert.strictEqual(c.averages.completed_tasks.value, H.NO_RECORD);
  assert.strictEqual(c.averages.completed_tasks.over, 0);
});

t('the window is the seven days BEFORE the chosen one, not including it', () => {
  const c = H.sevenDay(WEEK, 'maintenance', '2026-10-08');
  assert.strictEqual(c.window.to, '2026-10-07');
  assert.strictEqual(c.window.from, '2026-10-01');
  assert.ok(!c.series.some(s => s.date === '2026-10-08'));
});

t('the series runs oldest to newest', () => {
  const c = H.sevenDay(WEEK, 'maintenance', '2026-10-08');
  const dates = c.series.map(s => s.date);
  assert.deepStrictEqual(dates, dates.slice().sort());
});

// ---- the fallback --------------------------------------------------------
t('cc_daily_state is offered only as a labelled fallback', () => {
  const f = H.fallbackFromState(
    { total_tasks: 243, completed_tasks: 0, generated_at: 'x' }, '2026-10-02');
  assert.strictEqual(f.source, 'cc_daily_state');
  assert.ok(/never saved/.test(f.note));
  assert.ok(/23:30/.test(f.note), 'it should say when the figure was taken');
  // Every cc_daily_state row before 10/06 reads 0 because the counters did not
  // exist, so these must not print as zero.
  assert.strictEqual(f.completed_tasks, H.NO_RECORD);
  assert.ok(/started on 2026-10-06/.test(f.countersNote));
  assert.strictEqual(f.total_tasks, 243);
});

t('the fallback keeps real counters once they existed', () => {
  const f = H.fallbackFromState({ total_tasks: 120, completed_tasks: 13 }, '2026-10-08');
  assert.strictEqual(f.completed_tasks, 13);
  assert.ok(!f.countersNote);
});

t('no state row means no fallback, not an empty one', () => {
  assert.strictEqual(H.fallbackFromState(null, '2026-10-02'), null);
});

t('the fallback hides completed_manual too', () => {
  const f = H.fallbackFromState({ total_tasks: 1, completed_tasks: 1, completed_manual: 0 }, '2026-10-08');
  assert.ok(!('completed_manual' in f));
});

// ---- the routes ----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rStart = CODE.indexOf("app.get('/api/reports/daily/history/days'");
const rEnd = CODE.indexOf("app.get('/api/reports/daily/today'");
const routes = CODE.slice(rStart, rEnd);

t('both routes exist and are reads', () => {
  assert.ok(rStart > 0 && rEnd > rStart, 'routes not found');
  assert.ok(/app\.get\('\/api\/reports\/daily\/history', requireAuth/.test(CODE));
  ['.insert(', '.upsert(', '.update(', '.delete(', 'app.post', 'app.patch'].forEach(bad =>
    assert.ok(!routes.includes(bad), 'the history route does ' + bad));
});

t('it refuses a date it cannot parse', () => {
  assert.ok(/date must be YYYY-MM-DD/.test(routes));
  assert.ok(/DRH\.isYmd\(date\)/.test(routes));
  assert.strictEqual(H.isYmd('2026-10-07'), true);
  ['', 'yesterday', '10/07/2026', '2026-13-99x'].forEach(v =>
    assert.strictEqual(H.isYmd(v), false, v));
});

t('NOTHING is rebuilt from the work-order tables', () => {
  // Today's work orders cannot describe 09/30, and the 2026-10-08 backfill put
  // 1,050 rows in carrying old dates.
  ['maintenance_work_orders', 'maintenance_inspections', 'wo_completed', 'appfolio']
    .forEach(src => assert.ok(!routes.includes(src), 'the history reads ' + src));
});

t('cc_daily_state is only read when the report is missing', () => {
  assert.ok(/if \(!today\) \{[\s\S]{0,400}cc_daily_state/.test(routes),
    'cc_daily_state should only be consulted when no report was saved');
});

t('the day list is paged, so an old day cannot fall off the picker', () => {
  assert.ok(/selectAll\(\(\) => client\.from\('daily_reports'\)/.test(routes));
});

// ---- the UI --------------------------------------------------------------
t('the picker is built from the days that exist', () => {
  assert.ok(/id="report-history-date"/.test(HTML));
  assert.ok(/api\('\/api\/reports\/daily\/history\/days'/.test(APP));
  assert.ok(/drhDays\.map/.test(APP), 'the options should come from the stored days');
});

t('it defaults to the most recent stored day before today', () => {
  assert.ok(/drhDays\.find\(x => x < today\)/.test(APP));
});

t('a "no record" value renders as a dash, never as 0', () => {
  assert.ok(/DRH_NO_RECORD = 'no record for this day'/.test(APP));
  const f = APP.slice(APP.indexOf('const drhVal'), APP.indexOf('function drhList'));
  assert.ok(/Not written down on this day/.test(f), 'the dash should explain itself on hover');
});

t('the comparison states the missing days on screen', () => {
  assert.ok(/of 7 days have no report/.test(APP));
  assert.ok(/over \$\{a\.over\} day/.test(APP), 'each average must say how many days it covers');
});

t('the UI escapes what it renders', () => {
  const ui = APP.slice(APP.indexOf('function drhPersonCard'), APP.indexOf('async function loadReportHistory'));
  ['esc(p.title)', 'esc(p.owner)'].forEach(v =>
    assert.ok(ui.includes(v), v + ' is not escaped'));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
