// The pre-push hook, and the one mistake it exists to prevent.
//
// 13f1fd0 reached main red because the gate was `npm test | grep … && commit`,
// which reads GREP's exit code. These assert the hook reads node's.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-push');
const src = fs.readFileSync(HOOK, 'utf8');
// Comments explain the bug by quoting it, so every assertion about the SHAPE of
// the script runs against the code only. Asserting against prose is how a test
// ends up passing because of a sentence.
const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('pre-push hook');

t('the hook exists and is a shell script', () => {
  assert.ok(fs.existsSync(HOOK));
  assert.ok(/^#!\/bin\/sh/.test(src));
});

t('it runs the full suite, not a subset', () => {
  assert.ok(/^npm test$/m.test(code), 'expected a bare `npm test` line');
});

t('npm test is never piped — a pipeline reports the LAST command exit code', () => {
  const piped = code.split('\n').filter(l => /npm test/.test(l) && /\|/.test(l));
  assert.deepStrictEqual(piped, [], 'npm test is piped: ' + piped.join(' / '));
});

t('the verdict comes from $? and nothing else', () => {
  assert.ok(/status=\$\?/.test(code), 'expected the exit code to be captured in a variable');
  assert.ok(/\[ \$status -ne 0 \]/.test(code), 'expected a branch on that exit code');
});

t('grep decides nothing', () => {
  assert.ok(!/grep/.test(code), 'grep appears in the executable part of the hook');
});

t('a failure exits non-zero, which is what blocks the push', () => {
  assert.ok(/\bexit 1\b/.test(code));
  assert.ok(/\bexit 0\b/.test(code));
});

t('package.json installs it by pointing core.hooksPath at .githooks', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['hooks:install'], 'no hooks:install script');
  assert.ok(/core\.hooksPath \.githooks/.test(pkg.scripts['hooks:install']));
});

// The behaviour, not just the shape: run the hook's own logic against a fake
// `npm` that fails, and against one that succeeds.
const run = exitCode => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hook-'));
  fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho "(fake suite)"\nexit ' + exitCode + '\n');
  fs.chmodSync(path.join(dir, 'npm'), 0o755);
  try {
    execFileSync('sh', [HOOK], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status;
  }
};

t('a red suite blocks the push (exit 1)', () => {
  assert.strictEqual(run(1), 1);
});

t('a suite that CRASHES before printing a summary also blocks', () => {
  // This is the exact case the grep gate let through: no "0 FAILED" line to
  // match, so grep found nothing and the push went ahead.
  assert.strictEqual(run(7), 1);
});

t('a green suite lets the push through (exit 0)', () => {
  assert.strictEqual(run(0), 0);
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
