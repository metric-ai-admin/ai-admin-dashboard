// Week labels the user reads.
//
// The KPI pipeline note said "(Mon–Sun)" next to 2026-09-27 to 2026-10-03.
// Phase 3 moved the dates and left the word behind, because the word was typed
// into the HTML and the dates were computed. For two days the screen contradicted
// itself, and the only thing that would have caught it is somebody reading it.
//
// So: no label naming a week convention may be a literal. Each one comes from
// lib/week.js, and for the pipeline it travels with the data it describes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const W = require('../lib/week.js');
const server = read('server.js');
const app = read('public/app.js');
// A literal in a comment is prose about the fix; only code can reach a screen.
const code = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('the conventions carry their own name');
t('both are named, and the names are what a label would print', () => {
  assert.strictEqual(W.SUN_SAT.name, 'Sun–Sat');
  assert.strictEqual(W.MON_SUN.name, 'Mon–Sun');
  assert.strictEqual(W.DASHBOARD.name, 'Sun–Sat', 'DASHBOARD moved — every derived label moves with it');
});

console.log('\nno screen or email types a convention by hand');
t('no user-visible "(Mon–Sun)" or "(Sun–Sat)" literal survives', () => {
  // The exact shape the bug had: the name in parentheses, inside a template.
  [['server.js', code(server)], ['public/app.js', code(app)],
   ['public/command-center.js', code(read('public/command-center.js'))],
  ].forEach(([file, src]) => {
    const hits = src.match(/\((?:Mon[–-]Sun|Sun[–-]Sat)\)/g) || [];
    assert.strictEqual(hits.length, 0,
      `${file} still prints ${hits[0]} as a literal — it cannot follow lib/week.js`);
  });
});
t('the EOD email names the convention through the module', () => {
  const i = server.indexOf('Weekly Activity by Agent');
  assert.ok(i > 0, 'the BD CRM weekly table is gone');
  assert.ok(/Weekly Activity by Agent \(\$\{WEEK\.DASHBOARD\.name\}\)/.test(server.slice(i - 40, i + 80)),
    'the EOD heading does not derive its label');
});

console.log('\nthe pipeline label travels with the dates it describes');
t('the server sends the convention it actually built the week with', () => {
  // Deriving it again in the browser would be right today and wrong the day
  // this endpoint is pinned to something other than DASHBOARD.
  const i = server.indexOf('buildRegionalPerformance(');
  assert.ok(i > 0, 'the regional performance call is gone');
  const block = server.slice(i, server.indexOf('syncedAt:', i));
  assert.ok(/WEEK\.weekStartYMD\(todayCT, WEEK\.DASHBOARD\)/.test(server.slice(i - 900, i)),
    'the week is no longer built from WEEK.DASHBOARD');
  assert.ok(/weekConvention: WEEK\.DASHBOARD\.name/.test(block),
    'the response does not carry the convention name');
});
t('the browser prints what the server sent', () => {
  const i = app.indexOf('This week is ${rpEsc(funnel.range.thisWeek[0])}');
  assert.ok(i > 0, 'the pipeline note is gone or reworded');
  const note = app.slice(i - 200, i + 700);
  assert.ok(/weekConvention/.test(note), 'the note ignores the field the server sends');
  assert.ok(!/\(Mon[–-]Sun\)|\(Sun[–-]Sat\)/.test(code(note)), 'the note still hard-codes a convention');
  assert.ok(/const \{[^}]*weekConvention[^}]*\} = rpData;/.test(app),
    'weekConvention is never destructured, so the label would render undefined');
});
t('a cached response from before the field falls back, it does not print blank', () => {
  const i = app.indexOf('This week is ${rpEsc(funnel.range.thisWeek[0])}');
  const note = app.slice(i - 200, i + 700);
  assert.ok(/MetricWeek\.DASHBOARD\.name/.test(note),
    'an older cached payload would render "This week is X to Y ()"');
});

console.log('\nwhat is pinned stays pinned, and still says so');
t('the Monday Morning Brief is still Mon–Sun, by name', () => {
  // Its label is CORRECT as Mon–Sun, so this test exists to stop a blanket
  // find-and-replace sweeping it into Sun–Sat along with the rest.
  const brief = code(read('weekly-brief.js'));
  assert.ok(/WEEK\.MON_SUN/.test(brief), 'the brief no longer pins its convention');
  assert.ok(!/WEEK\.DASHBOARD/.test(brief), 'the brief now follows DASHBOARD');
  assert.deepStrictEqual(require('../weekly-brief.js').weekOf('2026-10-01'),
    { start: '2026-09-28', end: '2026-10-04' });
});
t('leasing still asks for SUN_SAT explicitly', () => {
  const i = server.indexOf('async function leasingWeeklyRollup(');
  assert.ok(/WEEK\.SUN_SAT/.test(server.slice(i, i + 900)));
});

console.log('\nthe dates the KPI tab shows today');
t('this week is Sunday 2026-09-27 to Saturday 2026-10-03', () => {
  // The dates the label was contradicting.
  const start = W.weekStartYMD('2026-10-01', W.DASHBOARD);
  assert.strictEqual(start, '2026-09-27');
  assert.strictEqual(W.addDaysYMD(start, 6), '2026-10-03');
  assert.strictEqual(W.dowYMD(start), 0, 'the week does not open on a Sunday');
  assert.strictEqual(W.DASHBOARD.name, 'Sun–Sat', 'the label would not match those dates');
});

console.log(`\n${pass} passing`);
