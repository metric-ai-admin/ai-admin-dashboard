// Matching a delinquent resident to the calls on their number.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CM = require('../lib/call-match.js');
const PA = require('../lib/property-aliases.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const TODAY = '2026-10-13';
const call = (d, dir, dur, num) => ({
  call_date: d, call_direction: dir, duration: dur, counterparty_number: num,
});

console.log('call match');

// ---- the number ------------------------------------------------------------

t('ten digits, however it was written', () => {
  ['512-555-0100', '(512) 555-0100', '+1 512 555 0100', '15125550100', '5125550100']
    .forEach(v => assert.strictEqual(CM.normPhone(v), '5125550100', v));
});

t('anything that is not ten digits is not a number', () => {
  // A partial match would join strangers.
  ['555-0100', '', null, 'Danny Metric', '44 20 7946 0958']
    .forEach(v => assert.strictEqual(CM.normPhone(v), null, String(v)));
});

// ---- "no calls since", never "never called" --------------------------------

t('a resident with no calls gets the capture date, not "never"', () => {
  // THE ONE THAT MATTERS. 2,146 calls before 2026-09-29 carry no number.
  // "Never called" is a lie about them, and somebody would pick up the phone
  // believing nobody had tried.
  const s = CM.summarise('512-555-0100', { callsByNumber: new Map(), today: TODAY });
  assert.strictEqual(s.note, 'No calls since 2026-09-29');
  assert.ok(!/never/i.test(s.note));
  assert.strictEqual(CM.CAPTURE_START, '2026-09-29');
});

t('no number on file is a different answer from no calls', () => {
  // They lead to different actions: find a number, or pick up the phone.
  const s = CM.summarise('', { callsByNumber: new Map(), today: TODAY });
  assert.strictEqual(s.note, 'no number on file');
});

// ---- last contact ----------------------------------------------------------

const CALLS = CM.indexCalls([
  call('2026-10-11', 'outbound', '95', '512-555-0100'),
  call('2026-10-02', 'inbound', '240', '5125550100'),
  call('2026-09-30', 'inbound', '30', '512-555-0100'),
  call('2026-10-05', 'inbound', '45', '512-555-9999'),
]);

t('the newest call is the last contact, in either direction', () => {
  // "Last contact", not "last inbound call": the archive stores the other
  // party's number on outbound calls now, so an attempt by Karla is visible.
  const s = CM.summarise('512-555-0100', { callsByNumber: CALLS, today: TODAY });
  assert.strictEqual(s.lastContact.date, '2026-10-11');
  assert.strictEqual(s.lastContact.direction, 'outbound');
  assert.strictEqual(s.lastContact.daysAgo, 2);
});

t('duration reads as minutes and seconds', () => {
  assert.strictEqual(CM.duration('95'), '1m 35s');
  assert.strictEqual(CM.duration('240'), '4m');
  assert.strictEqual(CM.duration('30'), '30s');
  assert.strictEqual(CM.duration('2:05'), '2m 5s');
  assert.strictEqual(CM.duration(''), null, 'a missing duration is not 0s');
});

t('the 30-day count counts 30 days, not everything', () => {
  const old = CM.indexCalls([
    call('2026-10-11', 'inbound', '60', '5125550100'),
    call('2026-09-01', 'inbound', '60', '5125550100'),   // 42 days — outside
  ]);
  const s = CM.summarise('5125550100', { callsByNumber: old, today: TODAY });
  assert.strictEqual(s.count30, 1);
});

// ---- a shared number -------------------------------------------------------

const DIR = CM.indexResidents([
  { tenant_name: 'Castilla, Dulce P.', phone: '512-555-0100' },
  { tenant_name: 'Castilla, Jorge', mobile: '(512) 555-0100' },
  { tenant_name: 'Smith, John', phone: '512-555-7777' },
]);

t('a number on two leases is reported as shared', () => {
  const s = CM.summarise('5125550100', {
    callsByNumber: CALLS, residentsByNumber: DIR, name: 'Castilla, Dulce P.', today: TODAY,
  });
  assert.deepStrictEqual(s.sharedWith, ['Castilla, Jorge']);
  assert.ok(/shared with 1 other resident/.test(CM.line(s)));
  assert.ok(/may not be theirs/.test(CM.line(s)), 'it must say what that means');
});

t('the resident the card is about is not "shared with" themselves', () => {
  const s = CM.summarise('512-555-7777', {
    callsByNumber: new Map(), residentsByNumber: DIR, name: 'Smith, John', today: TODAY,
  });
  assert.deepStrictEqual(s.sharedWith, []);
});

t('no directory means no sharing claimed, which is the safe direction', () => {
  // It never says a call belongs to one person when it might belong to two.
  const s = CM.summarise('5125550100', { callsByNumber: CALLS, name: 'X', today: TODAY });
  assert.deepStrictEqual(s.sharedWith, []);
});

t('the line reads as a sentence', () => {
  const s = CM.summarise('5125550100', { callsByNumber: CALLS, name: 'X', today: TODAY });
  const l = CM.line(s);
  assert.ok(/^Last contact: 2026-10-11 — outbound, 1m 35s/.test(l), l);
  assert.ok(/3 calls in the last 30 days/.test(l), l);
});

// ---- the tenant directory keeps no birthdates ------------------------------

t('the directory is stored through a projection that drops the DOB', () => {
  // It was kept out of the registry entirely because it carries resident dates
  // of birth. The answer is to drop those columns before anything is written,
  // not to accept them because something else on the report is useful.
  const af = require('../appfolio-reports.js');
  const def = (af.REPORTS || []).find(r => r.id === 'tenant_directory');
  assert.ok(def, 'tenant_directory is not registered');
  assert.strictEqual(typeof def.project, 'function', 'it is stored whole');
  const out = def.project({
    tenant_name: 'A', property_name: 'B', unit: '1', phone: '5125550100',
    date_of_birth: '1990-04-12', ssn: '000', email: 'a@b.c', balance: '100',
  });
  ['date_of_birth', 'ssn', 'email', 'balance'].forEach(k =>
    assert.ok(!(k in out), k + ' reaches the disk'));
  assert.strictEqual(out.phone, '5125550100', 'the phone must survive');
  assert.strictEqual(out.tenant_name, 'A', 'the name must survive — a shared number needs it');
});

// ---- property aliases ------------------------------------------------------

t('the spellings the user named all map', () => {
  [['Windy Hill', 'Windy Hill Apartment'], ['Windy Hill Apartments', 'Windy Hill Apartment'],
    ['Windy Hill (Kyle)', 'Windy Hill Apartment'], ['Ascent', 'Ascent at Northgate'],
    ['Ascend', 'Ascent at Northgate'], ['Highlander', 'The Highlander'],
    ['Iconic Round Rock', 'iConic Round Rock']].forEach(([from, to]) =>
    assert.strictEqual(PA.canonical(from), to, from));
});

t('"Unidentified" is an ANSWER and is never mapped', () => {
  // 995 of 1,896 rows. Turning that into a property would invent data.
  ['Unidentified', 'Unidentified (Kyle, TX property)', 'Multiple Metric Properties']
    .forEach(v => assert.strictEqual(PA.canonical(v), null, v));
});

t('buildings that are not ours are left alone', () => {
  ['Ventura North (not a Metric property)', 'Brazos Lofts (no longer managed)',
    '803 Tirado Street', '902 Romeria Drive', 'Cedar & Sage']
    .forEach(v => assert.strictEqual(PA.canonical(v), null, v));
});

t('a plausible-looking stranger is NOT guessed at', () => {
  // A fuzzy matcher would tidy the list and file somebody else's building
  // under one of ours. A wrong attribution looks exactly like a right one.
  ['Ascension Apartments', 'Highland Mall', 'Hyde Park West', 'Sunset Homes',
    'Windy Hill Road (Kyle, TX)'].forEach(v =>
    assert.strictEqual(PA.canonical(v), null, v + ' was guessed'));
});

t('a plan reports what it leaves alone, not just what it changes', () => {
  const rows = [
    { property_name: 'Windy Hill' }, { property_name: 'Windy Hill' },
    { property_name: 'Unidentified' }, { property_name: '803 Tirado Street' },
    { property_name: 'Hyde Park Square' },
  ];
  const p = PA.plan(rows);
  assert.strictEqual(p.rowsChanged, 2);
  assert.strictEqual(p.unmappedDistinct, 2, 'Unidentified and the address');
  assert.ok(p.keep.some(k => k.value === 'Hyde Park Square' && k.canonical),
    'an already-correct value must not be reported as a problem');
});

t('the script defaults to a dry run and updates per spelling', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'normalize-call-properties.js'), 'utf8');
  assert.ok(/DRY RUN/.test(s) && /--write/.test(s));
  assert.ok(/\.eq\('property_name', c\.from\)/.test(s),
    '1,847 per-row updates to change 272 rows is 1,500 round trips doing nothing');
});

// ---- the wiring ------------------------------------------------------------

t('the card says "no calls since", never "never"', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const at = app.indexOf('function dqCalls');
  assert.ok(at > 0, 'the call line is gone');
  const fn = app.slice(at, app.indexOf('function dqCard'));
  assert.ok(!/never/i.test(fn.replace(/^\s*\/\/.*$/gm, '')), 'it can still say "never"');
  assert.ok(/Last contact/.test(fn));
  assert.ok(/shared with/.test(fn), 'a shared number is not flagged');
  assert.ok(/dqEsc\(c\.note\)/.test(fn) && /dqEsc\(L\.direction\)/.test(fn),
    'values reach the card unescaped');
});

t('an externally managed property still says so', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(/not on the Metric phone system/.test(app));
});

t('the directory sync is on the morning cron, clear of the others', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("syncReport('tenant_directory')");
  assert.ok(at > 0, 'it is not scheduled');
  const before = server.slice(Math.max(0, at - 700), at);
  assert.ok(/'30 6 \* \* \*'/.test(before), 'it is not at 06:30');
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(server.slice(at, at + 400)));
  // 06:25 is the last maintenance feed; 06:30 is five minutes clear.
  assert.ok(!/\[30, 'tenant_directory'/.test(server), 'it was squeezed into the 5 AM block');
});

t('no resident data is logged', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("syncReport('tenant_directory')");
  const block = server.slice(at, at + 400);
  assert.ok(/' residents'/.test(block), 'it should log a count');
  assert.ok(!/rows\[|\.phone|\.tenant_name/.test(block), 'it logs a row');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
