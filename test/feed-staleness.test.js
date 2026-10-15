// Rows an AppFolio report has stopped returning.
//
// THE SHAPE OF THE PROBLEM. Every one of these syncs UPSERTS what the report
// returns and never revisits what it does not. A row that leaves the report
// keeps its last known values for ever and reads exactly like a current one.
//
// It bit twice. Work orders: a sync that only asks for open ones left closed
// ones frozen as open, 436 on Erick's board where 95 were real — fixed with a
// third state, "Unknown — not in feed". Then leases: a future move-in dated
// 2026-11-10 on a row last seen 2026-10-02, which Kara's brief counted as a
// real arrival and raised a data conflict over. 51 of 82 rows were stale.
//
// THE PART THAT IS EASY TO GET WRONG is who should filter. A reader
// describing the PRESENT must drop stale rows. A reader counting what
// HAPPENED in a closed week must not: the report only returns recent and
// active leases, so an old completed move-in leaves the feed as a matter of
// course, and filtering would have taken the week ending 2026-09-05 from 12
// move-ins to 0.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('feed staleness');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const gather = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'kara-brief-gather.js'), 'utf8');

// ---- the sync marks what it did not see -------------------------------------

t('the lease sync marks rows the report stopped returning', () => {
  assert.match(server, /markMissingFromFeed\('leasing_lease_history'/);
  assert.match(server, /r.in_feed = true/, 'and flags the ones it did see');
  assert.match(server, /last_seen_at = now/);
});

t('nothing is deleted', () => {
  const fn = server.slice(server.indexOf('async function markMissingFromFeed'),
    server.indexOf('// Log raw report size'));
  assert.ok(!/\.delete\(/.test(fn),
    'a lease that left the report is still the best record of what it was');
  assert.match(fn, /in_feed: false/);
});

t('an EMPTY report marks nothing', () => {
  // An AppFolio outage, a bad filter or an auth failure returns zero rows.
  // Marking everything out of feed would empty the present for every reader
  // at once, and would look like a day on which nothing exists rather than a
  // day on which the sync failed.
  const fn = server.slice(server.indexOf('async function markMissingFromFeed'),
    server.indexOf('// Log raw report size'));
  assert.match(fn, /if \(!keys\.length\)/);
  const guard = fn.slice(fn.indexOf('if (!keys.length)'), fn.indexOf('const db ='));
  assert.match(guard, /return 0/, 'it returns before touching the table');
});

t('the marking runs AFTER the upsert', () => {
  // Marking first would mean a failed sync left the whole table flagged out
  // of feed.
  const route = server.slice(server.indexOf("// POST /api/leasing/sync/lease-history"));
  const block = route.slice(0, route.indexOf('res.json'));
  assert.ok(block.indexOf('leasingSyncUpsert') < block.indexOf('markMissingFromFeed'));
});

t('rows already out of feed keep the date they really left', () => {
  // Otherwise last_seen_at creeps forward every night and "last seen" stops
  // meaning anything.
  const fn = server.slice(server.indexOf('async function markMissingFromFeed'),
    server.indexOf('// Log raw report size'));
  assert.match(fn, /in_feed\.is\.null,in_feed\.is\.true/,
    'only rows currently in the feed are touched');
});

// ---- who filters and who must not -------------------------------------------

t('the brief filters on in_feed — it describes the future', () => {
  assert.match(gather, /in_feed !== false/);
  assert.match(gather, /staleLeaseFutureMoveIns/);
});

t('a MISSING in_feed column does not empty the projection', () => {
  // Reading in_feed before migration 100 yields undefined for every row,
  // which under a plain truthiness test marks the whole table stale. A column
  // that is missing must not look like a column that says no.
  assert.match(gather, /const hasFlag = \(rows \|\| \[\]\)\.some\(r => r\.in_feed === true \|\| r\.in_feed === false\)/);
  // lastIndexOf for the end marker: `let staleLeaseRows = 0` is declared near
  // the top of gather(), long before this block, so indexOf would hand back
  // an empty slice and every assertion on it would fail for the wrong reason.
  const block = gather.slice(gather.indexOf('const hasFlag'),
    gather.lastIndexOf('staleLeaseRows ='));
  assert.ok(block.length > 0, 'the block was actually found');
  assert.match(block, /const fresh = hasFlag\s*\?/,
    'and falls back to synced_at when it is absent');
  assert.match(block, /clean\(r\.synced_at\)\.slice\(0, 10\) === newest/,
    'the fallback is the newest-sync comparison');
});

t('the KPI, Goal Board and Monday Brief readers are NOT filtered, on purpose', () => {
  // Measured 2026-10-15: filtering would have taken the week ending 09-05
  // from 12 move-ins to 0 and 09-26 from 12 to 1. Those move-ins happened.
  const readers = [...server.matchAll(/from\('leasing_lease_history'\)\s*\.?\s*\n?\s*\.select\([^)]*\)/g)];
  assert.ok(readers.length >= 3, 'the three historical readers are still there');
  readers.forEach(m => {
    const after = server.slice(m.index, m.index + 400);
    assert.ok(!/in_feed/.test(after),
      'a past-week reader must not filter on in_feed: ' + m[0].slice(0, 60));
  });
  // And the reason is written down where the next person will meet it.
  assert.match(server, /NOT FILTERED ON in_feed, deliberately/);
  assert.match(server, /week\s*\n?\s*\/\/ ending 09-05 would have gone from 12 move-ins to 0/);
});

t('the two other historical readers point at the explanation', () => {
  const notes = server.match(/Past weeks: not filtered on in_feed\. See the note at the KPI reader\./g);
  assert.strictEqual((notes || []).length, 2);
});

// ---- the migration ----------------------------------------------------------

t('the backfill is exact rather than a guess', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '100_lease_history_last_seen.sql'), 'utf8');
  // synced_at was only ever written when the row was seen, so it IS the
  // last-seen date for every existing row.
  assert.match(sql, /set last_seen_at = synced_at/);
  assert.match(sql, /add column if not exists in_feed boolean/);
  assert.ok(!/delete from/i.test(sql), 'nothing is deleted');
});

t('asking for in_feed before the migration does not lose the query', () => {
  // Selecting a column that does not exist fails the WHOLE select, and the
  // catch around the move-in lookup would have turned that into "no dated
  // move-in source" — the projection silently back to counting departures
  // only, with a banner saying so. The preview caught it; the fallback is a
  // second select without the column.
  const block = gather.slice(gather.indexOf('const BASE ='),
    gather.indexOf('// THE UNIT IS NOT IN THIS TABLE'));
  assert.ok(block.length > 0, 'the block was found');
  assert.match(block, /\.catch\(/, 'a failed select is retried');
  assert.match(block, /no in_feed/, 'and the retry drops the column');
  assert.ok(block.indexOf("select(BASE + ',in_feed')") < block.indexOf('select(BASE)'),
    'the column is tried first');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
