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
const consts = src.slice(src.indexOf('const MR_SUPPORT_ADDRESSES'), src.indexOf('function mrGreetedNames'));
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

console.log(`\n${pass} passing`);
