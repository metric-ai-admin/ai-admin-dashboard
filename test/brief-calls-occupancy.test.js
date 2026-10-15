// Kara's (b) call scores and (c) projected occupancy, and the (d) that is not
// built.
//
// WHAT THESE ARE REALLY GUARDING. Three different ways a section can be
// confidently wrong without looking wrong:
//
//   * a count with no denominator, or a denominator padded with calls nobody
//     could score — "12 below 70" is a different sentence out of 15 than out
//     of 200
//   * a projection that assumes zero move-ins because the source was empty,
//     which makes every property fall every week and reads as a portfolio in
//     trouble
//   * a section that disappears when it has nothing to say, which reads as
//     good news to the person who asked for it
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CALLS = require('../lib/brief-calls.js');
const OCC = require('../lib/brief-occupancy.js');
const B = require('../lib/kara-brief.js');
const H = require('../lib/kara-brief-html.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('brief: calls, occupancy, FAS');

// ---- (b) call scores --------------------------------------------------------

const DAY = '2026-10-14';
const managed = n => /^(Ascent at Northgate|The Chateau)$/.test(n);
const run = (calls, thresholds) =>
  CALLS.failedCalls(calls, DAY, thresholds || [], { isManaged: managed });

t('the default threshold is the Call Analyzer\'s own C/D boundary', () => {
  // If the brief graded on a different number from the screen people look at,
  // "12 calls below 70" in the email and a green row in the tool would both be
  // correct and nobody could reconcile them.
  assert.strictEqual(CALLS.DEFAULT_MIN, 70);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const bands = server.match(/const GRADE_BANDS = \[([^\]]*\])[^;]*/);
  assert.ok(bands, 'GRADE_BANDS still exists in server.js');
  assert.match(bands[0], /\[70, 'C'\]/, 'and 70 is still where C starts');
});

t('counts below the threshold, with the denominator', () => {
  const r = run([
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 55 },
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 69 },
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 70 },
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 91 },
  ]);
  const g = r.rows[0];
  assert.strictEqual(g.below, 2, '70 is not below 70');
  assert.strictEqual(g.scored, 4);
  assert.strictEqual(CALLS.line(g), '2 calls below 70 (of 4)');
});

t('unscoreable calls are in neither number', () => {
  // They are neither passes nor failures. Counting them as either is a lie in
  // one direction or the other, and a property whose calls are mostly
  // unscoreable has a recording problem that reads as a clean sheet if they
  // are dropped entirely.
  const r = run([
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 55 },
    { call_date: DAY, property_name: 'Ascent at Northgate', not_scoreable: true },
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: null },
  ]);
  const g = r.rows[0];
  assert.strictEqual(g.scored, 1);
  assert.strictEqual(g.below, 1);
  assert.strictEqual(g.notScoreable, 2);
  assert.match(CALLS.line(g), /2 unscoreable/);
});

t('only the requested day is counted', () => {
  const r = run([
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 55 },
    { call_date: '2026-10-13', property_name: 'Ascent at Northgate', overall_score: 10 },
  ]);
  assert.strictEqual(r.rows[0].scored, 1);
});

t('a timestamp is matched by its date part', () => {
  const r = run([{ call_date: DAY + 'T14:22:01.000Z', property_name: 'Ascent at Northgate', overall_score: 55 }]);
  assert.strictEqual(r.rows[0].scored, 1);
});

t('Unidentified and Unknown are ONE group, apart from the properties', () => {
  const r = run([
    { call_date: DAY, property_name: 'Unidentified', overall_score: 30 },
    { call_date: DAY, property_name: 'Unknown', overall_score: 40 },
    { call_date: DAY, property_name: '', overall_score: 50 },
    { call_date: DAY, property_name: null, overall_score: 60 },
  ]);
  assert.strictEqual(r.rows.length, 0, 'none of them is a property row');
  assert.strictEqual(r.others.length, 0);
  assert.strictEqual(r.unidentified.scored, 4, 'all four in one group');
  assert.strictEqual(r.unidentified.below, 4);
});

t('a named property that is not one of ours is PRESENT, in its own group', () => {
  // Kara asked for Cedar & Sage "separate but present". In the main list it
  // makes the portfolio look worse than it is; dropped, it loses calls that
  // really happened.
  const r = run([
    { call_date: DAY, property_name: 'Cedar and Sage', overall_score: 40 },
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 95 },
  ]);
  assert.deepStrictEqual(r.rows.map(g => g.property), ['Ascent at Northgate']);
  assert.deepStrictEqual(r.others.map(g => g.property), ['Cedar and Sage']);
  assert.strictEqual(r.others[0].below, 1);
});

t('a label that is not a property at all is not a property row', () => {
  // This is the bug the first wiring shipped with: AFP.resolveProperty hands
  // back whatever it is given — it is a normaliser, not a membership test —
  // so "Not property-specific" appeared among the managed properties looking
  // exactly like a property having a bad morning.
  const r = run([{ call_date: DAY, property_name: 'Not property-specific', overall_score: 40 }]);
  assert.strictEqual(r.rows.length, 0);
  assert.strictEqual(r.others.length, 1);
});

t('the threshold can be moved per property, then for everybody', () => {
  const thresholds = [
    { property: '*', call_score_min: 80 },
    { property: 'The Chateau', call_score_min: 60 },
  ];
  const r = run([
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 75 },
    { call_date: DAY, property_name: 'The Chateau', overall_score: 75 },
  ], thresholds);
  const asc = r.rows.find(g => g.property === 'Ascent at Northgate');
  const cha = r.rows.find(g => g.property === 'The Chateau');
  assert.strictEqual(asc.min, 80);
  assert.strictEqual(asc.below, 1, '75 is below the 80 from the star row');
  assert.strictEqual(cha.min, 60);
  assert.strictEqual(cha.below, 0, '75 is above its own 60');
});

t('no calls at all is reported, not rendered as silence', () => {
  // The Call Analyzer has gone quiet before — "No calls since 9/29". A section
  // that renders nothing when the table is empty reads as "nobody scored
  // badly yesterday".
  const r = run([]);
  assert.strictEqual(r.empty, true);
  const text = B.render(B.build({ properties: [], thresholds: [], calls: r }));
  assert.match(text, /No calls were graded/);
  assert.match(text, /not the same as/);
});

// ---- (c) projected occupancy ------------------------------------------------

const TODAY = '2026-10-15';
const props = [
  { name: 'Ascent at Northgate', units: 100, occupied: 90 },
  { name: 'The Chateau', units: 50, occupied: 40 },
];

t('weeks are weekly to 30 days and one grey block beyond', () => {
  const r = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  const w = r.rows[0].weeks;
  const firm = w.filter(x => x.firm);
  const grey = w.filter(x => !x.firm);
  assert.ok(firm.length >= 4 && firm.length <= 5, 'four or five firm weeks');
  assert.strictEqual(grey.length, 1, 'one grey block, not six more rows');
  assert.strictEqual(firm[0].from, TODAY);
  assert.strictEqual(grey[0].to, OCC.addDays(TODAY, 60));
});

t('a week straddling day 30 is not counted as firm', () => {
  // The half past the line has no move-ins behind it, so calling the whole
  // week firm would overstate exactly the part that is least known.
  const r = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  r.rows[0].weeks.filter(w => w.firm).forEach(w =>
    assert.ok(w.to <= OCC.addDays(TODAY, 30), w.label + ' ends inside the horizon'));
});

t('departures reduce occupancy in the week they fall', () => {
  const r = OCC.project({
    todayCT: TODAY, properties: props, moveIns: [],
    moveOuts: [
      { property: 'Ascent at Northgate', date: '2026-10-20' },
      { property: 'Ascent at Northgate', date: '2026-10-21' },
    ],
  });
  const w = r.rows[0].weeks[0];
  assert.strictEqual(w.moveOuts, 2);
  assert.strictEqual(w.occupied, 88);
  assert.ok(Math.abs(w.pct - 0.88) < 1e-9);
});

t('arrivals are counted inside the horizon and ignored beyond it', () => {
  const r = OCC.project({
    todayCT: TODAY, properties: props, moveOuts: [],
    moveIns: [
      { property: 'Ascent at Northgate', date: '2026-10-20' },
      { property: 'Ascent at Northgate', date: '2026-12-01' },
    ],
  });
  assert.strictEqual(r.rows[0].weeks[0].moveIns, 1);
  const grey = r.rows[0].weeks.find(w => !w.firm);
  assert.strictEqual(grey.moveIns, null, 'the grey block reports no arrivals at all');
  assert.strictEqual(grey.occupied, r.rows[0].weeks[r.rows[0].weeks.length - 2].occupied,
    'and the stray December signature does not lift it');
});

t('a MISSING move-in source is not treated as zero move-ins', () => {
  // The whole point. An empty array means "we looked and there are none";
  // null means "we cannot see them". Confusing the two makes occupancy fall
  // every week at every property and reads as a portfolio in trouble.
  const absent = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [] });
  const empty = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  assert.strictEqual(absent.moveInsKnown, false);
  assert.strictEqual(empty.moveInsKnown, true);
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: absent }));
  assert.match(text, /MOVE-INS ARE NOT IN THIS PROJECTION/);
  assert.match(text, /floor, not a forecast/);
});

t('the Metric total is recomputed from units, never averaged from percentages', () => {
  // The mean of two properties' occupancy weights a 12-unit property like a
  // 200-unit one.
  const r = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  const first = r.total[0];
  assert.strictEqual(first.units, 150);
  assert.strictEqual(first.occupied, 130);
  assert.ok(Math.abs(first.pct - 130 / 150) < 1e-9);
  const mean = (0.9 + 0.8) / 2;
  assert.ok(Math.abs(first.pct - mean) > 1e-6, 'and it is not the mean of the two');
});

t('nothing is clamped', () => {
  // A projection below zero means the inputs disagree. Hiding that behind a
  // clamp turns a data problem into a quiet quarter.
  const r = OCC.project({
    todayCT: TODAY, moveIns: [],
    properties: [{ name: 'A', units: 10, occupied: 2 }],
    moveOuts: Array.from({ length: 5 }, () => ({ property: 'A', date: '2026-10-16' })),
  });
  assert.strictEqual(r.rows[0].weeks[0].occupied, -3);
  assert.ok(r.rows[0].weeks[0].pct < 0);
});

t('the portfolio split is empty and SAYS it is empty', () => {
  // Kara has not said which properties are RR and which are Greystone.
  // Guessing would produce two totals that look authoritative and are made up.
  const r = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  assert.strictEqual(r.groups.configured, false);
  assert.deepStrictEqual(r.groups.ungrouped.sort(),
    ['Ascent at Northgate', 'The Chateau']);
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /not split yet/);
  assert.match(text, /2 properties are currently ungrouped/);
});

t('a configured split groups and still names what it could not place', () => {
  const r = OCC.project({
    todayCT: TODAY, properties: props, moveOuts: [], moveIns: [],
    portfolioMap: { 'Ascent at Northgate': 'RR' },
  });
  assert.strictEqual(r.groups.configured, true);
  assert.strictEqual(r.groups.groups[0].name, 'RR');
  assert.deepStrictEqual(r.groups.ungrouped, ['The Chateau'],
    'a property with no portfolio is named, not folded into one');
});

// ---- (d) FAS ----------------------------------------------------------------

t('FAS says it cannot be measured rather than being absent', () => {
  // Kara asked for this alert because she suspects some are overdue. A
  // section simply missing from the email reads as "none are".
  const brief = B.build({ properties: [], thresholds: [] });
  assert.strictEqual(brief.fas.measurable, false);
  const text = B.render(brief);
  assert.match(text, /FINAL ACCOUNT STATEMENTS/);
  assert.match(text, /NOT MEASURABLE/);
  assert.match(text, /should be read as "no FAS is overdue"/);
  assert.match(text, /deposit settled/, 'and what it is waiting on');
});

// ---- both renderers agree ---------------------------------------------------

t('every new section is in the HTML as well as the text', () => {
  // A section present in one renderer and missing from the other is the kind
  // of difference that reaches a mailbox unnoticed: the email is the HTML.
  const calls = run([
    { call_date: DAY, property_name: 'Ascent at Northgate', overall_score: 55 },
    { call_date: DAY, property_name: 'Cedar and Sage', overall_score: 40 },
    { call_date: DAY, property_name: 'Unknown', overall_score: 20 },
  ]);
  const occupancy = OCC.project({ todayCT: TODAY, properties: props, moveOuts: [], moveIns: [] });
  const brief = B.build({ properties: [], thresholds: [], calls, occupancy });
  const text = B.render(brief);
  const html = H.renderHtml(brief);
  [
    [/^CALL SCORES/m, />Call scores/],
    [/^PROJECTED OCCUPANCY/m, />Projected occupancy</],
    [/^FINAL ACCOUNT STATEMENTS/m, />Final account statements</],
  ].forEach(([inText, inHtml]) => {
    assert.ok(inText.test(text), 'text: ' + inText);
    assert.ok(inHtml.test(html), 'html: ' + inHtml);
  });
  // The three groups survive into the HTML too.
  assert.match(html, /Cedar and Sage/);
  assert.match(html, /Unidentified \/ Unknown/);
  assert.match(html, /notices only/);
});

t('the HTML escapes a property name that contains markup', () => {
  const calls = run([{ call_date: DAY, property_name: '<script>x</script>', overall_score: 10 }]);
  const html = H.renderHtml(B.build({ properties: [], thresholds: [], calls }));
  assert.ok(!/<script>/.test(html), 'no raw script tag reaches the email');
});

t('the gatherer uses a membership test, not the normaliser', () => {
  // The unit tests above inject isManaged, so they would keep passing while
  // the wiring handed in the wrong function — which is exactly what shipped.
  // This pins the wiring itself.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'kara-brief-gather.js'), 'utf8');
  const block = src.slice(src.indexOf('isManaged:'), src.indexOf('isManaged:') + 120);
  assert.match(block, /PA\.canonical/, 'canonical() answers "is this one of ours"');
  assert.ok(!/isManaged:\s*name\s*=>\s*!!AFP\.resolveProperty/.test(src),
    'resolveProperty hands back whatever it is given and is not a membership test');
  // And the thing it relies on is still true.
  const PA = require('../lib/property-aliases.js');
  assert.strictEqual(PA.canonical('Not property-specific'), null);
  assert.strictEqual(PA.canonical('Cedar and Sage'), null);
  assert.ok(PA.canonical('Ascent at Northgate'));
});

// ---- the occupancy red, which went missing ----------------------------------
//
// On 2026-10-13 the brief said ">> occupancy 51.4% against a 85.0% goal". On
// the 15th no property had that flag and the footer still promised it. The
// brief that actually went out was fine; the PREVIEW was handed a goal
// function returning null, so nothing was ever under goal. A preview that
// disagrees with the email is worse than no preview, because it is believed.

const GOALS = require('../lib/leasing-goals.js');

t('a property under its goal is RED, and says by how much', () => {
  const brief = B.build({
    thresholds: [],
    properties: [{
      name: 'Ascent at Northgate', units: 111, occupied: 57,
      occupancyPct: 57 / 111, goalPct: GOALS.leasingGoalFraction('Ascent at Northgate'),
    }],
  });
  assert.strictEqual(brief.red.length, 1, 'it is in the red list');
  const flag = brief.red[0].flags.find(f => f.kind === 'occupancy');
  assert.ok(flag, 'with an occupancy flag');
  assert.match(flag.text, /51\.4%/);
  assert.match(flag.text, /85\.0%/);
  const text = B.render(brief);
  assert.match(text, /occupancy 51\.4% against a 85\.0% goal/);
});

t('the goals are the Goal Board\'s, and come from one place', () => {
  // The table used to be a const inside server.js, which is why anything
  // outside it had to be handed a goal function — and why one caller could be
  // handed a broken one without a test noticing.
  assert.strictEqual(GOALS.leasingGoalPct('iConic Round Rock'), 92);
  assert.strictEqual(GOALS.leasingGoalPct('Windy Hill Apartment'), 90);
  assert.strictEqual(GOALS.leasingGoalPct('Ascent at Northgate'), 85);
  assert.strictEqual(GOALS.leasingGoalPct('Somewhere New'), 85, 'default');
  const board = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools',
    'weekly_leasing_goal_board.html'), 'utf8');
  const override = board.match(/const GOAL_OVERRIDE=\{[^}]*\}/);
  assert.ok(override, 'the Goal Board still has its overrides');
  assert.match(override[0], /"iConic Round Rock":0\.92/);
  assert.match(override[0], /"Windy Hill Apartment":0\.90/);
});

t('no property is under goal when every goal is null — which is the bug', () => {
  // Pinning the failure mode itself: with no goals, the flag cannot fire, so
  // a caller that supplies none renders a brief with no occupancy reds at all
  // while the footer still names the threshold.
  const brief = B.build({
    thresholds: [],
    properties: [{ name: 'Ascent at Northgate', units: 111, occupied: 57,
      occupancyPct: 57 / 111, goalPct: null }],
  });
  assert.strictEqual(brief.red.length, 0);
  assert.match(B.render(brief), /occupancy below the property goal/,
    'and the footer promises what the body did not deliver');
});

t('the preview passes the real goals, not nulls', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'kara-brief-preview.js'), 'utf8');
  assert.match(src, /goalPctFor:[\s\S]{0,120}leasingGoalFraction/,
    'the preview uses the shared table');
  assert.ok(!/goalPctFor:\s*\(\)\s*=>\s*null/.test(src));
});

t('server.js and the preview read the same goal table', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/leasing-goals\.js'\)/);
  assert.ok(!/const LEASING_GOAL_PCT = \{/.test(server),
    'the table is not redefined in server.js');
});

// ---- undated signed leases --------------------------------------------------

t('signed leases with no date land in the first week and are declared', () => {
  // The email prints "Signed, not moved in" per property. A projection that
  // drops the undated ones ends lower than a count three inches above it, in
  // the same message.
  const r = OCC.project({
    todayCT: TODAY, properties: [{ name: 'Windy Hill Apartment', units: 100, occupied: 90 }],
    moveOuts: [], moveIns: [],
    undatedMoveInsBy: { 'Windy Hill Apartment': 2 },
  });
  assert.strictEqual(r.undatedMoveIns, 2);
  assert.strictEqual(r.rows[0].weeks[0].undatedPlaced, 2);
  assert.strictEqual(r.rows[0].weeks[0].occupied, 92);
  assert.strictEqual(r.rows[0].weeks[1].undatedPlaced, 0, 'placed once, not every week');
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /no move-in date/);
  assert.match(text, /FIRST week/);
  assert.match(text, /not a date anybody gave us/);
});

t('undated leases are ignored when the move-in source is absent entirely', () => {
  // Without a source there is nothing to reconcile against, and inventing
  // arrivals from a count alone would be worse than the gap it fills.
  const r = OCC.project({
    todayCT: TODAY, properties: [{ name: 'A', units: 10, occupied: 5 }],
    moveOuts: [], undatedMoveInsBy: { A: 3 },
  });
  assert.strictEqual(r.moveInsKnown, false);
  assert.strictEqual(r.rows[0].weeks[0].occupied, 5);
});

// ---- the collections sentence -----------------------------------------------

t('the brief no longer claims AppFolio cannot be asked about a past period', () => {
  // It can: posted_on_from/to = "2026-09" returns all of September. What it
  // will not do is part of a month. I wrote the stronger claim and it was
  // wrong by the time it shipped.
  const COLL = require('../lib/collections-mtd.js');
  const note = COLL.alert([{ captured_on: '2026-10-05', property: 'A', rent_income: 1 }],
    '2026-10-15').note;
  assert.ok(!/cannot be asked about a past period/.test(note));
  assert.match(note, /whole past month/);
  assert.match(note, /not about part of one/);
  assert.match(note, /comparison starts 2026-11-05/);
});

// ---- the nightly property fill ----------------------------------------------

t('the call-property fill is scheduled between grading and the brief', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf('fill-call-properties.js');
  assert.ok(at > 0, 'it is wired into a cron');
  const starts = [...server.slice(0, at).matchAll(/cron\.schedule\('(\d+) (\d+) \* \* \*'/g)];
  const last = starts[starts.length - 1];
  const hour = Number(last[2]);
  assert.ok(hour > 2, 'after the 02:00 auto-grade that creates the rows (got ' + hour + ')');
  assert.ok(hour < 6, 'before the 06:00 brief that counts them (got ' + hour + ')');
});

t('the fill is importable and does not run on require', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'fill-call-properties.js'), 'utf8');
  assert.match(src, /require\.main === module/, 'the CLI entry point is guarded');
  assert.match(src, /module\.exports = \{ fillCallProperties \}/);
  // The rule that makes it safe to run unattended.
  assert.match(src, /call_grades_history/, 'previous values are kept');
  assert.match(src, /property_source: CP\.SOURCE\.MATCH/, 'and every row is marked');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
