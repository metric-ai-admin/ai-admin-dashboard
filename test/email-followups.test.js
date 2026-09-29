// The Follow-Up Tracker's rules.
//
// Every case here comes from something real in Lyndsay's mailbox, checked
// read-only on 2026-09-29 before the feature was designed: three tagged
// messages in 18,356 sent, the tag at character 84 of a 101-character subject,
// a "**follow up **" form nobody had mentioned, and sixteen messages matching
// "*follow" of which most are replies inheriting the subject.
const assert = require('assert');
const F = require('../email-followups.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const LY = 'lyndsay@metricpropertymanagement.com';
const from = a => ({ from: { emailAddress: { address: a } } });
const msg = (a, at, subject, extra) => Object.assign(from(a), { sentDateTime: at, subject }, extra || {});

console.log('the tag, in the forms she actually writes');
t('the real 2026-09-15 subject matches, tag at the END', () => {
  const s = 'Fw: 2026 Litigation Recommendation - Metric Property Management (Travis County, TX) *follow up needed';
  assert.strictEqual(F.matchTag(s), '*follow up needed');
});
t('the real 2024 form matches: double asterisk, space before the close', () => {
  const s = 'Fw: **follow up ** ADMIN - STATMENT / PDF INVOCIE COPIES - ICONIC ROUND ROCK  # 895514';
  assert.ok(F.hasTag(s), 'the "**follow up **" form is not recognised');
});
t('the spec variants match, case and hyphen ignored', () => {
  ['*follow up needed', '*Follow-up needed', '*follow-up', '*FOLLOW UP NEEDED', '* follow up']
    .forEach(s => assert.ok(F.hasTag('Re: something ' + s), s));
});
t('prose about following up does NOT match — these are real subjects', () => {
  // A search for "follow up needed" returns both of these from her Sent Items.
  ['Fw: Following up regarding our loan / Forbearance proposal',
   'Re: Incomplete transition and undocumented tasks following Andrea',
   'Re: Brazos Lofts: Metric Communication Follow Up',
   'Re: [IMPORTANT]: Iconic at the Station: Follow-Ups',
  ].forEach(s => assert.strictEqual(F.hasTag(s), false, s));
});
t('the asterisk is what makes it deliberate', () => {
  assert.strictEqual(F.hasTag('follow up needed'), false);
  assert.ok(F.hasTag('*follow up needed'));
});

console.log('\nan out-of-office is not an answer');
t('ADJUSTMENT 1 — a simulated OOO does NOT close the follow-up', () => {
  const thread = [
    msg(LY, '2026-09-15T18:54:00Z', 'Fw: Litigation Recommendation *follow up needed'),
    Object.assign(msg('counsel@example.com', '2026-09-16T08:00:00Z',
      'Automatic reply: Fw: Litigation Recommendation *follow up needed'), {
      internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
    }),
  ];
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: thread });
  assert.strictEqual(r.status, 'open', 'an out-of-office closed the follow-up');
});
t('each auto signal alone is enough', () => {
  const at = '2026-09-16T08:00:00Z';
  const cases = [
    ['subject "Automatic reply"', msg('a@b.com', at, 'Automatic reply: hello')],
    ['subject "Auto:"', msg('a@b.com', at, 'Auto: hello')],
    ['subject "Out of Office"', msg('a@b.com', at, 'Out of Office AutoReply')],
    ['subject "Undeliverable"', msg('a@b.com', at, 'Undeliverable: hello')],
    ['sender postmaster', msg('postmaster@example.com', at, 'hello')],
    ['sender mailer-daemon', msg('mailer-daemon@example.com', at, 'hello')],
    ['sender noreply', msg('noreply@example.com', at, 'hello')],
    ['sender no-reply', msg('no-reply@vendor.com', at, 'hello')],
    ['Auto-Submitted header', Object.assign(msg('a@b.com', at, 'hello'),
      { internetMessageHeaders: [{ name: 'auto-submitted', value: 'auto-generated' }] })],
    ['X-Auto-Response-Suppress', Object.assign(msg('a@b.com', at, 'hello'),
      { internetMessageHeaders: [{ name: 'X-Auto-Response-Suppress', value: 'All' }] })],
    ['Precedence: bulk', Object.assign(msg('a@b.com', at, 'hello'),
      { internetMessageHeaders: [{ name: 'Precedence', value: 'bulk' }] })],
  ];
  cases.forEach(([label, m]) => assert.ok(F.isAutoReply(m), label + ' was not treated as automatic'));
});
t('a real person is not mistaken for a machine', () => {
  assert.strictEqual(F.isAutoReply(msg('counsel@example.com', '2026-09-16T08:00:00Z', 'Re: Litigation')), false);
  // Auto-Submitted: no is what ordinary mail says when it says anything.
  assert.strictEqual(F.isAutoReply(Object.assign(msg('a@b.com', '2026-09-16T08:00:00Z', 'Re: hi'),
    { internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'no' }] })), false);
  // A person whose address merely contains the word.
  assert.strictEqual(F.isAutoReply(msg('jen.noreplyson@example.com', '2026-09-16T08:00:00Z', 'Re: hi')), false);
});

console.log('\nrule (a): someone else replied');
t('a human reply closes it, and records who', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg(LY, '2026-09-15T18:54:00Z', 'Fw: X *follow up needed'),
    msg('counsel@example.com', '2026-09-17T09:00:00Z', 'Re: Fw: X *follow up needed'),
  ]});
  assert.strictEqual(r.status, 'replied');
  assert.strictEqual(r.reason, 'reply');
  assert.strictEqual(r.by, 'counsel@example.com');
  assert.strictEqual(r.at, '2026-09-17T09:00:00Z');
});
t('a reply that arrived BEFORE the tag does not close it', () => {
  // She tagged it because the thread so far did not satisfy her.
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg('counsel@example.com', '2026-09-10T09:00:00Z', 'Re: X'),
    msg(LY, '2026-09-15T18:54:00Z', 'Fw: X *follow up needed'),
  ]});
  assert.strictEqual(r.status, 'open');
});
t('a received message ordered by receivedDateTime still counts', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    { ...from('counsel@example.com'), receivedDateTime: '2026-09-17T09:00:00Z', subject: 'Re: X' },
  ]});
  assert.strictEqual(r.status, 'replied');
});

console.log('\nrule (b): she wrote again, without the tag');
t('ADJUSTMENT 4 — her reply that still carries the tag does NOT close it', () => {
  // Replying inherits the subject, so the tag comes along. Reading that as
  // "she wrote again" would close the follow-up the moment she chased it.
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg(LY, '2026-09-15T18:54:00Z', 'Fw: X *follow up needed'),
    msg(LY, '2026-09-20T10:00:00Z', 'Re: Fw: X *follow up needed'),
  ]});
  assert.strictEqual(r.status, 'open', 'her own tagged chase closed the follow-up');
});
t('her message WITHOUT the tag closes it', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg(LY, '2026-09-15T18:54:00Z', 'Fw: X *follow up needed'),
    msg(LY, '2026-09-20T10:00:00Z', 'Re: Fw: X'),
  ]});
  assert.strictEqual(r.status, 'resolved');
  assert.strictEqual(r.reason, 'untagged_message');
});
t('case and address casing do not decide who she is', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg(LY.toUpperCase(), '2026-09-20T10:00:00Z', 'Re: Fw: X'),
  ]});
  assert.strictEqual(r.status, 'resolved');
});
t('when both happen, the earlier one wins', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    msg(LY, '2026-09-22T10:00:00Z', 'Re: Fw: X'),
    msg('counsel@example.com', '2026-09-17T09:00:00Z', 'Re: Fw: X *follow up needed'),
  ]});
  assert.strictEqual(r.status, 'replied', 'the follow-up ended when it ended');
  assert.strictEqual(r.at, '2026-09-17T09:00:00Z');
});
t('an OOO followed by a real reply closes on the real one', () => {
  const r = F.classifyThread({ mailbox: LY, taggedAt: '2026-09-15T18:54:00Z', messages: [
    Object.assign(msg('counsel@example.com', '2026-09-16T08:00:00Z', 'Automatic reply: X'),
      { internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }),
    msg('counsel@example.com', '2026-09-18T09:00:00Z', 'Re: X'),
  ]});
  assert.strictEqual(r.status, 'replied');
  assert.strictEqual(r.at, '2026-09-18T09:00:00Z');
});

console.log('\nthe scan over Sent Items');
t('the real 2026-09-15 message is picked up, with its recipients', () => {
  const rows = F.taggedFromSent([{
    id: 'AAA', conversationId: 'CONV1',
    subject: 'Fw: 2026 Litigation Recommendation - Metric Property Management (Travis County, TX) *follow up needed',
    sentDateTime: '2026-09-15T18:54:00Z',
    ...from(LY),
    toRecipients: [{ emailAddress: { name: 'Jane Counsel', address: 'jane@law.example' } }],
    ccRecipients: [{ emailAddress: { address: 'ops@example.com' } }],
  }], LY);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].conversation_id, 'CONV1');
  assert.strictEqual(rows[0].tag_matched, '*follow up needed');
  // Real names in the EOD, which only she receives.
  assert.deepStrictEqual(rows[0].recipients, ['Jane Counsel', 'ops@example.com']);
});
t('untagged sent mail is ignored', () => {
  assert.strictEqual(F.taggedFromSent([
    { id: '1', conversationId: 'C', subject: 'Re: ordinary', sentDateTime: '2026-09-15T00:00:00Z', ...from(LY) },
  ], LY).length, 0);
});
t('one row per conversation, keeping the most recent tag', () => {
  // Re-tagging a thread means "still waiting, as of now" — the day count
  // restarts rather than the EOD showing the same subject twice.
  const rows = F.taggedFromSent([
    { id: '1', conversationId: 'C', subject: 'X *follow up', sentDateTime: '2026-09-10T00:00:00Z', ...from(LY) },
    { id: '2', conversationId: 'C', subject: 'Re: X *follow up needed', sentDateTime: '2026-09-20T00:00:00Z', ...from(LY) },
  ], LY);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sent_at, '2026-09-20T00:00:00Z');
  assert.strictEqual(rows[0].message_id, '2');
});
t('mail someone else sent from a shared mailbox is not hers to chase', () => {
  assert.strictEqual(F.taggedFromSent([
    { id: '1', conversationId: 'C', subject: 'X *follow up needed', sentDateTime: '2026-09-15T00:00:00Z',
      ...from('someone.else@metricpropertymanagement.com') },
  ], LY).length, 0);
});
t('a message with no conversationId is skipped rather than guessed at', () => {
  assert.strictEqual(F.taggedFromSent([
    { id: '1', subject: 'X *follow up needed', sentDateTime: '2026-09-15T00:00:00Z', ...from(LY) },
  ], LY).length, 0);
});

console.log('\ndays waiting, and the window');
t('ADJUSTMENT 3 — the 2026-09-15 message reads 14d on 2026-09-29', () => {
  const now = Date.parse('2026-09-29T18:54:00Z');
  assert.strictEqual(F.daysWaiting('2026-09-15T18:54:00Z', now), 14);
});
t('a partial day is not rounded up into a whole one', () => {
  const now = Date.parse('2026-09-16T08:00:00Z');
  assert.strictEqual(F.daysWaiting('2026-09-15T18:54:00Z', now), 0);
});
t('a malformed date yields null rather than a made-up age', () => {
  assert.strictEqual(F.daysWaiting('not a date', Date.now()), null);
  assert.strictEqual(F.severityFor(null), 'grey');
});
t('amber at 3 days, red at 7', () => {
  assert.strictEqual(F.severityFor(0), 'green');
  assert.strictEqual(F.severityFor(2), 'green');
  assert.strictEqual(F.severityFor(3), 'amber');
  assert.strictEqual(F.severityFor(6), 'amber');
  assert.strictEqual(F.severityFor(7), 'red');
  assert.strictEqual(F.severityFor(14), 'red');
});
t('ADJUSTMENT 3 — 30 days on the first run, 14 after', () => {
  assert.strictEqual(F.scanWindowDays(0), 30, 'the first run must reach back to the 09/15 message');
  assert.strictEqual(F.scanWindowDays(1), 14);
  assert.strictEqual(F.scanWindowDays(250), 14);
});

// ---------------------------------------------------------------------------
// Where it is wired, checked against the shipped source.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const between = (from, to) => {
  const i = SRC.indexOf(from);
  assert.ok(i >= 0, `server.js no longer contains ${from}`);
  const j = SRC.indexOf(to, i);
  return SRC.slice(i, j > i ? j : i + 40000);
};

console.log('\nADJUSTMENT 2 — the EOD only, never the Morning Report');
t('the EOD gathers and renders it', () => {
  assert.ok(/S\.followups\s*=\s*\{\s*rows:\s*await followupsForReport/.test(
    between('async function eodGather()', 'function eodRenderHtml')),
    'eodGather no longer collects follow-ups');
  assert.ok(/Follow-ups waiting on a reply/.test(
    between('function eodRenderHtml(', '\napp.get')),
    'the EOD no longer renders the follow-ups section');
});
t('the Morning Report does NOT — it goes to the High Ops group chat', () => {
  const mr = between("app.get('/api/morning-report'", 'async function eodGather()');
  assert.ok(!/followups|Follow-ups waiting/i.test(mr),
    'follow-ups leaked into the Morning Report, which is read by the whole High Ops chat');
});
t('the section is omitted when there is nothing waiting', () => {
  const render = between('function eodRenderHtml(', '\napp.get');
  assert.ok(/if \(fu\.error \|\| \(fu\.rows && fu\.rows\.length\)\)/.test(render),
    'the follow-ups section renders unconditionally — an empty one every day is noise');
});

console.log('\nread-only against the mailbox');
t('the tracker never writes to Graph', () => {
  const block = between('async function followupsScan(', 'async function refreshEmailAndCalendar()');
  assert.ok(!/method:\s*'(POST|PATCH|PUT|DELETE)'/i.test(block),
    'the follow-up code issues a non-GET Graph request');
  assert.ok(!/\/move\b|\/send\b|isRead/.test(block),
    'the follow-up code touches a mutating Graph route');
});

console.log(`\n${pass} passing`);
