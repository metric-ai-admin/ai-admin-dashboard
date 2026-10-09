// The Task Queue's date window, in Central.
//
// Katie reported "0 completed" for a week she had worked. The attribution was
// the main cause, but this window was a second one waiting: the bounds were
// written in UTC and "today" came from the server's clock, which on Render is
// UTC. Her reviews were stamped 18:0x Central — one hour later and they would
// have fallen outside a window that was supposed to contain them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WEEK = require('../lib/week.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('crm/completed dates');

// ---- the arithmetic --------------------------------------------------------

t('a Central evening belongs to that Central day, not the next UTC one', () => {
  // 2026-10-08 18:40 Central is 2026-10-08, and 23:40Z the same day.
  const review = new Date('2026-10-08T23:40:00.000Z');
  assert.strictEqual(WEEK.toChicagoYMD(review), '2026-10-08');
  const from = WEEK.chicagoStartOfDayISO('2026-10-08');
  const to = WEEK.chicagoStartOfDayISO(WEEK.addDaysYMD('2026-10-08', 1));
  assert.ok(review.toISOString() >= from && review.toISOString() < to,
    'a review logged at 18:40 Austin time must fall inside the 10/08 window');
});

t('the old UTC bound would have dropped it — which is the bug', () => {
  // 19:30 Central on the 8th is 00:30Z on the 9th, so the UTC window for 10/08
  // excluded it and the 10/09 window claimed it.
  const evening = new Date('2026-10-09T00:30:00.000Z');
  assert.strictEqual(WEEK.toChicagoYMD(evening), '2026-10-08');
  assert.ok(evening.toISOString() > '2026-10-08T23:59:59.999Z',
    'UTC put this evening in the wrong day');
  assert.ok(evening.toISOString() < WEEK.chicagoStartOfDayISO('2026-10-09'),
    'Central keeps it on the 8th, where the person who did the work would put it');
});

t('the upper bound is half-open, so the last millisecond is not lost', () => {
  const end = WEEK.chicagoStartOfDayISO(WEEK.addDaysYMD('2026-10-09', 1));
  const lastMoment = new Date(new Date(end).getTime() - 1).toISOString();
  assert.ok(lastMoment < end);
  assert.strictEqual(WEEK.toChicagoYMD(lastMoment), '2026-10-09');
});

t('the bound follows DST rather than assuming an offset', () => {
  // CDT in October, CST in December: -5 and -6. A hard-coded offset is wrong
  // for half the year, in whichever half you did not test.
  assert.strictEqual(WEEK.chicagoStartOfDayISO('2026-10-09'), '2026-10-09T05:00:00.000Z');
  assert.strictEqual(WEEK.chicagoStartOfDayISO('2026-12-09'), '2026-12-09T06:00:00.000Z');
});

// ---- the route uses it -----------------------------------------------------

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const at = SERVER.indexOf("app.get('/api/crm/completed'");
const route = SERVER.slice(at, at + 1800);

t('the route exists and is the one being tested', () => {
  assert.ok(at >= 0);
});

t('"today" is the Central date, not the server’s', () => {
  assert.ok(/WEEK\.toChicagoYMD\(new Date\(\)\)/.test(route),
    'the default upper bound must come from the Central clock');
  assert.ok(!/getFullYear\(\)/.test(route),
    'the hand-rolled local-time dstr() must be gone — on Render it was UTC');
});

t('the timestamp bounds are Central midnights', () => {
  assert.ok(/chicagoStartOfDayISO/.test(route), 'the bounds must use the Central midnight helper');
  assert.ok(!/T23:59:59\.999Z/.test(route), 'the UTC end-of-day string must be gone');
  assert.ok(!/T00:00:00\.000Z/.test(route), 'the UTC start-of-day string must be gone');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
