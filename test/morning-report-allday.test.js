// All-day events in the Morning Report: which DAYS does one appear on?
//
// Graph returns Lyndsay's all-day events as naive midnight-to-midnight stamps
// labelled UTC. They are floating dates — "the 28th" — not instants, and the
// first version ran them through the Central-time converter, which turned
// midnight UTC into 7pm the evening before and shifted the whole event a day
// early at BOTH ends: "Appfolio Future Conference" (09/28–10/01 exclusive)
// showed up on Sunday the 27th and had disappeared by Wednesday the 30th.
//
// The predicate is pulled out of the shipped source rather than copied, for the
// same reason as test/leasing-week.test.js: a copy here would pass while the
// real report stayed wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function block(startMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, 'server.js no longer contains: ' + startMarker);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + startMarker);
}

// The helper, and the shipped `if (m.allDay) { … }` branch verbatim. The branch
// answers by returning false, so a wrapper that reaches the end means "shows".
const helper = block('const allDayYMD = (iso) =>');
const branch = block('      if (m.allDay) {');
assert.ok(/allDayYMD\(m\.startIso\)/.test(branch), 'the all-day branch no longer uses allDayYMD');
assert.ok(!/ctDateOf\(m\.(start|end)Iso\)[\s\S]{0,40}allDay/.test(branch),
  'the all-day branch converts to Central again');

// eslint-disable-next-line no-new-func
const shows = new Function('m', 'todayCT', `${helper}\n${branch}\nreturn true;`);

// Graph hands these over after normalizeGraphDateTime has appended the Z.
const CONFERENCE = { allDay: true, startIso: '2026-09-28T00:00:00.0000000Z', endIso: '2026-10-01T00:00:00.0000000Z' };
const SAN_DIEGO  = { allDay: true, startIso: '2026-09-25T00:00:00.0000000Z', endIso: '2026-10-01T00:00:00.0000000Z' };

const days = (from, to) => { const out = []; const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out; };

function expect(ev, label, from, to, want) {
  days(from, to).forEach(day => {
    const got = shows(ev, day);
    assert.strictEqual(got, want.includes(day),
      `${label} on ${day}: shows=${got}, expected=${want.includes(day)}`);
  });
}

console.log('the real events Lyndsay has on her calendar');
t('Appfolio Future Conference shows on 28, 29 and 30 — not the 27, not the 1st', () => {
  expect(CONFERENCE, 'conference', '2026-09-26', '2026-10-02',
    ['2026-09-28', '2026-09-29', '2026-09-30']);
});
t('San Diego Trip shows every day from the 25th to the 30th', () => {
  expect(SAN_DIEGO, 'san diego', '2026-09-23', '2026-10-02',
    ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
});
t('the exclusive end is respected: the last day is end minus one', () => {
  assert.strictEqual(shows(CONFERENCE, '2026-09-30'), true);
  assert.strictEqual(shows(CONFERENCE, '2026-10-01'), false);
});
t('midnight UTC is NOT read as the previous Central evening', () => {
  // The whole bug in one line: 2026-09-28T00:00:00Z is 2026-09-27 19:00 CT.
  assert.strictEqual(shows(CONFERENCE, '2026-09-27'), false);
});

console.log('\nshorter and stranger spans');
t('a one-day event ends the next day and shows on exactly one day', () => {
  const e = { allDay: true, startIso: '2026-09-29T00:00:00Z', endIso: '2026-09-30T00:00:00Z' };
  expect(e, 'one-day', '2026-09-27', '2026-10-01', ['2026-09-29']);
});
t('no end at all falls back to the start day only', () => {
  const e = { allDay: true, startIso: '2026-09-29T00:00:00Z', endIso: null };
  expect(e, 'no end', '2026-09-27', '2026-10-01', ['2026-09-29']);
});
t('an end that is not after the start is treated as one day, not as nothing', () => {
  const e = { allDay: true, startIso: '2026-09-29T00:00:00Z', endIso: '2026-09-29T00:00:00Z' };
  expect(e, 'degenerate', '2026-09-27', '2026-10-01', ['2026-09-29']);
});
t('a span crossing the DST change keeps whole calendar days', () => {
  // 2026-11-01 is the US fall-back; an offset-based comparison drifts here.
  const e = { allDay: true, startIso: '2026-10-30T00:00:00Z', endIso: '2026-11-03T00:00:00Z' };
  expect(e, 'dst', '2026-10-29', '2026-11-04',
    ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});
t('a span crossing the new year is not confused by the rollover', () => {
  const e = { allDay: true, startIso: '2026-12-30T00:00:00Z', endIso: '2027-01-02T00:00:00Z' };
  expect(e, 'new year', '2026-12-29', '2027-01-03',
    ['2026-12-30', '2026-12-31', '2027-01-01']);
});
t('a garbled start drops the event rather than showing it every day', () => {
  ['', null, 'tomorrow'].forEach(v => {
    assert.strictEqual(shows({ allDay: true, startIso: v, endIso: '2026-10-01T00:00:00Z' }, '2026-09-29'),
      false, String(v));
  });
});
t('an offset-bearing stamp is read by its own date, not shifted', () => {
  // If Graph ever returns a real offset, the date written is still the date.
  const e = { allDay: true, startIso: '2026-09-28T00:00:00-05:00', endIso: '2026-10-01T00:00:00-05:00' };
  expect(e, 'offset', '2026-09-26', '2026-10-02',
    ['2026-09-28', '2026-09-29', '2026-09-30']);
});

console.log(`\n${pass} passing`);
