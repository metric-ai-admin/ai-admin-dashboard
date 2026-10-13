// Kara's 6 AM brief.
//
// She asked for numbers and no graphics, every property and the portfolio,
// red ones first, each red saying which threshold it broke. And the first
// line has to say how old the data is: a brief that arrives at 6 AM with
// yesterday's occupancy and says nothing is worse than one that does not
// arrive, because she would act on it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kara-brief.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const prop = (over) => Object.assign({
  name: 'X', units: 100, occupied: 90, occupancyPct: 0.90, goalPct: 0.85,
  preleased: 2, applicationsPending: 1, applicationOldestDays: 1,
  makeReadyOpen: 0, makeReadyOldestDays: null,
  moveInsExpected: 1, moveOutsExpected: 0, notices: 1, delinquency: 1000,
}, over || {});
const THRESH = [{ property: '*', delinquency_over: 5000, make_ready_days: 7, application_days: 3 }];

console.log('kara brief');

// ---- thresholds ------------------------------------------------------------

t('a property row beats the default, which beats the built-in', () => {
  const rows = [
    { property: '*', delinquency_over: 5000, make_ready_days: 7, application_days: 3 },
    { property: 'Windy Hill Apartment', delinquency_over: 12000 },
  ];
  const wh = K.thresholdsFor('Windy Hill Apartment', rows);
  assert.strictEqual(wh.delinquency_over, 12000, 'its own number');
  assert.strictEqual(wh.make_ready_days, 7, 'inherited from the default row');
  const other = K.thresholdsFor('Hyde Park Square', rows);
  assert.strictEqual(other.delinquency_over, 5000);
});

t('no table at all falls back to the built-in defaults', () => {
  // The brief must still go out the morning before migration 088 is run.
  const t0 = K.thresholdsFor('X', []);
  assert.strictEqual(t0.delinquency_over, K.DEFAULTS.delinquency_over);
  assert.strictEqual(t0.source, 'built-in');
});

t('the proposed defaults are the ones agreed', () => {
  assert.deepStrictEqual(K.DEFAULTS, { delinquency_over: 5000, make_ready_days: 7, application_days: 3 });
});

t('the property name is matched regardless of case', () => {
  const rows = [{ property: 'windy hill apartment', delinquency_over: 999 }];
  assert.strictEqual(K.thresholdsFor('Windy Hill Apartment', rows).delinquency_over, 999);
});

// ---- what goes red ---------------------------------------------------------

t('each threshold raises its own flag, and says the numbers', () => {
  const p = prop({
    occupancyPct: 0.556, goalPct: 0.90, delinquency: 6293.79,
    makeReadyOldestDays: 14, applicationOldestDays: 9,
  });
  const f = K.flagsFor(p, K.thresholdsFor('X', THRESH));
  assert.deepStrictEqual(f.map(x => x.kind).sort(),
    ['applications', 'delinquency', 'make_ready', 'occupancy']);
  const text = f.map(x => x.text).join(' | ');
  assert.ok(/55\.6% against a 90\.0% goal/.test(text), 'occupancy must name both numbers');
  assert.ok(/\$6,294 over \$5,000/.test(text));
  assert.ok(/14 days \(over 7\)/.test(text));
  assert.ok(/9 days \(over 3\)/.test(text));
});

t('exactly at the threshold is NOT red', () => {
  // ">" not ">=". A property sitting exactly on the line every week would be
  // red every week, and a flag that is always on is one nobody reads.
  const p = prop({ delinquency: 5000, makeReadyOldestDays: 7, applicationOldestDays: 3 });
  assert.deepStrictEqual(K.flagsFor(p, K.thresholdsFor('X', THRESH)), []);
});

t('occupancy exactly at goal is not red', () => {
  assert.deepStrictEqual(K.flagsFor(prop({ occupancyPct: 0.85, goalPct: 0.85 }), K.thresholdsFor('X', THRESH)), []);
});

t('a missing number raises nothing, rather than reading as zero', () => {
  // A property whose delinquency could not be computed must not be reported
  // as $0 and therefore fine, nor as red.
  const p = prop({ delinquency: null, occupancyPct: null, makeReadyOldestDays: null, applicationOldestDays: null });
  assert.deepStrictEqual(K.flagsFor(p, K.thresholdsFor('X', THRESH)), []);
});

// ---- ordering --------------------------------------------------------------

t('red properties come first, worst first', () => {
  const b = K.build({
    thresholds: THRESH,
    properties: [
      prop({ name: 'Fine' }),
      prop({ name: 'OneFlag', delinquency: 9000 }),
      prop({ name: 'ThreeFlags', delinquency: 9000, makeReadyOldestDays: 20, applicationOldestDays: 10 }),
    ],
  });
  assert.deepStrictEqual(b.properties.map(p => p.name), ['ThreeFlags', 'OneFlag', 'Fine']);
  assert.strictEqual(b.red.length, 2);
  assert.strictEqual(b.ok.length, 1);
});

t('every property appears, red or not', () => {
  // "Red ones first" is an ordering, not a filter: she asked for each property
  // AND the total.
  const b = K.build({ thresholds: THRESH, properties: [prop({ name: 'A' }), prop({ name: 'B' })] });
  assert.strictEqual(b.properties.length, 2);
});

// ---- the rendering ---------------------------------------------------------

const RENDER = K.render(K.build({
  thresholds: THRESH,
  properties: [
    prop({ name: 'Windy Hill Apartment', occupancyPct: 0.556, goalPct: 0.90, delinquency: 6293.79,
      rentableUnits: 49, rentableOccupied: 40, rentableOccupancyPct: 40 / 49, rentableNote: 'excludes Building 3' }),
    prop({ name: 'Hyde Park Square' }),
  ],
  portfolio: { units: 397, occupied: 279, occupancyPct: 279 / 397, preleased: 4,
    applicationsPending: 12, makeReadyOpen: 3, moveInsExpected: 2, moveOutsExpected: 1,
    notices: 10, delinquency: 64479.44 },
  freshness: { asOf: '2026-10-13 (Central)', lines: [{ source: 'occupancy', ok: true, when: 'as of 2026-10-13' }] },
}), {});

t('the first line is the age of the data', () => {
  const first = RENDER.split('\n').find(l => /DATA AS OF/.test(l));
  assert.ok(first, 'there is no freshness line');
  assert.ok(RENDER.indexOf('DATA AS OF') < RENDER.indexOf('NEEDS ATTENTION'),
    'it comes after the numbers, where it reads as a footnote');
});

t('a failed sync is shouted about, not footnoted', () => {
  const r = K.render(K.build({
    thresholds: THRESH, properties: [prop()],
    freshness: { asOf: 'today', lines: [{ source: 'delinquency_kpi', ok: false, note: 'refresh failed' }] },
  }), {});
  assert.ok(/DID NOT RUN/.test(r));
  assert.ok(/older than they look/.test(r), 'it must say what that means for the numbers');
  assert.ok(/delinquency_kpi/.test(r), 'and which source');
});

t('no freshness at all is stated, not assumed fine', () => {
  const r = K.render(K.build({ thresholds: THRESH, properties: [prop()] }), {});
  assert.ok(/not recorded/.test(r) && /unverified/.test(r));
});

t('every field Kara asked for is on the page', () => {
  ['Occupancy', 'Rentable occupancy', 'Preleased', 'Applications pending',
    'Make-readies open', 'Move-ins this week', 'Move-outs this week', 'Notices',
    'Delinquency', 'PORTFOLIO TOTAL'].forEach(label =>
    assert.ok(RENDER.includes(label), 'missing: ' + label));
});

t('the rentable line appears ONLY where a building is excluded', () => {
  // Everywhere else it would be the same number twice, which teaches people
  // to skip the line.
  const blocks = RENDER.split('  Hyde Park Square');
  assert.ok(/Rentable occupancy/.test(blocks[0]), 'Windy Hill has no rentable line');
  assert.ok(!/Rentable occupancy/.test(blocks[1]), 'Hyde Park has one and should not');
});

t('a red property lists its reasons above its numbers', () => {
  const i = RENDER.indexOf('Windy Hill Apartment');
  const block = RENDER.slice(i, i + 400);
  assert.ok(block.indexOf('>> occupancy') < block.indexOf('Occupancy  '),
    'the reasons come after the numbers');
});

t('no graphics, no HTML, no emoji — she asked for old school', () => {
  assert.ok(!/<[a-z]/i.test(RENDER), 'there is markup in the body');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(RENDER), 'there is an emoji');
});

t('the test copy says it is a test', () => {
  const r = K.render(K.build({ thresholds: THRESH, properties: [prop()] }), { testMode: true });
  assert.ok(/\[TEST — not sent to Kara\]/.test(r));
});

// ---- the wiring ------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('it sends to NOBODY until the address is set', () => {
  // THE ONE THAT MATTERS BEFORE LAUNCH. A report reaching a VP before anybody
  // has read one is how a wrong number becomes a decision.
  assert.ok(/KARA_BRIEF_TO = \(process\.env\.KARA_BRIEF_TO \|\| ''\)/.test(server),
    'the recipient list is not empty by default');
  // Anchored on THIS cron's own body, not on the hour: there are two crons at
  // 06:00 and lastIndexOf found the other one, so the first version of this
  // test passed and failed for reasons that had nothing to do with the brief.
  const at = server.indexOf('karaBriefRender({})');
  assert.ok(at > 0, 'the 06:00 brief cron is gone');
  const cron = server.slice(at, at + 900);
  assert.ok(/if \(!KARA_BRIEF_TO\.length\)/.test(cron), 'the cron sends without checking');
  assert.ok(/NOT SENT \(KARA_BRIEF_TO is unset\)/.test(cron), 'and it must say so in the log');
  assert.ok(/'0 6 \* \* \*'/.test(server.slice(Math.max(0, at - 400), at)), 'it is not at 06:00');
});

t('the test route sends to Arturo and cannot send to Kara', () => {
  const at = server.indexOf("app.post('/api/brief/kara/test'");
  assert.ok(at > 0, 'there is no test route');
  // Bounded by the END of the handler, not by a character count: a fixed
  // window ran past it into the cron below, which legitimately names
  // KARA_BRIEF_TO, and the test failed on its neighbour's code.
  const end = server.indexOf('});', server.indexOf('catch (err)', at));
  const route = server.slice(at, end > at ? end : at + 900);
  assert.ok(/briefSendMail\(KARA_BRIEF_TEST_TO/.test(route));
  assert.ok(!/KARA_BRIEF_TO/.test(route), 'the test route can reach the real recipient list');
  assert.ok(/testMode: true/.test(route));
  assert.ok(/dryRun/.test(route), 'there must be a way to render without sending');
});

t('it goes out from the EOD account, and keeps its alignment', () => {
  const at = server.indexOf('async function briefSendMail');
  const fn = server.slice(at, at + 1400);
  assert.ok(/EOD_SENDER/.test(fn), 'it uses a different sender from the EOD');
  assert.ok(/<pre/.test(fn), 'Outlook reflows plain text and the columns collapse');
  assert.ok(/replace\(\/&\/g/.test(fn), 'the text is not escaped into the HTML');
});

t('migration 088 exists, is not run, and seeds without overwriting', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '088_brief_thresholds.sql'), 'utf8');
  assert.ok(/NOT RUN YET/.test(sql));
  assert.ok(/on conflict \(property\) do nothing/.test(sql),
    're-running it would overwrite a number Kara set');
  assert.ok(/5000/.test(sql) && /7/.test(sql) && /3/.test(sql));
  assert.ok(/OCCUPANCY IS DELIBERATELY ABSENT/.test(sql),
    'a second place to set an occupancy goal is a second place for it to disagree');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
