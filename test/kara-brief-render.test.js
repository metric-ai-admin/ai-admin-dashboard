// The brief, RENDERED END TO END against stubs.
//
// WHY THIS FILE EXISTS. test/kara-brief.test.js checked the pieces and read
// server.js as text to confirm the right calls were written down. All of it
// passed while the route threw "AFP is not defined" on its first real call:
// the gather referenced a module required in kpi-build.js and never in
// server.js.
//
// A test that reads code cannot find an undefined identifier. Only running it
// can. So this one runs the whole path — gather, build, render — with every
// external dependency stubbed, and fails the build if any of it throws.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/kara-brief-gather.js');
const K = require('../lib/kara-brief.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// ---- stubs, shaped like the real things ------------------------------------

const NOW = new Date('2026-10-13T14:00:00Z');   // 09:00 Central
const TODAY = '2026-10-13';

const card = (metric, value) => ({ metric, value, source: 'appfolio' });
const column = m => ([
  { key: 'occupancy', cards: Object.entries(m).map(([k, v]) => card(k, v)) },
]);

function reportStub(over) {
  const wh = { units: 72, occupied: 40, occPct: 40 / 72, vacantRented: 2, notices: 0,
    moveIns: 0, moveOuts: 1, dqTotal: 6293.79 };
  const hp = { units: 48, occupied: 44, occPct: 44 / 48, vacantRented: 1, notices: 1,
    moveIns: 2, moveOuts: 0, dqTotal: 2760.36 };
  return Object.assign({
    week_ending: '2026-10-10',
    columns: ['Hyde Park Square', 'Windy Hill Apartment', 'Round Rock', 'Greystone', 'Portfolio'],
    properties: { 'Windy Hill Apartment': column(wh), 'Hyde Park Square': column(hp) },
    portfolio: column({ units: 397, occupied: 279, occPct: 279 / 397, vacantRented: 4,
      notices: 10, moveIns: 2, moveOuts: 1, dqTotal: 64479.44 }),
    rentable: {
      'Windy Hill Apartment': {
        rentableUnits: 49, rentableOccupied: 40, rentablePct: 40 / 49,
        rules: [{ label: 'Building 3', prefix: '3', reason: 'no certificate of occupancy' }],
      },
    },
    freshness: { as_of: TODAY },
    gaps: [],
  }, over || {});
}

function deps(over) {
  const o = over || {};
  return Object.assign({
    now: NOW,
    db: {
      from: () => ({
        select: () => Promise.resolve({ data: [{ property: '*', delinquency_over: 5000,
          make_ready_days: 7, application_days: 3 }], error: null }),
      }),
    },
    selectAll: () => Promise.resolve([
      // standing, 9 days old
      { property_name: 'Windy Hill Apartment', status: 'Decision Pending', application_date: '2026-10-04' },
      // carried through to a lease — not pending
      { property_name: 'Windy Hill Apartment', status: 'Approved', detailed_status: 'Converting', application_date: '2026-10-01' },
      { property_name: 'Hyde Park Square', status: 'Decision Pending', application_date: '2026-10-12' },
    ]),
    buildKpiReport: () => Promise.resolve(reportStub(o.report)),
    readReportData: id => Promise.resolve(
      id === 'unit_turn_detail'
        ? { fetchedAt: TODAY + 'T10:30:00Z', rows: [
          // vacant today, 14 days — a real make-ready
          { property_name: 'Windy Hill Apartment', unit: '101', move_out_date: '2026-09-29', turn_end_date: '' },
          // vacant today, 2 days — also real
          { property_name: 'Windy Hill Apartment', unit: '102', move_out_date: '2026-10-11', turn_end_date: '' },
          // 490 days — a record, whatever the rent roll says
          { property_name: 'Windy Hill Apartment', unit: '103', move_out_date: '2025-06-10', turn_end_date: '' },
          // 8 days but somebody lives there — the turn finished, the record did not
          { property_name: 'Hyde Park Square', unit: '201', move_out_date: '2026-10-05', turn_end_date: '' },
          // finished properly
          { property_name: 'Hyde Park Square', unit: '202', move_out_date: '2026-09-01', turn_end_date: '2026-09-20' },
        ] }
        : id === 'rent_roll'
          ? { fetchedAt: TODAY + 'T10:30:00Z', rows: [
            { property_name: 'Windy Hill Apartment', unit: '101', status: 'Vacant-Unrented', rent: '1400' },
            { property_name: 'Windy Hill Apartment', unit: '102', status: 'Vacant-Unrented', rent: '1400' },
            { property_name: 'Windy Hill Apartment', unit: '103', status: 'Current', rent: '1400' },
            { property_name: 'Hyde Park Square', unit: '201', status: 'Current', rent: '1600' },
            { property_name: 'Hyde Park Square', unit: '202', status: 'Current', rent: '1600' },
          ] }
          : { fetchedAt: TODAY + 'T10:30:00Z', rows: [] }),
    goalPctFor: name => (name === 'Windy Hill Apartment' ? 0.90 : 0.85),
  }, o.deps || {});
}

console.log('kara brief, rendered end to end');

(async () => {
  // ---- the whole path ------------------------------------------------------

  await ta('gather, build and render run without throwing', async () => {
    // THE TEST THAT WAS MISSING. "AFP is not defined" was a route with a full
    // suite of passing tests behind it.
    const data = await G.gather(deps());
    const brief = K.build(data);
    const text = K.render(brief, {});
    assert.ok(text.length > 400, 'the brief came out empty');
  });

  await ta('every property on the report reaches the brief', async () => {
    const data = await G.gather(deps());
    assert.deepStrictEqual(data.properties.map(p => p.name).sort(),
      ['Hyde Park Square', 'Windy Hill Apartment']);
    // Round Rock and Greystone are roll-ups, not properties.
    assert.ok(!data.properties.some(p => /Round Rock|Greystone|Portfolio/.test(p.name)));
  });

  await ta('the numbers arrive where the labels say they do', async () => {
    const data = await G.gather(deps());
    const wh = data.properties.find(p => p.name === 'Windy Hill Apartment');
    assert.strictEqual(wh.units, 72);
    assert.strictEqual(wh.occupied, 40);
    assert.strictEqual(wh.preleased, 2, 'signed, not moved in');
    assert.strictEqual(wh.delinquency, 6293.79);
    assert.strictEqual(wh.rentableUnits, 49);
    assert.strictEqual(wh.goalPct, 0.90);
  });

  await ta('pending applications use the KPI rule, and the oldest is the oldest', async () => {
    const data = await G.gather(deps());
    const wh = data.properties.find(p => p.name === 'Windy Hill Apartment');
    assert.strictEqual(wh.applicationsPending, 1, 'the Converting one is not pending');
    assert.strictEqual(wh.applicationOldestDays, 9);
  });

  await ta('a make-ready counts only on a unit that is vacant today', async () => {
    const data = await G.gather(deps());
    const wh = data.properties.find(p => p.name === 'Windy Hill Apartment');
    assert.strictEqual(wh.makeReadyOpen, 2, '101 and 102 are vacant');
    assert.strictEqual(wh.makeReadyOldestDays, 14);
    assert.strictEqual(wh.staleMakeReadies, 1, '103 is 490 days old');
    assert.strictEqual(wh.staleMakeReadyOldest, 490);

    const hp = data.properties.find(p => p.name === 'Hyde Park Square');
    assert.strictEqual(hp.makeReadyOpen, 0,
      '201 is 8 days old but somebody lives there — the turn finished, the record did not');
    assert.strictEqual(hp.staleMakeReadies, 1);
    assert.strictEqual(hp.makeReadyOldestDays, null);
  });

  await ta('the rendered brief puts the right property in red, for the right reasons', async () => {
    const data = await G.gather(deps());
    const brief = K.build(data);
    assert.deepStrictEqual(brief.red.map(p => p.name), ['Windy Hill Apartment']);
    const text = K.render(brief, {});
    assert.ok(/occupancy 55\.6% against a 90\.0% goal/.test(text));
    assert.ok(/delinquency \$6,294 over \$5,000/.test(text));
    assert.ok(/a make-ready open 14 days \(over 7\)/.test(text));
    assert.ok(/an application pending 9 days \(over 3\)/.test(text));
    assert.ok(/Rentable occupancy\s+40\/49/.test(text));
  });

  // ---- freshness, which is the whole first block ---------------------------

  await ta('a feed synced this morning is not an alarm', async () => {
    const text = K.render(K.build(await G.gather(deps())), {});
    assert.ok(!/DID NOT RUN/.test(text), 'everything synced today and it still cried wolf');
  });

  await ta('a feed that missed this morning IS an alarm, and is named', async () => {
    const d = deps();
    d.readReportData = id => Promise.resolve(id === 'delinquency_kpi'
      ? { fetchedAt: '2026-10-12T22:45:00Z', rows: [] }
      : { fetchedAt: TODAY + 'T10:30:00Z', rows: [] });
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/DID NOT RUN/.test(text));
    assert.ok(/delinquency_kpi/.test(text));
    assert.ok(/not this morning/.test(text));
  });

  await ta('a store that is not there says so rather than passing', async () => {
    const d = deps();
    d.readReportData = () => Promise.resolve(null);
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/no data on disk/.test(text));
  });

  await ta('occupancy synced yesterday is an alarm too', async () => {
    const d = deps({ report: { freshness: { as_of: '2026-10-12' } } });
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/DID NOT RUN/.test(text));
    assert.ok(/occupancy/.test(text));
  });

  // ---- it degrades rather than throwing ------------------------------------

  await ta('no thresholds table — the brief still goes out', async () => {
    const d = deps();
    d.db = { from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'no table' } }) }) };
    const data = await G.gather(d);
    const text = K.render(K.build(data), {});
    assert.ok(/NEEDS ATTENTION/.test(text), 'it fell over without its settings');
  });

  await ta('a report with no properties renders an empty but honest brief', async () => {
    const d = deps({ report: { columns: ['Portfolio'], properties: {}, rentable: {} } });
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/NEEDS ATTENTION — none/.test(text));
  });

  await ta('a throwing store costs that line, not the brief', async () => {
    const d = deps();
    d.readReportData = () => Promise.reject(new Error('disk gone'));
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/no data on disk/.test(text));
  });

  // ---- records, not work ---------------------------------------------------

  await ta('a stale record never puts a property in red', async () => {
    // THE WHOLE POINT. Ascent came back with 40 "open make-readies", the
    // oldest 490 days, and seven of eight properties went red on the first
    // morning. A report that is all red is one nobody opens twice.
    const data = await G.gather(deps());
    const brief = K.build(data);
    // Windy Hill DOES have a real one — unit 101, vacant, 14 days — so the
    // flag is expected. What must not happen is the 490-day record driving it.
    const wh = brief.properties.find(p => p.name === 'Windy Hill Apartment');
    const mrFlag = wh.flags.find(f => f.kind === 'make_ready');
    assert.ok(mrFlag, 'the real 14-day make-ready stopped raising a flag');
    assert.ok(/14 days/.test(mrFlag.text), 'the flag reads: ' + mrFlag.text);
    assert.ok(!/490/.test(mrFlag.text), 'the 490-day record is driving the flag');

    // Hyde Park's only open turn is on an occupied unit, so it has none.
    const hp = brief.properties.find(p => p.name === 'Hyde Park Square');
    assert.deepStrictEqual(hp.flags.filter(f => f.kind === 'make_ready'), [],
      'an occupied unit raised a make-ready flag');
  });

  await ta('an application pending past the cutoff is a record, not a decision', async () => {
    const d = deps();
    d.selectAll = () => Promise.resolve([
      { property_name: 'Windy Hill Apartment', status: 'Decision Pending', application_date: '2026-07-16' },
      { property_name: 'Windy Hill Apartment', status: 'Decision Pending', application_date: '2026-10-09' },
    ]);
    const data = await G.gather(d);
    const wh = data.properties.find(p => p.name === 'Windy Hill Apartment');
    assert.strictEqual(wh.applicationsPending, 1, 'the 89-day one is not pending');
    assert.strictEqual(wh.applicationOldestDays, 4);
    assert.strictEqual(wh.staleApplications, 1);
    assert.strictEqual(wh.staleApplicationOldest, 89);
    // The 4-day one is over the 3-day threshold, so a flag is expected — from
    // IT, not from the 89-day record.
    const flags = K.flagsFor(wh, K.thresholdsFor(wh.name, data.thresholds));
    const apFlag = flags.find(f => f.kind === 'applications');
    assert.ok(apFlag && /4 days/.test(apFlag.text), 'the flag reads: ' + (apFlag && apFlag.text));
    assert.ok(!/89/.test(apFlag.text), 'the 89-day record is driving the flag');
  });

  await ta('the records section lists them, with counts and the oldest', async () => {
    const text = K.render(K.build(await G.gather(deps())), {});
    assert.ok(/RECORDS TO CLEAN UP IN APPFOLIO/.test(text));
    assert.ok(/Windy Hill Apartment\s+1 unit turn \(oldest 490d\)/.test(text));
    assert.ok(/Hyde Park Square\s+1 unit turn \(oldest 8d\)/.test(text));
  });

  await ta('nothing stale means no section at all', async () => {
    const d = deps();
    d.readReportData = id => Promise.resolve({ fetchedAt: TODAY + 'T10:30:00Z', rows: [] });
    d.selectAll = () => Promise.resolve([]);
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(!/RECORDS TO CLEAN UP/.test(text), 'an empty section is noise');
  });

  await ta('delinquency shows a share of rent beside the dollars', async () => {
    // Kara may prefer a relative threshold once she can see both. BESIDE, not
    // instead: the dollar figure is what the $5,000 threshold is set against.
    const text = K.render(K.build(await G.gather(deps())), {});
    assert.ok(/\$6,294/.test(text), 'the dollars are gone');
    // Three units at $1,400 on the stub rent roll.
    assert.ok(/% of \$4,200 monthly rent/.test(text), 'the share is missing');
  });

  await ta('no rent roll means no share, and the dollars still print', async () => {
    const d = deps();
    d.readReportData = id => Promise.resolve(id === 'rent_roll'
      ? { fetchedAt: TODAY + 'T10:30:00Z', rows: [] }
      : { fetchedAt: TODAY + 'T10:30:00Z', rows: [] });
    const text = K.render(K.build(await G.gather(d)), {});
    assert.ok(/\$6,294/.test(text));
    assert.ok(!/monthly rent/.test(text), 'it invented a share with no rent to divide by');
  });

  // ---- the route is reachable from the Render shell ------------------------

  t('the test route takes the API key, like the other admin routes', () => {
    // requireAuth has no session to find in a shell, which is where this is
    // run from. Same fault the reconcile route had.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const at = server.indexOf("app.post('/api/brief/kara/test'");
    assert.ok(at > 0);
    const line = server.slice(at, server.indexOf('\n', at));
    assert.ok(/requireMetricAdmin/.test(line), 'it still demands a browser session');
    assert.ok(!/requireAuth/.test(line));
  });

  t('and it still names exactly one recipient', () => {
    // Changing who may CALL the route must not change where the mail goes.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const at = server.indexOf("app.post('/api/brief/kara/test'");
    const end = server.indexOf('});', server.indexOf('catch (err)', at));
    const sends = [...server.slice(at, end).matchAll(/briefSendMail\(([^,]+),/g)].map(m => m[1].trim());
    assert.deepStrictEqual(sends, ['KARA_BRIEF_TEST_TO']);
  });

  t('server.js no longer references AFP at all', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!/\bAFP\./.test(server), 'the undefined identifier is back');
  });

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
