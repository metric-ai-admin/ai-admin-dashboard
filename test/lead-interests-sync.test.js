// The interests sync: guest_cards ['all'], keyed HMAC, Central days.
//
// This is the pull that matches Katie's report. The leads sync reads
// guest_card_inquiries — a different population, 84 rows for 09/27-10/03 where
// her report has 136 — and that one is deliberately left alone, because the
// Goal Board runs on it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const sql = read(path.join('supabase', 'migrations', '080_lead_interests_rekey.sql'));

console.log('it reads the right report');
t("it pulls guest_cards, not the leads sync's report", () => {
  assert.ok(/LEAD_INTEREST_REPORT = '\/api\/v2\/reports\/guest_cards\.json'/.test(code));
  const i = code.indexOf('async function leasingFetchGuestCardInterests');
  const body = code.slice(i, i + 900);
  assert.ok(!/guest_card_inquiries/.test(body), 'it reads the inquiries report again');
});
t("guest_card_statuses is the literal 'all'", () => {
  // Without it the API answers with active cards only — 99 rows in that week
  // against her 136. Four numeric spellings were probed and ignored.
  const i = code.indexOf('async function leasingFetchGuestCardInterests');
  const body = code.slice(i, i + 900);
  assert.ok(/guest_card_statuses: \['all'\]/.test(body), "the ['all'] status filter is gone");
});
t('the leads sync is untouched', () => {
  // Katie's Goal Board runs on it and its numbers must not move.
  assert.ok(/attempts = \[\s*\n?\s*\{ path: '\/api\/v2\/reports\/guest_card_inquiries\.json'/.test(code)
    || /guest_card_inquiries/.test(code), 'leasingFetchGuestCards changed report');
  assert.ok(/onConflict: 'appfolio_id'/.test(code), 'the leads upsert key changed');
});

console.log('\nthe day boundary');
t('it asks for one extra day', () => {
  // received_on_to is applied against UTC and Central is hours behind it, so
  // asking for the week exactly loses every Saturday evening — that is the
  // Hyde Park row, and it happens every week.
  const i = code.indexOf('async function leasingFetchGuestCardInterests');
  const body = code.slice(i, i + 900);
  assert.ok(/plusOne\.setUTCDate\(plusOne\.getUTCDate\(\) \+ 1\)/.test(body), 'no extra day is requested');
  assert.ok(/received_on_to: plusOne/.test(body));
});
t('and narrows back on the CENTRAL day', () => {
  const i = code.indexOf('async function leasingFetchGuestCardInterests');
  const body = code.slice(i, i + 900);
  assert.ok(/WEEK\.toChicagoYMD\(new Date\(r && r\.received\)\)/.test(body),
    'the extra day is kept, so the window is a day too wide');
  assert.ok(/day >= dateFrom && day <= dateTo/.test(body));
});
t('both counts are reported, so the widening is visible', () => {
  assert.ok(/inCentralWindow: got\.inWindow\.length/.test(code));
  assert.ok(/requestedTo/.test(code), 'nothing says the window was widened');
});

console.log('\nthe dedup key cannot be reversed');
t('it is an HMAC, not a bare digest', () => {
  // Ten billion US phone numbers is hours of GPU time: a plain sha256 of a
  // phone is not an anonymisation, it is an encoding.
  const i = code.indexOf('function leadDedupKey');
  const body = code.slice(i, i + 900);
  assert.ok(/createHmac\('sha256', secret\)/.test(body), 'the key is not an HMAC');
  assert.ok(!/createHash\('sha256'\)/.test(body), 'an unkeyed digest is still in there');
});
t('a missing secret REFUSES, it does not fall back', () => {
  // A silent fallback would produce the reversible digests this column exists
  // to avoid, indistinguishable from the real ones afterwards.
  const i = code.indexOf('function leadDedupKey');
  const body = code.slice(i, i + 900);
  assert.ok(/if \(!secret\) throw new Error\(/.test(body), 'it defaults instead of refusing');
  assert.ok(/LEAD_DEDUP_HMAC_KEY is not set/.test(body), 'the error does not name the variable');
});
t("the basis is Lyndsay's chain, in her order, with her trim", () => {
  const i = code.indexOf('function leadDedupKey');
  const body = code.slice(i, i + 900);
  assert.ok(/const basis = phone \|\| email \|\| name;/.test(body), 'the fallback order is wrong');
  assert.ok(!/toLowerCase\(\)/.test(body), 'it lowercases, which her report does not');
  assert.ok(!/replace\(\/\\D\/g/.test(body), 'it strips digits, which her report does not');
});
t('equal inputs hash equal, so the count is hers', () => {
  // The property that makes this work at all.
  const k = 'test-secret';
  const h = v => crypto.createHmac('sha256', k).update(v).digest('hex');
  assert.strictEqual(h('(737) 555-0101'), h('(737) 555-0101'));
  assert.notStrictEqual(h('(737) 555-0101'), h('(737) 555-0102'));
});
t('a row with no phone, email or name is skipped, not given a key', () => {
  const i = code.indexOf('function leadDedupKey');
  const body = code.slice(i, i + 900);
  assert.ok(/if \(!basis\) return null;/.test(body));
  const j = code.indexOf('function leadInterestRow');
  assert.ok(/if \(!dedup\) return null;/.test(code.slice(j, j + 1400)), 'a keyless row is still written');
});
t('no contact detail reaches the row', () => {
  const i = code.indexOf('function leadInterestRow');
  const body = code.slice(i, code.indexOf('function leasingInterestFromReport'));
  assert.ok(!/\bname:/.test(body) && !/\bemail:/.test(body) && !/\bphone:/.test(body),
    'the row carries contact details');
  // Column DECLARATIONS only. The word "name" appears in the comments that
  // explain the dedup key, and matching those would fail for the opposite of
  // the reason this test exists.
  const block = sql.split('create table')[1].split(');')[0]
    .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  ['name', 'email', 'phone', 'phone_number', 'email_address']
    .forEach(c => assert.ok(!new RegExp('^\\s+' + c + '\\s+(text|varchar)', 'm').test(block),
      `the table has a ${c} column`));
});

console.log('\nthe primary key');
t('it upserts on the 080 key', () => {
  assert.ok(/onConflict: 'guest_card_uuid,interest_received'/.test(code));
  assert.ok(!/onConflict: 'inquiry_id'/.test(code), 'it still upserts on the dropped key');
});
t('duplicates are dropped before the upsert, on that same key', () => {
  const i = code.indexOf('const seenKey = new Set()');
  const body = code.slice(i, i + 600);
  assert.ok(/rec\.guest_card_uuid \+ '\|' \+ rec\.interest_received/.test(body),
    'the in-batch dedupe uses a different key from the table');
});
t('a row without both halves of the key is skipped', () => {
  const i = code.indexOf('function leadInterestRow');
  const body = code.slice(i, i + 700);
  assert.ok(/if \(!uuid \|\| !received\) return null;/.test(body));
});
t('the migration matches what the code writes', () => {
  assert.ok(/primary key \(guest_card_uuid, interest_received\)/.test(sql));
  assert.ok(/dedup_key\s+text\s+not null/.test(sql));
  // Again: declarations only. inquiry_id is all over the comments explaining
  // why it was dropped, and matching those would fail for the opposite of the
  // reason this test exists.
  const cols = sql.split('create table')[1].split(');')[0]
    .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  assert.ok(!/inquiry_id/.test(cols), 'inquiry_id is still a column');
});

console.log(`\n${pass} passing`);
