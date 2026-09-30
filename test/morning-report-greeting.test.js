// Pending Critical Emails: mail addressed to someone who is not Lyndsay.
//
// The report already dropped mail opening "Hi Arturo". On 2026-09-30 mail
// opening "Hi Katrina" was reaching it the same way, so the rule generalised:
// a greeting that names somebody who is not her.
//
// THE ASYMMETRY THAT SHAPES EVERY CASE HERE. Dropping mail she has to answer is
// far worse than leaving one extra line on her report. So anything ambiguous is
// KEPT: no greeting, a greeting to the room, a greeting that names her among
// others, a sentence that runs on instead of naming anyone.
//
// Pulled out of the shipped server.js rather than copied.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function block(marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'server.js no longer contains: ' + marker);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + marker);
}
const consts = src.slice(src.indexOf('const MR_SUPPORT_ADDRESSES'), src.indexOf('function mrGreetedNames'))
  + src.slice(src.indexOf('const MR_NOT_A_NAME'), src.indexOf('function mrAddressedToSomeoneElse'));
// eslint-disable-next-line no-new-func
const F = new Function(consts
  + block('function mrGreetedNames(')
  + block('function mrAddressedToSomeoneElse(')
  + block('function mrAddressedToArturo(')
  + 'return { mrGreetedNames, mrAddressedToSomeoneElse, mrAddressedToArturo };')();

const drops = body => F.mrAddressedToSomeoneElse({ bodyPreview: body });

console.log('mail greeting somebody else is dropped');
t('"Hi Katrina" — the one that prompted this', () => {
  assert.strictEqual(drops('Hi Katrina, please see the attached invoice.'), true);
});
t('colleagues by name, in either language', () => {
  [
    'Hey Erick, the tech is on site.',
    'Good morning Bekah, the violation was cleared.',
    'Hola Rocío, adjunto el reporte de morosidad',
    'Dear Jay, following up on the approval',
    'Hello Kara — the resident called back',
  ].forEach(b => assert.strictEqual(drops(b), true, b));
});
t('a greeting naming several people, none of them her', () => {
  assert.strictEqual(drops('Hi Katrina and Jay, see below.'), true);
});

console.log('\nmail she has to answer is kept');
t('a greeting that names her', () => {
  ['Hi Lyndsay, quick question about the lease.',
   'Hello Lyndsay!',
   'Dear Lyndsay Hanes, regarding the contract',
  ].forEach(b => assert.strictEqual(drops(b), false, b));
});
t('however outsiders spell it — a misspelling is still addressed to her', () => {
  ['Hello Lindsey — following up on the tax bill.',
   'Hi Lindsay, see attached',
   'Hi Lyndsey, thanks',
   'Dear Ms. Hanes, regarding your account',
   'Dear Mrs Lyndsay Hanes',
  ].forEach(b => assert.strictEqual(drops(b), false, b));
});
t('a greeting to the room is a greeting to her too', () => {
  ['Hi all, the report is ready.', 'Hi team,', 'Hello everyone,',
   'Hi there, following up.', 'Hi folks — quick update', 'Dear partners,',
  ].forEach(b => assert.strictEqual(drops(b), false, b));
});
t('her name among others', () => {
  assert.strictEqual(drops('Hi Lyndsay and Katrina, see below.'), false);
  assert.strictEqual(drops('Hi Jay, Lyndsay and Kara — see below.'), false);
});
t('no greeting at all — most real mail', () => {
  ['Thanks for sending this over.',
   'Please find the signed lease attached.',
   'The wire went out this morning.',
   '',
   null,
  ].forEach(b => assert.strictEqual(drops(b), false, JSON.stringify(b)));
});
t('a sentence running on is not a name', () => {
  // "Hi I hope this finds you well" must not be read as a greeting to "I".
  ['Hi I hope this finds you well.',
   'Hello hope you had a good weekend',
  ].forEach(b => assert.strictEqual(drops(b), false, b));
});
t('a word that merely starts like a greeting is not one', () => {
  assert.strictEqual(drops('Hiring update for the leasing team'), false);
  assert.strictEqual(drops('Heads up on the invoice'), false);
});

t('a period does not hide the rest of the greeting, nor split a title', () => {
  // The capture used to stop at the first comma, which lost her name in
  // "Hi Jay, Lyndsay and Kara"; stopping at a period instead turned
  // "Dear Ms. Hanes" into a greeting to "Ms". It now reads past both.
  assert.strictEqual(drops('Hi Katrina. Please see attached.'), true);
  assert.strictEqual(drops('Hi Jay, Katrina and Erick — see below.'), true);
  assert.strictEqual(drops('Hi Jay, Lyndsay and Kara — see below.'), false);
  assert.strictEqual(drops('Estimada Sra. Hanes, le escribo por'), false);
});

console.log('\nthe real mail in her folders on 2026-09-30');
t('the six Arturo checked before the report went to High Ops', () => {
  // Named senders, real openings. The two that look like greetings but are not
  // are the ones that matter: "Metric Team," addresses the room, and
  // "Lyndsay, Connecting you..." has no greeting word at all — neither may be
  // read as mail for somebody else.
  const cases = [
    ['Jennifer',         'Hi Katrina, attached is the branding proposal.',                        true],
    ['Beth Obillo',      'Hi Rebekah, please see the updated violation list.',                    true],
    ['Andrew Dellinger', 'Metric Team, Please confirm the occupancy numbers for Ascent.',         false],
    ['J.R. Ellis',       'Lyndsay, Connecting you with our lender contact as discussed.',         false],
    ['Kabani',           'Hi Lyndsay, the audit draft is ready for your review.',                 false],
    ['Senate Eskridge',  'Please find the signed documents attached for the Round Rock transfer.', false],
  ];
  cases.forEach(([who, body, shouldDrop]) =>
    assert.strictEqual(drops(body), shouldDrop,
      `${who}: expected ${shouldDrop ? 'dropped' : 'kept'} — ${JSON.stringify(F.mrGreetedNames(body))}`));
});

console.log('\nthe Arturo rule still works, now on the same machinery');
t('a greeting to Arturo is still dropped', () => {
  assert.strictEqual(F.mrAddressedToArturo({ bodyPreview: 'Hi Arturo, can you check this?' }), true);
});
t('mail sent only to support@ is still dropped', () => {
  assert.strictEqual(F.mrAddressedToArturo({
    bodyPreview: 'Please help with the gate code.',
    toRecipients: [{ emailAddress: { address: 'support@livewithmetric.com' } }],
  }), true);
});
t('mail to support@ AND to her is kept', () => {
  assert.strictEqual(F.mrAddressedToArturo({
    bodyPreview: 'Please help with the gate code.',
    toRecipients: [
      { emailAddress: { address: 'support@livewithmetric.com' } },
      { emailAddress: { address: 'lyndsay@metricpropertymanagement.com' } },
    ],
  }), false);
});

console.log('\nthe rule is wired into the filter');
t('mrEmailExcluded calls it', () => {
  const body = block('function mrEmailExcluded(');
  assert.ok(/mrAddressedToSomeoneElse\(m\)/.test(body),
    'mrEmailExcluded no longer drops mail addressed to other people');
  assert.ok(/mrAddressedToArturo\(m\)/.test(body));
});



console.log('\nthe fetch is wider than the display cap');
t('unread mail is pulled 50 deep, not 10', () => {
  // The list is filtered and THEN cut to ten, so a limit of ten on the fetch
  // meant the budget was spent on mail the rules were about to discard. On
  // 2026-09-30 five of the top eleven unread were one repeated thread, two of
  // which the greeting rule dropped — and a solicitor's email about live
  // litigation sat at #12 and never reached the report.
  // Comments stripped first: the comment explaining this fix says "$top=10",
  // and matching that would fail on the very text that documents it.
  const body = block('async function mrEmails(')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const tops = [...body.matchAll(/\$top=(\d+)/g)].map(m => Number(m[1]));
  assert.ok(tops.length, 'no $top found in mrEmails — the query changed shape');
  tops.forEach(n => assert.ok(n >= 50,
    `mrEmails fetches only ${n} messages before filtering; real mail below the noise is dropped silently`));
  assert.ok(/\.slice\(0, 10\)/.test(body),
    'the display cap is gone — the point is a wide fetch and a narrow display');
});



console.log('\nthe two critical folders are merged by date, not stacked');
t('Lyndsay Review cannot starve Clients', () => {
  // They were joined end to end and then cut to ten, so whichever came first
  // could fill the list. Widening the fetch made Lyndsay Review supply all ten
  // and Clients disappeared, taking a funding-request email with it.
  const i = src.indexOf("const crit = [...(emails['Lyndsay Review']");
  assert.ok(i > 0, 'the Critical section no longer builds `crit` — update this test');
  const line = src.slice(i, i + 400);
  assert.ok(/\.sort\(/.test(line), 'the two folders are concatenated and capped without sorting');
  assert.ok(/receivedIso/.test(line), 'the sort is not using a sortable date');
});
t('each email carries a sortable timestamp, not just "Sep 29"', () => {
  const body = block('async function mrEmails(');
  assert.ok(/receivedIso: m\.receivedDateTime/.test(body),
    'receivedIso is gone, so the merge sorts on a string that cannot order across months');
});



console.log('\nonly a NAME counts against an email');
t('ordinary words after a greeting are not people', () => {
  // "Hi, the attached report is ready" was being read as mail for someone
  // called "the". Dropping a real email because a sentence started with an
  // ordinary word is the failure this whole rule exists to avoid.
  ['Hi, the attached report is ready for review.',
   'Interesting, thanks for sending that over.',
   'Hi, please find the signed lease.',
   'Hello, attached is the statement.',
   'Hi, just confirming the wire went out.',
   'Hola, adjunto el estado de cuenta.',
  ].forEach(b => assert.strictEqual(drops(b), false, b));
});
t('a real name still counts', () => {
  assert.strictEqual(drops('Hi Katrina, please see the attached invoice.'), true);
  assert.strictEqual(drops('Hi Rebekah, the violation was cleared.'), true);
});
t('a two-word phrase of ordinary words is not a name', () => {
  assert.strictEqual(drops('Hi, see below for the numbers'), false);
  assert.strictEqual(drops('Hi, quick update on the wire'), false);
});

console.log('\nautomated senders never reach Pending Critical');
const excluded = m => {
  const body = block('function mrEmailExcluded(');
  return body;
};
t('"do not reply" is matched in the display name and the address', () => {
  // "Metric Property Management of Texas LLC (Do Not Reply)" reached her list,
  // and nobody can answer it. AppFolio puts it in the NAME and sends from an
  // ordinary-looking address, so the name has to be checked too.
  const re = /\b(do[\s._-]*not[\s._-]*reply|no[\s._-]*reply|mailer[\s._-]*daemon|postmaster)\b/i;
  ['Metric Property Management of Texas LLC (Do Not Reply)',
   'donotreply@appfolio.com', 'no-reply@ramp.com', 'noreply@calendar.google.com',
   'mailer-daemon@example.com', 'MAILER-DAEMON', 'postmaster@example.com',
  ].forEach(v => assert.ok(re.test(v), v));
});
t('real support addresses are NOT automated senders', () => {
  // SimpleVOIP and Sonetel write from support@ and a human answers.
  const re = /\b(do[\s._-]*not[\s._-]*reply|no[\s._-]*reply|mailer[\s._-]*daemon|postmaster)\b/i;
  ['support@sonetel.com', 'Sonetel Notifications', 'support@simplevoip.us',
   'support@livewithmetric.com', 'Jennifer Content Director',
  ].forEach(v => assert.strictEqual(re.test(v), false, v));
});
t('the rule is wired in, on the name as well as the address', () => {
  const body = block('function mrEmailExcluded(');
  assert.ok(/MR_NOREPLY_RE\.test\(senderName\)/.test(body), 'the display name is not checked');
  assert.ok(/MR_NOREPLY_RE\.test\(addr\)/.test(body), 'the address is not checked');
});

console.log('\nengineering detail stays out of her list');
t('the ops notes are cleaned before they are shown', () => {
  const render = src.slice(src.indexOf("ARTURO'S PENDING ITEMS LIST"), src.indexOf("ARTURO'S PENDING ITEMS LIST") + 900);
  assert.ok(/mrCleanOpsNote\(o\.pending\)/.test(render), 'notes are printed raw again');
  assert.ok(/note \?/.test(render), 'an empty note still prints a trailing dash');
});

console.log(`\n${pass} passing`);
