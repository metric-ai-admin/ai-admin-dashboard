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
    readReportData: id => Promise.resolve(id === 'unit_turn_detail'
      ? { fetchedAt: TODAY + 'T10:30:00Z', rows: [
        { property_name: 'Windy Hill Apartment', move_out_date: '2026-09-29', turn_end_date: '' },
        { property_name: 'Windy Hill Apartment', move_out_date: '2026-10-11', turn_end_date: '' },
        { property_name: 'Hyde Park Square', move_out_date: '2026-09-01', turn_end_date: '2026-09-20' },
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

  await ta('an open make-ready is one with no end date, aged from the move-out', async () => {
    const data = await G.gather(deps());
    const wh = data.properties.find(p => p.name === 'Windy Hill Apartment');
    assert.strictEqual(wh.makeReadyOpen, 2);
    assert.strictEqual(wh.makeReadyOldestDays, 14);
    const hp = data.properties.find(p => p.name === 'Hyde Park Square');
    assert.strictEqual(hp.makeReadyOpen, 0, 'a finished turn is not open');
    assert.strictEqual(hp.makeReadyOldestDays, null, 'and has no age');
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
