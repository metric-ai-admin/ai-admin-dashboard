// Kara, 2026-10-09: "Take the total needed and split it amongst them."
//
// Rocio, Oscar and Yeni share every community except Windy Hill, so the goal
// for that pool is divided three ways. The property this file exists to defend
// is the one Kara stated herself: THE PARTS ADD BACK TO THE TOTAL. A board that
// shows three shares summing to one less than the goal is a board that quietly
// lowers the target every week it is read.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'tools', 'weekly_leasing_goal_board.html');
const html = fs.readFileSync(FILE, 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// Just the declarations, the way goal-board-coverage.test.js does it. `__OUT`
// rather than a short name: the board has its own top-level variables and a
// one-letter parameter was shadowed by one of them once already.
const decls = js.slice(js.indexOf('const PEOPLE='), js.indexOf('const GROUPS='));
const sandbox = {};
new Function('__OUT', decls +
  '\n__OUT.splitEqually=splitEqually; __OUT.shareOf=shareOf; __OUT.SHARE_ORDER=SHARE_ORDER;' +
  '\n__OUT.SHARED_TEAM=SHARED_TEAM; __OUT.SAMMY_ONLY=SAMMY_ONLY; __OUT.LEAD=LEAD;')(sandbox);
const { splitEqually, shareOf, SHARE_ORDER, SHARED_TEAM, SAMMY_ONLY, LEAD } = sandbox;

console.log('goal board split');

t('the three shares add back to the total, for every total', () => {
  for (let total = 0; total <= 400; total++) {
    const parts = splitEqually(total, 3);
    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[0] + parts[1] + parts[2], total,
      total + ' split into ' + parts.join('/') + ' — the parts do not add back');
  }
});

t('a total that divides evenly splits evenly', () => {
  assert.deepStrictEqual(splitEqually(99, 3), [33, 33, 33]);
  assert.deepStrictEqual(splitEqually(0, 3), [0, 0, 0]);
});

t('a remainder of one goes to one person, not to all three', () => {
  // 100 is 34/33/33. Rounding 33.33 up everywhere would set a goal of 102 for
  // a pool that needs 100, and rounding down would set 99.
  assert.deepStrictEqual(splitEqually(100, 3), [34, 33, 33]);
  assert.deepStrictEqual(splitEqually(101, 3), [34, 34, 33]);
});

t('the shares never differ by more than one', () => {
  for (let total = 0; total <= 400; total++) {
    const p = splitEqually(total, 3);
    assert.ok(Math.max(...p) - Math.min(...p) <= 1, total + ' -> ' + p.join('/'));
  }
});

t('the remainder always lands on the same people in the same order', () => {
  // Otherwise an unrelated number moving by one would shuffle whose target
  // went up, and the board would look like it was reassigning work.
  assert.deepStrictEqual(SHARE_ORDER, ['Rocio', 'Oscar', 'Yeni']);
  assert.strictEqual(shareOf(100, 'Rocio'), 34);
  assert.strictEqual(shareOf(100, 'Oscar'), 33);
  assert.strictEqual(shareOf(100, 'Yeni'), 33);
  assert.strictEqual(shareOf(101, 'Oscar'), 34);
});

t('each person’s share of any total adds back to that total', () => {
  for (const total of [0, 1, 2, 7, 25, 58, 100, 397, 1234]) {
    const sum = SHARE_ORDER.reduce((s, who) => s + shareOf(total, who), 0);
    assert.strictEqual(sum, total, total + ' does not reassemble from the three shares');
  }
});

t('Sammy is not in the split — Windy Hill is his whole, not a third', () => {
  assert.strictEqual(shareOf(90, 'Sammy'), 0);
  assert.ok(!SHARE_ORDER.includes('Sammy'));
  assert.strictEqual(SAMMY_ONLY, 'Windy Hill Apartment');
  assert.strictEqual(LEAD[SAMMY_ONLY], 'Sammy');
});

t('a fractional or junk total is still split into whole units that add up', () => {
  // Goals arrive from compute() and are not always integers.
  assert.deepStrictEqual(splitEqually(10.4, 3), [4, 3, 3]);
  assert.deepStrictEqual(splitEqually(-5, 3), [0, 0, 0], 'a negative goal is no goal, not a negative share');
  assert.deepStrictEqual(splitEqually(NaN, 3), [0, 0, 0]);
});

// ---- the board uses it, and does not split the actuals ---------------------

t('the scorecard shows a share of the goal for the three', () => {
  const fn = js.slice(js.indexOf('function renderScorecard'), js.indexOf('function sumActuals'));
  assert.ok(/shareOf\(sharedGoals\[k\],person\)/.test(fn),
    'the three must be shown their share of the shared goal');
  assert.ok(/Shared pool/.test(fn),
    'the pool the shares came from must be shown too — a third of nothing stated is unreadable');
});

t('activity is never divided three ways', () => {
  const fn = js.slice(js.indexOf('function renderScorecard'), js.indexOf('function sumActuals'));
  // Splitting actuals would credit each of them with a third of leads nobody
  // recorded them taking. That is the same invented attribution the CRM was
  // just fixed for.
  assert.ok(!/shareOf\(\s*a\[|splitEqually\(\s*a\[/.test(fn),
    'actuals must not be run through the split');
  assert.ok(/Team Actual/.test(fn), 'the shared actuals must be labelled as the team’s');
});

t('the board still parses', () => {
  assert.doesNotThrow(() => new Function(js));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
