// KPI RR Automation — the rules.
//
// The fixtures are the real meeting, read from Graph on 2026-09-29: the
// attendee list of "KPI ICRR & ICDT + Metric", and the twenty transcripts and
// recordings the series returns under one onlineMeeting.
const assert = require('assert');
const K = require('../kpi-recap.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const att = (name, address) => ({ emailAddress: { name, address } });

// The real invitation. Externals carry no display name in Outlook, which is why
// the cached feed shows their address where it shows colleagues' names.
const REAL_EVENT = {
  subject: 'KPI ICRR & ICDT + Metric',
  seriesMasterId: 'SERIES-RR',
  attendees: [
    att('Office Calendar', 'officecalendar@metricpropertymanagement.com'),
    att('Rebekah Tuckner', 'bekah@metricpropertymanagement.com'),
    att('', 'ktt@niagara-investments.com'),
    att('', 'kttproperties@gmail.com'),
    att('', 'ryan@topproducerinvestmentscapital.com'),
    att('Lyndsay Hanes', 'lyndsay@metricpropertymanagement.com'),
    att('Roxanne De vero', 'rhoxie@metricpropertymanagement.com'),
    att('Jay Manuel', 'admin@metricpropertymanagement.com'),
    att('Janae Rapps', 'janae@niagara-investments.com'),
    att('Amber Lackey', 'amber@niagara-investments.com'),
    att('', 'senate@senateeskridge.com'),
    att('Kara Garst', 'kara@metricpropertymanagement.com'),
    att('Lyndsay Hanes', 'LYNDSAY@metricpropertymanagement.com'),   // she is listed twice
  ],
};

console.log('draft mode is not optional');
t('automatic sending is OFF', () => {
  assert.strictEqual(K.AUTO_SEND, false,
    'AUTO_SEND is on. It stays off until Lyndsay has confirmed the recipients against a real draft.');
});

console.log('\nwhich meetings');
t('the Round Rock series matches, by id and by subject', () => {
  assert.ok(K.isRoundRockMeeting(REAL_EVENT, ['SERIES-RR']));
  assert.ok(K.isRoundRockMeeting({ subject: 'KPI ICRR & ICDT + Metric' }, []), 'subject fallback');
  assert.ok(K.isRoundRockMeeting({ subject: 'ICDT sync' }, []));
});
t('the other KPI meetings do NOT — they belong to other partners', () => {
  // All three are real, and all three sit in the same calendar.
  ['KPI THSI + Metric', 'KPI TRIGILD + Metric', 'Ascent at Northgate KPI + Metric']
    .forEach(subject => assert.strictEqual(K.isRoundRockMeeting({ subject }, ['SERIES-RR']), false, subject));
});

console.log('\nwho it proposes to write to');
t('only the external partners — colleagues never receive it', () => {
  const { proposed } = K.recipientsFrom(REAL_EVENT);
  assert.deepStrictEqual(proposed.map(p => p.address).sort(), [
    'ktt@niagara-investments.com',
    'kttproperties@gmail.com',
    'ryan@topproducerinvestmentscapital.com',
    'senate@senateeskridge.com',
  ]);
});
t('Janae Rapps and Amber Lackey are held back, and recorded as held back', () => {
  // They speak in the 2026-09-23 transcript alongside the partners, so they are
  // probably Round Rock's — but probably is not enough to send someone a
  // recording. Excluded until Lyndsay says otherwise, and visible on the draft.
  const { proposed, excluded } = K.recipientsFrom(REAL_EVENT);
  assert.deepStrictEqual(excluded.map(e => e.name).sort(), ['Amber Lackey', 'Janae Rapps']);
  proposed.forEach(p => assert.ok(!/janae|amber/i.test(p.name + p.address), 'a held-back name leaked into the recipients'));
});
t('Lyndsay appears twice in the invitation and is dropped once, on the address', () => {
  const all = K.recipientsFrom(REAL_EVENT);
  const everyone = all.proposed.concat(all.excluded).map(p => p.address.toLowerCase());
  assert.strictEqual(new Set(everyone).size, everyone.length, 'a duplicate survived');
});
t('every Metric domain counts as internal', () => {
  ['a@metricpropertymanagement.com', 'b@livewithmetric.com', 'c@metric.internal']
    .forEach(a => assert.ok(K.isInternal(a), a));
  assert.strictEqual(K.isInternal('ktt@niagara-investments.com'), false);
  // A lookalike domain is not ours.
  assert.strictEqual(K.isInternal('x@notmetricpropertymanagement.com.evil.com'), false);
});
t('an attendee with no address is skipped rather than half-sent', () => {
  const { proposed } = K.recipientsFrom({ attendees: [att('Nobody', ''), att('', null)] });
  assert.strictEqual(proposed.length, 0);
});

console.log('\npicking one occurrence out of twenty');
// The series shares one onlineMeeting, so Graph returns every occurrence at once.
const TRANSCRIPTS = [
  { id: 'T-0923', contentCorrelationId: 'CALL-0923', createdDateTime: '2026-09-23T17:59:00Z', endDateTime: '2026-09-23T18:23:00Z' },
  { id: 'T-0916', contentCorrelationId: 'CALL-0916', createdDateTime: '2026-09-16T18:01:00Z', endDateTime: '2026-09-16T18:10:00Z' },
  { id: 'T-0826', contentCorrelationId: 'CALL-0826', createdDateTime: '2026-08-26T17:57:00Z', endDateTime: '2026-08-26T18:31:00Z' },
];
const RECORDINGS = [
  { id: 'R-0916', contentCorrelationId: 'CALL-0916', createdDateTime: '2026-09-16T18:01:00Z', recordingContentUrl: 'u16' },
  { id: 'R-0923', contentCorrelationId: 'CALL-0923', createdDateTime: '2026-09-23T17:59:00Z', recordingContentUrl: 'u23' },
];

t('the newest transcript is the last meeting', () => {
  const { transcript } = K.artifactsFor(TRANSCRIPTS, RECORDINGS);
  assert.strictEqual(transcript.id, 'T-0923');
});
t('the recording is paired by contentCorrelationId, not by date', () => {
  // Same call, so the pair is exact even if a second recording shares a day.
  const { recording } = K.artifactsFor(TRANSCRIPTS, RECORDINGS);
  assert.strictEqual(recording.id, 'R-0923');
});
t('a restarted recording on the same day does not steal the pairing', () => {
  const extra = RECORDINGS.concat([
    { id: 'R-STRAY', contentCorrelationId: 'CALL-OTHER', createdDateTime: '2026-09-23T18:30:00Z' },
  ]);
  assert.strictEqual(K.artifactsFor(TRANSCRIPTS, extra).recording.id, 'R-0923');
});
t('a transcript with no recording yields one, not a crash', () => {
  const { transcript, recording } = K.artifactsFor([TRANSCRIPTS[2]], RECORDINGS);
  assert.strictEqual(transcript.id, 'T-0826');
  assert.strictEqual(recording, null);
});
t('an occurrence can be picked by date', () => {
  assert.strictEqual(K.artifactsFor(TRANSCRIPTS, RECORDINGS, '2026-09-20T00:00:00Z').transcript.id, 'T-0916');
});
t('no transcripts at all is null, not an exception', () => {
  assert.deepStrictEqual(K.artifactsFor([], []), { transcript: null, recording: null });
});

console.log('\nre-running the scan changes nothing');
t('occurrences already drafted are skipped', () => {
  const pending = K.pendingOccurrences(TRANSCRIPTS, ['CALL-0923', 'CALL-0916']);
  assert.deepStrictEqual(pending.map(p => p.contentCorrelationId), ['CALL-0826']);
});
t('with everything drafted, nothing is pending', () => {
  assert.strictEqual(K.pendingOccurrences(TRANSCRIPTS, ['CALL-0923', 'CALL-0916', 'CALL-0826']).length, 0);
});
t('a first run against an empty table drafts ONE meeting, not twenty', () => {
  // The series returns every past occurrence at once. Without this the first
  // run would put twenty months of meetings in front of Arturo at once.
  const p = K.pendingOccurrences(TRANSCRIPTS, []);
  assert.strictEqual(p.length, 1, 'more than one draft from a single run');
  assert.strictEqual(p[0].id, 'T-0923', 'not the most recent meeting');
});
t('a backfill has to ask for one, explicitly', () => {
  assert.deepStrictEqual(K.pendingOccurrences(TRANSCRIPTS, [], 2).map(x => x.id), ['T-0923', 'T-0916']);
});
t('after the newest is drafted, the next run takes the one before it', () => {
  assert.deepStrictEqual(K.pendingOccurrences(TRANSCRIPTS, ['CALL-0923']).map(x => x.id), ['T-0916']);
});

console.log('\nthe draft email');
t('the recording is offered on request, never as a link or an attachment', () => {
  // The Graph URL needs an access token: a partner clicking it gets a 401, not
  // a video. Making it openable means changing SharePoint's external sharing,
  // which nobody has asked for.
  const d = K.composeDraft({ subject: 'KPI ICRR & ICDT + Metric', meetingDate: '2026-09-23T17:59:00Z',
    summary: '<p>Occupancy discussed.</p>', recordingUrl: 'https://graph.microsoft.com/v1.0/users/x/rec', transcriptAttached: true });
  assert.ok(/available on request/i.test(d.body), 'the draft does not offer the recording on request');
  assert.ok(!/graph\.microsoft\.com/.test(d.body), 'a Graph URL leaked into the email body');
  assert.ok(!/<a /i.test(d.body), 'the body still contains a link');
  assert.ok(/transcript is attached/i.test(d.body));
  assert.strictEqual(d.subject, 'KPI ICRR & ICDT + Metric — recording & transcript (2026-09-23)');
});
t('a missing recording is stated, not quietly dropped', () => {
  const d = K.composeDraft({ subject: 'X', meetingDate: '2026-09-23T00:00:00Z', transcriptAttached: false });
  assert.ok(/not available/i.test(d.body), 'the draft hides that there is no recording');
  assert.ok(/transcript is not available/i.test(d.body));
});
t('the subject carries the meeting date, not today', () => {
  assert.ok(K.composeDraft({ subject: 'X', meetingDate: '2026-08-26T17:57:00Z' }).subject.endsWith('(2026-08-26)'));
});
t('a partner name with HTML in it cannot break the body', () => {
  const d = K.composeDraft({ subject: '<script>alert(1)</script>', meetingDate: '2026-09-23T00:00:00Z' });
  assert.ok(!/<script>/.test(d.body), 'the subject was interpolated unescaped');
  assert.ok(/&lt;script&gt;/.test(d.body));
});

console.log(`\n${pass} passing`);
