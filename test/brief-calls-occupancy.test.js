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

t('below zero is still not clamped', () => {
  // It has not happened, the cause would be different — more departures than
  // residents — and inventing a floor for a case nobody has seen is how a
  // future bug gets hidden.
  const r = OCC.project({
    todayCT: TODAY, moveIns: [],
    properties: [{ name: 'A', units: 10, occupied: 2 }],
    moveOuts: Array.from({ length: 5 }, () => ({ property: 'A', date: '2026-10-16' })),
  });
  assert.strictEqual(r.rows[0].weeks[0].occupied, -3);
  assert.ok(r.rows[0].weeks[0].pct < 0);
});

t('over 100% is capped AND named, never quietly capped', () => {
  // The Chateau, 2026-10-15: 30 of 30 occupied, a signed move-in on 11/10 and
  // no notice behind it. Printing 103.3% leaves the reader to work it out;
  // clamping to 100% turns a contradiction between two AppFolio reports into
  // a plausible number nobody ever investigates. Both, or it is wrong.
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    moveIns: [{ property: 'The Chateau', date: '2026-11-10', unit: '113' }],
  });
  const over = r.rows[0].weeks.find(w => w.over);
  assert.ok(over, 'the overflow is detected');
  assert.strictEqual(over.occupied, 30, 'shown capped at the unit count');
  assert.strictEqual(over.pct, 1, 'and at 100%');
  assert.strictEqual(over.rawOccupied, 31, 'while the arithmetic is kept whole');

  assert.strictEqual(r.conflicts.length, 1);
  assert.deepStrictEqual(
    { ...r.conflicts[0], week: undefined },
    { kind: 'move_in_without_vacancy', date: '2026-11-10', unit: '113',
      property: 'The Chateau', week: undefined });

  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /Data conflict: 1 signed move-in on 2026-11-10, unit 113,/);
  assert.match(text, /no notice or move-out on file — check the unit in AppFolio/);
  assert.ok(!/103/.test(text), 'and 103.3% is not printed anywhere');
  // The conflict has to come BEFORE the capped number: a reader who meets
  // 100.0% first has no reason to read on.
  assert.ok(text.indexOf('Data conflict') < text.indexOf('100.0%'));
});

t('the conflict is reported even when the unit cannot be resolved', () => {
  // leasing_lease_history has no unit column; the unit is looked up from the
  // rent roll by name and a name in two units resolves to nothing. A missing
  // unit must not swallow the conflict.
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    moveIns: [{ property: 'The Chateau', date: '2026-11-10' }],
  });
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].unit, null);
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /Data conflict: 1 signed move-in on 2026-11-10 with no notice/);
});

t('an undated signed lease that overfills is named too', () => {
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [], moveIns: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    undatedMoveInsBy: { 'The Chateau': 2 },
  });
  assert.strictEqual(r.rows[0].weeks[0].pct, 1);
  assert.strictEqual(r.rows[0].weeks[0].rawOccupied, 32);
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /Data conflict: 2 signed move-ins with no move-in date/);
});

t('every property over 100% gets the treatment, not just the first', () => {
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [],
    properties: [
      { name: 'The Chateau', units: 30, occupied: 30 },
      { name: 'Sunset Palms', units: 36, occupied: 36 },
      { name: 'Ascent at Northgate', units: 111, occupied: 50 },
    ],
    moveIns: [
      { property: 'The Chateau', date: '2026-10-20', unit: '113' },
      { property: 'Sunset Palms', date: '2026-10-21', unit: '7' },
      { property: 'Ascent at Northgate', date: '2026-10-21', unit: '204' },
    ],
  });
  assert.strictEqual(r.conflicts.length, 2, 'both full properties, not the one under capacity');
  assert.deepStrictEqual(r.conflicts.map(c => c.property).sort(),
    ['Sunset Palms', 'The Chateau']);
  r.rows.forEach(row => row.weeks.forEach(w =>
    assert.ok(w.pct === null || w.pct <= 1, row.property + ' never shows above 100%')));
});

t('the Metric total uses the capped figures, so it cannot exceed its own units', () => {
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    moveIns: [{ property: 'The Chateau', date: '2026-10-20' }],
  });
  r.total.forEach(w => assert.ok(w.occupied <= w.units,
    w.label + ': ' + w.occupied + '/' + w.units));
});

t('the HTML carries the conflict in the red, above the table', () => {
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    moveIns: [{ property: 'The Chateau', date: '2026-11-10', unit: '113' }],
  });
  const html = H.renderHtml(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(html, /Data conflict/);
  assert.match(html, /unit 113/);
  assert.ok(!/103/.test(html));
  assert.ok(html.indexOf('Data conflict') < html.indexOf('100.0%'));
});

t('the unit lookup refuses an ambiguous name', () => {
  // A name in two units resolves to nothing rather than to whichever sorts
  // first. A wrong unit number sends somebody to the wrong door and looks
  // exactly like a right one — the same rule as the call matching.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'kara-brief-gather.js'), 'utf8');
  const block = src.slice(src.indexOf('const unitByTenant'), src.indexOf('return (rows || [])'));
  assert.match(block, /null;\s*\/\/ null = seen in more than one unit/,
    'a second unit for the same name blanks it');
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
  // AGAINST THE UNWRAPPED TEXT. The section is wrapped to the rules above it,
  // so a phrase can be split across two lines by nothing more than a reworded
  // sentence earlier in the paragraph — which is what happened when the note
  // was updated, and it fails here as a missing sentence rather than as a line
  // break. The sentence is what matters; where it wraps is not.
  const flat = String(text).replace(/\s+/g, ' ');
  assert.match(flat, /should be read as "no FAS is overdue"/);
  // What it is waiting on — a person and an action, not a question already
  // answered. Kara confirmed "deposit settled" on 2026-10-20 and the note went
  // on asking her for it every morning until 2026-10-21.
  assert.match(flat, /Waiting on: Arturo/);
  assert.ok(!/Kara to confirm whether/.test(flat),
    'the note still asks Kara for something she has already given');
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

// ---- stale lease rows -------------------------------------------------------
//
// The sync UPSERTS what the report returns and never removes what it does not,
// so a lease that falls out — rescheduled, completed, cancelled — keeps its
// last known values for ever and reads exactly like today's.
//
// The Chateau, 2026-10-15: a "future move-in" dated 2026-11-10 whose row had
// not been touched since 2026-10-02, while 31 others were refreshed that
// morning. Leasing says the real date is 10/11 — in the past, which is why it
// had left the report. The projection counted a phantom arrival and raised a
// data conflict over it.

t('a future move-in from a stale row is left out and counted', () => {
  const r = OCC.project({
    todayCT: TODAY, moveOuts: [], moveIns: [],
    properties: [{ name: 'The Chateau', units: 30, occupied: 30 }],
    staleLeaseRows: 51, staleLeaseFutureMoveIns: 1,
  });
  assert.strictEqual(r.conflicts.length, 0, 'no phantom conflict');
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /1 lease with a future move-in date was LEFT OUT/);
  assert.match(text, /51 lease rows in all have not been refreshed/);
});

t('the gatherer trusts only rows the report still returns', () => {
  // Not an age in hours: the question is "does the report still return this",
  // which the sync answers in in_feed (migration 100), with the newest-sync
  // comparison as the fallback until that column exists everywhere.
  // test/feed-staleness.test.js owns the detail.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'kara-brief-gather.js'), 'utf8');
  const block = src.slice(src.indexOf('const hasFlag'), src.indexOf('return fresh'));
  assert.ok(block.length > 0, 'the block was found');
  assert.match(block, /in_feed/);
  assert.match(block, /synced_at/, 'the fallback is still there');
  assert.ok(!/hours|Date\.now\(\)/.test(block), 'and nothing is judged by an age in hours');
});

// ---- applications held out --------------------------------------------------

t('an excluded property raises no application flag, but keeps its other reds', () => {
  const brief = B.build({
    thresholds: [{ property: 'Windy Hill Apartment', applications_excluded: true }],
    properties: [{
      name: 'Windy Hill Apartment', units: 100, occupied: 50,
      occupancyPct: 0.5, goalPct: 0.9, delinquency: 9000, applicationOldestDays: 91,
    }],
  });
  assert.deepStrictEqual(brief.properties[0].flags.map(f => f.kind),
    ['occupancy', 'delinquency'],
    'only the application flag is suppressed');
});

t('the exclusion is NEVER inherited from the star row', () => {
  // "Every property is under construction" is not a thing anybody means to
  // say, and a flag switched on portfolio-wide by accident would silence the
  // application alerts everywhere at once.
  const brief = B.build({
    thresholds: [{ property: '*', applications_excluded: true }],
    properties: [{ name: 'Ascent at Northgate', units: 10, occupied: 9,
      occupancyPct: 0.9, goalPct: 0.85, applicationOldestDays: 91 }],
  });
  assert.ok(brief.properties[0].flags.some(f => f.kind === 'applications'));
});

t('held-out applications leave Records to clean up and are NAMED', () => {
  // Dropped without a word, the property is indistinguishable from one with
  // nothing outstanding.
  const brief = B.build({
    thresholds: [{ property: 'Windy Hill Apartment', applications_excluded: true,
      applications_excluded_note: 'units under construction — waiting on Sammy and Bekah' }],
    properties: [
      { name: 'Windy Hill Apartment', units: 100, occupied: 95, occupancyPct: 0.95,
        goalPct: 0.9, applicationsPending: 6, applicationOldestDays: 91,
        staleApplications: 6, staleApplicationOldest: 91 },
      { name: 'Ascent at Northgate', units: 10, occupied: 9, occupancyPct: 0.9,
        goalPct: 0.85, staleApplications: 2, staleApplicationOldest: 70 },
    ],
  });
  const text = B.render(brief);
  const records = text.slice(text.indexOf('RECORDS TO CLEAN UP'),
    text.indexOf('APPLICATIONS HELD OUT'));
  assert.ok(!/Windy Hill/.test(records), 'out of the records list');
  assert.match(records, /Ascent at Northgate\s+2 applications/, 'others unaffected');
  assert.match(text, /APPLICATIONS HELD OUT/);
  assert.match(text, /Windy Hill Apartment\s+6 applications not counted or flagged/);
  assert.match(text, /units under construction — waiting on Sammy and Bekah/);

  const html = H.renderHtml(brief);
  assert.match(html, />Applications held out</);
  assert.match(html, /units under construction/);
});

t('the card and the portfolio total agree with the held-out section', () => {
  // The first version held the applications out of the flags and out of
  // Records, and left them in both the property card and the portfolio count:
  // "Applications pending 4 oldest 56d" under a heading saying those four
  // were held out, and a portfolio total of 5 that nobody could reconcile
  // against the cards above it.
  const brief = B.build({
    thresholds: [{ property: 'Windy Hill Apartment', applications_excluded: true }],
    portfolio: { units: 400, occupied: 300, occupancyPct: 0.75, applicationsPending: 5 },
    properties: [
      { name: 'Windy Hill Apartment', units: 100, occupied: 95, occupancyPct: 0.95,
        goalPct: 0.9, applicationsPending: 4, applicationOldestDays: 56 },
      { name: 'Ascent at Northgate', units: 10, occupied: 9, occupancyPct: 0.9,
        goalPct: 0.85, applicationsPending: 1, applicationOldestDays: 2 },
    ],
  });

  assert.strictEqual(brief.portfolio.applicationsPending, 1, '5 minus the 4 held out');
  assert.strictEqual(brief.portfolio.applicationsHeldOut, 4);

  const text = B.render(brief);
  assert.match(text, /Applications pending\s+held out \(4\)/, 'the card says held out');
  assert.ok(!/oldest 56d/.test(text),
    'and drops the age, which is what invites action on a decision nobody has');
  assert.match(text, /Applications pending\s+1\s+\(4 held out, not counted\)/,
    'the portfolio total says what it left out rather than quietly dropping it');
  // Scoped to Ascent's own block rather than matched across the whole brief:
  // there are other lines between the name and this one, and a looser pattern
  // would pass on Windy Hill's card.
  const ascent = text.slice(text.indexOf('Ascent at Northgate'));
  assert.match(ascent.slice(0, 400), /Applications pending\s+1\s+oldest 2d/,
    'a normal property is untouched');

  const html = H.renderHtml(brief);
  assert.match(html, /held out \(4\)/);
  assert.match(html, /4 held out, not counted/);
  assert.ok(!/56d/.test(html));
});

t('the portfolio total is untouched when nothing is held out', () => {
  const brief = B.build({
    thresholds: [],
    portfolio: { units: 400, occupied: 300, applicationsPending: 5 },
    properties: [{ name: 'Ascent at Northgate', units: 10, occupied: 9,
      occupancyPct: 0.9, goalPct: 0.85, applicationsPending: 5 }],
  });
  assert.strictEqual(brief.portfolio.applicationsPending, 5);
  assert.strictEqual(brief.portfolio.applicationsHeldOut, undefined);
});

t('a portfolio total never goes below zero', () => {
  // If the per-property counts and the portfolio count ever disagree, a
  // negative total would be the first thing anybody noticed — and the least
  // useful. It floors at zero and still reports what it held out.
  const brief = B.build({
    thresholds: [{ property: 'Windy Hill Apartment', applications_excluded: true }],
    portfolio: { units: 400, occupied: 300, applicationsPending: 2 },
    properties: [{ name: 'Windy Hill Apartment', units: 100, occupied: 95,
      occupancyPct: 0.95, goalPct: 0.9, applicationsPending: 6 }],
  });
  assert.strictEqual(brief.portfolio.applicationsPending, 0);
  assert.strictEqual(brief.portfolio.applicationsHeldOut, 6);
});

t('without a note the brief still says who to ask', () => {
  const brief = B.build({
    thresholds: [{ property: 'Windy Hill Apartment', applications_excluded: true }],
    properties: [{ name: 'Windy Hill Apartment', units: 100, occupied: 95,
      occupancyPct: 0.95, goalPct: 0.9, applicationsPending: 6 }],
  });
  assert.match(B.render(brief), /held out by request — ask Arturo why/);
});

t('the unit-level filter that was asked for is not faked', () => {
  // Rocío asked for "building 3, or units with no CO". leasing_applications
  // carries no unit — all 46 Windy Hill rows have it NULL — so a filter
  // written against that column would exclude everything or nothing and look
  // like it was doing the finer job either way. The migration says so.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '099_applications_under_construction.sql'), 'utf8');
  assert.match(sql, /carries no unit/i);
  assert.match(sql, /applications_excluded/);
  const brief = require('../lib/kara-brief.js');
  const t2 = brief.thresholdsFor('Anything', []);
  assert.strictEqual(t2.applications_excluded, false, 'off by default');
});

// ---- the portfolio split ----------------------------------------------------

t('the portfolio split comes from kpi-report, not a second list', () => {
  // Kara's section printed "not split yet — waiting on Kara" while the answer
  // already existed in lib/kpi-report.js, and Jay's dashboard defines the same
  // four properties for Greystone independently (cv-live.js, read 2026-10-19).
  // A membership typed out a second time is one that will drift from the
  // first — the same reason the exclusion fragments and the leasing goals were
  // pulled into libs this month.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sync-brief-portfolios.js'), 'utf8');
  assert.match(src, /require\('\.\.\/lib\/kpi-report\.js'\)/);
  assert.ok(!/'Hyde Park Square'|'Sunset Palms'/.test(src),
    'no property name is restated in the script');
  const KPI = require('../lib/kpi-report.js');
  assert.deepStrictEqual([...KPI.VIRTUAL_GROUPS.Greystone].sort(),
    ['Hyde Park Square', 'Sunset Palms', 'The Chateau', 'The Highlander']);
  assert.deepStrictEqual([...KPI.ROUND_ROCK.members].sort(),
    ['iConic Downtown', 'iConic Round Rock']);
});

t('a dry run writes nothing and an empty source refuses', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sync-brief-portfolios.js'), 'utf8');
  assert.ok(src.indexOf('if (!WRITE)') < src.indexOf('.upsert('),
    'the dry-run return is above the write');
  assert.match(src, /refusing to write an empty split/,
    'an empty kpi-report must not blank the table');
  assert.match(src, /onConflict: 'property'/, 'rerunning replaces, never doubles');
});

t('a grouped projection still names what it could not place', () => {
  const r = OCC.project({
    todayCT: TODAY, properties: props, moveOuts: [], moveIns: [],
    portfolioMap: { 'The Chateau': 'Greystone' },
  });
  assert.strictEqual(r.groups.configured, true);
  assert.deepStrictEqual(r.groups.ungrouped, ['Ascent at Northgate']);
  const text = B.render(B.build({ properties: [], thresholds: [], occupancy: r }));
  assert.match(text, /Not in any portfolio: Ascent at Northgate/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
