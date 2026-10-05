// The Lyndsay Message Queue, rebuilt from the calendar instead of accumulated.
//
// Every fault reported on 2026-10-06 came from one decision: reminders were
// pushed into a JSON file and only ever left it when somebody marked them sent.
// Nothing went back to the calendar, so nothing could move, expire or vanish.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LQ = require('../lib/lyndsay-queue.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// A fixed clock. 2026-10-06 13:00 Central is 18:00 UTC.
const NOW = new Date('2026-10-06T18:00:00Z');
const TODAY_CT = '2026-10-06';
const toYMD = d => {
  // Central is UTC-5 in October.
  const x = new Date(d.getTime() - 5 * 3600 * 1000);
  return x.toISOString().slice(0, 10);
};
const at = iso => ({ id: 'ev-' + iso, subject: 'Meeting ' + iso, start: iso, attendees: [1, 2] });
const build = (meetings, sent) => LQ.build(meetings, {
  now: NOW, todayCentral: TODAY_CT, toCentralYMD: toYMD, sent: sent || {},
});

console.log('the 30-minute window');
t('a meeting 20 minutes away is in', () => {
  const r = build([at('2026-10-06T18:20:00Z')]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].minutesUntil, 20);
});
t('a meeting 31 minutes away is not yet', () => {
  assert.strictEqual(build([at('2026-10-06T18:31:00Z')]).length, 0);
});
t('exactly 30 minutes is in, 30 and a bit is not', () => {
  assert.strictEqual(build([at('2026-10-06T18:30:00Z')]).length, 1);
  assert.strictEqual(build([at('2026-10-06T18:30:01Z')]).length, 0);
});
t('a meeting that has already started EXPIRES, marked sent or not', () => {
  // The 9:30s. This is the whole second fault: nothing used to take them out.
  assert.strictEqual(build([at('2026-10-06T17:59:00Z')]).length, 0, 'a started meeting is still listed');
  assert.strictEqual(build([at('2026-10-06T15:30:00Z')]).length, 0, 'a meeting from hours ago is still listed');
  // And not because it was marked sent — it is gone either way.
  const m = at('2026-10-06T15:30:00Z');
  assert.strictEqual(build([m], { [LQ.keyOf(m)]: true }).length, 0);
});
t('the moment of the start is out, not in', () => {
  assert.strictEqual(build([at('2026-10-06T18:00:00Z')]).length, 0,
    'a meeting starting right now is still a thing to send');
});

console.log('\ntomorrow is not this queue');
t("tomorrow's meeting never appears", () => {
  // "Tomorrow reminder: Metric unknown charges review" sat in a list of things
  // to send now.
  assert.strictEqual(build([at('2026-10-07T18:20:00Z')]).length, 0);
});
t('tomorrow 20 minutes past midnight is still tomorrow', () => {
  assert.strictEqual(build([at('2026-10-07T05:20:00Z')]).length, 0);
});
t('the reminder type is gone from the server entirely', () => {
  assert.ok(!/reminderType === 'tomorrow'/.test(code) || !/generateLyndsayReminders\(lyndsayMeetings\)/.test(code),
    'the tomorrow branch is still live');
  assert.ok(/async function generateLyndsayReminders\(\) \{/.test(code),
    'the accumulating generator still queues things');
});
t('a late-evening Central meeting is still TODAY', () => {
  // 7pm Austin is 2026-10-07 in UTC. Comparing UTC dates would push it to
  // tomorrow and drop it.
  const r = LQ.build([at('2026-10-07T00:10:00Z')], {
    now: new Date('2026-10-07T00:00:00Z'), todayCentral: '2026-10-06',
    toCentralYMD: toYMD, sent: {},
  });
  assert.strictEqual(r.length, 1, 'a 7pm Central meeting was treated as tomorrow');
});

console.log('\na moved or cancelled meeting');
t('a cancelled meeting disappears', () => {
  const m = at('2026-10-06T18:20:00Z');
  m.isCancelled = true;
  assert.strictEqual(build([m]).length, 0);
});
t('a meeting moved to tomorrow leaves nothing behind', () => {
  // "Discovery Session — Kara & Arturo" stayed at 1:00 PM today after moving.
  // Nothing is stored, so there is nothing to leave behind.
  const moved = { id: 'discovery', subject: 'Discovery Session', start: '2026-10-07T18:00:00Z', attendees: [] };
  assert.strictEqual(build([moved]).length, 0);
});
t('a meeting moved within today follows its new time', () => {
  const m = { id: 'discovery', subject: 'Discovery Session', start: '2026-10-06T18:10:00Z', attendees: [] };
  const r = build([m]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].minutesUntil, 10);
});
t('"sent" is keyed on the event AND its start', () => {
  // Keeping it against the event alone would silence the reminder for the new
  // time, which is a different message to send.
  const before = { id: 'discovery', subject: 'D', start: '2026-10-06T18:10:00Z', attendees: [] };
  const after = { id: 'discovery', subject: 'D', start: '2026-10-06T18:25:00Z', attendees: [] };
  const marks = { [LQ.keyOf(before)]: true };
  assert.strictEqual(build([before], marks)[0].sent, true);
  assert.strictEqual(build([after], marks)[0].sent, false, 'the moved meeting inherited the sent mark');
});

console.log('\nthe text is written when it is copied');
t('the minutes are the real ones, not a baked lead time', () => {
  // It always said "starts in 4 minutes".
  const r = build([at('2026-10-06T18:17:00Z')]);
  const text = LQ.messageFor(r[0], NOW, '1:17 PM');
  assert.ok(/starts in 17 minutes/.test(text), text);
  assert.ok(!/starts in 4 minutes/.test(text));
});
t('the start time is in the sentence, so a stale paste shows itself', () => {
  const r = build([at('2026-10-06T18:17:00Z')]);
  assert.ok(/\(1:17 PM CT\)/.test(LQ.messageFor(r[0], NOW, '1:17 PM')));
});
t('one minute is singular', () => {
  const r = build([at('2026-10-06T18:01:00Z')]);
  assert.ok(/starts in 1 minute\b/.test(LQ.messageFor(r[0], NOW, '1:01 PM')));
});
t('the join link is included when there is one', () => {
  const m = at('2026-10-06T18:10:00Z');
  m.joinUrl = 'https://teams.example/x';
  assert.ok(LQ.messageFor(build([m])[0], NOW, '1:10 PM').includes('https://teams.example/x'));
});

console.log('\nwhat the route does');
t('it rebuilds on every read instead of reading the file', () => {
  const i = code.indexOf("app.get('/api/lyndsay-queue'");
  const body = code.slice(i, code.indexOf("app.post('/api/lyndsay-queue'", i));
  assert.ok(/LQ\.build\(mine/.test(body), 'the queue is still served from the stored file');
  assert.ok(/readJSON\(MEETINGS_FILE/.test(body), 'it never looks at the calendar');
});
t("it applies the Morning Report's ownership rule", () => {
  // A personal event, or an external invitation she never answered, is not a
  // reminder to send.
  const i = code.indexOf("app.get('/api/lyndsay-queue'");
  const body = code.slice(i, code.indexOf("app.post('/api/lyndsay-queue'", i));
  assert.ok(/mrOwnsTimed\(m\)/.test(body), 'every event on the calendar is queued');
  assert.ok(/!m\.isAllDay/.test(body), 'all-day events are queued as meetings');
});
t('manual entries survive the rebuild', () => {
  const i = code.indexOf("app.get('/api/lyndsay-queue'");
  const body = code.slice(i, code.indexOf("app.post('/api/lyndsay-queue'", i));
  assert.ok(/stored\.filter\(q => !q\.reminderType\)/.test(body),
    'a message somebody typed by hand is thrown away on rebuild');
});
t('marking sent writes a key, and old keys age out', () => {
  const i = code.indexOf("app.post('/api/lyndsay-queue/:id/sent'");
  const body = code.slice(i, i + 1200);
  assert.ok(/includes\('\|'\)/.test(body), 'a rebuilt reminder cannot be marked sent');
  assert.ok(/7 \* 24 \* 60 \* 60 \* 1000/.test(body), 'the sent file grows for ever');
});

console.log(`\n${pass} passing`);
