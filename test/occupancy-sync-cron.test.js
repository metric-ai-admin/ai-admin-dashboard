// The occupancy sync had no cron.
//
// leasing_occupancy was written only when somebody pressed Sync, and nobody
// had since 2026-10-02 — so on 2026-10-12 the Occupancy and Preleased figures
// going to owners were ten days old. It compounded: the Sunday 05:30 job
// copies that table into leasing_occupancy_history, so the row filed as "week
// ending 10/10" was made of 10/02 figures and was wrong per property by up to
// three units, with nothing in the table saying so.
//
// Neither half left an error anywhere. That is what these assertions are for.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('occupancy sync cron');

const AT = server.indexOf("cron.schedule('0 5 * * *'");
const CRON = AT < 0 ? '' : server.slice(AT, AT + 700);

t('the occupancy sync is on a schedule at all', () => {
  assert.ok(AT >= 0, 'there is no 05:00 cron');
  assert.ok(/callOwnRoute\('\/api\/leasing\/sync\/occupancy'/.test(CRON),
    'the 05:00 cron does not sync occupancy');
});

t('it runs BEFORE the Sunday snapshot, not after', () => {
  // THE ONE THAT MATTERS. The snapshot copies whatever the table holds. A
  // sync scheduled after it would leave the weekly history a day behind for
  // ever, which is a quieter version of the same bug.
  const snapAt = server.indexOf("cron.schedule('30 5 * * *'");
  assert.ok(snapAt > 0, 'the 05:30 snapshot cron is gone');
  assert.ok(AT < snapAt, 'the occupancy sync is registered after the snapshot');
  assert.ok(/'0 5 \* \* \*'/.test(CRON) , 'the sync must be at 05:00, not 05:30');
});

t('it is in Central, because Render is not', () => {
  // An unqualified '0 5 * * *' fires at midnight or 1 AM in Austin depending
  // on the season — and on a Sunday that is the wrong side of the snapshot.
  assert.ok(/timezone: LYNDSAY_TIMEZONE/.test(CRON),
    'without a timezone this drifts an hour twice a year');
});

t('it is its own job, so one failure does not cost the other', () => {
  assert.ok(!/leasingCronSync/.test(CRON), 'it was folded into the leasing sync');
  assert.ok(/\.catch\(/.test(CRON), 'a rejection would surface as an unhandled promise');
  assert.ok(/\[occupancy-sync\] FAILED/.test(CRON), 'a failure must be logged where the others are');
});

t('it goes through the route, which is where the rate limiting lives', () => {
  // appfolioReportsFetch retries 429 and the 5xx a limiter answers with,
  // honouring Retry-After. A second fetch path would not.
  assert.ok(/callOwnRoute\(/.test(CRON), 'it must not fetch AppFolio directly');
  const route = server.slice(server.indexOf("app.post('/api/leasing/sync/occupancy'"),
    server.indexOf("app.post('/api/leasing/sync/occupancy'") + 900);
  assert.ok(/appfolioReportsFetch\(APPFOLIO_OCC_REPORT/.test(route));
});

t('the minute is not shared with another AppFolio job', () => {
  // Stacking two syncs on the same minute is how a rate limit gets hit on a
  // schedule rather than by accident.
  const minutes = (server.match(/cron\.schedule\('0 5 \* \* \*'/g) || []).length;
  assert.strictEqual(minutes, 1, 'something else also fires at 05:00');
});

// ---- what the snapshot records about itself -------------------------------

console.log('\nthe snapshot says what day it was made of');
const W = server.slice(server.indexOf('async function captureOccupancySnapshot('),
  server.indexOf('async function leasingCronSync('));

t('source_as_of is written to the row, not only returned', () => {
  // It was already computed and returned into a log line. A log line is no
  // use a week later to somebody comparing two snapshots and wondering
  // whether the comparison means anything.
  assert.ok(/source_as_of: rowSourceAsOf/.test(W), 'the row does not carry its source date');
  assert.ok(/const rowSourceAsOf =/.test(W));
});

t('the stalest property wins when the sources disagree', () => {
  // A snapshot is only as current as its oldest row; taking the newest would
  // describe it more kindly than it deserves.
  assert.ok(/sourceAsOf\.length \? sourceAsOf\[0\] : null/.test(W),
    'sourceAsOf is sorted ascending, so [0] is the oldest');
});

t('a missing migration costs the description, not the week', () => {
  assert.ok(/source_as_of/.test(W) && /086_occupancy_history_source/.test(W),
    'it must name the migration a reader has to run');
  assert.ok(/payload\.map\(\(\{ source_as_of, \.\.\.rest \}\) => rest\)/.test(W),
    'without the retry a missing column would lose the week’s only snapshot');
});

t('migration 086 exists and adds the column', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '086_occupancy_history_source.sql'), 'utf8');
  assert.ok(/add column if not exists source_as_of date/.test(sql));
  assert.ok(/NOT RUN YET/.test(sql), 'a migration must say whether it has been run');
  assert.ok(/NULL means/.test(sql),
    'a null must not be readable as "fresh" — that is the whole failure being fixed');
});

t('the marking script changes no measurement and deletes nothing', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mark-occupancy-history.js'), 'utf8');
  assert.ok(!/\.delete\(/.test(s), 'it must not delete');
  assert.ok(/update\(\{ source_as_of: p\.want \}\)/.test(s),
    'it must set only the source date');
  assert.ok(/\.is\('source_as_of', null\)/.test(s),
    'a re-run must not overwrite a value somebody set deliberately');
  assert.ok(/--write/.test(s) && /DRY RUN/.test(s), 'it must default to a dry run');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
