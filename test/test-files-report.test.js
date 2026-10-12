// Every test file must be able to fail the build.
//
// WHY THIS EXISTS. Several suites here count passes and failures and end with
//
//     console.log(pass + ' passed, ' + fail + ' failed');
//     if (fail) process.exit(1);
//
// Appending a test AFTER that block leaves it running past the exit check, so
// it prints FAIL and the process still ends zero. test/run-all.js reads the
// exit code, so the whole suite reports green with a failing assertion on
// screen. That happened on 2026-10-12 to evictions.test.js: a real failure —
// "EvictionStatus" not matching a status column — printed, and the run was
// reported as 88 suites all passing.
//
// A test that cannot fail is worse than no test: it is a claim that something
// was checked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const DIR = __dirname;
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.test.js'));

// Two spellings are in use here and both are fine:
//   if (fail) process.exit(1)
//   process.exit(fail ? 1 : 0)
// Matching only the first reported six healthy suites as broken on the first
// run of this file — the same class of mistake it exists to catch.
const EXIT_CALL = /process\.exit\([^)]*\)/g;
const DECIDES = /fail|1/;

console.log('test files can fail the build');

t('there are test files to check', () => {
  assert.ok(FILES.length > 50, 'only found ' + FILES.length + ' — the scan broke');
});

t('nothing runs after the exit check', () => {
  const offenders = [];
  FILES.forEach(f => {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const calls = [...src.matchAll(EXIT_CALL)].filter(m => DECIDES.test(m[0]));
    // No exit call at all means the suite throws instead, and a throw ends
    // the process with a non-zero code on its own.
    if (!calls.length) return;
    const at = calls[calls.length - 1].index;
    // Anything after it that is not a comment, a brace or blank is code
    // running with the verdict already decided.
    const after = src.slice(at).split('\n').slice(1)
      .filter(l => l.trim() && !/^(\/\/|\*|\/\*|\*\/|\}|\)|\);)/.test(l.trim()));
    if (after.length) offenders.push(f + ' (' + after.length + ' lines after the exit)');
  });
  assert.deepStrictEqual(offenders, [],
    'these run tests that cannot fail the build:\n   ' + offenders.join('\n   '));
});

t('a counting suite acts on its count', () => {
  // The other half of the same mistake: a file that tallies failures and
  // never looks at the tally.
  const offenders = [];
  FILES.forEach(f => {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const counts = /fail\+\+|fail \+= 1/.test(src);
    if (!counts) return;
    const acts = [...src.matchAll(EXIT_CALL)].some(m => /fail/.test(m[0]))
      || /if \(fail\)[\s\S]{0,60}process\.exit\(/.test(src);
    if (!acts) offenders.push(f);
  });
  assert.deepStrictEqual(offenders, [],
    'these count failures and never act on the count: ' + offenders.join(', '));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
