// The six early-morning feeds, and the date the comparison prints.
//
// leasing_applications and leasing_lease_history were last written 2026-10-02
// and are where the KPI report gets Converting, Renewals and Did Not Renew. So
// on the Monday the report was compared against Katie's workbook, three of the
// tables behind it were ten days old and nothing said so.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const kpiBuild = require('../lib/kpi-build.js');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('early feeds cron');

const AT = server.indexOf('const EARLY_FEEDS = [');
const BLOCK = AT < 0 ? '' : server.slice(AT, server.indexOf("cron.schedule('30 5 * * *'"));
// [minute, 'label'] pairs, read out of the table itself.
const SCHEDULE = [...BLOCK.matchAll(/\[(\d+),\s*'([a-z_-]+)'/g)].map(m => [Number(m[1]), m[2]]);

t('all six feeds are scheduled', () => {
  assert.ok(AT >= 0, 'the EARLY_FEEDS table is gone');
  const want = ['applications', 'lease-history', 'showings',
    'unit_vacancy', 'rent_roll', 'lease_expiration_detail'];
  assert.deepStrictEqual(SCHEDULE.map(s => s[1]), want);
});

t('they are staggered, never two on the same minute', () => {
  const minutes = SCHEDULE.map(s => s[0]);
  assert.strictEqual(new Set(minutes).size, minutes.length, 'two feeds share a minute');
  const sorted = [...minutes].sort((a, b) => a - b);
  assert.deepStrictEqual(minutes, sorted, 'the table is out of order — it is read by people too');
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 5,
      'only ' + (sorted[i] - sorted[i - 1]) + ' minutes between two AppFolio jobs');
  }
});

t('nothing is scheduled on the 05:30 minute that is already taken', () => {
  // 05:30 runs the leasing guest-card sync and both weekly snapshots.
  assert.ok(!SCHEDULE.some(s => s[0] === 30), 'a feed collides with the 05:30 block');
  assert.ok(!SCHEDULE.some(s => s[0] === 0), 'a feed collides with the 05:00 occupancy sync');
});

t('unit_vacancy lands BEFORE the snapshot that reads its store', () => {
  // THE ONE THAT MATTERS HERE. captureUnitVacancySnapshot reads the saved
  // report rather than fetching, so the weekly unit-vacancy history was frozen
  // in exactly the way the occupancy history was.
  const uv = SCHEDULE.find(s => s[1] === 'unit_vacancy');
  assert.ok(uv, 'unit_vacancy is not scheduled');
  assert.ok(uv[0] < 30, 'unit_vacancy syncs at :' + uv[0] + ', after the 05:30 snapshot reads it');
  const W = server.slice(server.indexOf('async function captureUnitVacancySnapshot('),
    server.indexOf('async function captureUnitVacancySnapshot(') + 900);
  assert.ok(/readReportData\('unit_vacancy'\)/.test(W),
    'the snapshot no longer reads the store — this ordering may no longer be the point');
});

t('every feed finishes well before the 8 AM reports', () => {
  assert.ok(Math.max(...SCHEDULE.map(s => s[0])) < 60, 'a feed is scheduled past the hour');
  assert.ok(/\$\{minute\} 5 \* \* \*/.test(BLOCK), 'the feeds are not all in the 5 AM hour');
});

t('each is its own cron, and a failure is logged not swallowed', () => {
  assert.ok(/EARLY_FEEDS\.forEach/.test(BLOCK), 'one sweep means one failure takes the rest');
  assert.ok(/\[early-sync\] \$\{label\} FAILED/.test(BLOCK));
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(BLOCK),
    'without a timezone these drift an hour twice a year, across the 05:30 boundary');
});

// ---- the date the comparison shows ----------------------------------------

console.log('\nthe comparison says what day our occupancy is from');
const F = kpiBuild.occupancyFreshness;

t('it reports the day and how far it is from the week', () => {
  const f = F([{ property_name: 'Sunset Palms', as_of: '2026-10-10', synced_at: '2026-10-10T10:00:00Z' }], '2026-10-10');
  assert.strictEqual(f.as_of, '2026-10-10');
  assert.strictEqual(f.matchesWeek, true);
  assert.strictEqual(f.daysBehind, 0);
  assert.strictEqual(f.staleForWeek, false);
});

t('the stalest property decides, not the freshest', () => {
  const f = F([
    { property_name: 'A', as_of: '2026-10-10' },
    { property_name: 'B', as_of: '2026-10-02' },
  ], '2026-10-10');
  assert.strictEqual(f.as_of, '2026-10-02');
  assert.strictEqual(f.daysBehind, 8);
  assert.strictEqual(f.staleForWeek, true);
});

t('a property the report does not cover cannot raise a false alarm', () => {
  // The sync upserts and never deletes, so The Sidney's 2026-09-16 row is
  // still there after it went into cession. Counting it made a freshly synced
  // report claim to be 24 days behind — on the one panel whose job is to tell
  // a date problem from a real difference.
  const f = F([
    { property_name: 'Sunset Palms', as_of: '2026-10-12' },
    { property_name: 'The Sidney', as_of: '2026-09-16' },
  ], '2026-10-10');
  assert.strictEqual(f.as_of, '2026-10-12');
  assert.strictEqual(f.daysBehind, -2);
});

t('data from AFTER her week is a mismatch too, and says which way', () => {
  const f = F([{ property_name: 'A', as_of: '2026-10-12' }], '2026-10-10');
  assert.strictEqual(f.matchesWeek, false);
  assert.strictEqual(f.staleForWeek, false, 'it is not stale — it is ahead');
  assert.ok(f.daysBehind < 0, 'the sign must say which direction');
});

t('no rows is null, not "fine"', () => {
  const f = F([], '2026-10-10');
  assert.strictEqual(f.as_of, null);
  assert.strictEqual(f.matchesWeek, null);
  assert.strictEqual(f.staleForWeek, null);
});

t('the compare route carries it to the panel', () => {
  const at = server.indexOf("app.post('/api/kpi/compare'");
  const route = server.slice(at, server.indexOf('// The KPI exports.'));
  assert.ok(/freshness: report\.freshness/.test(route), 'the panel is never sent the date');
});

t('the panel prints it, and warns either direction', () => {
  const at = app.indexOf('function kcFreshness');
  assert.ok(at >= 0, 'kcFreshness is gone');
  const fn = app.slice(at, app.indexOf('function kcRender'));
  // The words are built around a pluralised ${n}, so match the tail.
  assert.ok(/before<\/b>/.test(fn) && /after<\/b>/.test(fn),
    'it must say which way the dates differ');
  assert.ok(/carries no date/.test(fn), 'a missing date must be stated, not assumed fine');
  assert.ok(/kcEsc\(f\.as_of\)/.test(fn), 'the date reaches the page unescaped');
  assert.ok(/freshness \+ gaps/.test(app), 'it is computed but never rendered');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
