#!/usr/bin/env node
//
// Runs every test/*.test.js and reports a single pass/fail.
//
//   npm test
//
// Exists so "run the tests before deploying" is one command rather than a
// for-loop someone has to remember, and so a suite that FAILS cannot be missed:
// each file's exit code is checked, and the run exits non-zero if any file did.
// A previous version of that loop piped output to `head`, which discarded the
// exit code and hid a broken test for days.
//
// Each suite runs in its own process. They are independent, and the boot smoke
// test in particular builds a jsdom window and installs process-level error
// handlers — sharing a process with the others would let its state leak.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

// The boot smoke test builds a DOM and runs the whole front-end bundle, so it
// is slower than the pure-function suites and gets more room.
const TIMEOUT_MS = 120000;

let failed = 0;
const results = [];

for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    encoding: 'utf8', timeout: TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  const ok = r.status === 0 && !r.error;
  if (!ok) failed++;

  // A passing suite prints its last line (the count); a failing one prints
  // everything, because the point of running it was to see what broke.
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  results.push({ f, ok, ms, tail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f.padEnd(34)} ${String(ms).padStart(6)}ms  ${ok ? tail : ''}`);
  if (!ok) {
    if (r.error && r.error.code === 'ETIMEDOUT') console.log(`      timed out after ${TIMEOUT_MS / 1000}s`);
    console.log(out.split('\n').map(l => '      ' + l).join('\n'));
  }
}

// Two summary styles are in use — "N passing" and "N passed, 0 failed" — so
// both are read rather than silently counting one of them as zero.
const total = results.reduce((n, r) =>
  n + (Number((r.tail.match(/^(\d+) pass(?:ing|ed)/) || [])[1]) || 0), 0);
console.log(`\n${files.length} suites, ${total} assertions, ${failed ? failed + ' FAILED' : 'all passing'}`);
process.exit(failed ? 1 : 0);
