// Progress counters in the Morning Report's pending-items list.
//
// Arturo, 2026-10-19: "📖 SOP Review: 89/89 Slab links" appeared every morning
// after the review was finished — a completed job filed as outstanding, in the
// one section whose entire purpose is to say what is still left. 89 of 89 was
// checked against the table: total 89, linked 89.
//
// A line that never changes is also a line the reader stops seeing, which
// costs whatever appears beside it next.
//
// THESE RUN THE REAL FUNCTION rather than reading server.js for the right
// words. A test that greps for `done >= total` passes just as happily when the
// comparison is backwards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('morning report: progress counters');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Lift the function out and run it. server.js cannot be required — it starts a
// server — so the one function under test is extracted by its own bounds.
const start = src.indexOf('function mrProgressLine(');
assert.ok(start > 0, 'mrProgressLine is in server.js');
const end = src.indexOf('\n}', start) + 2;
const mrProgressLine = new Function(src.slice(start, end) + '; return mrProgressLine;')();

const render = (d, n) => `  📖 SOP Review: ${d}/${n} Slab links`;

t('it shows while there is work left', () => {
  assert.strictEqual(mrProgressLine(40, 89, render),
    '  📖 SOP Review: 40/89 Slab links');
  assert.strictEqual(mrProgressLine(88, 89, render),
    '  📖 SOP Review: 88/89 Slab links');
});

t('it disappears at 100% — the case that prompted this', () => {
  assert.strictEqual(mrProgressLine(89, 89, render), null);
});

t('and stays gone if the count somehow passes the total', () => {
  // A linked count above the total means the two queries disagree. Printing
  // "90/89 Slab links" under a pending heading would be both wrong and a
  // claim that work is outstanding.
  assert.strictEqual(mrProgressLine(90, 89, render), null);
});

t('an empty table is nothing left, not 0% done', () => {
  // 0/0 under a pending heading is the same false claim with worse arithmetic
  // behind it.
  assert.strictEqual(mrProgressLine(0, 0, render), null);
});

t('zero of many is still work to do', () => {
  assert.strictEqual(mrProgressLine(0, 89, render),
    '  📖 SOP Review: 0/89 Slab links');
});

t('unknown figures print nothing rather than a guess', () => {
  // A failed query or a missing count. A counter that invents a denominator
  // is worse than one nobody can see.
  [[null, 89], [89, null], [undefined, undefined], ['x', 5], [5, 'x'], [NaN, 10]]
    .forEach(([d, n]) => assert.strictEqual(mrProgressLine(d, n, render), null,
      JSON.stringify([d, n])));
});

t('a negative total is not treated as a backlog', () => {
  assert.strictEqual(mrProgressLine(0, -1, render), null);
});

t('numeric strings are read, not rejected', () => {
  // Supabase counts arrive as numbers today, but the head:true count has been
  // null before now and a string would be a quiet zero under `Number`.
  assert.strictEqual(mrProgressLine('40', '89', render),
    '  📖 SOP Review: 40/89 Slab links');
});

// ---- the wiring -------------------------------------------------------------

t('the SOP line goes through it', () => {
  const from = src.indexOf("ARTURO'S PENDING ITEMS LIST");
  const section = src.slice(from, src.indexOf('return L.join', from));
  assert.match(section, /mrProgressLine\(/, 'the counter is not pushed directly');
  assert.ok(!/L\.push\(`\s*📖 SOP Review/.test(section),
    'the unconditional push is gone');
  assert.match(section, /if \(sopLine\) L\.push\(sopLine\)/);
});

t('an error on the SOP query still prints nothing', () => {
  // It used to be guarded by `sopReview && !errors.sopReview`; that guard has
  // to survive, or a failed lookup becomes a counter of nulls.
  const from = src.indexOf("ARTURO'S PENDING ITEMS LIST");
  const section = src.slice(from, src.indexOf('return L.join', from));
  assert.match(section, /!errors\.sopReview/);
});

t('no other fixed counter is left in the report', () => {
  // The whole-report sweep Arturo asked for. Any OTHER "x/y" line built from
  // two interpolated values inside the report body would have the same
  // problem; today the SOP line is the only one, and this fails if a new one
  // is added without going through mrProgressLine.
  const body = src.slice(src.indexOf('function mrFormat('),
    src.indexOf('return L.join', src.indexOf('function mrFormat(')));
  const counters = [...body.matchAll(/\$\{[^}]+\}\/\$\{[^}]+\}/g)].map(m => m[0]);
  const viaHelper = body.slice(body.indexOf('mrProgressLine('));
  counters.forEach(c => assert.ok(viaHelper.includes(c),
    'a counter outside mrProgressLine: ' + c));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
