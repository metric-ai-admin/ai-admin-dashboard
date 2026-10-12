// Printing a report row without printing a person.
//
// scripts/probe-applications-report.js dumped a complete sample row to settle
// which columns the Rental Applications report carries. The row was a real
// applicant: email, phone, employer and monthly salary, on a terminal whose
// output gets pasted into chats. The script needed the column NAMES; it
// printed everything because printing everything was easier than deciding.
//
// windy-hill-prelease.js had already got this right and the lesson did not
// travel. These assertions are how it travels.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SP = require('../lib/safe-print.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('safe print');

t('the columns that leaked are redacted', () => {
  ['email', 'phone_number', 'employer_name', 'monthly_salary', 'applicant_s',
    'landlord_email', 'total_additional_income'].forEach(c =>
    assert.strictEqual(SP.isSafe(c), false, c + ' would still be printed'));
});

t('a column nobody has seen is hidden, not shown', () => {
  // THE RULE THAT MATTERS. A report that gains a column must not start
  // leaking one: a diagnostic is read once and a leak is permanent.
  ['co_applicant_mobile', 'guarantor_income', 'emergency_contact_name',
    'applicant_ssn', 'date_of_birth'].forEach(c =>
    assert.strictEqual(SP.isSafe(c), false, c + ' is new and was printed anyway'));
});

t('ids, dates, statuses and the property stay readable', () => {
  // A diagnostic that redacts these answers nothing and gets replaced by one
  // that redacts nothing.
  ['rental_application_id', 'property_id', 'property_name', 'unit', 'status',
    'application_status', 'tenant_status', 'received', 'lease_start_date',
    'move_in_date', 'created_at', 'updated_at'].forEach(c =>
    assert.strictEqual(SP.isSafe(c), true, c + ' is not personal and was hidden'));
});

t('property_name and tenant_status survive the personal pattern', () => {
  // Both match on a substring — "name", "tenant" — and neither is a person.
  // SAFE_NAME is checked first for exactly this reason.
  assert.ok(SP.isSafe('property_name'));
  assert.ok(SP.isSafe('tenant_status'));
  assert.ok(!SP.isSafe('tenant_name'), 'but the tenant’s NAME is still a person');
});

t('a masked value says whether there was one, and never what it was', () => {
  assert.strictEqual(SP.mask(''), '(empty)');
  assert.strictEqual(SP.mask(null), '(empty)');
  const m = SP.mask('dulce@example.com');
  assert.ok(!/dulce|example/.test(m), 'the value leaked into the mask');
  assert.ok(/set/.test(m), '"this column is always empty" is a finding too');
});

t('safeRow keeps every key and redacts the values', () => {
  const row = {
    rental_application_id: '123', property_name: 'Ascent at Northgate',
    received: '10/01/26', status: 'Approved',
    email: 'd@example.com', monthly_salary: '4200', employer_name: 'Acme',
  };
  const out = SP.safeRow(row);
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(row).sort(),
    'the column list is usually the whole point and must survive');
  assert.strictEqual(out.status, 'Approved');
  const printed = JSON.stringify(out);
  ['d@example.com', '4200', 'Acme'].forEach(v =>
    assert.ok(!printed.includes(v), v + ' reached the output'));
});

t('fillRates shows no values at all', () => {
  const lines = SP.fillRates([{ email: 'a@b.c', status: 'Approved' }]).join('\n');
  assert.ok(!/a@b\.c/.test(lines));
  assert.ok(/email/.test(lines), 'the column must still be listed');
});

// ---- the scripts use it ----------------------------------------------------

const SCRIPTS = path.join(__dirname, '..', 'scripts');

// Comments and string literals removed, so this scans CODE and not prose.
// Both of the first failures here were my own text: a help line that quotes
// `console.log(r)` inside a string, and a comment explaining which client the
// probe used to call. A test that reads its own explanation is not checking
// anything.
const codeOf = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

t('no diagnostic prints a whole raw row', () => {
  // The exact shape of the leak: JSON.stringify of a row, or a row object
  // handed straight to console.log.
  const offenders = [];
  fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.js')).forEach(f => {
    const code = codeOf(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
    // Rows from a report are conventionally `r` or `row` in this codebase.
    if (/console\.log\([^)]*JSON\.stringify\(\s*(r|row)\s*\)/.test(code)
      || /console\.log\(\s*(r|row)\s*\)/.test(code)) offenders.push(f);
  });
  assert.deepStrictEqual(offenders, [],
    'these print a raw row: ' + offenders.join(', '));
});

t('the probes that print columns go through safe-print', () => {
  ['probe-applications-report.js', 'windy-hill-prelease.js'].forEach(f => {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    assert.ok(/require\('\.\.\/lib\/safe-print\.js'\)/.test(src),
      f + ' has its own idea of what is safe, or none');
  });
});

t('the applications probe asks through the door the sync uses', () => {
  // The first version called appfolio-client (APPFOLIO_CLIENT_ID) while the
  // sync calls the Reports API (APPFOLIO_REPORTS_CLIENT_ID). Five of six
  // cases came back 0 and the zeros were about the client, not the
  // parameters — a probe that tests a different door answers a different
  // question and nobody can tell from the output.
  const src = fs.readFileSync(path.join(SCRIPTS, 'probe-applications-report.js'), 'utf8');
  const code = codeOf(src);
  assert.ok(/APPFOLIO_REPORTS_CLIENT_ID/.test(code));
  assert.ok(!/require\(.{0,4}\.\.\/appfolio-client/.test(code), 'it is back on the other client');
  assert.ok(/BASELINE/.test(src) && /ignored/.test(src),
    'an ignored parameter looks exactly like one that works — it must be measured against a baseline');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
