// The message has to leave the report, not merely match a regex.
//
// On 2026-09-30 a rule to drop "(Do Not Reply)" senders shipped, its regex was
// unit-tested, the call site was asserted, the suite was green — and the email
// stayed on Lyndsay's report. The tests checked the wiring and the pattern. The
// one thing nobody checked was whether the message was actually excluded.
//
// The cause: a heredoc had written a literal BACKSPACE (0x08) into server.js
// where \b was intended. The regex read correctly in every editor and in grep,
// compiled without error, and matched nothing ever — it required a backspace
// character on both sides. Sixteen of them were in the file, which is also why
// mrCleanOpsNote had been silently skipping half its steps.
//
// So this file does two things: run the real filter over the real message, and
// fail if a control character is ever written into the source again.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const root = p => path.join(__dirname, '..', p);
const src = fs.readFileSync(root('server.js'), 'utf8');

// mrEmailExcluded, with the module-level values it reads, lifted out of the
// shipped file. Only logLine is stubbed — it is the one thing in there that
// belongs to the server rather than to this rule. Everything else, including
// the greeting helpers and the diagnostic arrays, comes from the slice, so the
// function under test is the one that ships.
function slice(fromMarker, toMarker) {
  const i = src.indexOf(fromMarker);
  assert.ok(i >= 0, 'server.js no longer contains: ' + fromMarker);
  const j = src.indexOf(toMarker, i);
  assert.ok(j > i, 'server.js no longer contains: ' + toMarker);
  return src.slice(i, j);
}
function braceBlock(marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'server.js no longer contains: ' + marker);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + marker);
}

const consts = slice('const MR_SUPPORT_ADDRESSES', 'function mrEmailExcluded(');
// eslint-disable-next-line no-new-func
const mrEmailExcluded = new Function('logLine',
  consts + braceBlock('function mrEmailExcluded(') + '\nreturn mrEmailExcluded;',
)(() => {});

const mail = (name, address, subject, bodyPreview) => ({
  sender: { emailAddress: { name, address } },
  subject,
  bodyPreview: bodyPreview || 'Some content.',
  toRecipients: [{ emailAddress: { address: 'lyndsay@metricpropertymanagement.com' } }],
});

console.log('the automated senders that were sitting on her report');
t('AppFolio "(Do Not Reply)" is excluded — the one that started this', () => {
  // Real, from this morning. The display name carries it and so does the address.
  assert.strictEqual(mrEmailExcluded(mail(
    'Metric Property Management of Texas LLC (Do Not Reply)',
    'donotreply@appfolio.com',
    'Online Payments Enabled For: Iconic Reserve')), true);
});
t('the bank "(DO NOT REPLY)" is excluded, in caps', () => {
  // Also real, also on the report: the address is ordinary, only the name says so.
  assert.strictEqual(mrEmailExcluded(mail(
    'ANBTX TM Support (DO NOT REPLY)',
    'anbtx@olbanking.com',
    'Action Required: Treasury Browser Upgrade')), true);
});
t('the display name alone is enough, and the address alone is enough', () => {
  assert.strictEqual(mrEmailExcluded(mail('Some Vendor (Do Not Reply)', 'billing@vendor.com', 'Invoice')), true);
  assert.strictEqual(mrEmailExcluded(mail('Some Vendor', 'no-reply@vendor.com', 'Invoice')), true);
  assert.strictEqual(mrEmailExcluded(mail('', 'mailer-daemon@vendor.com', 'Undelivered')), true);
});

console.log('\nreal support addresses are not automated senders');
t('SimpleVOIP and Sonetel still reach her', () => {
  // Both write from support@ and a human reads the reply. Excluding them would
  // have hidden a service outage and a prepaid balance at minus $54.
  assert.strictEqual(mrEmailExcluded(mail('Sonetel Notifications', 'support@sonetel.com',
    'IMPORTANT! Calls will fail', 'Insufficient balance for calls.')), false);
  assert.strictEqual(mrEmailExcluded(mail('SimpleVOIP Support', 'support@simplevoip.us',
    'Port request update', 'The port completed.')), false);
});
t('an ordinary correspondent is untouched', () => {
  assert.strictEqual(mrEmailExcluded(mail('Kabani, Salina', 'salina.kabani@clydeco.us',
    'Mendoza v. Metric and Villas', 'Hi Lyndsay, I hope you are well.')), false);
  assert.strictEqual(mrEmailExcluded(mail('Andrew Dellinger', 'dellinger@peakrockcapital.com',
    'RE: Ascent Funding Request', 'Metric Team, Please confirm receipt.')), false);
});
t('"reply" on its own is not "no reply"', () => {
  // The word boundary matters: "replyall@" and "Reply Team" are not machines.
  assert.strictEqual(mrEmailExcluded(mail('Reply Team', 'replyall@vendor.com', 'Question')), false);
});

console.log('\nno control characters in the source, ever again');
t('no shipped file contains a stray control character', () => {
  // A literal backspace where \b was meant compiles, reads correctly in every
  // editor and in grep, and matches nothing. It cost a shipped rule that did
  // nothing at all and half of mrCleanOpsNote's steps.
  const files = ['server.js', 'lib/week.js', 'metric-routes.js', 'simplevoip.js',
    'email-followups.js', 'kpi-recap.js', 'weekly-brief.js', 'billable-report.js'];
  // Exactly the characters a mangled escape produces: \a \b \v \f \e. NUL is
  // NOT among them — billable-report.js uses one deliberately as a composite-key
  // separator, which is a real idiom and not a typo.
  // eslint-disable-next-line no-control-regex
  const BAD = /[\u0007\u0008\u000b\u000c\u001b]/;
  files.forEach(f => {
    const lines = fs.readFileSync(root(f), 'utf8').split('\n');
    const at = lines.findIndex(l => BAD.test(l));
    assert.strictEqual(at, -1,
      `${f}:${at + 1} holds a control character — a heredoc probably turned an escape into a raw byte`);
  });
});

console.log('\nthe steps those backspaces had disabled');
t('mrCleanOpsNote strips what it claims to strip', () => {
  // eslint-disable-next-line no-new-func
  const clean = new Function(braceBlock('function mrCleanOpsNote(') + '\nreturn mrCleanOpsNote;')();
  assert.strictEqual(
    clean('Steps 1+2 DONE (commit 541ba88, deployed, 22 suites / 637 assertions). Next'),
    'Steps 1+2 DONE. Next');
  assert.ok(!/e1aa8a4/.test(clean('Ran migration 069 and deployed e1aa8a4')), 'a commit hash survived');
  assert.ok(!/server\.js/.test(clean('Updated server.js and metric-routes.js today')), 'a filename survived');
  assert.ok(!/assertions/.test(clean('26 suites, 740 assertions, all passing')), 'a test count survived');
  assert.ok(!/var\/data/.test(clean('access log on disk (/var/data/access-2026-09-29.log)')), 'a path survived');
  assert.strictEqual(clean('09/22'), '', 'a bare date stamp should leave the title standing alone');
});

console.log(`\n${pass} passing`);
