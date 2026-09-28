// Leasing weeks: Sunday–Saturday, week_ending = the Saturday.
//
// This boundary has moved three times — Mon–Sun, Sun–Sat on a mistaken claim
// about AppFolio, Mon–Sun again (migration 056), and Sun–Sat now by Lyndsay's
// decision. Each move has to change the same rule in three places: server.js,
// public/app.js and the Goal Board. The point of this file is that they cannot
// drift apart silently again — if the server buckets a day into one week and
// the client into another, the Roll-Up jumps to a week the user did not sync.
//
// The helpers are not exported from either file, so they are pulled out of the
// real source. That is deliberate: a copy here would pass while the shipped
// code was wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const root = p => path.join(__dirname, '..', p);
function extract(file, markers, returns, args = {}) {
  const src = fs.readFileSync(root(file), 'utf8');
  const grab = m => {
    const i = src.indexOf(m);
    assert.ok(i >= 0, `${file} no longer contains ${m}`);
    let depth = 0, started = false;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error('unbalanced: ' + m);
  };
  const names = Object.keys(args);
  // eslint-disable-next-line no-new-func
  return new Function(...names, markers.map(grab).join('\n') + `\nreturn {${returns.join(',')}};`)(
    ...names.map(n => args[n]));
}

const S = extract('server.js', [
  'function toChicagoYMD(', 'function dowYMD(', 'function ymdToUTC(', 'function addDaysYMD(',
  'function chicagoStartOfDayISO(', 'function leasingWeekEnding(',
  'function leasingLastCompleteWeekEnding(',
], ['toChicagoYMD', 'dowYMD', 'ymdToUTC', 'addDaysYMD', 'chicagoStartOfDayISO',
  'leasingWeekEnding', 'leasingLastCompleteWeekEnding'],
{ ctDateStr: () => '2026-09-28' });

const C = extract('public/app.js', [
  'function leasingSaturdayOf(', 'function leasingWeekForRange(', 'function leasingDefaultRange(',
], ['leasingSaturdayOf', 'leasingWeekForRange', 'leasingDefaultRange']);

const dowName = ymd => new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });

console.log('the server buckets days into Sun–Sat weeks');
t('every day of one week closes on the same Saturday', () => {
  // 2026-09-20 is a Sunday, 2026-09-26 the Saturday that closes its week.
  ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    .forEach(d => assert.strictEqual(S.leasingWeekEnding(d), '2026-09-26', d));
});
t('a Saturday stays on itself, a Sunday starts the NEXT week', () => {
  assert.strictEqual(S.leasingWeekEnding('2026-09-26'), '2026-09-26');
  assert.strictEqual(S.leasingWeekEnding('2026-09-27'), '2026-10-03');
});
t('every week_ending it produces is a Saturday', () => {
  for (let i = 0; i < 400; i++) {
    const d = S.addDaysYMD('2026-01-01', i);
    assert.strictEqual(S.dowYMD(S.leasingWeekEnding(d)), 6, d);
  }
});

console.log('\nthe last COMPLETE week');
t('on Monday 2026-09-28 it is the week ending Saturday 09/26', () => {
  assert.strictEqual(S.leasingLastCompleteWeekEnding('2026-09-28'), '2026-09-26');
});
t('on a Saturday it returns the PREVIOUS week, not the one ending today', () => {
  // At 9am Saturday the week is not over, and a roll-up counting a partial day
  // reads as a collapse in performance.
  assert.strictEqual(S.leasingLastCompleteWeekEnding('2026-09-26'), '2026-09-19');
});
t('on a Sunday it is the Saturday just gone', () => {
  assert.strictEqual(S.leasingLastCompleteWeekEnding('2026-09-27'), '2026-09-26');
});
t('it is always a Saturday, and always in the past', () => {
  for (let i = 0; i < 200; i++) {
    const today = S.addDaysYMD('2026-03-01', i);
    const wk = S.leasingLastCompleteWeekEnding(today);
    assert.strictEqual(S.dowYMD(wk), 6, today);
    assert.ok(wk < today, `${wk} is not before ${today}`);
  }
});

console.log('\nCentral time, not the server clock');
t('an instant late on a Central evening belongs to that Central day', () => {
  // Render runs UTC. 2026-09-21T02:30Z is 9:30pm Central on the 20th — a
  // Sunday, so the first day of the week ending 09/26, not the last of 09/19.
  assert.strictEqual(S.toChicagoYMD('2026-09-21T02:30:00Z'), '2026-09-20');
  assert.strictEqual(S.leasingWeekEnding('2026-09-21T02:30:00Z'), '2026-09-26');
});
t('the DST offset is derived per date, not assumed', () => {
  assert.strictEqual(S.chicagoStartOfDayISO('2026-09-20'), '2026-09-20T05:00:00.000Z'); // CDT, UTC-5
  assert.strictEqual(S.chicagoStartOfDayISO('2026-01-15'), '2026-01-15T06:00:00.000Z'); // CST, UTC-6
});
t('day arithmetic does not drift across a DST change', () => {
  // 2026-11-01 is the US fall-back. Adding seven days must land seven calendar
  // days later, not 7 days minus an hour.
  assert.strictEqual(S.addDaysYMD('2026-10-30', 7), '2026-11-06');
  assert.strictEqual(S.addDaysYMD('2026-03-05', 7), '2026-03-12');
});
t('a malformed date yields null rather than a wrong week', () => {
  [null, '', 'yesterday', '2026-13-45'].forEach(v => {
    assert.strictEqual(S.dowYMD(v), null, String(v));
    assert.strictEqual(S.addDaysYMD(v, 1), null, String(v));
  });
});

console.log('\nthe client agrees with the server');
t('leasingSaturdayOf matches leasingWeekEnding for a full year', () => {
  // The drift this catches: the Roll-Up jumping to a different week than the
  // one just synced, because the two sides bucket the same day differently.
  for (let i = 0; i < 366; i++) {
    const d = S.addDaysYMD('2026-01-01', i);
    assert.strictEqual(C.leasingSaturdayOf(d), S.leasingWeekEnding(d), d);
  }
});
t('"Last Week" is the Sunday–Saturday span the server calls complete', () => {
  const r = C.leasingDefaultRange();
  assert.strictEqual(dowName(r.from), 'Sun', r.from);
  assert.strictEqual(dowName(r.to), 'Sat', r.to);
  assert.strictEqual(S.addDaysYMD(r.from, 6), r.to, 'the range must be exactly seven days');
  assert.strictEqual(r.to, S.leasingLastCompleteWeekEnding(), 'client and server disagree on the last complete week');
});

console.log('\nwhich week a synced range belongs to');
t('a whole Sun–Sat week maps to its own Saturday', () => {
  assert.deepStrictEqual(C.leasingWeekForRange('2026-09-20', '2026-09-26'), { week: '2026-09-26', spans: 1 });
});
t('a range straddling two weeks picks the one holding most of the days', () => {
  // 09/14–09/20: six days in the week ending 09/19, one in 09/26. Keying off
  // the To date alone would send the board to a week holding one day.
  assert.deepStrictEqual(C.leasingWeekForRange('2026-09-14', '2026-09-20'), { week: '2026-09-19', spans: 2 });
});
t('a single day maps to its own week', () => {
  assert.deepStrictEqual(C.leasingWeekForRange('2026-09-23', '2026-09-23'), { week: '2026-09-26', spans: 1 });
});
t('a reversed or empty range returns nothing rather than guessing', () => {
  assert.deepStrictEqual(C.leasingWeekForRange('2026-09-26', '2026-09-20'), { week: '', spans: 0 });
  assert.deepStrictEqual(C.leasingWeekForRange('', ''), { week: '', spans: 0 });
});

console.log('\nthe Goal Board columns');
t('START is the Sunday 2026-05-31, written in the form that survives a timezone', () => {
  const html = fs.readFileSync(root('public/tools/weekly_leasing_goal_board.html'), 'utf8');
  // new Date('2026-05-31') parses as UTC midnight and renders as the 30th west
  // of UTC, putting every column label a day early.
  assert.ok(/const START=new Date\(2026,4,31\)/.test(html), 'START is not the numeric 2026-05-31');
  // Comment lines are stripped first: the warning ABOUT the string form is
  // itself written out in a comment, and matching that would fail on the very
  // text that explains the rule.
  const code = html.split('\n').filter(l => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
  assert.ok(!/new Date\(\s*['"]2026-05-31['"]\s*\)/.test(code),
    'START uses the string form, which parses as UTC and renders a day early');
  const start = new Date(2026, 4, 31);
  assert.strictEqual(start.getDay(), 0, 'START is not a Sunday');
});
t('week 17 is 09/20 to 09/26, the week Lyndsay asked for', () => {
  const start = new Date(2026, 4, 31);
  const sun = new Date(start); sun.setDate(start.getDate() + 16 * 7);
  const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
  assert.strictEqual(sun.toLocaleDateString('en-CA'), '2026-09-20');
  assert.strictEqual(sat.toLocaleDateString('en-CA'), '2026-09-26');
});
t('the helper is named for the day it returns', () => {
  const html = fs.readFileSync(root('public/tools/weekly_leasing_goal_board.html'), 'utf8');
  assert.ok(/function sundayOf\(weekIdx\)/.test(html));
  assert.ok(!/function mondayOf\(/.test(html), 'mondayOf still exists and now returns a Sunday');
});

console.log(`\n${pass} passing`);
