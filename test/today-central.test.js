// "Today", everywhere a person reads it.
//
// Render runs on UTC. A date built from the server clock — toISOString()
// .slice(0,10), or getFullYear/getMonth/getDate, which is the same thing there
// — rolls over at 7PM Central in summer and 6PM in winter. Everything filed
// after that carried tomorrow's date: the Daily Report, the Command Center
// state, Erick's board, meeting summaries, task due dates, export filenames.
//
// The nightly Command Center snapshot was fixed on its own. This is the same
// bug everywhere else it reached.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WEEK = require('../lib/week.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('today, in Austin');

// ---- the boundary ----------------------------------------------------------

t('7:30 PM Central is still that day, not the next', () => {
  // THE CASE THAT BIT. 19:30 CT on 2026-10-09 is 00:30Z on the 10th, so a UTC
  // date said the 10th and a Daily Report generated then was stored under
  // tomorrow — and the next morning's generate found it and returned it rather
  // than making the real one.
  assert.strictEqual(WEEK.todayYMD(new Date('2026-10-10T00:30:00Z')), '2026-10-09');
});

t('12:30 AM Central is that day', () => {
  assert.strictEqual(WEEK.todayYMD(new Date('2026-10-10T05:30:00Z')), '2026-10-10');
});

t('one minute before Central midnight is still the old day', () => {
  assert.strictEqual(WEEK.todayYMD(new Date('2026-10-10T04:59:00Z')), '2026-10-09');
});

t('Central midnight exactly is the new day', () => {
  assert.strictEqual(WEEK.todayYMD(new Date('2026-10-10T05:00:00Z')), '2026-10-10');
});

t('the boundary follows DST — 6PM in winter, 7PM in summer', () => {
  // A hard-coded offset is wrong for half the year, in whichever half nobody
  // tested. In December the roll-over is an hour earlier.
  assert.strictEqual(WEEK.todayYMD(new Date('2026-12-10T00:30:00Z')), '2026-12-09',
    '18:30 CST is still the 9th');
  assert.strictEqual(WEEK.todayYMD(new Date('2026-12-10T06:00:00Z')), '2026-12-10',
    'midnight CST is the 10th');
});

t('it takes a `now`, so the edge can be tested without waiting for it', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(WEEK.todayYMD()), 'and still answers with no argument');
});

// ---- the places that used to read UTC --------------------------------------

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

t('reportDateStr is Central, and no longer reads the server clock', () => {
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function reportDateStr()'),
    server.indexOf('function reportDateStr()') + 200);
  assert.ok(/WEEK\.todayYMD\(\)/.test(fn));
  assert.ok(!/getFullYear\(\)/.test(fn), 'it still builds the date from the server clock');
});

t("Erick's board and the task engine are Central too", () => {
  const mr = read('metric-routes.js');
  const fn = mr.slice(mr.indexOf('function todayStr()'), mr.indexOf('function todayStr()') + 120);
  assert.ok(/WEEK\.todayYMD\(\)/.test(fn), 'metric-routes todayStr');
  assert.ok(/const todayISO = \(\) => WEEK\.todayYMD\(\)/.test(read('crm-task-engine.js')),
    'crm-task-engine todayISO — due dates and the overdue count are a working-day question');
});

t('the modules that default `today` default to Central', () => {
  ['code-violations.js', 'vacancy-rules.js', 'weekly-brief.js', 'regional-performance.js']
    .forEach(f => {
      const src = read(f);
      assert.ok(/opts\.today \|\| WEEK\.todayYMD\(\)|today \|\| WEEK\.todayYMD\(\)/.test(src),
        f + ' still defaults to a UTC date');
      assert.ok(/require\('\.\/lib\/week\.js'\)/.test(src), f + ' has no week module');
    });
});

t('nothing a person reads still builds a day from the server clock', () => {
  // Scoped to the files this change covers. A new one will be caught by
  // review, not by this — the point here is that these do not regress.
  const offenders = [];
  ['server.js', 'metric-routes.js', 'crm-task-engine.js', 'code-violations.js',
    'vacancy-rules.js', 'weekly-brief.js', 'regional-performance.js'].forEach(f => {
    const code = read(f).split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(code)) offenders.push(f);
  });
  assert.deepStrictEqual(offenders, [],
    'these still turn the server instant into a calendar day: ' + offenders.join(', '));
});

// ---- what must STAY UTC ----------------------------------------------------

t('stored timestamps are untouched', () => {
  // A timestamptz is an INSTANT and has no timezone question. Converting one
  // to Central would be a different kind of wrong — and these are the columns
  // every sync and every audit row is keyed on.
  const server = read('server.js');
  assert.ok(/synced_at: now/.test(server) || /synced_at: new Date\(\)\.toISOString\(\)/.test(server),
    'synced_at should still be a full ISO instant');
  assert.ok(/updated_at: new Date\(\)\.toISOString\(\)/.test(server),
    'updated_at should still be a full ISO instant');
});

t('date arithmetic on a YMD still runs in UTC, deliberately', () => {
  // lib/week.js parses a YYYY-MM-DD at UTC midnight and shifts it there, so
  // adding seven days lands seven calendar days later and not seven days minus
  // an hour across a DST change. That is correct and must not be "fixed".
  assert.strictEqual(WEEK.addDaysYMD('2026-03-07', 7), '2026-03-14',
    'a week across the spring DST change is still seven days');
  assert.strictEqual(WEEK.addDaysYMD('2026-11-01', 1), '2026-11-02');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
