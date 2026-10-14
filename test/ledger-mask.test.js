// A ledger description is not a system label.
//
// scripts/probe-deposit-reports.js printed two resident names on 2026-10-15
// under a banner saying no name was printed. The mistake was an assumption:
// `description` is usually the system's own words, and AppFolio interpolates
// the resident, the property and the unit into it. A field is not safe because
// of what it is called — the same lesson as lib/safe-print.js and the tenant
// directory's phone columns, for the third time.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/ledger-mask.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('ledger mask');

const REAL = 'Resident Security Deposits - Jane Doe, Hyde Park Square - 107: '
  + 'Transfer of Resident Security Deposits at Move Out';
const KNOWN = ['Jane Doe', 'Maria De La Cruz', 'John Smith', 'Hyde Park Square',
  'Windy Hill Apartment'];

t('the name, property and unit are gone from the real shape', () => {
  const p = M.pattern(REAL);
  ['Jane', 'Doe', 'Hyde Park Square', '107'].forEach(bit =>
    assert.ok(!p.includes(bit), bit + ' survived: ' + p));
});

t('what is left still says WHICH KIND of entry it is', () => {
  // A pattern nobody can read is useless; the point is to count kinds.
  const p = M.pattern(REAL);
  assert.ok(/Transfer of Resident Security Deposits at Move Out/.test(p), p);
  assert.ok(/Resident Security Deposits/.test(p), p);
});

t('the settlement entry patterns the same way', () => {
  const p = M.pattern('Resident Security Deposits - Maria De La Cruz, Windy Hill '
    + 'Apartment - 3-109: Settlement for unpaid Resident Security Deposits');
  assert.ok(/Settlement for unpaid Resident Security Deposits/.test(p), p);
  assert.ok(!/Maria|Cruz|Windy Hill|3-109/.test(p), p);
});

t('a short system label is left alone', () => {
  assert.strictEqual(M.pattern('Rent'), 'Rent');
  assert.strictEqual(M.pattern('Late Fee'), 'Late Fee');
});

t('THE SECOND LAYER CATCHES WHAT THE FIRST MISSES', () => {
  // "Security Deposit Refund issued to John Smith" has no " - ... :" shape, so
  // the structural rule does nothing to it. This is the case that proves the
  // verifying layer earns its keep — a rule I wrote failing is the expected
  // case, not the surprising one.
  const raw = 'Security Deposit Refund issued to John Smith';
  assert.ok(M.pattern(raw).includes('John Smith'), 'the structural rule should miss this');
  assert.ok(/^\(withheld/.test(M.describe(raw, KNOWN)), M.describe(raw, KNOWN));
});

t('withheld rows are COUNTED, not dropped', () => {
  // A probe that silently discards what it cannot mask reports a smaller
  // number than the truth, which is the other way to be wrong here.
  const rows = [
    { description: REAL },
    { description: 'Security Deposit Refund issued to John Smith' },
    { description: 'Rent' },
  ];
  const out = M.tally(rows, 'description', KNOWN);
  assert.strictEqual(out.withheld, 1);
  assert.strictEqual(out.rows.reduce((a, r) => a + r.count, 0), 3, 'a row went missing');
});

t('nothing a tally returns is a description as written', () => {
  const rows = KNOWN.map(n => ({ description: 'Resident Security Deposits - ' + n
    + ', Hyde Park Square - 107: Transfer of Resident Security Deposits at Move Out' }));
  const out = M.tally(rows, 'description', KNOWN);
  const text = JSON.stringify(out);
  KNOWN.forEach(n => assert.ok(!text.includes(n), n + ' reached the output'));
});

t('a blank description does not become a blank line', () => {
  assert.strictEqual(M.describe('', KNOWN), '(blank)');
  assert.strictEqual(M.describe(null, KNOWN), '(blank)');
});

// ---- the probes ------------------------------------------------------------

t('BOTH probes mask before printing', () => {
  // The old one is the one that leaked; fixing only the new one would leave
  // the loaded gun on the table.
  ['scripts/probe-ledger-window.js', 'scripts/probe-deposit-reports.js'].forEach(f => {
    const s = src(f);
    assert.ok(/ledger-mask/.test(s), f + ' does not use the mask');
    // String literals stripped first: the closing banner says "No description
    // was printed as written", and a test that matches the promise is a test
    // that fails for saying so. Fourth time this file's own words have tripped
    // a search in this repo.
    const code = s.replace(/^\s*\/\/.*$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    assert.ok(!/console\.log\([^)]*\bdescription\b[^)]*\)/.test(code),
      f + ' prints a description directly');
    // And the masker is what feeds the printing.
    assert.ok(/MASK\.tally\(|MASK\.describe\(/.test(code), f + ' never calls the mask');
  });
});

t('the date parameter is discovered against a baseline, not assumed', () => {
  // `from_date` on the applications report was accepted, ignored, and returned
  // 20 rows that looked like a working filter. A parameter that returns the
  // baseline count is IGNORED, and saying otherwise cost a morning.
  const s = src('scripts/probe-ledger-window.js');
  assert.ok(/BASELINE \(no parameters\)/.test(s));
  assert.ok(/IGNORED \(same count as baseline\)/.test(s));
  assert.ok(/r\.rows\.length === base\.rows\.length/.test(s),
    'nothing compares the filtered count to the unfiltered one');
});

t('the probes write nothing', () => {
  ['scripts/probe-ledger-window.js', 'scripts/probe-deposit-reports.js'].forEach(f => {
    const s = src(f);
    assert.ok(!/\.insert\(|\.update\(|\.upsert\(|writeJSON|fs\.write/.test(s), f + ' writes');
    // Reports are read with POST — that is how the Reports API works — but
    // nothing may POST anywhere else.
    assert.ok(!/\/api\/v2\/(?!reports)/.test(s), f + ' calls a non-report endpoint');
  });
});

t('the join would use property and unit, never the name', () => {
  // The pair is enough to tie an entry to a move-out and carries nobody's
  // identity on its own.
  const s = src('scripts/probe-ledger-window.js');
  assert.ok(/By PROPERTY \+ UNIT read out of the description, never by the name/.test(s));
  assert.ok(/turnKeys/.test(s) && /unit_turn_detail/.test(s));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
