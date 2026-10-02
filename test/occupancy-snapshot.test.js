// The weekly occupancy snapshot.
//
// leasing_occupancy is overwritten by its own sync, so the only way to answer
// "occupancy as of Saturday" later is to have written it down at the time. The
// one thing that must not go wrong is the DATE: a row filed under the wrong
// Saturday is worse than no row, because it looks like an answer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// eslint-disable-next-line no-new-func
const occSnapshotAsOf = new Function(
  server.slice(server.indexOf('function occSnapshotAsOf('),
    server.indexOf('// Reads leasing_occupancy and writes'))
  + 'return occSnapshotAsOf;')();

console.log('which Saturday a run describes');
t('a Sunday run files the Saturday that just ended', () => {
  // The whole design: run the morning after the week closes, file it under the
  // closed week. 2026-10-04 is a Sunday.
  assert.strictEqual(occSnapshotAsOf('2026-10-04'), '2026-10-03');
  assert.strictEqual(occSnapshotAsOf('2026-09-27'), '2026-09-26');
});
t('as_of is never the day the writer ran', () => {
  // Filing on the write date would put every week one day late, and the KPI
  // report asking for 09/26 would find 09/27.
  ['2026-09-27', '2026-10-04', '2026-10-11'].forEach(d =>
    assert.notStrictEqual(occSnapshotAsOf(d), d, `${d} filed itself under its own date`));
});
t('every answer is a Saturday, whatever day it is asked on', () => {
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10);
    const got = occSnapshotAsOf(d);
    assert.strictEqual(new Date(got + 'T00:00:00Z').getUTCDay(), 6,
      `${d} -> ${got}, which is not a Saturday`);
    assert.ok(got < d, `${d} -> ${got} is not in the past`);
  }
});
t('a manual run mid-week still captures the week that closed', () => {
  // Tuesday 2026-09-29 -> Saturday 2026-09-26, not the Saturday ahead.
  assert.strictEqual(occSnapshotAsOf('2026-09-29'), '2026-09-26');
  assert.strictEqual(occSnapshotAsOf('2026-10-02'), '2026-09-26');
  // Saturday itself -> the PREVIOUS Saturday, because today is not over.
  assert.strictEqual(occSnapshotAsOf('2026-10-03'), '2026-09-26');
});
t('it refuses a date it cannot read rather than guessing', () => {
  assert.throws(() => occSnapshotAsOf('not-a-date'), /YYYY-MM-DD/);
  assert.throws(() => occSnapshotAsOf(''), /YYYY-MM-DD/);
});

console.log('\nhow it is wired into the cron');
const CRON = server.slice(server.indexOf("cron.schedule('30 5 * * *'"),
  server.indexOf("cron.schedule('30 5 * * *'") + 1200);
t('it runs on Sundays only', () => {
  assert.ok(/getUTCDay\(\) === 0/.test(CRON), 'the Sunday guard is gone — it would run daily');
  assert.ok(/const satur = occSnapshotAsOf\(todayCT\);/.test(CRON),
    'the capture does not derive its date from today');
  assert.ok(/captureOccupancySnapshot\(satur\)/.test(CRON));
});
t('it captures BEFORE the sync overwrites the source', () => {
  // leasingCronSync replaces leasing_occupancy. Snapshotting after it would
  // record today's numbers under Saturday's date.
  const snapAt = CRON.indexOf('captureOccupancySnapshot');
  const syncAt = CRON.indexOf('leasingCronSync()');
  assert.ok(snapAt > 0 && syncAt > 0 && snapAt < syncAt,
    'the snapshot runs after the sync, so it would capture the wrong day');
});
t('a failed snapshot cannot take the leasing sync down', () => {
  assert.ok(/\[occ-snapshot\] FAILED/.test(CRON), 'the capture has no catch');
  const block = CRON.slice(CRON.indexOf('captureOccupancySnapshot'), CRON.indexOf('leasingCronSync()'));
  assert.ok(/\.catch\(/.test(block), 'a rejection would surface as an unhandled promise');
});
t('the day is read in Central, not in UTC', () => {
  // Render runs UTC. At 5:30 AM Central on a Sunday it is already Sunday in
  // UTC, but the guard still has to be asked in the business timezone.
  assert.ok(/WEEK\.toChicagoYMD/.test(CRON), 'the cron reads the day off a UTC clock');
});

console.log('\nwhat the writer records');
const W = server.slice(server.indexOf('async function captureOccupancySnapshot('),
  server.indexOf('async function leasingCronSync('));
t('it writes to the history table, never back to leasing_occupancy', () => {
  assert.ok(/from\(OCC_SNAPSHOT_TABLE\)/.test(W), 'it does not write to the history table');
  assert.ok(!/from\('leasing_occupancy'\)[\s\S]{0,80}upsert/.test(W),
    'it writes back into the snapshot table it reads from');
});
t('a re-run corrects the row instead of doubling the portfolio', () => {
  assert.ok(/onConflict: 'as_of,property_name'/.test(W),
    'without the conflict target a second run doubles every property');
});
t('it stores units and occupied, not only the ratio', () => {
  // The portfolio percentage is sum(occupied)/sum(units). Storing only the
  // per-property ratio would force a later average, which is a different and
  // wrong number.
  ['total_units', 'occupied_units', 'occupancy_pct'].forEach(f =>
    assert.ok(new RegExp(f + ':').test(W), `${f} is not recorded`));
});
t('it says when the source was from another day', () => {
  // leasing_occupancy carries its own as_of. If that is not the Saturday being
  // filed, the row is numbers from a different day under a Saturday label.
  assert.ok(/sourceAsOf/.test(W), 'the source date is not recorded');
  assert.ok(/stale/.test(W), 'nothing flags a snapshot taken from stale numbers');
});
t('a missing table is reported, not thrown', () => {
  assert.ok(/072_leasing_occupancy_history\.sql/.test(W),
    'a missing table gives no hint about which migration to run');
});

console.log('\nthe unit_vacancy snapshot');
// unit_vacancy.last_move_out is the only source we have for weekly move-outs,
// and the report drops a unit as soon as it is re-rented — so the week it
// emptied has to be written down while it is still on the report.
const UV = server.slice(server.indexOf('async function captureUnitVacancySnapshot('),
  server.indexOf('async function leasingCronSync('));

t('both snapshots share one Saturday', () => {
  // Deriving it twice could disagree at a DST boundary and file the two halves
  // of one week under different days.
  assert.ok(/captureUnitVacancySnapshot\(satur\)/.test(CRON),
    'the unit_vacancy capture is missing or uses its own date');
});
t('a failure in one does not cost the other', () => {
  // Two promises, not a chain. If occupancy throws, the move-outs still get
  // recorded — and this is the week they would otherwise be lost for.
  const i = CRON.indexOf('captureOccupancySnapshot(satur)');
  const j = CRON.indexOf('captureUnitVacancySnapshot(satur)');
  assert.ok(i > 0 && j > i);
  assert.ok(/\[uv-snapshot\] FAILED/.test(CRON), 'the unit_vacancy capture has no catch');
});
t('it reads the stored report, never triggers a fresh sync', () => {
  // A Sunday-morning snapshot should record what the week ended with; a sync
  // here would cost a round trip and race the one that runs next.
  assert.ok(/readReportData\('unit_vacancy'\)/.test(UV), 'it does not read the saved report');
  assert.ok(!/syncReport|appfolioReportsFetch/.test(UV), 'it triggers a sync of its own');
});
t('it de-duplicates by unit before writing', () => {
  // The table is unique on (as_of, property, unit), and a duplicate inside one
  // batch fails the WHOLE upsert rather than one row — losing the week.
  assert.ok(/seen\.has\(key\)/.test(UV), 'a repeated unit would break the whole batch');
  assert.ok(/onConflict: 'as_of,property_name,unit'/.test(UV), 'a re-run would duplicate the week');
});
t('it reports how many move-outs it captured for that week', () => {
  // For 2026-09-26 this should read 3: Ascent 5-127, Hyde Park 107,
  // iConic Round Rock 106 — the three in Lyndsay's box score.
  assert.ok(/moveOutsThatWeek/.test(UV), 'the log says nothing about what was captured');
  assert.ok(/WEEK\.addDaysYMD\(asOf, -6\)/.test(UV), 'the week window is not the Sunday before asOf');
});
t('only real dates are stored in last_move_out', () => {
  // It is the column the whole table exists for; a malformed value kept as a
  // string would make a week silently uncountable.
  assert.ok(/ymd = v =>/.test(UV), 'dates are not validated');
  assert.ok(/last_move_out: ymd\(r\.last_move_out\)/.test(UV));
});
t('a missing table names its migration instead of throwing', () => {
  assert.ok(/074_unit_vacancy_history\.sql/.test(UV));
});

console.log('\nnothing user-facing changed');
t('no route, no tab, no UI reads any of this', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/leasing_occupancy_history|occ-snapshot/.test(app + html),
    'the browser now references the snapshot');
  assert.ok(!/app\.(get|post)\([^)]*occupancy-snapshot/.test(server), 'a route was added');
});

console.log(`\n${pass} passing`);
