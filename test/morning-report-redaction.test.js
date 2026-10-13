// Three things Arturo was editing out of the Morning Report by hand, every
// morning, before pasting it into the High Ops group chat.
//
// Every line of that report is read by people who were not the audience of
// the thing it describes. A redaction done by hand is one somebody eventually
// forgets on a busy morning.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/redact.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

console.log('morning report redaction');

// ---- 1. banking details ----------------------------------------------------

t('an account and routing number is replaced, not masked', () => {
  // THE ONE THAT HAPPENED. Masking the digits would leave the sentence, and
  // the sentence is usually what says whose account it is.
  const p = R.safePreview('Account number: 736386207 Routing number: 322271627');
  assert.strictEqual(p, 'Banking details (see email)');
  assert.ok(!/736386207|322271627/.test(p));
});

t('it catches the other ways people write it', () => {
  [
    'Wire instructions: ABA 021000021, acct 1234567890',
    'Card number 4111 1111 1111 1111 expires 09/28',
    'Please use IBAN GB29 NWBK 6016 1331 9268 19',
    'Bank account: 00123456789, sort code 20-00-00',
    'Acct # 998877665544 for the deposit',
  ].forEach(s => assert.strictEqual(R.safePreview(s), R.BANKING_PLACEHOLDER, s));
});

t('a long number WITHOUT a banking label stays readable', () => {
  // A redaction that fires too often gets switched off. Work orders, invoices
  // and phone numbers are most of what a preview contains.
  [
    'Work order 23084 completed at unit 10-124',
    'Invoice 4458219 is attached for your review',
    'Call me back on 512 555 0100 when you can',
    'Lease 2026-10-15 through 2027-10-14 is ready',
  ].forEach(s => assert.strictEqual(R.safePreview(s), s, s));
});

t('a banking label WITHOUT digits stays readable', () => {
  // "Please send your account number" is a request, not a disclosure.
  ['Please send me your account number when you can',
    'Our bank details are in the attached PDF',
    'Can you confirm the routing number?'].forEach(s =>
    assert.strictEqual(R.safePreview(s), s, s));
});

t('an empty preview stays empty, not a false alarm', () => {
  assert.strictEqual(R.safePreview(''), '');
  assert.strictEqual(R.safePreview(null), '');
});

t('the report redacts BEFORE it truncates', () => {
  // Slicing to 200 characters first would let a preview escape when the
  // account number sits past the cut.
  assert.ok(/RED\.safePreview\(mrClean\(m\.bodyPreview\)\)\.slice\(0, 200\)/.test(server),
    'the preview is truncated before it is redacted, or not redacted at all');
});

t('a long preview with the numbers at the end is still caught', () => {
  const pad = 'Thanks for the quick turnaround on this, I have attached the '
    + 'signed agreement and the W9 as discussed on the call yesterday afternoon. '
    + 'Let me know if anything else is needed from our side before Friday. ';
  assert.ok(pad.length > 200);
  assert.strictEqual(R.safePreview(pad + 'Account number: 736386207'), R.BANKING_PLACEHOLDER);
});

// ---- 2. her own all-day events ---------------------------------------------

t('a trip with no attendees becomes "out of office"', () => {
  assert.strictEqual(R.isPersonalAllDay({ allDay: true, attendeeCount: 0 }), true);
  assert.strictEqual(R.OUT_OF_OFFICE, 'Lyndsay out of office — limited availability');
});

t('an all-day event WITH attendees keeps its title', () => {
  // A conference or an offsite is a commitment the room may share. Hiding its
  // title would make the report less useful without making it more private.
  assert.strictEqual(R.isPersonalAllDay({ allDay: true, attendeeCount: 5 }), false);
  assert.strictEqual(R.isPersonalAllDay({ allDay: true, attendees: [1, 2] }), false);
});

t('a timed meeting is never treated as a personal all-day', () => {
  assert.strictEqual(R.isPersonalAllDay({ allDay: false, attendeeCount: 0 }), false);
  assert.strictEqual(R.isPersonalAllDay(null), false);
});

t('the report prints the wording and drops the title and organizer', () => {
  const at = server.indexOf('allDayEvents.forEach');
  assert.ok(at > 0);
  const block = server.slice(at, at + 1200);
  assert.ok(/RED\.isPersonalAllDay\(m\)/.test(block));
  const personal = block.slice(block.indexOf('RED.isPersonalAllDay'), block.indexOf('return; }'));
  assert.ok(/RED\.OUT_OF_OFFICE/.test(personal));
  assert.ok(!/m\.subject/.test(personal), 'the title still reaches the line');
  assert.ok(!/m\.organizer/.test(personal), 'the organizer still reaches the line');
});

t('the attendee count is carried from Graph', () => {
  // Without it every all-day event looks personal, including the conferences.
  assert.ok(/attendeeCount: Array\.isArray\(e\.attendees\) \? e\.attendees\.length : 0/.test(server));
  assert.ok(/\$select=[^`']*attendees/.test(server), 'attendees are not requested from Graph');
});

// ---- 3. the pending item that names an open gap ----------------------------

t('the security incident task is RENAMED, and shows no note', () => {
  const r = R.opsTitle('Lyndsay mailbox security incident — follow up with Microsoft');
  assert.strictEqual(r.item, 'Email security follow-up');
  assert.strictEqual(r.showNote, false, 'the note is where the detail is');
});

t('it matches however the task happens to be worded', () => {
  ['Email security incident — Lyndsay mailbox',
    'Security incident: unauthorized access to Lyndsay mailbox',
    'Lyndsay email unauthorized access follow-up'].forEach(s =>
    assert.strictEqual(R.opsTitle(s).item, 'Email security follow-up', s));
});

t('an unrelated task keeps its title and its note', () => {
  ['Fix activity logs timezone', 'Social Security letter for Bekah',
    'Review the daily report with Jay'].forEach(s => {
    const r = R.opsTitle(s);
    assert.strictEqual(r.item, s, s);
    assert.strictEqual(r.showNote, true, s);
  });
});

t('a renamed task is SHOWN, not filtered out as well', () => {
  // It used to be dropped by MR_OPS_PRIVATE_RE and counted as "+N held back".
  // The rename is what makes it safe; dropping it too would hide work the room
  // should know is happening.
  const at = server.indexOf('const opsSafe = ops.filter');
  assert.ok(at > 0);
  const block = server.slice(at, at + 420);
  assert.ok(/RED\.opsTitle\(t\)\.showNote/.test(block), 'the rewrite is not consulted by the filter');
  assert.ok(/MR_OPS_PRIVATE_RE/.test(block), 'the titles with no rewrite must still be held back');
});

t('the printed line uses the rewritten title, not the original', () => {
  const at = server.indexOf('opsEn.slice(0, 10).forEach');
  const block = server.slice(at, at + 900);
  assert.ok(/const \{ item, showNote \} = RED\.opsTitle\(o\.item\)/.test(block));
  assert.ok(!/\$\{o\.item\}/.test(block), 'the original title still reaches the report');
  assert.ok(/showNote && o\.pending/.test(block), 'the note is printed regardless of the rewrite');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
