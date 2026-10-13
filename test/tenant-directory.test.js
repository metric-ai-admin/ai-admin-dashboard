// What of the Tenant Directory reaches the disk.
//
// The first projection was a whitelist of column names written from what the
// columns were assumed to be called. It synced 411 rows and produced ZERO
// phone numbers. The report does not call them `phone` and `mobile`, and a
// whitelist cannot report what it threw away — the store looked exactly like
// one nobody had synced.
//
// So these tests are mostly about columns NOBODY HAS SEEN YET: a projection
// whose correctness depends on guessing a name right is the thing being fixed,
// and a test that only feeds it the names we already know would pass for the
// same wrong reason the projection did.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TD = require('../lib/tenant-directory.js');
const CM = require('../lib/call-match.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('tenant directory projection');

// ---- the drop list wins ----------------------------------------------------

t('a birthdate never reaches the disk, under any spelling', () => {
  // The whole reason the report was kept out of the registry until 10-13.
  ['date_of_birth', 'Date Of Birth', 'birth_date', 'dob', 'DOB', 'tenant_dob']
    .forEach(k => assert.ok(TD.isDropped(k), k + ' is kept'));
});

t('SSN, email, emergency contact and balance go too', () => {
  ['ssn', 'SSN', 'social_security_number', 'tax_id',
    'email', 'Email', 'e-mail', 'tenant_email',
    'emergency_contact', 'emergency_contact_name', 'Emergency Phone',
    'balance', 'Balance', 'amount_owed', 'deposit_held', 'rent']
    .forEach(k => assert.ok(TD.isDropped(k), k + ' is kept'));
});

t('DROP beats KEEP, so a sensitive column cannot sneak in as a phone', () => {
  // THE ORDERING IS THE POINT. "Emergency Contact Phone" matches the phone
  // pattern. It must still be dropped, the same way HARD_PERSONAL beats
  // SAFE_NAME in lib/safe-print.js: the dangerous answer must not depend on a
  // keep-list staying complete.
  ['emergency_contact_phone', 'Emergency Contact Mobile', 'emergency_cell']
    .forEach(k => {
      assert.ok(TD.isDropped(k), k);
      assert.ok(!TD.isKept(k), k + ' survived as a phone column');
      assert.ok(!TD.isPhoneColumn(k), k + ' is treated as a resident number');
    });
});

t('a column nobody has seen is dropped by default', () => {
  // The default is OUT. Adding a field stays a deliberate act.
  ['employer', 'salary', 'notes', 'co_signer', 'contact_notes', 'drivers_license',
    'vehicle_plate', 'move_in_notes'].forEach(k =>
    assert.ok(!TD.isKept(k), k + ' is kept by accident'));
});

// ---- the phone columns are kept by meaning ---------------------------------

t('a phone column is kept whatever it is called', () => {
  // None of these were in the old whitelist. That is the bug, as a test.
  ['phone', 'mobile', 'Phone Numbers', 'phone_numbers', 'home_phone',
    'mobile_phone', 'cell', 'cell_phone', 'primary_phone', 'tenant_phone_number',
    'work_telephone', 'tel'].forEach(k => {
    assert.ok(TD.isPhoneColumn(k), k + ' would be thrown away');
    assert.ok(TD.isKept(k), k);
  });
});

t('"contact" alone is not a phone column', () => {
  // A looser pattern would keep contact_name and contact_notes, which are not
  // numbers. The fix for guessing too narrowly is not guessing too widely.
  ['contact_name', 'contact_notes', 'contact_preference']
    .forEach(k => assert.ok(!TD.isPhoneColumn(k), k));
});

t('a cell holding several numbers is several numbers', () => {
  // delinquency_kpi puts them all in one field. A field read whole matches
  // nothing: two numbers in a cell is not a phone number.
  assert.deepStrictEqual(TD.splitNumbers('(512) 555-0100, 512-555-7777'),
    ['(512) 555-0100', '512-555-7777']);
  assert.deepStrictEqual(TD.splitNumbers('512-555-0100 / 512-555-7777').length, 2);
  assert.deepStrictEqual(TD.splitNumbers('512-555-0100 and 512-555-7777').length, 2);
  assert.deepStrictEqual(TD.splitNumbers(''), []);
});

// ---- the whole row ---------------------------------------------------------

const RAW = {
  'Tenant Name': 'Castilla, Dulce P.',
  property_name: 'Hyde Park Square',
  property_id: '1925',
  unit: '107',
  tenant_status: 'Current',
  phone_numbers: '(512) 555-0100, 512-555-7777',
  home_phone: '512-555-0100',
  date_of_birth: '1990-04-12',
  ssn: '000-00-0000',
  email: 'a@b.c',
  emergency_contact_phone: '512-555-3333',
  balance: '1200.00',
  employer: 'Acme',
};
const OUT = TD.project(RAW);

t('the projected row carries what the match needs and nothing else', () => {
  ['date_of_birth', 'ssn', 'email', 'emergency_contact_phone', 'balance', 'employer']
    .forEach(k => assert.ok(!(k in OUT), k + ' reached the disk'));
  assert.strictEqual(OUT['Tenant Name'], 'Castilla, Dulce P.', 'a shared number needs the name');
  assert.strictEqual(OUT.unit, '107');
  assert.strictEqual(OUT.property_name, 'Hyde Park Square');
});

t('the raw phone columns are kept beside the flat list', () => {
  // Keeping both means the next person can see what the report actually
  // returned instead of trusting that the split was right.
  assert.strictEqual(OUT.phone_numbers, '(512) 555-0100, 512-555-7777');
  assert.ok(Array.isArray(OUT.phones));
  assert.ok(OUT.phones.length >= 2, 'the numbers were not split out');
  // The emergency number must not be in there pretending to be the resident's.
  assert.ok(!OUT.phones.some(p => /555-3333/.test(p)), 'an emergency contact became a resident');
});

t('the readers find the numbers without knowing the column names', () => {
  const idx = CM.indexDirectory([OUT]);
  assert.deepStrictEqual(idx.byUnit.get('hyde park square|107').sort(),
    ['5125550100', '5125557777']);
  assert.deepStrictEqual(
    CM.numbersFor({ property: 'Hyde Park Square', unit: '107' }, idx).sort(),
    ['5125550100', '5125557777']);
  const shared = CM.indexResidents([OUT]);
  assert.deepStrictEqual(shared.get('5125550100'), ['Castilla, Dulce P.']);
});

t('a row stored by the OLD projection still works', () => {
  // There is one on the Render disk right now, and it will be there until the
  // re-sync runs. It must not start throwing.
  const old = { tenant_name: 'Smith, John', property_name: 'The Chateau', unit: '4',
    phone: '512-555-7777', mobile: '' };
  assert.deepStrictEqual(CM.indexDirectory([old]).byUnit.get('the chateau|4'), ['5125557777']);
});

// ---- the wiring ------------------------------------------------------------

t('the registry no longer names the phone columns itself', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  const at = s.indexOf("id: 'tenant_directory'");
  assert.ok(at > 0);
  const block = s.slice(at, at + 1800);
  assert.ok(/require\('\.\/lib\/tenant-directory\.js'\)\.project/.test(block),
    'the projection is still written out inline');
  assert.ok(!/mobile: r\.mobile/.test(block), 'the guessed column names are still there');
});

t('the probe reads the LIVE report and prints no values', () => {
  // probe-store-columns can only show the columns a projection already kept,
  // which is exactly the question it cannot answer.
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'probe-report-columns.js'), 'utf8');
  assert.ok(/fetchReport/.test(s), 'it reads the store and cannot see a dropped column');
  assert.ok(!/writeJSON|syncReport|fs\.write/.test(s), 'it writes the unprojected rows somewhere');
  // The only reads of a cell are emptiness checks.
  assert.ok(/clean\(r\[k\]\)/.test(s));
  assert.ok(/no cell value was printed/.test(s));
});

t('the match script can read a list-valued phone field', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'call-resident-match.js'), 'utf8');
  assert.ok(/Array\.isArray\(v\)/.test(s),
    'a `phones` array falls through the string check and the source reports zero');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
