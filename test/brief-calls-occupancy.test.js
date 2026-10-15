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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
