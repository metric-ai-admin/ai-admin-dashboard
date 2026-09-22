// Tests for the Unit Vacancy Posting rules engine.
// Run: node test/vacancy-rules.test.js
//
// Fixtures are shaped like real unit_vacancy rows and cover each rule plus the
// edge cases the 2026-09-21 production pull actually contained: blank
// unit_type, blank ready_for_showing_on, and free-text descriptions.

const assert = require('assert');
const V = require('../vacancy-rules.js');

const TODAY = '2026-09-21';
const EXCLUDED = ['lily pad', 'wolf ridge', 'sidney', 'brazos', 'live with metric', 'cedar and sage'];
const isExcludedProperty = n => EXCLUDED.some(f => String(n || '').toLowerCase().includes(f));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const unit = (id, over = {}) => ({
  unit_id: String(id), property_name: 'Oakwood', unit_type: 'A2', bed_and_bath: '1/1.00',
  unit_status: 'Vacant-Unrented', rent_ready: 'No', ready_for_showing_on: null,
  posted_to_website: 'No', posted_to_internet: 'No', description: '', ...over,
});
const run = rows => V.analyzeVacancy(rows, { today: TODAY, isExcludedProperty });
const ids = list => list.map(r => r.unit_id).join(',');

console.log('\nRule 1 — exclusions');
t('Vacant-Rented is excluded', () => {
  const r = run([unit(1, { unit_status: 'Vacant-Rented', posted_to_website: 'Yes' })]);
  assert.strictEqual(r.stats.ranked, 0);
  assert.strictEqual(r.remove.length, 0, 'excluded units must never be removed');
  assert.match(r.excluded[0]._reason, /Vacant-Rented/);
});
t('Notice-Rented is excluded', () => {
  assert.strictEqual(run([unit(1, { unit_status: 'Notice-Rented' })]).stats.ranked, 0);
});
t('excluded property is dropped', () => {
  const r = run([unit(1, { property_name: 'Brazos Lofts', rent_ready: 'Yes' })]);
  assert.strictEqual(r.stats.ranked, 0);
  assert.strictEqual(r.add.length, 0, 'excluded property must not produce ADDs');
});
t('not-ready description is excluded', () => {
  const r = run([unit(1, { description: 'Model unit- do not rent', posted_to_website: 'Yes' })]);
  assert.strictEqual(r.remove.length, 0);
  assert.strictEqual(r.excluded.length, 1);
});
t('unposted unit outside top 3 produces no action', () => {
  // Rule 1: Website=No AND Internet=No is already off — nothing to do.
  const rows = [1, 2, 3, 4].map(i => unit(i, { rent_ready: 'Yes' }));
  const r = run(rows);
  assert.strictEqual(r.remove.length, 0, 'nothing posted, so nothing to remove');
});

console.log('\nDescription classification');
t('blank description is ready', () => assert.strictEqual(V.classifyDescription(''), 'ready'));
t('keyword match is not_ready', () => assert.strictEqual(V.classifyDescription('Severe Pest Infestation '), 'not_ready'));
t('real maintenance text is caught', () => {
  for (const d of ['Needs Condensor - otherwise ready - $2000', 'Broken Window - Ready but boarded up - ',
    'No electricity cause the city removed the meter', 'Burned Reno Unit', 'HVAC Replacement needed']) {
    assert.strictEqual(V.classifyDescription(d), 'not_ready', d);
  }
});
t('unclassifiable text goes to review, not ready', () => {
  assert.strictEqual(V.classifyDescription('see Erick'), 'review');
});
t('review units are held out of ranking entirely', () => {
  const r = run([unit(1, { description: 'see Erick', rent_ready: 'Yes', posted_to_website: 'Yes' })]);
  assert.strictEqual(r.stats.ranked, 0);
  assert.strictEqual(r.remove.length, 0, 'must not remove');
  assert.strictEqual(r.add.length, 0, 'must not add');
  assert.strictEqual(r.needsReview.length, 1);
  assert.strictEqual(r.needsReview[0]._posted, true, 'review rows report posting state');
});

console.log('\nRule 3 — priority tiers');
t('tier 1: rent ready + past showing date', () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'Yes', ready_for_showing_on: '2026-01-01' }, TODAY), 1);
});
t('tier 2: rent ready, future date', () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'Yes', ready_for_showing_on: '2027-01-01' }, TODAY), 2);
});
t('tier 2: rent ready, blank date', () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'Yes', ready_for_showing_on: null }, TODAY), 2);
});
t('tier 3: not rent ready, past date', () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'No', ready_for_showing_on: '2026-01-01' }, TODAY), 3);
});
t('tier 4: everything else', () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'No', ready_for_showing_on: null }, TODAY), 4);
});
t("today's date is not 'past'", () => {
  assert.strictEqual(V.priorityTier({ rent_ready: 'No', ready_for_showing_on: TODAY }, TODAY), 4);
});

console.log('\nRule 2 + 3 — cap and ordering');
t('keeps 3, removes the 4th posted unit', () => {
  const rows = [
    unit(101, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }), // tier 1
    unit(102, { rent_ready: 'Yes', ready_for_showing_on: '2026-02-01', posted_to_website: 'Yes' }), // tier 1, later
    unit(103, { rent_ready: 'Yes', posted_to_website: 'Yes' }),                                      // tier 2
    unit(104, { rent_ready: 'No', posted_to_website: 'Yes' }),                                       // tier 4
  ];
  const r = run(rows);
  assert.strictEqual(ids(r.remove), '104');
  assert.strictEqual(r.add.length, 0);
});
t('tiebreak is earliest showing date', () => {
  const rows = [
    unit(201, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(202, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }),
    unit(203, { rent_ready: 'Yes', ready_for_showing_on: '2026-02-01', posted_to_website: 'Yes' }),
    unit(204, { rent_ready: 'Yes', ready_for_showing_on: '2026-04-01', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '204', 'latest date drops out');
});
t('blank showing dates sort LAST within a tier', () => {
  const rows = [
    unit(301, { rent_ready: 'Yes', posted_to_website: 'Yes' }),                                    // blank
    unit(302, { rent_ready: 'Yes', ready_for_showing_on: '2027-01-01', posted_to_website: 'Yes' }),
    unit(303, { rent_ready: 'Yes', ready_for_showing_on: '2027-02-01', posted_to_website: 'Yes' }),
    unit(304, { rent_ready: 'Yes', ready_for_showing_on: '2027-03-01', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '301', 'the blank-date unit is the one dropped');
});
t('ranking is stable across input order', () => {
  const rows = [
    unit(401, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(402, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(403, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(404, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
  ];
  const a = ids(run(rows).remove);
  const b = ids(run([...rows].reverse()).remove);
  assert.strictEqual(a, b, 'same input, different order, same answer');
});
t('cap is per floor plan per property', () => {
  const mk = (id, prop, type) => unit(id, { property_name: prop, unit_type: type, rent_ready: 'Yes', posted_to_website: 'Yes' });
  const rows = [
    mk(501, 'Oakwood', 'A1'), mk(502, 'Oakwood', 'A1'), mk(503, 'Oakwood', 'A1'), mk(504, 'Oakwood', 'A1'),
    mk(505, 'Oakwood', 'B1'), mk(506, 'Oakwood', 'B1'),
    mk(507, 'Elmwood', 'A1'), mk(508, 'Elmwood', 'A1'),
  ];
  const r = run(rows);
  assert.strictEqual(ids(r.remove), '504', 'only the A1@Oakwood overflow');
  assert.strictEqual(r.stats.floorPlanGroups, 3);
});

console.log('\nADD list');
t('unposted unit inside top 3 is an ADD', () => {
  const rows = [
    unit(601, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }),
    unit(602, { rent_ready: 'Yes', ready_for_showing_on: '2026-02-01' }),                            // unposted, ranks 2nd
    unit(603, { rent_ready: 'No', posted_to_website: 'Yes' }),
  ];
  const r = run(rows);
  assert.strictEqual(ids(r.add), '602');
  assert.strictEqual(r.remove.length, 0, 'only 3 units, nothing over cap');
});
t('a better unposted unit displaces a posted one', () => {
  // Confirmed behaviour: rank all, cap at 3. The unposted tier-1 unit takes a
  // slot and the worst posted unit falls out.
  const rows = [
    unit(701, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }),
    unit(702, { rent_ready: 'Yes', ready_for_showing_on: '2026-02-01', posted_to_website: 'Yes' }),
    unit(703, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(704, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-15' }),                            // unposted, ranks 2nd
  ];
  const r = run(rows);
  assert.strictEqual(ids(r.add), '704');
  assert.strictEqual(ids(r.remove), '703', 'worst posted unit is displaced');
});

console.log('\nVacant before Notice (within a tier)');
t('isVacantNow reads the status prefix', () => {
  assert.strictEqual(V.isVacantNow({ unit_status: 'Vacant-Unrented' }), true);
  assert.strictEqual(V.isVacantNow({ unit_status: 'Notice-Unrented' }), false);
  assert.strictEqual(V.isVacantNow({ unit_status: '' }), false);
});
t('THE 2936 CASE: an empty unit outranks an occupied one with a future date', () => {
  // Reproduces The Highlander exactly. 2936 is empty today and advertised;
  // 2910 is still occupied and cannot be toured until 2026-10-10. Before this
  // rule, "blanks last" ranked 2910 above 2936 and recommended the swap.
  const rows = [
    unit(2934, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-26', unit_status: 'Vacant-Unrented', posted_to_website: 'Yes' }),
    unit(2942, { rent_ready: 'Yes', ready_for_showing_on: '2026-04-07', unit_status: 'Vacant-Unrented', posted_to_website: 'Yes' }),
    unit(2910, { rent_ready: 'Yes', ready_for_showing_on: '2026-10-10', unit_status: 'Notice-Unrented' }),
    unit(2936, { rent_ready: 'Yes', ready_for_showing_on: null, unit_status: 'Vacant-Unrented', posted_to_website: 'Yes', posted_to_internet: 'Yes' }),
  ];
  const r = run(rows);
  assert.strictEqual(r.remove.length, 0, '2936 must NOT be removed — it is empty and advertised');
  assert.strictEqual(r.add.length, 0, '2910 must NOT be added — it is still occupied until October');
});
t('vacant wins even when the occupied unit has an earlier date', () => {
  // All four are tier 2 — every date is in the future, so the tier cannot be
  // what separates them. Then 1504, the only empty unit, takes a slot despite
  // having the latest date of the four, and the worst occupied unit drops out.
  const rows = [
    unit(1501, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-10-01', posted_to_website: 'Yes' }),
    unit(1502, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-10-02', posted_to_website: 'Yes' }),
    unit(1503, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-10-03', posted_to_website: 'Yes' }),
    unit(1504, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2027-12-31', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '1503');
});
t('within the same status, the date still decides', () => {
  const rows = [
    unit(1601, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }),
    unit(1602, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2026-02-01', posted_to_website: 'Yes' }),
    unit(1603, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(1604, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2026-04-01', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '1604', 'latest date still drops out');
});
t('within the same status, blanks still sort last', () => {
  const rows = [
    unit(1701, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', posted_to_website: 'Yes' }),   // blank
    unit(1702, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2027-01-01', posted_to_website: 'Yes' }),
    unit(1703, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2027-02-01', posted_to_website: 'Yes' }),
    unit(1704, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', ready_for_showing_on: '2027-03-01', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '1701', 'the blank-date unit still drops out');
});
t('status does not override the tier', () => {
  // A tier-1 occupied unit still beats a tier-2 vacant one: the new step sorts
  // WITHIN a tier, it does not jump tiers.
  const rows = [
    unit(1801, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-01-01', posted_to_website: 'Yes' }), // tier 1
    unit(1802, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-01-02', posted_to_website: 'Yes' }), // tier 1
    unit(1803, { rent_ready: 'Yes', unit_status: 'Notice-Unrented', ready_for_showing_on: '2026-01-03', posted_to_website: 'Yes' }), // tier 1
    unit(1804, { rent_ready: 'Yes', unit_status: 'Vacant-Unrented', posted_to_website: 'Yes' }),                                     // tier 2
  ];
  assert.strictEqual(ids(run(rows).remove), '1804', 'the tier-2 vacant unit is the one over cap');
});

console.log('\nTie stability');
t('a full tie prefers the already-posted unit', () => {
  // All four identical on every ranking signal — the posted one must survive.
  const mk = (id, posted) => unit(id, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-15', posted_to_website: posted ? 'Yes' : 'No' });
  const r = run([mk(1201, false), mk(1202, false), mk(1203, false), mk(1204, true)]);
  assert.strictEqual(r.remove.length, 0, 'must not pull a posted unit for an identical unposted one');
  assert.strictEqual(r.add.length, 2, 'fills the two remaining slots');
});
t('tie stability does not override the date tiebreak', () => {
  const rows = [
    unit(1301, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(1302, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(1303, { rent_ready: 'Yes', ready_for_showing_on: '2026-03-01', posted_to_website: 'Yes' }),
    unit(1304, { rent_ready: 'Yes', ready_for_showing_on: '2026-01-01' }),
  ];
  assert.strictEqual(ids(run(rows).add), '1304', 'an earlier date still beats posted status');
});

console.log('\nFloor plan fallback');
t('blank unit_type falls back to bed_and_bath', () => {
  assert.strictEqual(V.floorPlanKey({ unit_type: '', bed_and_bath: '2/1.00' }), '2/1.00 (by bed/bath)');
});
t('unit_type wins when present', () => {
  assert.strictEqual(V.floorPlanKey({ unit_type: 'A2', bed_and_bath: '1/1.00' }), 'A2');
});
t('both blank falls back to marker', () => {
  assert.strictEqual(V.floorPlanKey({}), '(unspecified)');
});
t('different bed/bath do not share a group', () => {
  const mk = (id, bb) => unit(id, { unit_type: '', bed_and_bath: bb, rent_ready: 'Yes', posted_to_website: 'Yes' });
  const rows = [mk(801, '1/1.00'), mk(802, '1/1.00'), mk(803, '1/1.00'), mk(804, '3/2.00')];
  const r = run(rows);
  assert.strictEqual(r.remove.length, 0, 'the 3-bed is its own floor plan, not a 4th 1-bed');
  assert.strictEqual(r.stats.floorPlanGroups, 2);
});

console.log('\nFloor-plan collapse (opt-in, pending Lyndsay)');
t('collapseFloorVariants strips the floor suffix', () => {
  assert.strictEqual(V.collapseFloorVariants('One Bedroom / One Bath 1st Floor'), 'One Bedroom / One Bath');
  assert.strictEqual(V.collapseFloorVariants('One Bedroom / One Bath 3rd Floor'), 'One Bedroom / One Bath');
  assert.strictEqual(V.collapseFloorVariants('Two Bedroom / Two Baths Medium 2nd Floor'), 'Two Bedroom / Two Baths Medium');
});
t('collapseFloorVariants leaves other names alone', () => {
  assert.strictEqual(V.collapseFloorVariants('A2'), 'A2');
  assert.strictEqual(V.collapseFloorVariants('1 Bedroom Renovated'), '1 Bedroom Renovated');
});
t('opting in merges the per-floor groups', () => {
  const mk = (id, type) => unit(id, { unit_type: type, rent_ready: 'Yes', posted_to_website: 'Yes' });
  const rows = [
    mk(1401, 'One Bed / One Bath 1st Floor'), mk(1402, 'One Bed / One Bath 1st Floor'),
    mk(1403, 'One Bed / One Bath 2nd Floor'), mk(1404, 'One Bed / One Bath 2nd Floor'),
  ];
  const off = V.analyzeVacancy(rows, { today: TODAY, isExcludedProperty });
  assert.strictEqual(off.stats.floorPlanGroups, 2);
  assert.strictEqual(off.remove.length, 0, 'two groups of two — nothing over cap');
  const on = V.analyzeVacancy(rows, { today: TODAY, isExcludedProperty, floorPlanNormalizer: V.collapseFloorVariants });
  assert.strictEqual(on.stats.floorPlanGroups, 1);
  assert.strictEqual(on.remove.length, 1, 'one group of four — the 4th is over cap');
});

console.log('\nOutput format');
t('removalIdList is bare comma-separated numeric ids', () => {
  const rows = [
    unit(901, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(902, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(903, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(904, { rent_ready: 'No', posted_to_website: 'Yes' }),
    unit(905, { rent_ready: 'No', posted_to_internet: 'Yes' }),
  ];
  const out = V.removalIdList(run(rows));
  assert.match(out, /^\d+(,\d+)*$/, 'digits and commas only: ' + out);
});
t('realmXPrompt matches the agreed wording', () => {
  const rows = [
    unit(1001, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(1002, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(1003, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(1004, { rent_ready: 'No', posted_to_website: 'Yes' }),
  ];
  assert.strictEqual(V.realmXPrompt(run(rows)), 'Bulk remove the following unit IDs: 1004. Click confirm.');
});
t('empty input does not throw', () => {
  const r = V.analyzeVacancy([], { today: TODAY, isExcludedProperty });
  assert.strictEqual(r.remove.length, 0);
  assert.strictEqual(V.removalIdList(r), '');
});
t('no removals yields an empty prompt, not a prompt with no ids', () => {
  // Reachable in production as of the vacant-before-notice fix: the live data
  // now produces zero removals, and "…unit IDs: . Click confirm." must never
  // be pasteable.
  const r = V.analyzeVacancy([unit(1901, { rent_ready: 'Yes', posted_to_website: 'Yes' })], { today: TODAY, isExcludedProperty });
  assert.strictEqual(r.remove.length, 0);
  assert.strictEqual(V.realmXPrompt(r), '');
});
t('posted_to_internet alone counts as posted', () => {
  const rows = [
    unit(1101, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(1102, { rent_ready: 'Yes', posted_to_website: 'Yes' }),
    unit(1103, { rent_ready: 'Yes', posted_to_website: 'Yes' }), unit(1104, { rent_ready: 'No', posted_to_internet: 'Yes' }),
  ];
  assert.strictEqual(ids(run(rows).remove), '1104');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
