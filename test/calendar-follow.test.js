// "Calendar invites to follow" — the read-only list.
//
// Every subject below is verbatim from Lyndsay's live calendar on 2026-10-08,
// because the whole reason this exists rather than an automation is that the
// naming is inconsistent and a word-based rule misses real hearings.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/calendar-follow.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const ev = (subject, organizer, extra) => Object.assign({
  id: 'e' + Math.random(), subject,
  organizer: { emailAddress: { address: organizer || 'someone@example.com' } },
  start: { dateTime: '2026-10-20T19:00:00.0000000' },
  showAs: 'busy', responseStatus: { response: 'notResponded' },
  webLink: 'https://outlook.office365.com/owa/?itemid=x',
}, extra || {});
const COLL = 'collections@livewithmetric.com';
const ME = 'lyndsay@metricpropertymanagement.com';

console.log('calendar invites to follow');

// ---- what counts as a hearing -------------------------------------------
t('the case number is what identifies a hearing, not the word "hearing"', () => {
  // This one says no hearing word at all. A keyword rule loses it.
  assert.strictEqual(C.categorize(ev('In-PERSON - 1JC-26-3570 - A RESIDENT - iConic Downtown - 204 ', COLL)), 'hearing');
  // Every case shape seen on the calendar.
  ['J1-CV-26-004707', 'J2-CV-26-008772', 'J3-EV-26-001524', 'J5-CV-26-282997', '1JC-26-3567']
    .forEach(c => assert.ok(C.CASE_RE.test('whatever ' + c + ' whatever'), c));
});

t('every spelling of the hearing subject is caught', () => {
  ['InPerson Hearing | J1-CV-26-006461 | X - The Highlander - 113 ',
   'Virtual/Zoom Hearing - J5-CV-26-282343  - X -Sunset Palms 101',
   'VIRTUAL Hearing - J5-CV-26-282408 - X - THE CHATEAU',
   'In-Person Eviction Hearing- 1JC-26-3560  - X - ICONIC ROUND ROCK 104',
   'PHONE Hearing - 1JC-26-3567 - X - iConic Downtown - 103 ',
   'InPerson Hearing - 1JC-26-3569 - Reset Hearing Notice - X - iConic Round Rock - 204 ',
  ].forEach(s => assert.strictEqual(C.categorize(ev(s, COLL)), 'hearing', s));
});

t('the collections organizer alone also qualifies, as asked', () => {
  assert.strictEqual(C.categorize(ev('Something with no case number', COLL)), 'hearing');
  assert.strictEqual(C.categorize(ev('Something with no case number', 'other@example.com')), null);
});

t('but a day off from collections is NOT filed as a court date', () => {
  // "Rocio off" is a real entry organised by collections@. Testing "away"
  // before the organizer is what stops a day off becoming a hearing.
  assert.strictEqual(C.categorize(ev('Rocio off ', COLL)), 'pto');
  assert.strictEqual(C.categorize(ev('Katie - time off', COLL)), 'pto');
});

// ---- writs ---------------------------------------------------------------
t('writs are called WOP on this calendar', () => {
  assert.strictEqual(C.categorize(ev('WOP | X - Ascent at Northgate - 9-218 ', COLL)), 'wop');
  assert.strictEqual(C.categorize(ev('WOP - The Sidney - 107 - A Place 2 Stay LLC', COLL)), 'wop');
  assert.strictEqual(C.categorize(ev('Writ of Possession scheduled', COLL)), 'wop');
});

t('"WOP" does not fire inside another word', () => {
  assert.notStrictEqual(C.categorize(ev('SWOPPING shifts', 'a@b.com')), 'wop');
});

// ---- time off ------------------------------------------------------------
t('PTO is caught in both shapes the calendar uses', () => {
  assert.strictEqual(C.categorize(ev('PTO - Katrina', 'marketing@metricpropertymanagement.com')), 'pto');
  assert.strictEqual(C.categorize(ev('JAY - PTO ', 'admin@metricpropertymanagement.com')), 'pto');
  assert.strictEqual(C.categorize(ev('PTO - Katie', 'support@livewithmetric.com')), 'pto');
});

t('PTO is case-sensitive so it does not fire on fragments', () => {
  assert.strictEqual(C.categorize(ev('Your pto.example.com account', 'a@b.com')), null);
});

t('an invite arriving via the allmetric list is judged on its subject', () => {
  // Lyndsay is not a direct attendee on some of these; nothing here depends on
  // the attendee list, only on the subject and the organizer.
  const e = ev('PTO - Katrina', 'marketing@metricpropertymanagement.com',
    { attendees: [{ emailAddress: { address: 'allmetric@metricpropertymanagement.com' } }] });
  assert.strictEqual(C.categorize(e), 'pto');
});

// ---- already following ---------------------------------------------------
t('an invite already marked Following is recognised', () => {
  assert.ok(C.isFollowing(ev('Following: Reset | InPerson Hearing | J2-CV-26-008772 | X', COLL)));
  assert.ok(C.isFollowing(ev('Following: PTO - Katie', 'support@livewithmetric.com')));
  assert.ok(!C.isFollowing(ev('InPerson Hearing | J1-CV-26-006461 | X', COLL)));
});

// ---- the resident's name never reaches the screen -----------------------
t('a hearing label is REBUILT, so no resident name can survive it', () => {
  // Rebuilt from known-safe parts rather than redacted: a redaction leaks
  // whatever its pattern fails to catch, a rebuild cannot.
  const l = C.label(ev('InPerson Hearing | J1-CV-26-006461 | Damien Munoz - The Highlander - 113 ', COLL));
  assert.ok(!/Damien/i.test(l), 'the name survived: ' + l);
  assert.ok(!/Munoz/i.test(l), 'the surname survived: ' + l);
  assert.ok(l.includes('J1-CV-26-006461'), 'the case number was lost');
  assert.ok(l.includes('The Highlander'), 'the property was lost');
});

t('no resident name survives ANY of the real hearing subjects', () => {
  const cases = [
    ['Virtual/Zoom Hearing - J5-CV-26-282343  - Estephania Arrieta -Sunset Palms 101', ['Estephania', 'Arrieta']],
    ['In-Person Eviction Hearing- 1JC-26-3560  - JOSE L. REAL - ICONIC ROUND ROCK 104', ['JOSE', 'REAL']],
    ['In-PERSON - 1JC-26-3570 - YADIRA M. BONILLA - iConic Downtown - 204 ', ['YADIRA', 'BONILLA']],
    ['Reset | InPerson Hearing | J2-CV-26-008772 | ASCENT VS. SUSIE A JIMENEZ', ['SUSIE', 'JIMENEZ']],
    ['WOP | Danilo J. Perez - Ascent at Northgate - 9-218 ', ['Danilo', 'Perez']],
    ['Following: VIRTUAL HEARING | J3-EV-26-001524 5704 | CEDAR AND SAGE vs. PERI A. PERKINS, CEDRIC D. MITCHEL AND ALL OTHER OCCUPANTS', ['PERKINS', 'MITCHEL', 'PERI', 'CEDRIC']],
  ];
  cases.forEach(([subject, names]) => {
    const l = C.label(ev(subject, COLL));
    names.forEach(n => assert.ok(!new RegExp(n, 'i').test(l),
      'name "' + n + '" leaked into: ' + l));
  });
});

t('a PTO label KEEPS its subject — those are colleagues, and the point', () => {
  assert.strictEqual(C.label(ev('PTO - Katrina', 'marketing@metricpropertymanagement.com')), 'PTO - Katrina');
  assert.strictEqual(C.label(ev('JAY - PTO ', 'admin@metricpropertymanagement.com')), 'JAY - PTO');
});

t('the label still says what kind of appearance it is', () => {
  assert.ok(/Reset/.test(C.label(ev('Reset | InPerson Hearing | J2-CV-26-008772 | X', COLL))));
  assert.ok(/In person/.test(C.label(ev('InPerson Hearing | J1-CV-26-006461 | X', COLL))));
  assert.ok(/Virtual/.test(C.label(ev('Virtual/Zoom Hearing - J5-CV-26-282343 - X', COLL))));
  assert.ok(/Writ of possession/.test(C.label(ev('WOP | X - Ascent at Northgate', COLL))));
});

// ---- the list itself -----------------------------------------------------
const SAMPLE = [
  ev('Following: Reset | InPerson Hearing | J2-CV-26-008772 | X', COLL),       // done
  ev('InPerson Hearing | J1-CV-26-006461 | X - The Highlander - 113 ', COLL),
  ev('In-PERSON - 1JC-26-3570 - X - iConic Downtown - 204 ', COLL),
  ev('WOP | X - Ascent at Northgate - 9-218 ', COLL),
  ev('PTO - Katrina', 'marketing@metricpropertymanagement.com'),
  ev('Rocio off ', COLL),
  ev('Canceled: Virtual/Phone hearing - 1JC-26-3267 - X', COLL, { isCancelled: true }),
  ev('Greenlawn Summary Judgment Hearing', ME, { isOrganizer: true }),
  ev('Weekly leadership sync', 'someone@example.com'),
];

t('it picks exactly what is outstanding', () => {
  const items = C.pick(SAMPLE, { mailbox: ME });
  assert.strictEqual(items.length, 5);
  assert.deepStrictEqual(C.summarize(items).byCategory, { hearing: 2, wop: 1, pto: 2 });
});

t('already-Following, cancelled, and her own meetings are all left out', () => {
  const labels = C.pick(SAMPLE, { mailbox: ME }).map(i => i.label).join(' | ');
  assert.ok(!/J2-CV-26-008772/.test(labels), 'an already-Following invite was listed');
  assert.ok(!/1JC-26-3267/.test(labels), 'a cancelled hearing was listed');
  assert.ok(!/Greenlawn/.test(labels), 'she cannot follow her own meeting');
  assert.ok(!/leadership sync/.test(labels), 'an unrelated meeting was listed');
});

t('every row carries what is needed to act on it', () => {
  const i = C.pick(SAMPLE, { mailbox: ME })[0];
  ['id', 'category', 'label', 'start', 'organizer', 'status', 'webLink'].forEach(k =>
    assert.ok(k in i, 'missing ' + k));
  assert.ok(/outlook\.office365\.com/.test(i.webLink));
});

t('BOTH showAs and responseStatus are reported', () => {
  // They answer different questions, and a Followed invite reads free +
  // tentativelyAccepted — so neither alone says whether she has dealt with it.
  const i = C.pick([ev('InPerson Hearing | J1-CV-26-006461 | X', COLL,
    { showAs: 'free', responseStatus: { response: 'tentativelyAccepted' } })], { mailbox: ME })[0];
  assert.deepStrictEqual(i.status, { showAs: 'free', response: 'tentativelyAccepted' });
});

t('a missing status does not throw', () => {
  const i = C.pick([{ id: 'x', subject: 'WOP - X', organizer: { emailAddress: { address: COLL } } }], {})[0];
  assert.deepStrictEqual(i.status, { showAs: null, response: null });
});

t('rows come back in date order, soonest first', () => {
  const items = C.pick([
    ev('WOP - late', COLL, { start: { dateTime: '2026-12-01T10:00:00' } }),
    ev('WOP - early', COLL, { start: { dateTime: '2026-10-09T10:00:00' } }),
  ], { mailbox: ME });
  assert.deepStrictEqual(items.map(i => i.start), ['2026-10-09T10:00:00', '2026-12-01T10:00:00']);
});

t('the already-Following ones are counted, not just dropped', () => {
  // "Nothing waiting" and "this panel is broken" look identical on screen. On
  // 2026-10-08 the list correctly showed no hearings, and the only way to tell
  // that from a silent failure was to go and read the calendar.
  const af = C.alreadyFollowingSummary(SAMPLE, { mailbox: ME });
  assert.strictEqual(af.total, 1);
  assert.deepStrictEqual(af.byCategory, { hearing: 1 });
});

t('the real 2026-10-08 window reproduces: 0 hearings out, 4 already Following', () => {
  // The four collections@ events in the route's window, verbatim, all followed.
  const coll = s2 => ({ subject: s2, organizer: { emailAddress: { address: COLL } },
    start: { dateTime: '2026-10-20T19:00:00' } });
  const events = [
    coll('Following: InPerson Hearing | J2-CV-26-008772 | X - Ascent at Northgate - 3-216'),
    coll('Following: Reset | InPerson Hearing | J2-CV-26-008772 | ASCENT VS. X'),
    coll('Following: VIRTUAL HEARING | J3-EV-26-001524 5704 | CEDAR AND SAGE vs. X'),
    coll('Following: Virtual Hearing | J3-EV-26-001526 | 5704 COUGAR LLC DBA CEDAR AND SAGE vs. X'),
    ev('PTO - Katrina', 'marketing@metricpropertymanagement.com'),
    ev('PTO - Katrina', 'marketing@metricpropertymanagement.com'),
  ];
  assert.deepStrictEqual(C.summarize(C.pick(events, { mailbox: ME })), { total: 2, byCategory: { pto: 2 } });
  assert.deepStrictEqual(C.alreadyFollowingSummary(events, { mailbox: ME }), { total: 4, byCategory: { hearing: 4 } });
});

t('a Reset hearing with showAs tentative is still listed when not followed', () => {
  // The exact event queried on 2026-10-08. Neither the "Reset |" prefix, nor
  // the J2-CV number shape, nor showAs tentative excludes it — it was missing
  // from the list only because she had already pressed Follow.
  const e = ev('Reset | InPerson Hearing | J2-CV-26-008772 | ASCENT VS. SUSIE A JIMENEZ', COLL,
    { showAs: 'tentative', responseStatus: { response: 'tentativelyAccepted' } });
  assert.strictEqual(C.caseNumber(C.subjectOf(e)), 'J2-CV-26-008772');
  assert.strictEqual(C.categorize(e), 'hearing');
  const got = C.pick([e], { mailbox: ME });
  assert.strictEqual(got.length, 1, 'it would have been missed');
  assert.ok(/Reset/.test(got[0].label) && /J2-CV-26-008772/.test(got[0].label));
});

t('an empty calendar is an empty list, not an error', () => {
  assert.deepStrictEqual(C.pick([], {}), []);
  assert.deepStrictEqual(C.pick(null, {}), []);
  assert.deepStrictEqual(C.summarize([]), { total: 0, byCategory: {} });
  assert.deepStrictEqual(C.alreadyFollowingSummary(null, {}), { total: 0, byCategory: {} });
});

// ---- the route and the UI ------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const fn = CODE.slice(CODE.indexOf('async function calendarInvitesToFollow'),
  CODE.indexOf("app.get('/api/calendar/invites-to-follow'") + 400);

t('the route is admin-only', () => {
  assert.ok(/app\.get\('\/api\/calendar\/invites-to-follow', requireMetricAdmin/.test(CODE));
});

t('IT ONLY READS — no response, no accept, no edit anywhere in it', () => {
  ['/accept', '/decline', '/tentativelyAccept', 'tentativelyAccept(',
   "method: 'POST'", "method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'",
   'flagStatus', 'responseStatus:'].forEach(bad =>
    assert.ok(!fn.includes(bad), 'the invites list does ' + bad));
  assert.ok(/calendarView/.test(fn), 'it does not read the calendar');
});

t('it asks Graph for responseStatus and showAs', () => {
  assert.ok(/\$select=[^']*responseStatus/.test(fn));
  assert.ok(/\$select=[^']*showAs/.test(fn));
  assert.ok(/\$select=[^']*webLink/.test(fn));
});

t('the window is the last 7 days plus everything ahead', () => {
  assert.ok(/CAL_FOLLOW_PAST_DAYS = 7/.test(CODE));
  assert.ok(/Date\.now\(\) - CAL_FOLLOW_PAST_DAYS \* 86400000/.test(fn));
  assert.ok(/Date\.now\(\) \+ CAL_FOLLOW_FUTURE_DAYS \* 86400000/.test(fn));
});

t('THE COUNT IS NOT IN THE REPORT THAT GOES TO THE GROUP CHAT', () => {
  // `report` is the block Arturo pastes into High Ops. These rows name court
  // cases and whose day off it is. The count rides alongside it, never in it.
  assert.ok(/invitesToFollow,/.test(CODE), 'the count is not returned at all');
  // mrFormat's own body, bounded by its closing brace — a fixed character
  // window overran into the route below it and failed on the sibling field.
  const fStart = CODE.indexOf('function mrFormat');
  const after = CODE.slice(fStart);
  const fEnd = fStart + after.indexOf('\n}\n') + 2;
  const fmt = CODE.slice(fStart, fEnd);
  assert.ok(fmt.length > 500 && fmt.length < 9000, 'mrFormat slice looks wrong: ' + fmt.length);
  assert.ok(!/invitesToFollow/.test(fmt), 'the count leaked into the pasted report');
  assert.ok(!/invites to follow/i.test(fmt), 'a section for it leaked into the pasted report');
});

t('a calendar failure does not cost him the morning report', () => {
  assert.ok(/invitesToFollow = \{ error: e\.message \}/.test(CODE));
});

t('the panel always prints the already-Following tally', () => {
  assert.ok(/alreadyFollowing: CF\.alreadyFollowingSummary/.test(CODE), 'the route does not report it');
  const ui = APP.slice(APP.indexOf('async function loadCalFollow'), APP.indexOf('async function loadEmail'));
  assert.ok(/already marked Following/.test(ui));
  // Printed on BOTH paths — with rows and with none — so an empty panel can
  // still be told apart from a broken one.
  const flat = ui.split('\n').join(' ');
  assert.ok(flat.includes('Nothing waiting — ${esc(afText)}'), 'not printed on the empty path');
  assert.ok(/<\/tbody><\/table>'/.test(flat) && flat.indexOf('esc(afText)') < flat.length,
    'the tally is not rendered at all');
  assert.strictEqual((ui.match(/esc\(afText\)/g) || []).length, 2,
    'the tally should be printed on both the empty and the populated path');
});

t('the panel is in the Email / Cal tab and refreshes on its own', () => {
  assert.ok(/id="cal-follow-section"/.test(HTML));
  assert.ok(/id="cal-follow-body"/.test(HTML));
  assert.ok(/async function loadCalFollow/.test(APP));
  assert.ok(/api\('\/api\/calendar\/invites-to-follow'/.test(APP));
});

t('the morning report shows the count on screen only', () => {
  assert.ok(/id="morning-invites"/.test(HTML));
  assert.ok(/not included in the copied report/.test(APP),
    'the UI should say the count is not in the copied text');
  // The textarea is what gets copied; nothing may write the count into it.
  const copy = APP.slice(APP.indexOf("$('#morning-copy')"), APP.indexOf("$('#morning-copy')") + 300);
  assert.ok(!/invites/i.test(copy));
});

t('the UI escapes everything it renders', () => {
  const ui = APP.slice(APP.indexOf('async function loadCalFollow'), APP.indexOf('async function loadEmail'));
  ['i.label', 'i.organizer', 'i.webLink'].forEach(v =>
    assert.ok(new RegExp('esc\\(' + v.replace('.', '\\.') + '\\)').test(ui), v + ' is not escaped'));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
