// The showings sync's date range.
//
// Without one the report answers with 24 rows — whatever AppFolio considers
// current — and every completed showing has already dropped out. That was the
// 18-against-26 gap on Katie's 09/27-10/03 sheet.
//
// The spelling is NOT interchangeable. Measured by the probe on 2026-10-08:
// showing_date_from / showing_date_to returned 499 rows over
// 2026-07-01..2026-11-07 with 26 in Katie's week; from_date/to_date,
// showing_time_from/_to and from/to were all ignored and matched the baseline
// exactly. An ignored parameter looks identical to one that works, which is
// what these assertions are for.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WEEK = require('../lib/week.js');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// The sync route only, so an assertion cannot be satisfied by the probe route
// further down the file — the probe legitimately names every wrong spelling.
const start = SERVER.indexOf("app.post('/api/leasing/sync/showings'");
const end = SERVER.indexOf("app.post('/api/leasing/sync/applications'");
assert.ok(start > 0 && end > start, 'could not isolate the showings sync route');
const ROUTE = SERVER.slice(start, end);
const CODE = ROUTE.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('showings date range');

t('the sync sends a date range at all', () => {
  assert.ok(/showing_date_from/.test(CODE), 'no showing_date_from in the sync');
  assert.ok(/showing_date_to/.test(CODE), 'no showing_date_to in the sync');
});

t('it is the ONLY spelling the sync sends', () => {
  for (const wrong of ['from_date:', 'to_date:', 'showing_time_from', 'showing_time_to']) {
    assert.ok(!CODE.includes(wrong), 'the sync still sends ' + wrong + ', which AppFolio ignores');
  }
});

t('there is no fallback call — a second attempt with an ignored spelling '
  + 'would widen nothing and look like it had', () => {
  const fetches = CODE.match(/appfolioReportsFetch\(/g) || [];
  assert.strictEqual(fetches.length, 1, 'expected exactly one fetch, found ' + fetches.length);
  assert.ok(!/catch\s*\(e\)\s*{[\s\S]*appfolioReportsFetch/.test(CODE), 'a retry survives in the catch');
  assert.ok(!/dateFilter/.test(CODE), 'the dateFilter reporting field outlived the fallback it described');
});

t('the window is 90 days back and 60 forward, off the CENTRAL day', () => {
  assert.ok(/WEEK\.addDaysYMD\(today, -90\)/.test(CODE));
  assert.ok(/WEEK\.addDaysYMD\(today, 60\)/.test(CODE));
  assert.ok(/WEEK\.toChicagoYMD\(new Date\(\)\)/.test(CODE),
    'the window must come off the Central day, not UTC');
});

t('that window actually covers the week Katie reported', () => {
  // The point of 90 back: a week we are still reconciling must never sit near
  // the edge of the window.
  const today = '2026-10-08';
  const from = WEEK.addDaysYMD(today, -90);
  const to = WEEK.addDaysYMD(today, 60);
  assert.ok(from <= '2026-09-27', 'window starts after Katie week: ' + from);
  assert.ok(to >= '2026-10-03', 'window ends before Katie week: ' + to);
  // And with real room to spare at both ends.
  assert.strictEqual(from, '2026-07-10');
  assert.strictEqual(to, '2026-12-07');
});

t('the body can still override the range for a one-off backfill', () => {
  assert.ok(/req\.body && req\.body\.from_date/.test(CODE));
  assert.ok(/req\.body && req\.body\.to_date/.test(CODE));
});

t('the response says which window it used', () => {
  assert.ok(/showing_date_from, showing_date_to, timestamp/.test(CODE));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
