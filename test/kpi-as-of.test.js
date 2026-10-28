// The dates on the KPI report: what day the figures describe.
//
// Three things ship together here and they fail in the same way — a number
// with no date beside it reads as current. The occupancy line already
// existed; delinquency had no date anywhere, and neither export had one at
// all, which is how the 2026-10-28 reconciliation spent its first hour
// treating a two-day gap as a disagreement about money.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const K = require('../lib/kpi-build.js');
const SLOT = require('../lib/sync-slot.js');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Strip comments first. Every phrase below appears in prose somewhere in
// these files, and an assertion that matches a comment proves nothing.
const code = s => s.replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('delinquency freshness');

t('a balance pulled after the week is not the week', () => {
  const f = K.delinquencyFreshness('2026-10-28T13:04:02.602Z', '2026-10-24');
  assert.strictEqual(f.as_of, '2026-10-28');
  assert.strictEqual(f.matchesWeek, false);
  assert.strictEqual(f.staleForWeek, true);
});

t('it says the feed has no week at all', () => {
  // Not the same claim as "stale". A sync would not fix this: the figure for
  // a past week does not exist and never did.
  assert.strictEqual(K.delinquencyFreshness('2026-10-28T13:04:02Z', '2026-10-24').pointInTimeOnly, true);
});

t('a pull ON the week ending matches', () => {
  const f = K.delinquencyFreshness('2026-10-24T05:00:00Z', '2026-10-24');
  assert.strictEqual(f.matchesWeek, true);
  assert.strictEqual(f.staleForWeek, false);
});

t('no fetch date is null, not a verdict', () => {
  // "We do not know" and "it is fine" are different answers and only one of
  // them is safe to render quietly.
  const f = K.delinquencyFreshness(null, '2026-10-24');
  assert.strictEqual(f.as_of, null);
  assert.strictEqual(f.matchesWeek, null);
  assert.strictEqual(f.staleForWeek, null);
});

console.log('\nthe footer both exports print');

const WEEK = '2026-10-24';
const offReport = {
  week_ending: WEEK,
  freshness: { as_of: '2026-10-26', matchesWeek: false },
  delinquencyFreshness: K.delinquencyFreshness('2026-10-28T13:04:02Z', WEEK),
};

t('it names both sources and both dates', () => {
  const lines = K.asOfLines(offReport);
  assert.strictEqual(lines.length, 2, JSON.stringify(lines));
  assert.ok(/Occupancy[^.]*as of 2026-10-26/.test(lines[0]), lines[0]);
  assert.ok(/Delinquency is as of 2026-10-28/.test(lines[1]), lines[1]);
});

t('it says WHICH WAY a date is wrong, not just that it differs', () => {
  const lines = K.asOfLines(offReport);
  assert.ok(/not the week ending 2026-10-24/.test(lines[0]));
  assert.ok(/keeps no history/.test(lines[1]),
    'the delinquency line does not explain that a past-week figure does not exist');
});

t('a matching week says so plainly and raises nothing', () => {
  const lines = K.asOfLines({
    week_ending: WEEK,
    freshness: { as_of: WEEK, matchesWeek: true },
    delinquencyFreshness: K.delinquencyFreshness(WEEK + 'T05:00:00Z', WEEK),
  });
  assert.ok(lines.every(l => !/not the week/.test(l)), JSON.stringify(lines));
});

t('nothing known prints nothing — never "as of null"', () => {
  assert.deepStrictEqual(K.asOfLines({ week_ending: WEEK }), []);
  assert.deepStrictEqual(K.asOfLines({}), []);
  assert.deepStrictEqual(K.asOfLines(null), []);
  assert.deepStrictEqual(K.asOfLines({
    week_ending: WEEK, delinquencyFreshness: K.delinquencyFreshness(null, WEEK),
  }), []);
  // A freshness OBJECT that knows no date is the dangerous shape: the key is
  // present, so a truthiness test passes and the footer prints "as of
  // undefined" on a report going to an owner.
  assert.deepStrictEqual(K.asOfLines({
    week_ending: WEEK,
    freshness: { as_of: null, matchesWeek: null },
    delinquencyFreshness: { as_of: null, matchesWeek: null },
  }), []);
});

t('the PDF prints it, and cannot lose it to a missing dep', () => {
  const pdf = code(read('lib/kpi-pdf.js'));
  assert.ok(/require\('\.\/kpi-build\.js'\)/.test(pdf), 'asOfLines is not required directly');
  assert.ok(/asOfLines\(report\)/.test(pdf), 'the footer is never built');
  assert.ok(!/deps\.asOfLines/.test(pdf),
    'it is back on deps — a caller that forgets it drops the footer silently');
  assert.ok(/pdfSafe\(line\)/.test(pdf), 'the footer bypasses pdfSafe');
});

t('the Excel prints the SAME sentences', () => {
  const server = code(read('server.js'));
  assert.ok(/kpiBuild\.asOfLines\(report\)/.test(server), 'the workbook builds its own wording');
});

t('the screen prints it too', () => {
  const app = code(read('public/app.js'));
  assert.ok(/krReport\.delinquencyFreshness/.test(app), 'the page shows money with no date');
  assert.ok(/Delinquency is as of/.test(app));
});

t('the report carries the delinquency date at all', () => {
  const build = code(read('lib/kpi-build.js'));
  assert.ok(/delinquencyFreshness: delinquencyFreshness\(/.test(build), 'it is never put on the report');
  // THE VALUE, not just the assignment. `fetchedAt = null` also matches a
  // test that only looks for the field being set, and the report would carry
  // the key with nothing in it — which renders as no footer at all.
  assert.ok(/freshness\[id\]\.fetchedAt = \(data && data\.fetchedAt\) \|\| null;/.test(build),
    'refreshIfStale does not record the store fetch date it read');
});

console.log('\nthe sync slot');

// 2026-10-28 12:00 UTC is 07:00 CT — past the 05:00 and 05:30 slots.
const NOON_UTC = Date.parse('2026-10-28T12:00:00Z');
const TZ = 'America/Chicago';

t('a process that was up when the slot passed, and wrote nothing, missed it', () => {
  const s = SLOT.missedSlotState({
    startedAt: Date.parse('2026-10-27T12:00:00Z'), now: NOON_UTC,
    hour: 5, minute: 0, timezone: TZ,
  });
  assert.strictEqual(s.missedItsSlot, true);
  assert.ok(/05:00 run did not happen/.test(s.error), s.error);
});

t('a process deployed after the slot has not missed anything', () => {
  // The case that matters on a deploy day: this must not cry wolf.
  const s = SLOT.missedSlotState({
    startedAt: Date.parse('2026-10-28T11:00:00Z'), now: NOON_UTC,
    hour: 5, minute: 0, timezone: TZ,
  });
  assert.strictEqual(s.missedItsSlot, false);
  assert.strictEqual(s.error, null, 'a healthy deploy reports an error');
});

t('the slot is Central, not UTC', () => {
  // Render runs UTC. 05:00 CT is 10:00 or 11:00 UTC depending on the season,
  // and a fixed offset breaks twice a year — at 05:00, which is when every
  // one of these jobs runs.
  const last = SLOT.lastSlot(5, 0, TZ, NOON_UTC);
  assert.strictEqual(last.toISOString(), '2026-10-28T10:00:00.000Z');
  // In January the same wall-clock hour is an hour later in UTC.
  const winter = SLOT.lastSlot(5, 0, TZ, Date.parse('2026-01-15T18:00:00Z'));
  assert.strictEqual(winter.toISOString(), '2026-01-15T11:00:00.000Z');
});

t('before the slot arrives today, yesterday\'s is the one judged', () => {
  // 08:00 UTC on 10-28 is 03:00 CT — today's 05:00 has not come round.
  const last = SLOT.lastSlot(5, 0, TZ, Date.parse('2026-10-28T08:00:00Z'));
  assert.strictEqual(last.toISOString(), '2026-10-27T10:00:00.000Z');
});

t('the label names the schedule it is about', () => {
  const a = SLOT.missedSlotState({ startedAt: 0, now: NOON_UTC, hour: 5, minute: 0, timezone: TZ });
  const b = SLOT.missedSlotState({ startedAt: 0, now: NOON_UTC, hour: 5, minute: 30, timezone: TZ });
  assert.ok(/05:00/.test(a.error) && /05:30/.test(b.error),
    'both syncs report the same time and a reader cannot tell which broke');
});

console.log('\nthe occupancy sync alert');

const SERVER = code(read('server.js'));

t('the cron records state on success as well as failure', () => {
  // A file that only appears when something breaks cannot tell "ran fine"
  // from "never ran".
  const cron = SERVER.slice(SERVER.indexOf("callOwnRoute('/api/leasing/sync/occupancy'"));
  const block = cron.slice(0, cron.indexOf('async function writeOccupancySyncState'));
  assert.ok(/\.then\(async r => \{[\s\S]*writeOccupancySyncState/.test(block), 'success writes nothing');
  assert.ok(/\.catch\(async err => \{[\s\S]*writeOccupancySyncState/.test(block), 'failure writes nothing');
});

t('recording the state cannot break the sync', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function writeOccupancySyncState'));
  assert.ok(/try \{[\s\S]{0,200}catch/.test(fn.slice(0, 400)), 'an unwritable disk would reject the cron');
});

t('the EOD reads it, and both syncs ask the same question', () => {
  assert.ok(/readJSON\(OCCUPANCY_SYNC_STATE, null\)/.test(SERVER), 'the EOD never reads the state');
  const uses = SERVER.match(/SYNC_SLOT\.missedSlotState\(/g) || [];
  assert.strictEqual(uses.length, 2, 'expected the leasing and occupancy syncs to share the helper');
  assert.ok(!/setHours\(5, 30, 0, 0\)/.test(SERVER), 'the inlined 05:30 slot maths is back');
});

t('"has not run yet" is not rendered as a failure', () => {
  // Printing it in red sent an EOD that looked broken on the day the cron
  // shipped — the same mistake, once, is enough.
  const sec = SERVER.slice(SERVER.indexOf('const os = S.occupancySync;'));
  const block = sec.slice(0, sec.indexOf("P.push(eodSectionHtml('🔄'"));
  assert.ok(/!os\.at && !os\.missedItsSlot[\s\S]{0,200}EOD\.muted/.test(block),
    'a first run is announced in red');
  assert.ok(/os\.error[\s\S]{0,120}eodErr\(/.test(block), 'a real failure is not red');
});

t('a day-old sync is an alarm, and says why it matters', () => {
  const sec = SERVER.slice(SERVER.indexOf('const os = S.occupancySync;'));
  assert.ok(/osStale[\s\S]{0,400}eodErr\(/.test(sec), 'a stalled cron is reported quietly');
  assert.ok(/occupancy history will be written from stale figures/.test(read('server.js')),
    'the consequence is not stated');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
