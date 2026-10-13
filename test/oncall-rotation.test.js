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
  { id: 'jose-renteria',   full_name: 'Jose Renteria',   active: true, position: 'senior_maint_tech', show_on_map: true, home_lat: 30.2972, home_lng: -97.6859 },
  { id: 'angel-martinez',  full_name: 'Angel Martinez',  active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.3420, home_lng: -97.6590 },
  { id: 'emerson-garcia',  full_name: 'Emerson Garcia',  active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.3827, home_lng: -97.6854 },
  { id: 'carlos-portilla', full_name: 'Carlos Portilla', active: true, position: 'maint_tech',        show_on_map: true, home_lat: 30.5212, home_lng: -97.6539 },
  { id: 'yeison-salgado',  full_name: 'Yeison Salgado',  active: true, position: 'maint_tech',        show_on_map: false, home_lat: null,   home_lng: null },
  { id: 'fredy-ramirez',   full_name: 'Fredy Ramirez',   active: true, position: 'make_ready',        show_on_map: false, home_lat: null,   home_lng: null },
  { id: 'gone-tech',       full_name: 'Gone Tech',       active: false, position: 'maint_tech',       show_on_map: true, home_lat: 30.3,    home_lng: -97.7 },
];
const ASSIGNMENTS = [
  { property: 'Hyde Park Square',     maintenance_tech: 'Angel Martinez',                grounds_tech: 'Carlos Portilla' },
  { property: 'The Chateau',          maintenance_tech: 'Angel Martinez',                grounds_tech: 'Fredy Ramirez' },
  { property: 'The Highlander',       maintenance_tech: 'Angel Martinez',                grounds_tech: 'Fredy Ramirez' },
  { property: 'Ascent at Northgate',  maintenance_tech: 'Emerson Garcia',                grounds_tech: 'Emerson Garcia' },
  { property: 'Sunset Palms',         maintenance_tech: 'Raul Martinez, Emerson Garcia', grounds_tech: 'Fredy Ramirez' },
  { property: 'Windy Hill Apartment', maintenance_tech: 'Jose Renteria',                 grounds_tech: 'Jose Renteria' },
  { property: 'iConic Round Rock',    maintenance_tech: 'Raul Martinez',                 grounds_tech: 'Carlos Portilla' },
  { property: 'iConic Downtown',      maintenance_tech: 'Raul Martinez',                 grounds_tech: 'Carlos Portilla' },
];
const { properties: PROPS } = GEO.propertiesFrom(ASSIGNMENTS);
const byName = {};
R.poolFrom(TECHS).pool.forEach(p => { byName[p.name] = p; });

// ---- who is on call --------------------------------------------------------

t('the pool is the five the real calendars use', () => {
  const { pool } = R.poolFrom(TECHS);
  assert.deepStrictEqual(pool.map(p => p.name), [
    'Angel Martinez', 'Carlos Portilla', 'Emerson Garcia', 'Jose Renteria', 'Raul Martinez']);
});

t('Yeison is excluded WITH A REASON, not silently', () => {
  // An active maintenance tech whose role Erick has not confirmed. Dropping him
  // quietly would make the calendar look complete while a person who may be on
  // call is missing from it.
  const { excluded } = R.poolFrom(TECHS);
  const y = excluded.find(e => /Yeison/.test(e.name));
  assert.ok(y, 'Yeison vanished');
  assert.ok(/role not confirmed/.test(y.reason), y.reason);
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

t('a technician on call takes their own properties', () => {
  const s = R.splitWeek(['Angel Martinez', 'Raul Martinez'], PROPS, byName, {});
  ['Hyde Park Square', 'The Chateau', 'The Highlander'].forEach(p =>
    assert.strictEqual(s.assign[p], 'Angel Martinez', p));
  ['iConic Round Rock', 'iConic Downtown'].forEach(p =>
    assert.strictEqual(s.assign[p], 'Raul Martinez', p));
  assert.strictEqual(s.reasons['Hyde Park Square'], 'assigned property');
});

t('a property both of them own goes to the nearer one', () => {
  // Sunset Palms is Raúl's and Emerson's.
  const s = R.splitWeek(['Raul Martinez', 'Emerson Garcia'], PROPS, byName, {});
  assert.strictEqual(s.assign['Sunset Palms'], 'Emerson Garcia');
  assert.ok(/both assigned/.test(s.reasons['Sunset Palms']));
});

t('Carlos gets iConic Round Rock whenever its owner is not on call', () => {
  // He lives in Round Rock and is the only one for whom it is the nearest
  // property — Arturo's stated expectation for a Carlos week.
  ['Angel Martinez', 'Emerson Garcia', 'Jose Renteria'].forEach(other => {
    const s = R.splitWeek(['Carlos Portilla', other], PROPS, byName, {});
    assert.strictEqual(s.assign['iConic Round Rock'], 'Carlos Portilla', 'paired with ' + other);
  });
});

t('every property is covered, every week, by one of the two', () => {
  const pool = R.poolFrom(TECHS).pool.map(p => p.name);
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const s = R.splitWeek([pool[i], pool[j]], PROPS, byName, {});
      PROPS.forEach(p => assert.ok([pool[i], pool[j]].includes(s.assign[p.name]),
        p.name + ' uncovered for ' + pool[i] + ' + ' + pool[j]));
    }
  }
});

t('nobody ends a week with nothing', () => {
  // THE RAUL + CARLOS CASE. Raúl owns three properties and is nearer than
  // Carlos to all five others, so straight proximity hands Raúl all eight.
  // A pair where one person is on call for nothing is not a pair.
  const pool = R.poolFrom(TECHS).pool.map(p => p.name);
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const s = R.splitWeek([pool[i], pool[j]], PROPS, byName, {});
      const counts = { [pool[i]]: 0, [pool[j]]: 0 };
      PROPS.forEach(p => { counts[s.assign[p.name]]++; });
      assert.ok(counts[pool[i]] > 0 && counts[pool[j]] > 0,
        pool[i] + ' + ' + pool[j] + ' split ' + JSON.stringify(counts));
    }
  }
});

t('balance keeps the week even, and never moves an owned property', () => {
  const s = R.splitWeek(['Angel Martinez', 'Carlos Portilla'], PROPS, byName, {});
  const mine = PROPS.filter(p => s.assign[p.name] === 'Angel Martinez').length;
  assert.strictEqual(mine, 4, 'balance should halve the eight');
  ['Hyde Park Square', 'The Chateau', 'The Highlander'].forEach(p =>
    assert.strictEqual(s.assign[p], 'Angel Martinez', p + ' was balanced away from its owner'));
});

t('balance can be turned off, and then it is lopsided — by design', () => {
  // Kept switchable because it is a deviation from the letter of the rule
  // Arturo stated. The numbers are the argument for the default, so they are
  // pinned here rather than described.
  const s = R.splitWeek(['Angel Martinez', 'Carlos Portilla'], PROPS, byName, { balance: false });
  const angel = PROPS.filter(p => s.assign[p.name] === 'Angel Martinez').length;
  assert.strictEqual(angel, 7, 'straight proximity gives Angel seven of eight');
  // No guard here: Carlos still gets iConic Round Rock, because Angel does not
  // own it and Carlos is nearer. One property is lopsided, not zero.
  assert.strictEqual(s.guard, null);
  assert.strictEqual(s.assign['iConic Round Rock'], 'Carlos Portilla');
});

t('the zero guard fires on the one pair that strands a technician', () => {
  // Raúl OWNS iConic Round Rock, so Carlos's only nearest property is taken
  // from him, and Raúl is nearer than Carlos to all five others. Without the
  // guard Carlos is on call for nothing.
  const s = R.splitWeek(['Raul Martinez', 'Carlos Portilla'], PROPS, byName, { balance: false });
  assert.ok(s.guard, 'Carlos was left with nothing');
  assert.strictEqual(s.guard.tech, 'Carlos Portilla');
  // Least disadvantaged, not nearest: Carlos loses every contest on absolute
  // distance, so the question is which one he loses by least.
  assert.strictEqual(s.guard.property, 'Ascent at Northgate');
  assert.ok(/would have had no property/.test(s.reasons['Ascent at Northgate']));
});

t('the north/south blocks are a tiebreak, not the rule', () => {
  const lib = src('lib/oncall-rotation.js');
  assert.ok(/ONLY to break a tie/.test(lib), 'the blocks are documented as the rule');
  // A week where the pair owns properties on both sides is allowed to land
  // somewhere other than the blocks (Arturo, 2026-10-13).
  const s = R.splitWeek(['Jose Renteria', 'Emerson Garcia'], PROPS, byName, {});
  const north = R.BLOCKS.North.map(p => s.assign[p]);
  assert.ok(new Set(north).size >= 1);
  assert.strictEqual(s.assign['Windy Hill Apartment'], 'Jose Renteria', 'his own property');
});

// ---- fairness and pairing --------------------------------------------------

const NOV = R.build({
  year: 2026, month: 11, technicians: TECHS, properties: PROPS,
  carryPair: ['Carlos Portilla', 'Angel Martinez'], carryFrom: 'October Week 5',
});

t('November 2026 carries October Week 5 and says so', () => {
  assert.strictEqual(NOV.carry.days, 6);
  assert.ok(/Nov 01–06 \(7:59am\) covered by October Week 5 rotation \(Carlos \+ Angel\)/
    .test(NOV.carry.note), NOV.carry.note);
  assert.strictEqual(NOV.weeks.length, 4);
  assert.strictEqual(NOV.weeks[0].range, 'Sat 11/07 8am – Fri 11/13 7:59am');
  assert.strictEqual(NOV.weeks[3].spillsInto, 'December');
});

t('the carry-in pair counts toward fairness', () => {
  // They served a week; it is in the previous month's calendar. Counting only
  // full weeks would show them a week light and somebody would "fix" it.
  assert.ok(NOV.fairness.even, JSON.stringify(NOV.fairness.rows));
  const carried = NOV.fairness.rows.filter(r => r.carried).map(r => r.technician);
  assert.deepStrictEqual(carried.sort(), ['Angel Martinez', 'Carlos Portilla']);
  carried.forEach(n => {
    const r = NOV.fairness.rows.find(x => x.technician === n);
    assert.strictEqual(r.weeks, 1, n + ' owes one week, not two');
  });
});

t('nobody works two weeks running and no pair repeats', () => {
  const seen = new Set([['Carlos Portilla', 'Angel Martinez'].sort().join('|')]);
  let prev = ['Carlos Portilla', 'Angel Martinez'];
  NOV.weeks.forEach(w => {
    w.pair.forEach(n => assert.ok(!prev.includes(n), n + ' works ' + w.label + ' back to back'));
    const key = w.pair.slice().sort().join('|');
    assert.ok(!seen.has(key), 'pair repeats in ' + w.label);
    seen.add(key);
    prev = w.pair;
  });
  assert.deepStrictEqual(NOV.warnings, []);
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
  const other = NOV.weeks[0].pair[0] === 'Raul Martinez' ? 'Jose Renteria' : 'Raul Martinez';
  const after = R.applyEdits(NOV, [{ type: 'pair', week: 1, pair: ['Raul Martinez', other] }], 'Arturo');
  const w = after.weeks[0];
  assert.strictEqual(w.edited.length, 1);
  assert.strictEqual(w.edited[0].by, 'Arturo');
  assert.ok(w.edited[0].at, 'an edit with no timestamp cannot be reviewed');
  assert.deepStrictEqual(w.edited[0].to, ['Raul Martinez', other]);
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
  assert.ok(line.includes('Properties assigned per on-call week (never by group) per standing policy.'));
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
  const names = ROWS.slice(5, 5 + PROPS.length).map(r => r[0]);
  assert.deepStrictEqual(names.sort(), PROPS.map(p => p.name).sort());
  const row = ROWS.slice(5, 5 + PROPS.length).find(r => r[0] === 'Hyde Park Square');
  assert.ok(/^[A-Z][a-z]+$/.test(row[1]), 'the grid shows first names: ' + row[1]);
});

t('the fairness check is there, with the carry-in phrased as the originals do', () => {
  const head = ROWS.find(r => /^ROTATION FAIRNESS CHECK/.test(String(r[0])));
  assert.ok(head, 'no fairness check');
  assert.ok(/\(Nov 2026 cycle\)/.test(head[0]), head[0]);
  assert.deepStrictEqual(ROWS[ROWS.indexOf(head) + 1], ['Technician', 'Weeks On-Call', 'Which Weeks']);
  const carlos = ROWS.find(r => r[0] === 'Carlos Portilla');
  assert.ok(/^1 \(\+Nov 01-06 via Oct W5\)$/.test(String(carlos[1])), carlos[1]);
});

t('both 📌 notes are at the foot', () => {
  const notes = ROWS.filter(r => /^📌/.test(String(r[0]))).map(r => r[0]);
  assert.ok(notes.some(n => /covered by October Week 5/.test(n)), 'no carry-in note');
  assert.ok(notes.some(n => /spills into December/.test(n) && /carry forward unless/.test(n)),
    'no spill note');
  assert.ok(notes.some(n => /Not in the on-call pool: Yeison/.test(n)),
    'the excluded technician is not on the calendar anybody reads');
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
  const row = rows.find(r => r[0] === 'Sunset Palms');
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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
