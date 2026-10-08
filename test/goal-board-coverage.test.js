// Kara's assignment on the weekly Leasing Goal Board (2026-10-08):
//   Rocio, Oscar and Yeni cover every community EXCEPT Windy Hill.
//   Sammy covers Windy Hill and nothing else.
//
// Coverage (who may be assigned) is deliberately NOT the same thing as LEAD
// (whose numbers a property counts toward) — the Team Scorecard sums each
// person's properties, so three people sharing all eight would report the
// portfolio three times. These assert both halves of that.
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

// Evaluate just the declarations this test is about, rather than booting the
// whole board.
const slice = (from, to) => js.slice(js.indexOf(from), js.indexOf(to));
const decls = slice('const PEOPLE=', 'const GROUPS=');
const sandbox = {};
new Function('S', decls + '\nS.PEOPLE=PEOPLE; S.LEAD=LEAD; S.coverFor=coverFor; S.SAMMY_ONLY=SAMMY_ONLY; S.SHARED_TEAM=SHARED_TEAM;')(sandbox);
const { LEAD, coverFor, SAMMY_ONLY, SHARED_TEAM } = sandbox;

const ALL_PROPS = Object.keys(LEAD);

console.log('goal board coverage');

t('the board still parses', () => {
  assert.doesNotThrow(() => new Function(js));
});

t('Windy Hill is the one Sammy property, by its full board name', () => {
  assert.strictEqual(SAMMY_ONLY, 'Windy Hill Apartment');
  assert.ok(ALL_PROPS.includes('Windy Hill Apartment'),
    'the board does not have a property by that exact name');
  assert.deepStrictEqual(coverFor('Windy Hill Apartment'), ['Sammy']);
});

t('Rocio, Oscar and Yeni cover every OTHER property', () => {
  assert.deepStrictEqual(SHARED_TEAM, ['Rocio', 'Oscar', 'Yeni']);
  for (const p of ALL_PROPS) {
    if (p === SAMMY_ONLY) continue;
    assert.deepStrictEqual(coverFor(p), ['Rocio', 'Oscar', 'Yeni'], p + ' is not covered by all three');
  }
});

t('Sammy covers nothing except Windy Hill', () => {
  const sammys = ALL_PROPS.filter(p => coverFor(p).includes('Sammy'));
  assert.deepStrictEqual(sammys, ['Windy Hill Apartment']);
});

t('none of the three shares Windy Hill with Sammy', () => {
  for (const who of SHARED_TEAM) {
    assert.ok(!coverFor('Windy Hill Apartment').includes(who), who + ' is on Windy Hill');
  }
});

t('every LEAD is somebody who covers that property', () => {
  for (const p of ALL_PROPS) {
    assert.ok(coverFor(p).includes(LEAD[p]),
      p + ' is led by ' + LEAD[p] + ', who does not cover it');
  }
});

t('LEAD is still exactly one person per property — the scorecard depends on it', () => {
  for (const p of ALL_PROPS) assert.strictEqual(typeof LEAD[p], 'string', p);
  // Nobody holds the whole portfolio: if LEAD ever became the coverage list the
  // Team Scorecard would count every property three times over.
  const counts = {};
  ALL_PROPS.forEach(p => { counts[LEAD[p]] = (counts[LEAD[p]] || 0) + 1; });
  assert.ok(Math.max(...Object.values(counts)) < ALL_PROPS.length);
});

t('the dropdowns that pick a person for a property offer only its coverage', () => {
  assert.ok(/class="leadsel-input" data-prop="\$\{p\}">\$\{coverFor\(p\)/.test(js),
    'the lead selector still lists everyone');
  assert.ok(/class="fb-by" data-prop="\$\{p\}">[\s\S]{0,60}\$\{coverFor\(p\)/.test(js),
    'the Facebook "Shared by" selector still lists everyone');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
