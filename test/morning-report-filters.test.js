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

console.log('\n2 — the Asana section is gone');
// It was Lyndsay's section fed by ARTURO's Asana "My Tasks", so everything in
// it was his and repeated verbatim two sections down. Rather than find a feed
// of her tasks, the section was removed: she does not use Asana and is
// replacing it, and what matters is already in his list.
t('the section is not rendered, and nothing fetches it any more', () => {
  assert.ok(!/PENDING CRITICAL ASANA TASKS/.test(server), 'the heading is back');
  assert.ok(!/function mrAsana\(/.test(server), 'the Asana fetch still runs, for nobody');
  assert.ok(!/mrIsArturosTask/.test(server), 'the filter it needed is still here');
  assert.ok(!/errors\.asana/.test(server), 'an error key survives with nothing to set it');
});
t('the gather is positional, and still lines up', () => {
  // Promise.allSettled destructures by position. Dropping mrAsana() from the
  // array while leaving aR in the names would have shifted every result after
  // it — handing the ops list to appfolio and the SOP count to nobody. This is
  // the one way this removal could break something silently.
  // Anchored on the endpoint: server.js has several Promise.allSettled calls
  // and the first one belongs to the EOD report.
  const i = server.indexOf("app.get('/api/morning-report'");
  assert.ok(i > 0, 'the morning-report endpoint is gone');
  const block = server.slice(server.indexOf('const [', i), server.indexOf('const report = mrFormat', i));
  const names = /const \[([^\]]+)\]/.exec(block)[1].split(',').map(x => x.trim());
  // One promise per line inside the array. Not "ends with a comma" — mrOps()
  // ends with a trailing comment, which an earlier version of this count
  // missed, making it report a mismatch that was not there.
  const arr = block.slice(block.indexOf('allSettled([') + 12, block.indexOf('\n  ]);'));
  const calls = arr.split('\n').filter(l => /^ {4}\S/.test(l)).length;
  assert.strictEqual(names.length, calls,
    `${names.length} result names for ${calls} promises — the destructuring is off`);
  assert.ok(!names.includes('aR'), 'aR is still destructured');
});
t('mrFormat dropped it at the definition AND at the call', () => {
  // Half a rename leaves `asana` undefined inside the formatter.
  const def = /function mrFormat\(\{([^}]+)\}\)/.exec(server)[1];
  const call = /mrFormat\(\{([^}]+)\}\)/.exec(server.slice(server.indexOf('const report = mrFormat')))[1];
  assert.ok(!/\basana\b/.test(def), 'the formatter still declares an asana parameter');
  assert.ok(!/\basana\b/.test(call), 'the caller still passes asana');
  assert.deepStrictEqual(def.split(',').map(x => x.trim()).sort(),
    call.split(',').map(x => x.trim()).sort(),
    'the formatter and its caller disagree about the arguments');
});
t('every other section survived', () => {
  ["*TODAY'S MEETINGS*", '*PENDING CRITICAL EMAILS*',
   '*PENDING APPFOLIO TASKS — LYNDSAY*', "*ARTURO'S PENDING ITEMS LIST*",
  ].forEach(h => assert.ok(server.includes(h), `the ${h} section went with it`));
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
