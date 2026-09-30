// lib/week.js is the only place that knows what a week is.
//
// The leasing week has moved three times, and each move meant finding the same
// arithmetic hand-written in server.js, in public/app.js and in the Goal Board.
// One of them was missed every time, and the symptom was always the same: the
// server bucketed a day into one week and the client into another, so the
// Roll-Up jumped to a week nobody had synced.
//
// An inventory on 2026-09-29 found ten more copies of `(getDay() + 6) % 7`
// across Tasks, the Call Analyzer, the 6PM Report, Regional Performance, triage,
// auto-move, SimpleVOIP and the Command Center.
//
// This file has two jobs: prove the module is correct, and fail the build if a
// private copy comes back.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/week.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Comment lines out. Several checks below look for an identifier that the
// comment explaining the rule also mentions, and matching that would fail on
// the very text that documents the fix.
const stripComments = src => src.split(String.fromCharCode(10))
  .filter(l => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).join(String.fromCharCode(10));

console.log('the two conventions');
t('Sun-Sat: every day of one week closes on the same Saturday', () => {
  ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    .forEach(d => assert.strictEqual(W.weekEndYMD(d, W.SUN_SAT), '2026-09-26', d));
  assert.strictEqual(W.weekEndYMD('2026-09-27', W.SUN_SAT), '2026-10-03', 'Sunday starts the next week');
});
t('Mon-Sun: every day of one week closes on the same Sunday', () => {
  ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    .forEach(d => assert.strictEqual(W.weekEndYMD(d, W.MON_SUN), '2026-09-27', d));
  assert.strictEqual(W.weekEndYMD('2026-09-28', W.MON_SUN), '2026-10-04', 'Monday starts the next week');
});
t('a week is always exactly seven days, both ways, for two years', () => {
  for (let i = 0; i < 730; i++) {
    const d = W.addDaysYMD('2026-01-01', i);
    [W.SUN_SAT, W.MON_SUN].forEach(c => {
      const r = W.weekRange(d, c);
      assert.strictEqual(W.addDaysYMD(r.from, 6), r.to, `${c.name} ${d}`);
      assert.ok(r.from <= d && d <= r.to, `${d} outside its own ${c.name} week`);
      assert.strictEqual(W.dowYMD(r.from), c.firstDay, `${c.name} ${d} does not open on its first day`);
    });
  }
});
t('the last COMPLETE week is always in the past, never the one ending today', () => {
  // At 9am Saturday the Sun-Sat week is not over; counting a partial day reads
  // as a collapse in performance.
  assert.strictEqual(W.lastCompleteWeekEnd('2026-09-26', W.SUN_SAT), '2026-09-19');
  assert.strictEqual(W.lastCompleteWeekEnd('2026-09-28', W.SUN_SAT), '2026-09-26');
  assert.strictEqual(W.lastCompleteWeekEnd('2026-09-27', W.MON_SUN), '2026-09-20');
  for (let i = 0; i < 400; i++) {
    const today = W.addDaysYMD('2026-03-01', i);
    [W.SUN_SAT, W.MON_SUN].forEach(c => {
      const end = W.lastCompleteWeekEnd(today, c);
      assert.ok(end < today, `${c.name}: ${end} is not before ${today}`);
      assert.strictEqual(W.dowYMD(end), (c.firstDay + 6) % 7, `${c.name} ${today}`);
    });
  }
});

console.log('\nno Date.now() hiding inside it');
t('the same "now" always gives the same answer', () => {
  assert.strictEqual(W.lastCompleteWeekEnd('2026-09-28', W.SUN_SAT), W.lastCompleteWeekEnd('2026-09-28', W.SUN_SAT));
  assert.deepStrictEqual(W.lastCompleteWeekRange('2026-09-28', W.SUN_SAT), { from: '2026-09-20', to: '2026-09-26' });
});
t('a malformed date yields null rather than a confidently wrong week', () => {
  [null, '', 'yesterday', '2026-13-45', '2026-02-30'].forEach(v => {
    assert.strictEqual(W.dowYMD(v), null, String(v));
    assert.strictEqual(W.addDaysYMD(v, 1), null, String(v));
    assert.strictEqual(W.weekStartYMD(v, W.SUN_SAT), null, String(v));
    assert.strictEqual(W.weekEndYMD(v, W.SUN_SAT), null, String(v));
  });
});

console.log('\nCentral time, not the server clock');
t('an instant late on a Central evening belongs to that Central day', () => {
  // Render runs UTC. 2026-09-21T02:30Z is 9:30pm Central on the 20th - a Sunday,
  // so the first day of the week ending 09/26, not the last of 09/19.
  assert.strictEqual(W.toChicagoYMD('2026-09-21T02:30:00Z'), '2026-09-20');
  assert.strictEqual(W.leasingWeekEnding('2026-09-21T02:30:00Z'), '2026-09-26');
});
t('the DST offset is derived per date, not assumed', () => {
  assert.strictEqual(W.chicagoStartOfDayISO('2026-09-20'), '2026-09-20T05:00:00.000Z'); // CDT, UTC-5
  assert.strictEqual(W.chicagoStartOfDayISO('2026-01-15'), '2026-01-15T06:00:00.000Z'); // CST, UTC-6
});
t('day arithmetic does not drift across a DST change', () => {
  assert.strictEqual(W.addDaysYMD('2026-10-30', 7), '2026-11-06'); // US fall-back is 11-01
  assert.strictEqual(W.addDaysYMD('2026-03-05', 7), '2026-03-12');
});

console.log('\nleasing asks for Sun-Sat BY NAME, so Phase 3 cannot drag it back');
t('leasing ignores DASHBOARD', () => {
  // The whole point: flipping DASHBOARD must not move leasing, because leasing
  // has Supabase rows keyed on its Saturday.
  ['2026-09-20', '2026-09-24', '2026-09-26'].forEach(d =>
    assert.strictEqual(W.leasingWeekEnding(d), '2026-09-26', d));
  assert.strictEqual(W.dowYMD(W.leasingWeekEnding('2026-09-24')), 6, 'not a Saturday');
});
t('every week_ending leasing produces is a Saturday, for a year', () => {
  for (let i = 0; i < 366; i++) {
    const d = W.addDaysYMD('2026-01-01', i);
    assert.strictEqual(W.dowYMD(W.leasingWeekEnding(d)), 6, d);
  }
});

console.log('\nDASHBOARD is Mon-Sun until Phase 3 flips it');
t('DASHBOARD is Sun-Sat', () => {
  // Flipped 2026-09-30. Moving it back is a decision, not a refactor: it changes
  // what Tasks, the 6PM Report, the Call Analyzer, SimpleVOIP, Regional
  // Performance and the Command Center all show.
  assert.strictEqual(W.DASHBOARD, W.SUN_SAT,
    'DASHBOARD moved off Sun-Sat. That changes what users see - intended?');
});
t('a surface on DASHBOARD now runs Sunday to Saturday', () => {
  const r = W.weekRange('2026-09-30', W.DASHBOARD);
  assert.deepStrictEqual(r, { from: '2026-09-27', to: '2026-10-03' });
  assert.strictEqual(W.dowYMD(r.from), 0, 'the week does not open on a Sunday');
  assert.strictEqual(W.dowYMD(r.to), 6, 'the week does not close on a Saturday');
});

console.log('\ntwo things do NOT follow DASHBOARD, and each says so by name');
t('the Monday Morning Brief stays Mon-Sun', () => {
  // A "Monday brief" that opens on Sunday is a product decision, not a
  // consequence of standardising week arithmetic.
  // Comments stripped: the note explaining the pin names DASHBOARD, and
  // matching that would fail on the very text documenting it.
  const brief = stripComments(read('weekly-brief.js'));
  assert.ok(/WEEK\.MON_SUN/.test(brief), 'weekly-brief.js no longer pins its convention by name');
  assert.ok(!/WEEK\.DASHBOARD/.test(brief), 'the Monday brief follows DASHBOARD and has moved to Sunday');
  assert.deepStrictEqual(require('../weekly-brief.js').weekOf('2026-09-30'),
    { start: '2026-09-28', end: '2026-10-04' });
});
t('leasing stays Sun-Sat by name, not by coincidence', () => {
  // It reads the same as DASHBOARD today, which is exactly why it must be asked
  // for explicitly: a future flip must not drag rows keyed on a Saturday.
  const s = read('server.js');
  const i = s.indexOf('async function leasingWeeklyRollup(');
  assert.ok(/WEEK\.SUN_SAT/.test(s.slice(i, i + 900)));
  assert.strictEqual(W.leasingWeekEnding('2026-09-30'), '2026-10-03');
});

console.log('\nthe WO schedule calendar now follows DASHBOARD');
// It was the last surface pinned to MON_SUN for a reason other than the
// document it produces: a grid redrawing under someone mid-week. Erick was told
// on 2026-09-30, so the reason expired and the pin came out.
const woCal = stripComments(read('public/wo-schedule-calendar.js'));
t('it asks for DASHBOARD, and no longer names MON_SUN', () => {
  assert.ok(/MetricWeek\.DASHBOARD/.test(woCal), 'the calendar does not follow DASHBOARD');
  assert.ok(!/MetricWeek\.MON_SUN/.test(woCal), 'the calendar is still pinned to Mon-Sun');
});
t("this week's grid runs Sunday 09/27 to Saturday 10/03", () => {
  // The whole visible consequence. Every day of the week has to land on the
  // same grid, or someone opening it on Friday sees a different week.
  const days = d => Array.from({ length: 7 }, (_, i) => W.addDaysYMD(W.weekStartYMD(d, W.DASHBOARD), i));
  ['2026-09-27', '2026-09-30', '2026-10-01', '2026-10-03'].forEach(d => {
    const g = days(d);
    assert.strictEqual(g[0], '2026-09-27', `grid opened on ${g[0]} for ${d}`);
    assert.strictEqual(g[6], '2026-10-03', `grid closed on ${g[6]} for ${d}`);
    assert.strictEqual(W.dowYMD(g[0]), 0, 'the first column is not a Sunday');
    assert.strictEqual(W.dowYMD(g[6]), 6, 'the last column is not a Saturday');
  });
});
t('a scheduled WO keeps its day — only the column order moves', () => {
  // A card is placed by matching scheduled_date to a column's own date, so the
  // day a WO sits on cannot depend on where the week starts. This is the part
  // Erick would notice if it were wrong.
  assert.ok(/r\.scheduled_date === iso/.test(woCal),
    'cards are no longer placed by date — check what they are keyed on now');
  const onDay = (ymd, conv) =>
    Array.from({ length: 7 }, (_, i) => W.addDaysYMD(W.weekStartYMD(ymd, conv), i)).indexOf(ymd);
  // Wednesday 09/30 was column 2 of a Mon-Sun grid and is column 3 of a Sun-Sat
  // one. Different column, same date, same card.
  assert.strictEqual(onDay('2026-09-30', W.MON_SUN), 2);
  assert.strictEqual(onDay('2026-09-30', W.DASHBOARD), 3);
  ['2026-09-27', '2026-09-28', '2026-09-30', '2026-10-02', '2026-10-03'].forEach(d => {
    assert.ok(onDay(d, W.DASHBOARD) >= 0, `${d} fell outside this week's grid entirely`);
  });
});

console.log('\nthe triage trend groups Sun-Sat and is labelled by range');
t('the week NUMBER is gone from the codebase', () => {
  // It was neither ISO 8601 nor Sunday-based, and it was the last thing still
  // grouping Mon-Sun after Phase 3. It survived only to avoid relabelling the
  // buckets; the relabelling has happened, so it has no reason to exist.
  assert.strictEqual(W.legacyWeekNumberKey, undefined,
    'legacyWeekNumberKey is back — nothing should bucket by week number');
  assert.ok(!/legacyWeekNumberKey/.test(read('server.js')),
    'server.js still buckets something by the old week number');
});
t('the trend buckets on the Sun-Sat week of session_date', () => {
  const route = read('server.js');
  const i = route.indexOf('const weeklyMap = {}');
  assert.ok(i > 0, 'the triage trend no longer builds weeklyMap — update this test');
  const body = route.slice(i, i + 3200);
  assert.ok(/weekStartYMD\([\s\S]{0,140}WEEK\.DASHBOARD\)/.test(body),
    'the trend does not bucket on the dashboard week');
  assert.ok(/week_start\.localeCompare/.test(body),
    'the trend sorts on the label, which cannot order across a year boundary');
});
t('the label is the range; the ISO dates are what it sorts on', () => {
  // "09/27 – 10/03" is the thing itself. "2026-W39" asks the reader to know
  // which numbering is meant and then go and look the dates up.
  const start = W.weekStartYMD('2026-09-30', W.DASHBOARD);
  const end = W.addDaysYMD(start, 6);
  assert.strictEqual(start, '2026-09-27');
  assert.strictEqual(end, '2026-10-03');
  assert.strictEqual(`${start.slice(5).replace('-', '/')} – ${end.slice(5).replace('-', '/')}`,
    '09/27 – 10/03');
});

// ---------------------------------------------------------------------------
console.log('\nnobody keeps a private copy of the arithmetic');

// The idioms. Each is a way of writing "back up to the start of the week" or
// "forward to the end of it" by hand.
const IDIOMS = [
  [/\(\s*\w+\.getDay\(\)\s*\+\s*6\s*\)\s*%\s*7/, 'the (getDay() + 6) % 7 Monday walk-back'],
  [/\(\s*6\s*-\s*\w+\.getDay\(\)\s*\)\s*%\s*7/, 'the (6 - getDay()) % 7 walk-forward to Saturday'],
  [/getDay\(\)\s*===?\s*6\s*\?\s*7\s*:/, 'the "Saturday means go back a full week" branch'],
  [/dow\s*===?\s*0\s*\?\s*-6\s*:\s*1\s*-\s*dow/, 'the "Sunday means go back six" branch'],
];

// A helper NAMED for a week boundary is fine when its body delegates — a thin
// wrapper that keeps a call site readable is not a private copy. What is banned
// is one that works the boundary out itself. So the name is looked up and its
// body checked, rather than the name alone being treated as guilt.
const WEEK_HELPER = /function\s+(mondayOf|sundayOf|saturdayOf|weekStart|ccWeekStart|woMonday)\s*\([^)]*\)\s*\{/g;
// Named exceptions, each with the reason it is not a private copy.
const HELPER_EXCEPTIONS = {
  // The Goal Board's columns are "week N since a fixed START", so this walks
  // N*7 days from a Sunday that was chosen once. It never decides which day
  // opens a week — START does — and the day that CLOSES one it asks the module
  // for (see the test below). Index arithmetic, not a boundary rule.
  'public/tools/weekly_leasing_goal_board.html': ['sundayOf'],
};

function undelegatingHelpers(code, file) {
  const allowed = HELPER_EXCEPTIONS[file] || [];
  const bad = [];
  let m;
  WEEK_HELPER.lastIndex = 0;
  while ((m = WEEK_HELPER.exec(code)) !== null) {
    // The body, to its closing brace.
    let depth = 0, started = false, body = '';
    for (let i = m.index; i < code.length; i++) {
      if (code[i] === '{') { depth++; started = true; }
      else if (code[i] === '}') { depth--; }
      body += code[i];
      if (started && depth === 0) break;
    }
    if (allowed.includes(m[1])) continue;
    if (!/MetricWeek\.|WEEK\./.test(body)) bad.push(`${m[1]}() works the boundary out itself`);
  }
  return bad;
}
const GUARDED = ['server.js', 'public/app.js', 'public/command-center.js',
  'public/tools/weekly_leasing_goal_board.html'];


GUARDED.forEach(file => {
  t(`${file} has no private week arithmetic`, () => {
    const code = stripComments(read(file));
    const bad = IDIOMS.filter(([re]) => re.test(code)).map(([, why]) => why)
      .concat(undelegatingHelpers(code, file));
    assert.deepStrictEqual(bad, [],
      `${file} computes a week boundary by hand: ${bad.join('; ')}\n`
      + '  Use lib/week.js. If this really is not a week boundary, add the reason\n'
      + '  to the exception list in this test rather than deleting the check.');
  });
  t(`${file} actually calls the module`, () => {
    assert.ok(/MetricWeek\.|WEEK\.|require\(['"]\.\/lib\/week\.js['"]\)/.test(read(file)),
      `${file} never references lib/week.js - it either lost its week logic or forked it`);
  });
});

t('the Goal Board does not decide which day closes a week', () => {
  // Its sundayOf() is index arithmetic from a fixed START, which is fine. What
  // it may not do is add 6 to reach the closing day on its own.
  const code = stripComments(read('public/tools/weekly_leasing_goal_board.html'));
  assert.ok(!/setDate\(\s*\w+\.getDate\(\)\s*\+\s*6\s*\)/.test(code),
    'the Goal Board is walking forward 6 days to find the end of a week again');
  assert.ok(/MetricWeek\.leasingWeekEnding/.test(code),
    'the Goal Board no longer asks the module which day closes a week');
});

t('the leasing roll-up asks for SUN_SAT by name, not DASHBOARD', () => {
  // leasingWeeklyRollup feeds the Daily Report's "Weekly Leasing Board" (Katie)
  // and the EOD leasing section (Lyndsay). It ran Mon–Sun until 2026-09-29, a
  // day out from the Goal Board it is read next to. Following DASHBOARD would
  // fix it today and break it again the moment Phase 3 flips — so it names the
  // convention, and this is the check that keeps it named.
  const src = read('server.js');
  const i = src.indexOf('async function leasingWeeklyRollup(');
  assert.ok(i > 0, 'leasingWeeklyRollup is gone — update this test');
  const body = src.slice(i, i + 900);
  assert.ok(/weekStartYMD\([^)]*WEEK\.SUN_SAT\)/.test(body),
    'leasingWeeklyRollup no longer asks for SUN_SAT — a leasing number on a non-leasing week');
  assert.ok(!/WEEK\.DASHBOARD/.test(body),
    'leasingWeeklyRollup follows DASHBOARD again, so Phase 3 will silently move it');
});

t('the roll-up counts ONE week of leads, not every week from here on', () => {
  // `.gte('week_ending', weekStart)` returned the week AND everything after it:
  // 88 for the week ending 2026-09-26 where the Goal Board shows 68. It looked
  // right only because no lead was dated past the current week.
  const src = read('server.js');
  const i = src.indexOf('async function leasingWeeklyRollup(');
  const body = src.slice(i, i + 2200);
  assert.ok(/\.eq\('week_ending',\s*weekEnd\)/.test(body),
    'the leads query no longer pins week_ending to the closing Saturday');
  assert.ok(!/from\('leasing_leads'\)[\s\S]{0,120}\.gte\('week_ending'/.test(body),
    'the open-ended week_ending filter is back — it counts future weeks too');
});

t('every roll-up window is closed at the top, not just the leads one', () => {
  // All four were open upwards. Leads were fixed first; these three were left
  // for a separate call because bounding move-ins changes a number Lyndsay and
  // Katie read — on 2026-09-29 it went from 9 to 5, four of them scheduled for
  // later weeks and counted as though they had already happened.
  const src = read('server.js');
  const i = src.indexOf('async function leasingWeeklyRollup(');
  const body = src.slice(i, i + 2600);
  [
    ['leasing_showings', 'showing_date'],
    ['leasing_applications', 'application_date'],
    ['leasing_lease_history', 'move_in_date'],
  ].forEach(([table, col]) => {
    const q = new RegExp(`from\\('${table}'\\)[\\s\\S]{0,220}?\\.lte\\('${col}',\\s*weekEnd\\)`);
    assert.ok(q.test(body),
      `${table} is filtered from weekStart with no upper bound — it counts rows dated after the week as if they were in it`);
  });
});

t('the Daily Report card labels week_ending with the closing Saturday', () => {
  // A field called week_ending held the week's FIRST day, so the card and the
  // Goal Board next to it named the same week differently.
  const src = read('server.js');
  const i = src.indexOf('async function reportLeasingSection(');
  assert.ok(i > 0, 'reportLeasingSection is gone — update this test');
  const body = src.slice(i, i + 1600);
  assert.ok(/week_ending:\s*weekEnd\b/.test(body),
    'the card is labelling week_ending with something other than weekEnd');
  assert.ok(!/week_ending:\s*weekStart\b/.test(body),
    'the card is back to calling the first day of the week its ending');
});

t('the browser is served the module before app.js runs', () => {
  const html = read('public/index.html');
  const week = html.indexOf('/lib/week.js');
  const app = html.indexOf('src="app.js"');
  assert.ok(week >= 0, 'index.html does not load /lib/week.js');
  assert.ok(app >= 0, 'index.html no longer loads app.js - update this test');
  assert.ok(week < app, '/lib/week.js loads AFTER app.js, so MetricWeek is undefined when app.js renders');
});
t('the Goal Board loads it too', () => {
  assert.ok(read('public/tools/weekly_leasing_goal_board.html').includes('/lib/week.js'));
});
t('the server serves /lib and cache-busts the file', () => {
  const src = read('server.js');
  assert.ok(/app\.use\(\s*'\/lib'/.test(src), 'nothing serves /lib, so the browser gets a 404');
  // The EFFECT, not the spelling: the pattern must actually match the tag.
  // It grew to cover /lib/due-date.js too, and a literal-text assertion broke
  // on a change that was entirely correct.
  const stamped = /const STAMPED = (\/.*\/[a-z]*);/.exec(src);
  assert.ok(stamped, 'STAMPED is gone — update this test');
  // eslint-disable-next-line no-eval
  const re = eval(stamped[1]);
  assert.ok(re.test('<script src="/lib/week.js"></script>'),
    '/lib/week.js is not cache-busted, so a deploy leaves stale copies cached');
});
t('the module is one file, not a copy under public/', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'lib', 'week.js')),
    'there is a second copy at public/lib/week.js - that is the drift this module exists to prevent');
});

console.log(`\n${pass} passing`);
