// Morning Report, 2026-10-01: four filters.
//
// Every one of these REMOVES something from a report Lyndsay reads and pastes
// into a group chat. The danger in all four is the same and it is not that they
// drop too little — it is that they drop something real and nobody notices. So
// each test names the thing that must still survive, not just the thing that
// must go.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lift = (start, end) => new Function('MAILBOX_LYNDSAY',
  server.slice(server.indexOf(start), server.indexOf(end)) + `return ${start.match(/(?:function |const )(\w+)/)[1]};`)
  ('lyndsay@metricpropertymanagement.com');

const MR_INTERNAL_DOMAINS = ['metricpropertymanagement.com', 'livewithmetric.com'];
const mrIsInternalAddress = a => MR_INTERNAL_DOMAINS.includes(String(a || '').toLowerCase().split('@')[1] || '');
// eslint-disable-next-line no-new-func
const mrOwnsTimed = new Function('MAILBOX_LYNDSAY', 'mrIsInternalAddress',
  server.slice(server.indexOf('function mrOwnsTimed('), server.indexOf('function mrOwnsAllDay('))
  + 'return mrOwnsTimed;')('lyndsay@metricpropertymanagement.com', mrIsInternalAddress);

console.log('1 — timed meetings she never answered');
const meeting = (o) => Object.assign({ subject: 'X', organizerEmail: 'x@outside.com', response: '' }, o);
t('an outsider\'s invitation she has not answered is dropped', () => {
  // "Mexican Martinis w Tanya", organized by Rocco Sirizzotti, 2026-10-01.
  assert.strictEqual(mrOwnsTimed(meeting({
    subject: 'Mexican Martinis w Tanya', organizerEmail: 'rocco@sirizzotti.com', response: 'notResponded',
  })), false);
  assert.strictEqual(mrOwnsTimed(meeting({ response: 'tentativelyAccepted' })), false);
  assert.strictEqual(mrOwnsTimed(meeting({ response: '' })), false);
  assert.strictEqual(mrOwnsTimed(meeting({ response: 'none' })), false);
});
t('an outsider\'s meeting she ACCEPTED stays — this is looser than the all-day rule', () => {
  // The deliberate difference. A partner's 2pm call she said yes to is her day;
  // accepting somebody's two-week trip is not. Getting this backwards would
  // quietly delete her client meetings.
  assert.strictEqual(mrOwnsTimed(meeting({ response: 'accepted' })), true);
  assert.strictEqual(mrOwnsTimed(meeting({
    subject: 'KPI - Windy Hill', organizerEmail: 'officecalendar@livewithmetric.com', response: 'accepted',
  })), true);
});
t('anything organized inside Metric stays, answered or not', () => {
  ['', 'notResponded', 'tentativelyAccepted', 'accepted'].forEach(r => {
    assert.strictEqual(mrOwnsTimed(meeting({ organizerEmail: 'jay@metricpropertymanagement.com', response: r }), true), true,
      `an internal meeting was dropped on response=${r || '(none)'}`);
    assert.strictEqual(mrOwnsTimed(meeting({ organizerEmail: 'officecalendar@livewithmetric.com', response: r })), true);
  });
});
t('her own meetings stay however Graph labels the response', () => {
  assert.strictEqual(mrOwnsTimed(meeting({ organizerEmail: 'LYNDSAY@metricpropertymanagement.com', response: '' })), true);
  assert.strictEqual(mrOwnsTimed(meeting({ organizerEmail: 'x@outside.com', response: 'organizer' })), true);
});
t('the drop is logged, not silent', () => {
  const i = server.indexOf('const owns = mrOwnsTimed(m);');
  assert.ok(i > 0, 'the timed rule is not applied in the calendar filter');
  assert.ok(/mrAllDayDiagnostic\.push/.test(server.slice(i, i + 400)),
    'a timed meeting can disappear with no record of why');
});

console.log('\n2 — the Asana section is for Lyndsay');
// From the constants, not from the function — the names it reads are declared
// above it.
const mrIsArturosTask = new Function(
  server.slice(server.indexOf('const MR_ARTURO_NAMES'), server.indexOf('const MR_OPS_PRIVATE_RE'))
  + 'return mrIsArturosTask;')();
t('tasks assigned to Arturo are his, however his name is written', () => {
  ['Arturo', 'arturo', 'Arturo Mendoza', 'ARTURO MENDOZA', ' Mendoza '].forEach(a =>
    assert.strictEqual(mrIsArturosTask({ assignee: a, name: 'Anything' }), true, a));
});
t('the recurring report tasks are his too, by title', () => {
  [`Lyndsay's Daily Morning Report — High Ops chat`,
   'Lyndsays Daily Morning Report',
   'Morning Report — Review and send to High Ops chat (10/01)',
  ].forEach(n => assert.strictEqual(mrIsArturosTask({ assignee: null, name: n }), true, n));
});
t('somebody else\'s task is NOT his — including one that mentions him', () => {
  // The whole risk: a title-based rule that eats real work.
  [{ assignee: 'Lyndsay Hanes', name: 'Approve the Greysteel rent roll' },
   { assignee: 'Jay Manuel', name: 'Ops Dashboard integration' },
   { assignee: null, name: 'Send Arturo the Q4 numbers' },
   { assignee: 'Rocío Hunsberger', name: 'Report on morning collections calls' },
  ].forEach(x => assert.strictEqual(mrIsArturosTask(x), false, x.name));
});
t('an empty section says WHY it is empty', () => {
  // The feed is Arturo's own My Tasks, so filtering his tasks empties it. A
  // bare "none pending" would read as "Lyndsay has nothing", which is not what
  // we know — we know we cannot see hers.
  const i = server.indexOf("L.push('*PENDING CRITICAL ASANA TASKS*')");
  const body = server.slice(i, i + 2200);
  assert.ok(/Nothing here is waiting on Lyndsay/.test(body),
    'the empty state claims Lyndsay has no pending tasks');
  assert.ok(/see his list below/.test(body), 'it does not say where the tasks went');
});
t('the "+ N more" line cannot outlive the tasks it counts', () => {
  // asana.more counts the unfiltered feed. Printing it beside an empty list
  // would say "+ 17 more" under "nothing is waiting on Lyndsay".
  const i = server.indexOf("L.push('*PENDING CRITICAL ASANA TASKS*')");
  const body = server.slice(i, i + 2200);
  assert.ok(/readable\.length && asana\.more > 0/.test(body),
    'the more-count is printed even when everything was filtered out');
});

console.log('\n3 — Security items stay out of the group chat');
const MR_OPS_PRIVATE_RE = lift('const MR_OPS_PRIVATE_RE', '// The same idea as mrOwnsAllDay');
t('a title STARTING with Security is held back', () => {
  ['Security — Reduce Azure app permissions (remove Mail.Read + MailboxSettings.ReadWrite)',
   'Security hardening — access log, CORS origin, persistent log',
   'security review of the triage caller key',
  ].forEach(x => assert.ok(MR_OPS_PRIVATE_RE.test(x.trim()), x));
});
t('a title that merely mentions security is NOT held back', () => {
  // Start of the title only. A rule matching anywhere would hide ordinary work.
  ['Review Social Security letter for payroll',
   'Jay — Ops Dashboard integration: single login (meeting Friday)',
   'Deposit security refund — Windy Hill 204',
  ].forEach(x => assert.ok(!MR_OPS_PRIVATE_RE.test(x.trim()), x));
});
t('the report says something was held back, without saying what', () => {
  const i = server.indexOf("L.push(`*ARTURO'S PENDING ITEMS LIST*`)");
  const body = server.slice(i, i + 1800);
  assert.ok(/security item\$\{opsPrivate === 1 \? '' : 's'\} not shown here/.test(body),
    'items vanish with no notice that the list is incomplete');
  assert.ok(!/\$\{o\.item\}/.test(body.slice(body.indexOf('opsPrivate'), body.indexOf('opsPrivate') + 300)),
    'the notice leaks the title it is hiding');
});

console.log('\n4 — a greeting with no "Hi"');
// mrGreetedNames + mrLooksLikeName + the two regexes, lifted together.
const greetBlock = server.slice(server.indexOf('const MR_GREETING_RE'),
  server.indexOf('function mrAddressedToArturo('));
// eslint-disable-next-line no-new-func
const addressedToSomeoneElse = new Function(greetBlock + 'return mrAddressedToSomeoneElse;')();
const to = body => addressedToSomeoneElse({ bodyPreview: body });

t('"Charles, Hope all is well!" is dropped, like "Hi Charles"', () => {
  // Andrew Dellinger's usual opening. It had no greeting word, so it read as
  // no greeting at all and reached her list.
  assert.strictEqual(to('Charles, Hope all is well! Attached is the draft.'), true);
  assert.strictEqual(to('Hi Charles, Hope all is well!'), true);
});
t('"Lyndsay, ..." is KEPT — it is her name', () => {
  // The explicit warning in the brief, and the one that would hurt most.
  ['Lyndsay, please see the attached.', 'Lyndsey, quick question.',
   'Hanes, confirming for Friday.', 'Ms. Hanes, following up.',
  ].forEach(b => assert.strictEqual(to(b), false, b));
});
t('an ordinary sentence that opens with a comma is still kept', () => {
  // The failure this whole rule exists to avoid: dropping a real email because
  // a sentence happened to start with a word and a comma.
  ['Thanks, the report is ready.', 'Confirming, we are on for Tuesday.',
   'Attached, as discussed.', 'Yes, that works.', 'Per our call, here are the numbers.',
   'Good, that is settled.', 'FYI, the sync failed last night.',
   'Hope all is well, let me know.',
  ].forEach(b => assert.strictEqual(to(b), false, b));
});
t('a lowercase opener is not a salutation', () => {
  // Without a greeting word the only marker is the shape. A capital is part of it.
  assert.strictEqual(to('charles, hope all is well'), false);
  assert.strictEqual(to('the attached, as discussed'), false);
});
t('a greeting to the room still counts as hers', () => {
  ['All, please review.', 'Team, quick update.', 'Everyone, see below.',
   'Hi all, please review.',
  ].forEach(b => assert.strictEqual(to(b), false, b));
});
t('two names still work, and so does the comma-free case', () => {
  assert.strictEqual(to('Andrew Dellinger, thanks for the call.'), true);
  assert.strictEqual(to('Charles Rushman, see attached.'), true);
  // No comma, no bare-name greeting — this is a sentence.
  assert.strictEqual(to('Charles asked me to send this over.'), false);
});

console.log(`\n${pass} passing`);
