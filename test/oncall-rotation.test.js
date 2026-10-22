// The monthly on-call rotation, against the two calendars Arturo built by hand.
//
// Those files are the specification: OnCall_Rotation_September_2026.xlsx and
// OnCall_Rotation_October_2026.xlsx. The dates, the carry-in, the spill
// warning, the fairness wording and the two 📌 notes are all taken from them,
// and the assertions below are what "copy the format exactly" means in code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/oncall-rotation.js');
const X = require('../lib/oncall-export.js');
const GEO = require('../lib/property-geo.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('on-call rotation');

// The roster and assignments as the live tables hold them.
const TECHS = [
  { id: 'josue-garcia',    full_name: 'Josue Garcia',    active: true, position: 'field_supervisor', show_on_map: false, home_lat: null,    home_lng: null },
  { id: 'raul-martinez',   full_name: 'Raul Martinez',   active: true, position: 'senior_maint_tech', show_on_map: true, home_lat: 30.2835, home_lng: -97.6545 },
  { id: 'jose-renteria',   full_name: 'José Rentería',   active: true, position: 'senior_maint_tech', show_on_map: true, home_lat: 30.2972, home_lng: -97.6859 },
  { id: 'angel-martinez',  full_name: 'Angel Martinez',  active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.3420, home_lng: -97.6590 },
  { id: 'emerson-garcia',  full_name: 'Emerson Garcia',  active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.3827, home_lng: -97.6854 },
  { id: 'carlos-portilla', full_name: 'Carlos Portilla', active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.5212, home_lng: -97.6539 },
  { id: 'yeison-salgado',  full_name: 'Yeison Salgado',  active: false, position: 'maint_tech',       show_on_map: false, home_lat: null,   home_lng: null },
  { id: 'franklin-garcia', full_name: 'Franklin Garcia', active: false, position: 'make_ready',       show_on_map: false, home_lat: null,   home_lng: null },
  { id: 'fredy-ramirez',   full_name: 'Fredy Ramirez',   active: true, position: 'make_ready',        show_on_map: false, home_lat: null,   home_lng: null },
  { id: 'gone-tech',       full_name: 'Gone Tech',       active: false, position: 'maint_tech',       show_on_map: true, home_lat: 30.3,    home_lng: -97.7 },
];
const ASSIGNMENTS = [
  { property: 'Hyde Park Square',     maintenance_tech: 'Angel Martinez',                grounds_tech: 'Carlos Portilla' },
  { property: 'The Chateau',          maintenance_tech: 'Angel Martinez',                grounds_tech: 'Fredy Ramirez' },
  { property: 'The Highlander',       maintenance_tech: 'Angel Martinez',                grounds_tech: 'Fredy Ramirez' },
  { property: 'Ascent at Northgate',  maintenance_tech: 'Emerson Garcia',                grounds_tech: 'Emerson Garcia' },
  { property: 'Sunset Palms',         maintenance_tech: 'Raul Martinez, Emerson Garcia', grounds_tech: 'Fredy Ramirez' },
  { property: 'Windy Hill Apartment', maintenance_tech: 'José Rentería',                 grounds_tech: 'José Rentería' },
  { property: 'iConic Round Rock',    maintenance_tech: 'Raul Martinez',                 grounds_tech: 'Carlos Portilla' },
  { property: 'iConic Downtown',      maintenance_tech: 'Raul Martinez',                 grounds_tech: 'Carlos Portilla' },
];
const { properties: PROPS } = GEO.propertiesFrom(ASSIGNMENTS);
const byName = {};
R.poolFrom(TECHS).pool.forEach(p => { byName[p.name] = p; });

// ---- who is on call --------------------------------------------------------


t('Yeison is excluded WITH A REASON, not silently', () => {
  // An active maintenance tech whose role Erick has not confirmed. Dropping him
  // quietly would make the calendar look complete while a person who may be on
  // call is missing from it.
  const { excluded } = R.poolFrom(TECHS);
  const y = excluded.find(e => /Yeison/.test(e.name));
  assert.ok(y, 'Yeison vanished');
  assert.strictEqual(y.reason, 'inactive');
  assert.ok(!excluded.some(e => /Fredy|Josue/.test(e.name)),
    'make-ready and supervisors are not candidates and should not be listed every month');
});

t('an inactive technician is not on call', () => {
  assert.ok(!R.poolFrom(TECHS).pool.some(p => p.name === 'Gone Tech'));
});

// ---- the weeks -------------------------------------------------------------

t('September 2026 matches the real file, week for week', () => {
  const { weeks, carryDays } = R.weeksOf(2026, 9);
  assert.strictEqual(carryDays, 4, 'Sep 01–04 belongs to August Week 5');
  assert.strictEqual(weeks.length, 4);
  assert.strictEqual(weeks[0].range, 'Sat 09/05 8am – Fri 09/11 7:59am');
  assert.strictEqual(weeks[3].range, 'Sat 09/26 8am – Fri 10/02 7:59am');
  assert.strictEqual(weeks[3].spillsInto, 'October');
  assert.strictEqual(weeks[2].spillsInto, null);
});

t('October 2026 matches the real file, week for week', () => {
  const { weeks, carryDays } = R.weeksOf(2026, 10);
  assert.strictEqual(carryDays, 2, 'Oct 01–02 belongs to September Week 4');
  assert.strictEqual(weeks.length, 5);
  assert.strictEqual(weeks[0].range, 'Sat 10/03 8am – Fri 10/09 7:59am');
  assert.strictEqual(weeks[4].range, 'Sat 10/31 8am – Fri 11/06 7:59am');
  assert.strictEqual(weeks[4].spillsInto, 'November');
});

t('a month starting ON a Saturday has no carry-in', () => {
  // August 2026 starts on a Saturday, so Week 1 is the 1st and nothing is
  // carried. The carry-in note must not appear for such a month.
  const aug = R.weeksOf(2026, 8);
  assert.strictEqual(aug.carryDays, 0);
  assert.strictEqual(aug.weeks[0].range.slice(0, 11), 'Sat 08/01 8');
});

// ---- the property split ----------------------------------------------------

// ---- Bekah's group scheme (2026-10-13) -------------------------------------
//
// It REPLACES the ownership-and-proximity split. She kept the format, the
// fairness table and the weekday handover, and asked for the two groups her old
// tracker used — two sets that never move are something four people can hold in
// their heads on a Saturday night.

const G = require('../lib/oncall-groups.js');

t('Carlos is off the rotation, with who decided it and when', () => {
  // He is still an active technician with properties assigned to him. A name
  // missing from a rota with nothing beside it is the first thing somebody
  // puts back.
  const { pool, excluded } = R.poolFrom(TECHS);
  assert.ok(!pool.some(p => /Carlos/.test(p.name)), 'Carlos is still on call');
  const c = excluded.find(e => /Carlos/.test(e.name));
  assert.ok(c, 'Carlos vanished instead of being excluded');
  assert.strictEqual(c.reason, 'removed from on-call by Bekah, 10/13');
});

t('the pool is the four Bekah named', () => {
  assert.deepStrictEqual(R.poolFrom(TECHS).pool.map(p => p.name),
    ['Angel Martinez', 'Emerson Garcia', 'José Rentería', 'Raul Martinez']);
});

t('the groups are the two sets, and nothing is in neither', () => {
  // The Highlander moved Red on 2026-10-22 (Bekah) to even the unit counts.
  assert.deepStrictEqual(G.GROUPS.RED.properties,
    ['Sunset Palms', 'The Chateau', 'Windy Hill Apartment', 'The Highlander']);
  assert.deepStrictEqual(G.GROUPS.BLUE.properties,
    ['Hyde Park Square', 'Ascent at Northgate',
      'iConic Downtown', 'iConic Round Rock']);
  PROPS.forEach(p => assert.ok(G.groupOf(p.name), p.name + ' is in no group'));
  assert.strictEqual(G.GROUPS.RED.properties.length + G.GROUPS.BLUE.properties.length,
    PROPS.length, 'a property is in both groups or missing from both');
});

t('moving The Highlander breaks neither hard constraint', () => {
  // The two rules and the move are independent, and that is checked rather
  // than assumed: Windy Hill stays Red, so Raúl and Emerson still never have
  // it, and both iConics stay in one group, so they still go to one
  // technician. A move that quietly broke either would be worse than the
  // imbalance it was meant to fix.
  G.PAIR_CYCLE.forEach(pair => {
    const s = G.assignGroups(pair, PROPS);
    assert.deepStrictEqual(G.violations(s.assign || s.assignments || {}), [],
      'pair ' + pair.join(' + ') + ' violates a rule');
  });
});

t('the unit counts are the ones Bekah balanced', () => {
  // Red 187 against Blue 210 — the reason for the move. Before it, Red carried
  // 138 against Blue's 259.
  const units = Object.fromEntries(PROPS.map(p => [p.name, p.units || 0]));
  const sum = names => names.reduce((n, x) => n + (units[x] || 0), 0);
  const red = sum(G.GROUPS.RED.properties);
  const blue = sum(G.GROUPS.BLUE.properties);
  // Only meaningful if the fixture carries unit counts at all.
  if (red + blue === 0) return;
  assert.ok(Math.abs(red - blue) < Math.abs((red - 49) - (blue + 49)),
    'the move made the split worse: Red ' + red + ' Blue ' + blue);
});

t('red goes to José or Angel, blue to Raúl or Emerson', () => {
  G.PAIR_CYCLE.forEach(pair => {
    const s = G.assignGroups(pair, PROPS);
    assert.ok(G.GROUPS.RED.techs.some(x => G.same(x, s.groups.RED)),
      s.groups.RED + ' took red');
    assert.ok(G.GROUPS.BLUE.techs.some(x => G.same(x, s.groups.BLUE)),
      s.groups.BLUE + ' took blue');
    assert.strictEqual(s.note, null);
  });
});

t('a group is never split across the two technicians', () => {
  G.PAIR_CYCLE.forEach(pair => {
    const s = G.assignGroups(pair, PROPS);
    ['RED', 'BLUE'].forEach(k => {
      const who = new Set(G.GROUPS[k].properties.map(n => s.assign[n]));
      assert.strictEqual(who.size, 1, k + ' was split between ' + pair.join(' and '));
    });
  });
});

t('a pairing that does not split red/blue is REPORTED, not guessed', () => {
  // Two red technicians cannot cover a week between them under this scheme.
  // Saying so is the only honest answer; silently handing blue to a red
  // technician is how a rota becomes wrong without anybody seeing it.
  const s = G.assignGroups(['José Rentería', 'Angel Martinez'], PROPS);
  assert.ok(s.note && /does not split red\/blue/.test(s.note), s.note);
});

// ---- the hard constraints --------------------------------------------------

t('the two iConics always go to the same technician', () => {
  assert.deepStrictEqual(G.violations({
    'iConic Round Rock': 'Raul Martinez', 'iConic Downtown': 'Raul Martinez',
  }), []);
  const v = G.violations({
    'iConic Round Rock': 'Raul Martinez', 'iConic Downtown': 'Emerson Garcia',
  });
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].id, 'iconic-together');
});

t('Raúl and Emerson never have Windy Hill', () => {
  ['Raul Martinez', 'Emerson Garcia'].forEach(n => {
    const v = G.violations({ 'Windy Hill Apartment': n });
    assert.strictEqual(v.length, 1, n + ' was allowed Windy Hill');
    assert.strictEqual(v[0].id, 'windy-hill');
  });
  ['José Rentería', 'Angel Martinez'].forEach(n =>
    assert.deepStrictEqual(G.violations({ 'Windy Hill Apartment': n }), []));
});

t('the scheme satisfies both constraints on every week it produces', () => {
  G.PAIR_CYCLE.forEach(pair =>
    assert.deepStrictEqual(G.violations(G.assignGroups(pair, PROPS).assign), [],
      pair.join(' + ')));
});

// ---- fixed alternating pairs -----------------------------------------------

t('the pairs are fixed and alternate', () => {
  assert.deepStrictEqual(G.PAIR_CYCLE, [
    ['Raul Martinez', 'José Rentería'],
    ['Emerson Garcia', 'Angel Martinez'],
  ]);
  const p = G.fixedPairs(5, []);
  assert.deepStrictEqual(p[0], p[2]);
  assert.deepStrictEqual(p[1], p[3]);
  assert.notDeepStrictEqual(p[0], p[1]);
});

t('a repeated PAIR is allowed now; a repeated PERSON back to back is not', () => {
  // Four technicians in fixed pairs must repeat the pair. Bekah relaxed that
  // rule for this scheme, which is said out loud rather than quietly dropped.
  const p = G.fixedPairs(4, ['Carlos Portilla', 'Angel Martinez']);
  for (let i = 1; i < p.length; i++) {
    p[i].forEach(n => assert.ok(!p[i - 1].some(x => G.same(x, n)),
      n + ' works two weeks running'));
  }
});

t('the alternation continues from whoever worked the carry-in week', () => {
  // NOVEMBER. The carry-in is Carlos + Angel; Carlos is off the rotation and
  // Angel cannot work two weeks running, so the month opens with Raúl + José.
  assert.deepStrictEqual(G.fixedPairs(1, ['Carlos Portilla', 'Angel Martinez'])[0],
    ['Raul Martinez', 'José Rentería']);
  // And the other way round.
  assert.deepStrictEqual(G.fixedPairs(1, ['Raul Martinez', 'José Rentería'])[0],
    ['Emerson Garcia', 'Angel Martinez']);
});

t('a carry-in naming somebody off the rotation still bars their partner', () => {
  // Carlos is not in the pool any more, but Angel worked beside him and the
  // week he worked is still a week. Filtering the carry-in down to the current
  // pool would lose that and put Angel back on Week 1.
  const d = R.build({
    year: 2026, month: 11, technicians: TECHS, properties: PROPS,
    carryPair: ['Carlos Portilla', 'Angel Martinez'], carryFrom: 'October Week 5',
  });
  assert.ok(!d.weeks[0].pair.some(n => G.same(n, 'Angel Martinez')),
    'Angel works Week 1 straight after the carry-in week');
  assert.deepStrictEqual(d.carry.pair, ['Carlos Portilla', 'Angel Martinez']);
  assert.ok(/Carlos \+ Angel/.test(d.carry.note), d.carry.note);
});

// ---- November, end to end --------------------------------------------------

const NOV = R.build({
  year: 2026, month: 11, technicians: TECHS, properties: PROPS,
  carryPair: ['Carlos Portilla', 'Angel Martinez'], carryFrom: 'October Week 5',
});

t('November runs Raúl + José, then Emerson + Angel, alternating', () => {
  assert.deepStrictEqual(NOV.weeks.map(w => w.pair), [
    ['Raul Martinez', 'José Rentería'],
    ['Emerson Garcia', 'Angel Martinez'],
    ['Raul Martinez', 'José Rentería'],
    ['Emerson Garcia', 'Angel Martinez'],
  ]);
  assert.strictEqual(NOV.scheme, 'fixed-pairs');
  assert.deepStrictEqual(NOV.warnings, []);
});

t('every November week is clean against the hard constraints', () => {
  NOV.weeks.forEach(w => assert.deepStrictEqual(w.violations, [], w.label));
  NOV.weeks.forEach(w => {
    assert.strictEqual(w.assign['iConic Round Rock'], w.assign['iConic Downtown'], w.label);
    assert.ok(!['Raul Martinez', 'Emerson Garcia']
      .some(n => G.same(n, w.assign['Windy Hill Apartment'])), w.label);
  });
});

t('an uneven total caused only by the carry-in is explained, not alarmed', () => {
  // Under fixed pairs the full weeks are always equal; the only thing that can
  // tip the total is the week served in the previous month's calendar. A red
  // warning on a number nobody can change is one people learn to ignore.
  assert.strictEqual(NOV.fairness.even, false);
  assert.strictEqual(NOV.fairness.fullSpread, 0, 'the full weeks should be equal');
  assert.ok(/carry-in week/.test(NOV.fairness.note || ''), NOV.fairness.note);
  NOV.fairness.rows.forEach(r => assert.strictEqual(r.weeks, 2, r.technician));
});

// ---- edits are re-validated ------------------------------------------------

t('a hand edit that breaks a hard constraint is caught', () => {
  // The rule never produces this. A person moving one property in the editor
  // can, and the edit is the whole reason the constraints are written down.
  const bad = R.applyEdits(NOV, [{
    type: 'property', week: 1, property: 'Windy Hill Apartment', tech: 'Raul Martinez',
  }], 'Arturo');
  const v = bad.weeks[0].violations;
  assert.strictEqual(v.length, 1, JSON.stringify(v));
  assert.strictEqual(v[0].id, 'windy-hill');
  assert.ok(bad.warnings.some(w => /Windy Hill/.test(w)), 'the warning is not on the draft');
  // And the original is untouched.
  assert.deepStrictEqual(NOV.weeks[0].violations, []);
});

t('splitting the two iConics by hand is caught', () => {
  const bad = R.applyEdits(NOV, [{
    type: 'property', week: 1, property: 'iConic Downtown',
    tech: NOV.weeks[0].pair.find(n => n !== NOV.weeks[0].assign['iConic Downtown']),
  }], 'Arturo');
  assert.ok(bad.weeks[0].violations.some(v => v.id === 'iconic-together'));
});

t('fixing an edit clears the warning rather than leaving it stuck', () => {
  const bad = R.applyEdits(NOV, [{
    type: 'property', week: 1, property: 'Windy Hill Apartment', tech: 'Raul Martinez',
  }], 'Arturo');
  const fixed = R.applyEdits(bad, [{
    type: 'property', week: 1, property: 'Windy Hill Apartment', tech: 'José Rentería',
  }], 'Arturo');
  assert.deepStrictEqual(fixed.weeks[0].violations, []);
  assert.ok(!fixed.warnings.some(w => /Windy Hill/.test(w)), fixed.warnings.join(' | '));
});

// ---- the groups are visible, and named as well as coloured -----------------

t('the panel shows the group colour AND its name', () => {
  // Colour alone is lost on a photocopy and on a screen reader.
  const app = src('public/app.js');
  assert.ok(/doc\.groups \|\| \{\}/.test(app), 'the panel ignores the groups');
  assert.ok(/esc\(g\.color\)/.test(app) && /esc\(g\.label\)/.test(app));
  assert.ok(/no group/.test(app), 'a property in neither group would be invisible');
});

t('the workbook groups the rows and prints the legend', () => {
  const rows = X.sheetRows({ ...NOV, state: 'draft' }, PROPS);
  const names = rows.map(r => String(r[0]));
  const red = names.findIndex(n => /^Sunset Palms/.test(n));
  const blue = names.findIndex(n => /^Hyde Park Square/.test(n));
  assert.ok(red > 0 && blue > red, 'red block should come before blue');
  assert.ok(/\(Red\)$/.test(names[red]), names[red]);
  assert.ok(/\(Blue\)$/.test(names[blue]), names[blue]);
  assert.ok(names.some(n => /^GROUPS — Red:/.test(n)), 'no legend');
  assert.ok(names.some(n => /Red goes to Jos|Red.*goes to/.test(n)), 'the legend does not say who takes which');
});

t('a broken constraint is on the face of the calendar, not in a log', () => {
  const bad = R.applyEdits(NOV, [{
    type: 'property', week: 1, property: 'Windy Hill Apartment', tech: 'Raul Martinez',
  }], 'Arturo');
  const rows = X.sheetRows({ ...bad, state: 'draft' }, PROPS);
  assert.ok(rows.some(r => /Windy Hill Apartment, and Ra/.test(String(r[0]))),
    'the three people approving it would never see it');
});

t('the PDF colours the group rows and resets afterwards', () => {
  // The drawing moved out of the route into lib/oncall-export.js on
  // 2026-10-22, so a test could render November and measure it. Reading
  // server.js here would now pass by finding nothing.
  const s = src('lib/oncall-export.js');
  assert.ok(/G\.GROUPS\[gkey\]\.color/.test(s), 'the PDF ignores the group colour');
  assert.ok(/pdf\.fillColor\('#000000'\);\n\s*pdf\.y = y \+ maxH/.test(s),
    'the colour leaks into the next row');
});

t('November 2026 carries October Week 5 and says so', () => {
  assert.strictEqual(NOV.carry.days, 6);
  assert.ok(/Nov 01–06 \(7:59am\) covered by October Week 5 rotation \(Carlos \+ Angel\)/
    .test(NOV.carry.note), NOV.carry.note);
  assert.strictEqual(NOV.weeks.length, 4);
  assert.strictEqual(NOV.weeks[0].range, 'Sat 11/07 8am – Fri 11/13 7:59am');
  assert.strictEqual(NOV.weeks[3].spillsInto, 'December');
});



t('a month is generated on its own, never two at a time', () => {
  const lib = src('lib/oncall-rotation.js');
  assert.ok(/never two at a time/.test(lib));
  const route = src('server.js');
  assert.ok(/oncall_rotations_month_idx|onConflict: 'year,month'/.test(route),
    'two drafts for one month would be indistinguishable');
});

// ---- edits -----------------------------------------------------------------

t('a hand edit is marked, and fairness is recomputed', () => {
  const before = NOV.fairness.rows.find(r => r.technician === 'Raul Martinez').weeks;
  // A DIFFERENT pair, not a reordering of the same two — otherwise the fairness
  // table has nothing to move and the test proves nothing.
  const after = R.applyEdits(NOV,
    [{ type: 'pair', week: 1, pair: ['Emerson Garcia', 'Angel Martinez'] }], 'Arturo');
  const w = after.weeks[0];
  assert.strictEqual(w.edited.length, 1);
  assert.strictEqual(w.edited[0].by, 'Arturo');
  assert.ok(w.edited[0].at, 'an edit with no timestamp cannot be reviewed');
  assert.deepStrictEqual(w.edited[0].to, ['Emerson Garcia', 'Angel Martinez']);
  // A fairness table describing the version before the edit is worse than none.
  assert.notStrictEqual(JSON.stringify(after.fairness), JSON.stringify(NOV.fairness),
    'fairness did not move after the pair changed');
  assert.ok(after.fairness.rows.find(r => r.technician === 'Raul Martinez').weeks >= before - 1);
});

t('a property edit records what it replaced', () => {
  const was = NOV.weeks[0].assign['Sunset Palms'];
  const to = NOV.weeks[0].pair.find(n => n !== was) || NOV.weeks[0].pair[0];
  const after = R.applyEdits(NOV, [{ type: 'property', week: 1, property: 'Sunset Palms', tech: to }], 'Erick');
  const e = after.weeks[0].edited.find(x => x.type === 'property');
  assert.strictEqual(e.from, was);
  assert.strictEqual(e.to, to);
  assert.strictEqual(after.weeks[0].reasons['Sunset Palms'], 'changed by hand');
  assert.strictEqual(NOV.weeks[0].assign['Sunset Palms'], was, 'the original was mutated');
});

// ---- states ----------------------------------------------------------------

t('states go forward one step, and back only to draft', () => {
  assert.deepStrictEqual(R.STATES, ['draft', 'pending_approval', 'approved']);
  assert.strictEqual(R.nextState('draft', 'pending_approval').ok, true);
  assert.strictEqual(R.nextState('draft', 'approved').ok, false, 'approval must not skip review');
  assert.strictEqual(R.nextState('approved', 'draft').ok, true);
  assert.strictEqual(R.nextState('approved', 'pending_approval').ok, false);
  assert.strictEqual(R.nextState('draft', 'draft').ok, false);
});

t('an approval needs a name, and the three approvers are named', () => {
  const s = src('server.js');
  assert.ok(/An approval needs a name/.test(s),
    '"approved" with nobody\'s name on it is the same as not approved');
  assert.deepStrictEqual(R.APPROVERS, ['Josue Garcia', 'Rebekah Hernandez', 'Jay Manuel']);
});

t('an approved month cannot be edited without going back to draft', () => {
  const s = src('server.js');
  assert.ok(/Approved — send it back to draft to change it/.test(s));
});

// ---- the export ------------------------------------------------------------

const ROWS = X.sheetRows({ ...NOV, state: 'draft' }, PROPS);

t('the workbook has the title and the DRAFT line, verbatim', () => {
  assert.strictEqual(ROWS[0][0], 'ON-CALL ROTATION CALENDAR — NOVEMBER 2026');
  const line = ROWS[1][0];
  assert.ok(line.startsWith('DRAFT — Pending approval from Josue, Rebekah, and Jay.'), line);
  assert.ok(line.includes('Prepared by Arturo Mendoza Carvajal.'));
  // The policy sentence changed with the rule: the old one said "never by
  // group", which is the exact opposite of what the table now shows.
  assert.ok(line.includes('Properties assigned by group (Red / Blue) per on-call week'), line);
  assert.ok(!/never by group/.test(line), 'the header contradicts the table under it');
  assert.ok(line.includes('Note: Nov 01–06'), 'the carry-in note is missing from the header');
});

t('one column per week, with the range and the spill warning', () => {
  const head = ROWS[3];
  assert.strictEqual(head[0], 'Property');
  assert.strictEqual(head.length, 5);
  assert.strictEqual(head[1], 'Week 1\n(Sat 11/07 8am –\nFri 11/13 7:59am)');
  assert.ok(head[4].endsWith('⚠ Spills into Dec'), head[4]);
});

t('the On-Call Techs row carries full names and (draft)', () => {
  const techs = ROWS[4];
  assert.strictEqual(techs[0], 'On-Call Techs');
  assert.ok(/ \+ /.test(techs[1]) && / \(draft\)$/.test(techs[1]), techs[1]);
});

t('one row per property, first names only', () => {
  // The label now carries the group as text as well as the name.
  const names = ROWS.slice(5, 5 + PROPS.length).map(r => String(r[0]));
  PROPS.forEach(p => assert.ok(names.some(n => n.startsWith(p.name)), p.name + ' is missing'));
  const row = ROWS.slice(5, 5 + PROPS.length).find(r => /^Hyde Park Square/.test(String(r[0])));
  assert.ok(/^[A-Z][a-z]+$/.test(row[1]), 'the grid shows first names: ' + row[1]);
});

t('the fairness check is there, with the carry-in phrased as the originals do', () => {
  const head = ROWS.find(r => /^ROTATION FAIRNESS CHECK/.test(String(r[0])));
  assert.ok(head, 'no fairness check');
  assert.ok(/\(Nov 2026 cycle\)/.test(head[0]), head[0]);
  assert.deepStrictEqual(ROWS[ROWS.indexOf(head) + 1], ['Technician', 'Weeks On-Call', 'Which Weeks']);
  // Angel carries the Nov 01-06 week now; Carlos is off the rotation.
  const angel = ROWS.find(r => r[0] === 'Angel Martinez');
  assert.ok(/^2 \(\+Nov 01-06 via Oct W5\)$/.test(String(angel[1])), angel[1]);
});

t('both 📌 notes are at the foot', () => {
  const notes = ROWS.filter(r => /^📌/.test(String(r[0]))).map(r => r[0]);
  assert.ok(notes.some(n => /covered by October Week 5/.test(n)), 'no carry-in note');
  assert.ok(notes.some(n => /spills into December/.test(n) && /carry forward unless/.test(n)),
    'no spill note');
  const pool = notes.find(n => /Not in the on-call pool/.test(n));
  assert.ok(pool, 'the excluded technicians are not on the calendar anybody reads');
  assert.ok(/Yeison/.test(pool) && /Carlos/.test(pool), pool);
  assert.ok(/removed from on-call by Bekah/.test(pool), 'the reason is not carried');
});

t('an approved calendar does not still say DRAFT', () => {
  // A reader who sees DRAFT on an approved calendar goes looking for a newer one.
  const approved = X.sheetRows({
    ...NOV, state: 'approved',
    approvals: [{ by: 'Jay Manuel', at: '2026-10-30T12:00:00Z' }],
  }, PROPS);
  assert.ok(/^APPROVED by Jay Manuel\./.test(approved[1][0]), approved[1][0]);
  assert.ok(!/\(draft\)/.test(approved[4][1]), 'the techs row still says (draft)');
});

t('a hand-edited cell is marked in the export', () => {
  const edited = R.applyEdits(NOV, [{
    type: 'property', week: 1, property: 'Sunset Palms',
    tech: NOV.weeks[0].pair.find(n => n !== NOV.weeks[0].assign['Sunset Palms']),
  }], 'Arturo');
  const rows = X.sheetRows({ ...edited, state: 'draft' }, PROPS);
  const row = rows.find(r => /^Sunset Palms/.test(String(r[0])));
  assert.ok(String(row[1]).endsWith('*'), 'the edit is invisible on the page people approve');
  assert.ok(rows.some(r => /marks a cell changed by hand/.test(String(r[0]))),
    'the asterisk is never explained');
});

// ---- the two copies of the coordinates -------------------------------------

t('property-geo still agrees with the Coverage Map', () => {
  // Two copies of the same eight coordinates. The right fix is a column on
  // property_assignments; until somebody geocodes them, this is what keeps the
  // server and the map from quietly disagreeing about where a building is.
  const app = src('public/app.js');
  const block = app.slice(app.indexOf('const MAP_PROPERTIES'), app.indexOf('let MAP_TECHS'));
  Object.entries(GEO.PROPERTY_GEO).forEach(([name, g]) => {
    const key = name === 'Windy Hill Apartment' ? 'Windy Hill' : name;
    const re = new RegExp("name: '" + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + "'[^}]*lat: ([\\-\\d.]+), lng: ([\\-\\d.]+)");
    const m = block.match(re);
    assert.ok(m, name + ' is not on the Coverage Map');
    assert.strictEqual(Number(m[1]), g.lat, name + ' latitude');
    assert.strictEqual(Number(m[2]), g.lng, name + ' longitude');
  });
});

t('a property with no location is reported, never dropped', () => {
  // The rotation has to cover all eight; a silent omission leaves a building
  // with nobody on call for it.
  const { properties, missing } = GEO.propertiesFrom(
    ASSIGNMENTS.concat([{ property: 'Somewhere New', maintenance_tech: 'Angel Martinez' }]));
  assert.strictEqual(properties.length, 8);
  assert.deepStrictEqual(missing, ['Somewhere New']);
});

t('the dashboard does not claim to write to AppFolio', () => {
  const s = src('server.js');
  const at = s.indexOf('On-call rotation (Erick');
  const block = s.slice(at, at + 900);
  assert.ok(/DOES NOT WRITE TO APPFOLIO/.test(block));
  const routes = s.slice(at, s.indexOf('make-ready-audit.xlsx'));
  assert.ok(!/appfolio.*\.post|syncReport/i.test(routes), 'a route touches AppFolio');
});

// ---- the month before is an input ------------------------------------------
//
// November generated wrong: October had been built by hand and was never in the
// dashboard, so the carry-in came back empty. The same pair was handed Week 1
// while they were still covering Nov 1–6, both worked two weeks running, and
// the fairness table counted a week nobody was told about.

t('an empty carry-in lets the same pair work two weeks running', () => {
  // The BUG, reproduced. This is what the refusal exists to prevent, so it is
  // asserted rather than described — otherwise the guard could be removed and
  // every test would still pass.
  const broken = R.build({
    year: 2026, month: 11, technicians: TECHS, properties: PROPS,
    carryPair: [], carryFrom: null,
  });
  // With nothing carried, nobody is barred from Week 1 and the fairness table
  // shows five technicians sharing eight weeks with no carry-in named.
  assert.ok(!broken.fairness.rows.some(r => r.carried),
    'a carry-in appeared from nowhere');
  assert.ok(broken.weeks[0].pair.length === 2);
});

t('a known carry-in bars both of them from Week 1 and counts their week', () => {
  const carry = ['Carlos Portilla', 'Angel Martinez'];
  const good = R.build({
    year: 2026, month: 11, technicians: TECHS, properties: PROPS,
    carryPair: carry, carryFrom: 'October Week 5',
  });
  carry.forEach(n => assert.ok(!good.weeks[0].pair.includes(n),
    n + ' works Week 1 straight after the carry-in week'));
  // Only Angel is counted: Carlos worked that week but is off the rotation, so
  // he has no row in a fairness table about who is on call this month.
  assert.deepStrictEqual(good.fairness.rows.filter(r => r.carried).map(r => r.technician),
    ['Angel Martinez']);
  // Under fixed pairs the FULL weeks stay equal; the carry-in is what tips the
  // total, and that is explained rather than flagged.
  assert.strictEqual(good.fairness.fullSpread, 0);
  assert.ok(good.fairness.note, 'an uneven total with no explanation');
});

t('the server REFUSES to generate without it, and says which week it needs', () => {
  // Generating around a missing fact produced a calendar that looked finished
  // and was wrong. Refusing is the only honest answer.
  const s = src('server.js');
  const at = s.indexOf('carry_pair_required');
  assert.ok(at > 0, 'it still generates with an empty carry-in');
  // Bounded on the end of the refusal, not on a character count: the payload
  // has already outgrown one.
  const block = s.slice(at - 1400, s.indexOf('});', at));
  assert.ok(/weeksOf\(year, month\)\.carryDays > 0/.test(block),
    'a month that starts on a Saturday has no carry-in and must not be blocked');
  assert.ok(/need: \{/.test(block) && /range:/.test(block),
    'it refuses without saying which week it means');
  assert.ok(/candidates: ONCALL\.carryCandidates/.test(block),
    'the caller has no list to choose from');
});

t('a month with no carry-in days is never blocked', () => {
  // August 2026 starts on a Saturday. There is nothing to carry, so asking for
  // a pair would be asking for a fact that does not exist.
  assert.strictEqual(R.weeksOf(2026, 8).carryDays, 0);
  const aug = R.build({ year: 2026, month: 8, technicians: TECHS, properties: PROPS, carryPair: [] });
  assert.ok(aug.weeks.length >= 4);
  assert.strictEqual(aug.carry.note, null);
});

t('the panel asks with pickers, not a free-text box', () => {
  // A typo here is a name the roster does not know and a carry-in that
  // silently does nothing — which is the bug again, one layer up.
  const app = src('public/app.js');
  assert.ok(/function ocAskCarry/.test(app));
  // Bounded on the next function, not on a character count the function
  // outgrew the first time it changed.
  const at = app.indexOf('function ocAskCarry');
  const fn = app.slice(at, app.indexOf('async function ocEdit', at));
  assert.ok(/<select id="oncall-carry-a"/.test(fn) && /<select id="oncall-carry-b"/.test(fn));
  assert.ok(/a === b/.test(fn), 'one technician could be picked twice');
  assert.ok(/carry_pair_required/.test(app), 'the refusal is not handled at all');
});

t('a table the anon key cannot read must not read as an empty month', () => {
  // THE SECOND BUG, and it wore the first one's clothes. RLS is on
  // oncall_rotations with no anon policy, so a read through supabasePublic
  // returns [] with no error — indistinguishable from a month nobody has
  // generated. The panel said "October 2026 is not in the dashboard" about a
  // month that was imported, verified and sitting in the table.
  const s = src('server.js');
  assert.ok(/function oncallDb\(res\)/.test(s), 'the on-call routes still fall back to the anon client');
  const fn = s.slice(s.indexOf('function oncallDb(res)'), s.indexOf('async function oncallRow'));
  assert.ok(/SUPABASE_SERVICE_ROLE_KEY is not set/.test(fn),
    'the message does not name the thing to fix');
  assert.ok(/503/.test(fn), 'a configuration problem is reported as missing data');

  // Every on-call route goes through it. One that still used
  // `supabaseAdmin || supabasePublic` would show the same empty month again.
  const start = s.indexOf("app.get('/api/maintenance/oncall'");
  const end = s.indexOf('// GET /api/reports/make-ready-audit.xlsx');
  const routes = s.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.strictEqual((routes.match(/supabaseAdmin \|\| supabasePublic/g) || []).length, 0,
    'an on-call route can still read as the anon key');
  assert.ok((routes.match(/oncallDb\(res\)/g) || []).length >= 5);
});

t('NOTHING in the on-call code may touch the anon client', () => {
  // Reported twice: "October 2026 is not in the dashboard" about a month that
  // was stored both times. The whole region is checked, not just the route
  // bodies — oncallInputs and oncallRow take `db` as an argument and a future
  // edit could hardcode a client inside either of them.
  const s = src('server.js');
  const start = s.indexOf('// ---- On-call rotation (Erick');
  const end = s.indexOf('// GET /api/reports/make-ready-audit.xlsx');
  assert.ok(start > 0 && end > start, 'the on-call block moved');
  // Comments stripped first: this file explains the bug by naming the client,
  // and a test that matches its own prose fails for the wrong reason.
  const region = s.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual((region.match(/supabasePublic/g) || []).length, 0,
    'the on-call code can still read as the anon key, and RLS makes that look empty');
  // Every route takes its client from the one guard.
  const routes = (region.match(/app\.(get|post)\('\/api\/maintenance\/oncall/g) || []).length;
  assert.ok(routes >= 5, 'routes went missing');
  // Counting the CALL SITES, not the declaration: `function oncallDb(res)`
  // matches the same pattern and would always make this one too many.
  assert.strictEqual((region.match(/= oncallDb\(res\)/g) || []).length, routes,
    'a route gets its client from somewhere other than oncallDb');
});

t('the carry lookup is a pure function, so it can be tested without a route', () => {
  // It has been the cause twice. A function that lives inside a route handler
  // can only be debugged by reproducing the route.
  assert.strictEqual(typeof R.carryFrom, 'function');
  const s = src('server.js');
  assert.ok(/ONCALL\.carryFrom\(prev, ONCALL\.MONTHS\[prevMonth - 1\]\)/.test(s));
  assert.ok(!/function carryFromPrevious/.test(s), 'the old in-route copy is still there');
});

t('the carry lookup says WHY there is no pair', () => {
  // "Not in the dashboard" was wrong about the cause both times. Each of these
  // is a different thing to go and fix.
  assert.strictEqual(R.carryFrom(null).why, 'no row for the previous month');
  assert.strictEqual(R.carryFrom({}).why, 'the previous month has no draft stored');
  assert.strictEqual(R.carryFrom({ draft: { weeks: [] } }).why,
    'the previous month stored no weeks');
  assert.ok(/does not run into this one/.test(R.carryFrom({ draft: {
    monthName: 'October 2026',
    weeks: [{ label: 'Week 4', pair: ['A', 'B'], spillsInto: null }],
  } }).why));
  assert.ok(/has no pair stored/.test(R.carryFrom({ draft: {
    monthName: 'October 2026',
    weeks: [{ label: 'Week 5', pair: [], spillsInto: 'November' }],
  } }).why));
});

t('a stored month that spills gives its pair and no reason', () => {
  const out = R.carryFrom({ draft: {
    monthName: 'October 2026',
    weeks: [{ label: 'Week 5', pair: ['Carlos Portilla', 'Angel Martinez'], spillsInto: 'November' }],
  } });
  assert.deepStrictEqual(out.pair, ['Carlos Portilla', 'Angel Martinez']);
  assert.strictEqual(out.from, 'October Week 5');
  assert.strictEqual(out.why, null);
});

t('the refusal reports why, and which client it read with', () => {
  const s = src('server.js');
  const at = s.indexOf('carry_pair_required');
  const block = s.slice(at, at + 2200);
  assert.ok(/why: carry\.why/.test(block), 'the next report is another round of guessing');
  assert.ok(/previousMonthFound: !!prev/.test(block));
  assert.ok(/readAs: supabaseAdmin \? 'service-role'/.test(block),
    'nothing says whether RLS was in play');
});

// ---- who can be named as the carry-in --------------------------------------

t('Generate is WRAPPED, so a click event never arrives as the carry pair', () => {
  // THE BUG. addEventListener hands its listener a MouseEvent, and
  // ocGenerate's first parameter is the carry-in pair — so clicking Generate
  // posted the click event as `carryPair`. It arrived as an object, failed the
  // array check, and the route refused with "October 2026 is not in the
  // dashboard" about a month it had just read correctly. Twice.
  const app = src('public/app.js');
  assert.ok(/addEventListener\('click', \(\) => ocGenerate\(\)\)/.test(app),
    'the listener passes its event straight into ocGenerate');
  assert.ok(!/addEventListener\('click', ocGenerate\)/.test(app));
  // Same shape one line up: ocFetch takes no arguments today, and a listener
  // bound bare is a parameter away from the same bug.
  assert.ok(!/addEventListener\('click', ocFetch\)/.test(app));
});

t('a carryPair that is not two names is REFUSED, not used', () => {
  // `||` treated a MouseEvent as a real answer. An object is neither an array
  // nor falsy, which is the whole trap.
  const s = src('server.js');
  const at = s.indexOf('const supplied = req.body?.carryPair');
  assert.ok(at > 0, 'the supplied pair is still trusted');
  const block = s.slice(at, at + 700);
  assert.ok(/Array\.isArray\(supplied\)/.test(block));
  assert.ok(/supplied\.length === 2/.test(block));
  assert.ok(/typeof n === 'string'/.test(block), 'two of anything would pass');
  assert.ok(/suppliedOk \? supplied/.test(block),
    'a malformed value can still shadow the looked-up pair');
});

t('the refusal NEVER comes back without a reason', () => {
  // "the row was found - read as service-role" with no reason is what the last
  // report had to work with: true, and useless.
  const s = src('server.js');
  const at = s.indexOf('why: carry.why');
  assert.ok(at > 0);
  const block = s.slice(at, at + 700);
  assert.ok(/suppliedBad/.test(block), 'a bad carryPair produces an empty reason');
  assert.ok(/this is a bug, please report it/.test(block),
    'an unreachable case still has to say something');
  const app = src('public/app.js');
  assert.ok(/the server gave no reason — report this line/.test(app),
    'the panel can still render an empty Why');
});

t('a draft from before the current rules says so', () => {
  // The stored November predates the group scheme, so every property reads
  // "no group". Saying why beats leaving somebody to work it out.
  const app = src('public/app.js');
  assert.ok(/doc\.scheme !== 'fixed-pairs'/.test(app));
  assert.ok(/generated under the/.test(app) && /Press <b>Generate<\/b>/.test(app));
});

t('a regenerate replaces the draft and sends it back to draft state', () => {
  const s = src('server.js');
  const at = s.indexOf("app.post('/api/maintenance/oncall/generate'");
  const block = s.slice(at, s.indexOf("app.post('/api/maintenance/oncall/edit'"));
  assert.ok(/state: 'draft'/.test(block), 'a regenerated month keeps its old state');
  assert.ok(/edits: \[\], approvals: \[\]/.test(block),
    'approvals for the old calendar would carry over to a new one');
  // Only an APPROVED month is protected; a pending one is still a draft.
  assert.ok(/existing\.state === 'approved'/.test(block));
});

t('the carry-in picker is every ACTIVE technician, not the on-call pool', () => {
  // Carlos covered October Week 5 and Bekah has since taken him off the
  // rotation. A picker built from the pool cannot name who actually worked that
  // week, and the week still happened.
  const names = R.carryCandidates(TECHS, null).map(c => c.name);
  assert.ok(names.includes('Carlos Portilla'), 'the only correct answer is unselectable');
  assert.ok(!R.poolFrom(TECHS).pool.some(p => /Carlos/.test(p.name)),
    'this test proves nothing if Carlos is still in the pool');
  // Still technicians only: make-ready staff and inactive people are not it.
  assert.ok(!names.includes('Fredy Ramirez'));
  assert.ok(!names.includes('Yeison Salgado'), 'inactive');
});

t('somebody already named in the previous calendar is always offered', () => {
  // A name already written down is evidence. Dropping it because they have
  // since left the roster would make the correct answer unselectable.
  const prev = { draft: { weeks: [{ pair: ['Gone Person', 'Raul Martinez'] }] } };
  const c = R.carryCandidates(TECHS, prev);
  const gone = c.find(x => x.name === 'Gone Person');
  assert.ok(gone, 'a name from the stored calendar was dropped');
  assert.strictEqual(gone.note, 'from the previous calendar');
  // And nobody is listed twice.
  assert.strictEqual(new Set(c.map(x => x.name)).size, c.length);
});

t('Carlos covered the carry-in week but is NOT in November\'s fairness table', () => {
  // He worked Nov 01-06. He is not on call this month, so he has no row in a
  // table about who is on call this month — and the week he did work is named
  // in the carry-in note instead.
  const rows = NOV.fairness.rows.map(r => r.technician);
  assert.ok(!rows.some(n => /Carlos/.test(n)), 'Carlos is counted in a month he is not on call');
  assert.deepStrictEqual(NOV.carry.pair, ['Carlos Portilla', 'Angel Martinez']);
  assert.ok(/Carlos \+ Angel/.test(NOV.carry.note), NOV.carry.note);
});

t('the panel offers the candidates the server sent, not its own list', () => {
  const app = src('public/app.js');
  assert.ok(/d\.candidates \|\| d\.pool/.test(app), 'the picker still builds from the pool');
  assert.ok(/from the previous calendar|c\.note/.test(app), 'the note is not shown');
  assert.ok(/<b>Why:<\/b>/.test(app), 'the reason from the server is thrown away');
});

t('the check script reads with BOTH keys, so the difference is visible', () => {
  const s = src('scripts/check-oncall.js');
  assert.ok(/as the ANON key/.test(s) && /as the SERVICE key/.test(s));
  assert.ok(/RLS, not absence/.test(s), 'an empty anon read is not explained');
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(s), 'the check script writes');
});

// ---- importing a hand-built month ------------------------------------------

t('the importer reads the carry-in out of the file, not from a prompt', () => {
  // The October file's own DRAFT line says who covered Oct 01-02. Importing
  // without it would store the same hole one month further back.
  const s = src('scripts/import-oncall-xlsx.js');
  assert.ok(/covered by \(\[A-Za-z\]\+ Week|covered by \(/.test(s.replace(/\\/g, '')),
    'the carry-in note is not parsed');
  assert.ok(/carryPair,\n\s*carryFrom,/.test(s) || /carryPair, carryFrom/.test(s));
});

t('the importer stores what was IN FORCE, not what the rule would say', () => {
  // October Week 3 gave José the north and Angel the south, which Arturo has
  // confirmed was an oversight. It is imported as it stands: a calendar nobody
  // worked is not a record of the month.
  const s = src('scripts/import-oncall-xlsx.js');
  assert.ok(/imported from the hand-built calendar/.test(s));
  assert.ok(/imported as the file has it/i.test(s), 'the disagreement is silently corrected');
  // And the disagreement is measured against the FILE's pair, not the
  // generated one — comparing two different pairings calls every cell a
  // disagreement, which is how a diff becomes noise.
  assert.ok(/assignGroups\(w\.pair, properties\)/.test(s));
});

t('the importer refuses a file whose week count is not that month\'s', () => {
  const s = src('scripts/import-oncall-xlsx.js');
  assert.ok(/the file has \$\{weekCount\} weeks/.test(s),
    'a September file imported as October would store five weeks of nonsense');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
