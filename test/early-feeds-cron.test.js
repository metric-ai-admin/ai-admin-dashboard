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
//
// AND THE HOUR, which used to be implicit. Every entry ran in the 05:00 hour
// until unit_turn_detail needed a slot on 2026-10-26 and that hour had none
// left, so an entry may now carry a trailing hour that defaults to 5. The
// checks below compare ABSOLUTE times: with a 04:45 entry in the table,
// comparing bare minutes would read it as the last feed of the morning rather
// than the first, and the stagger gap between it and 05:05 as -40.
// Line by line: each entry is one line, and a multiline regex over the whole
// block silently swallowed one of them when the trailing-hour form appeared.
const SCHEDULE = BLOCK.split('\n')
  .map(line => {
    const head = line.match(/^\s*\[(\d+),\s*'([a-z_-]+)'/);
    if (!head) return null;
    const tail = line.match(/,\s*(\d+)\s*\],?\s*$/);
    return [Number(head[1]), head[2], tail ? Number(tail[1]) : 5];
  })
  .filter(Boolean);
const absMinutes = s => s[2] * 60 + s[0];

t('all eleven early feeds are scheduled, in time order', () => {
  assert.ok(AT >= 0, 'the EARLY_FEEDS table is gone');
  // unit_turn_detail joined on 2026-10-26. It had been in MORNING_FEEDS since
  // 10/13 with nothing syncing it before 06:00, so the brief reported it as a
  // failed sync on twelve consecutive mornings — see
  // test/morning-feeds-covered.test.js, which asserts the rule rather than
  // this list.
  const want = ['unit_turn_detail', 'applications', 'lease-history', 'showings',
    'unit_vacancy', 'rent_roll', 'lease_expiration_detail',
    'tenant_tickler', 'work_order_labor_summary', 'occupancy_custom_fields',
    'delinquency_kpi'];
  assert.deepStrictEqual(SCHEDULE.map(s => s[1]), want);
});

t('all four Monday Brief sources are scheduled together', () => {
  // Three of these were scheduled and tenant_tickler was held back for a day.
  // A brief built from three fresh feeds and one from whenever somebody last
  // pressed Sync All mixes days inside one document, which is harder to spot
  // than all four being equally old.
  const brief = ['tenant_tickler', 'unit_vacancy', 'rent_roll', 'lease_expiration_detail'];
  const have = SCHEDULE.map(s => s[1]);
  brief.forEach(f => assert.ok(have.includes(f), f + ' feeds the Monday Brief but is on no schedule'));
});

t('they are staggered, never two on the same minute', () => {
  const times = SCHEDULE.map(absMinutes);
  assert.strictEqual(new Set(times).size, times.length, 'two feeds share a minute');
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepStrictEqual(times, sorted, 'the table is out of order — it is read by people too');
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 5,
      'only ' + (sorted[i] - sorted[i - 1]) + ' minutes between two AppFolio jobs');
  }
});

t('a feed outside the 05:00 hour still clears the jobs around it', () => {
  // 04:00 (deposit snapshot) and 04:30 (collections MTD) both pull AppFolio
  // through appfolio-reports, so an entry placed in the 04:00 hour has to keep
  // the same five-minute discipline against them as it would against its
  // siblings here.
  const OTHER_APPFOLIO = [4 * 60 + 0, 4 * 60 + 30, 5 * 60 + 0, 5 * 60 + 30];
  const tooClose = SCHEDULE
    .map(s => ({ label: s[1], at: absMinutes(s) }))
    .filter(x => OTHER_APPFOLIO.some(o => Math.abs(x.at - o) < 5));
  assert.deepStrictEqual(tooClose.map(x => x.label), [],
    'these run within five minutes of another AppFolio job: '
    + tooClose.map(x => x.label).join(', '));
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

t('delinquency lands before the 06:00 brief reads it', () => {
  // Kara's brief reports rather than syncs, so whatever it finds on disk at
  // 06:00 is what she sees. A delinquency pull at or after 06:00 would put
  // yesterday evening's figure on her page every morning.
  const dq = SCHEDULE.find(s => s[1] === 'delinquency_kpi');
  assert.ok(dq, 'delinquency_kpi is not in the morning block');
  assert.ok(dq[0] <= 55, 'it runs at :' + dq[0] + ', too late for a 06:00 brief');
});

t('every feed finishes well before the 8 AM reports', () => {
  // "They are all in the 5 AM hour" was the check until unit_turn_detail moved
  // to 04:45, which it had to: the 05:00 hour had no slot left that kept both
  // the five-minute spacing and clear of the two unlimited pulls. So the
  // window is asserted on the real times instead of on the template.
  assert.ok(Math.max(...SCHEDULE.map(s => s[0])) < 60, 'a feed is scheduled past the hour');
  assert.ok(Math.max(...SCHEDULE.map(absMinutes)) < 8 * 60,
    'a feed runs at or after 08:00, when the reports already want what it writes');
  assert.ok(Math.min(...SCHEDULE.map(absMinutes)) >= 4 * 60,
    'a feed runs before 04:00 — outside the window this block is paced for');
  assert.ok(/\$\{minute\} \$\{hour\} \* \* \*/.test(BLOCK),
    'the schedule template no longer honours a per-entry hour');
});

t('each is its own cron, and a failure is logged not swallowed', () => {
  assert.ok(/EARLY_FEEDS\.forEach/.test(BLOCK), 'one sweep means one failure takes the rest');
  assert.ok(/\[early-sync\] \$\{label\} FAILED/.test(BLOCK));
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(BLOCK),
    'without a timezone these drift an hour twice a year, across the 05:30 boundary');
});

// ---- the Command Center feeds ---------------------------------------------

const MAT = server.indexOf('const MAINT_FEEDS = [');
const MBLOCK = MAT < 0 ? '' : server.slice(MAT, MAT + 900);
const MSCHED = [...MBLOCK.matchAll(/\[(\d+),\s*'([a-z-]+)'\]/g)].map(m => [Number(m[1]), m[2]]);

t('the five Command Center feeds are scheduled', () => {
  assert.ok(MAT >= 0, 'the MAINT_FEEDS table is gone');
  assert.deepStrictEqual(MSCHED.map(m => m[1]),
    ['inspections', 'billable', 'labor', 'inventory', 'custom-fields']);
});

t('they run AFTER the 06:00 work-order sync, staggered', () => {
  assert.ok(/\$\{minute\} 6 \* \* \*/.test(MBLOCK), 'they are not in the 6 AM hour');
  const mins = MSCHED.map(m => m[0]);
  assert.ok(Math.min(...mins) >= 5, 'something runs on the 06:00 minute the WO sync holds');
  assert.ok(Math.max(...mins) <= 25, 'a feed runs later than agreed');
  const sorted = [...mins].sort((a, b) => a - b);
  assert.deepStrictEqual(mins, sorted);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 5, 'two AppFolio jobs less than five minutes apart');
  }
});

t('custom-fields is last, because it is the heaviest pull', () => {
  // 24,000 rows. Ahead of the others it would put the slowest job in front of
  // the board Erick opens on.
  assert.strictEqual(MSCHED[MSCHED.length - 1][1], 'custom-fields');
});

t('each is its own cron and names itself when it fails', () => {
  assert.ok(/MAINT_FEEDS\.forEach/.test(MBLOCK));
  assert.ok(/\[maint-sync\] \$\{name\} FAILED/.test(MBLOCK));
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(MBLOCK));
});

t('every scheduled maintenance feed is a route that exists', () => {
  // The table builds its path by string concatenation, so a typo here is a
  // 404 at 6 AM that nobody is awake to see.
  MSCHED.forEach(([, name]) => assert.ok(
    server.includes("app.post('/api/maintenance/sync/" + name + "'"),
    '/api/maintenance/sync/' + name + ' is scheduled but not registered'));
});

t('no two AppFolio jobs share a minute across the two blocks', () => {
  // Keyed on the entry's real hour: with a 04:45 feed in the table, '5:' + 45
  // would claim it runs at 05:45 and collide with work_order_labor_summary.
  const all = SCHEDULE.map(s => s[2] + ':' + s[0]).concat(MSCHED.map(m => '6:' + m[0]));
  all.push('5:0', '5:30', '6:0');   // occupancy, the leasing block, the WO sync
  assert.strictEqual(new Set(all).size, all.length, 'two jobs collide');
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
