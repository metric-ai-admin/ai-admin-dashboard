// The inspection behind each move-out, for Collections.
//
// Karla opens the official move-out inspection, finds it empty, and cannot
// find the photos she needs to charge a deposit. AppFolio's Inspections tab
// does not open on a unit, so finding the real walk is a manual search.
//
// In the last 90 days exactly ONE official move-out inspection was completed,
// against 41 walks recorded under a technician's name or "Untitled". That is
// the shape of the problem and the reason the fourth state exists.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/moveout-alerts.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('move-out inspections for Collections');

const TODAY = '2026-10-22';
const view = (turns, inspections, opts) =>
  M.collectionsView({ turns, inspections }, TODAY, Object.assign({ days: 90 }, opts || {}));
const one = (turns, inspections) => view(turns, inspections).rows[0];

const turn = o => Object.assign(
  { property_name: 'Ascent at Northgate', unit: '214', move_out_date: '2026-10-05' }, o);
const insp = o => Object.assign({
  inspection_id: '2001', inspection_name: 'Move Out Damage and Occupancy Inspection',
  property_name: 'Ascent at Northgate', unit: '214', status: 'NEW', inspected_on: '2026-10-06',
}, o);

// ---- the link ------------------------------------------------------------------

t('the URL is built from inspection_id, verified against 1393', () => {
  // Arturo opened it: https://metricpropertymanagement.appfolio.com/inspections/1393
  // That row carries unit_id 1898 and property_id 26 as well, and neither is in
  // the address — picking one of those would have produced a link that opens
  // SOMEBODY ELSE'S inspection rather than a 404, which is worse.
  assert.strictEqual(
    M.inspectionUrl({ inspection_id: '1393', unit_id: '1898', property_id: '26' }),
    'https://metricpropertymanagement.appfolio.com/inspections/1393');
});

t('an id that is not a number gets no link', () => {
  // A link to nothing is worse than no link: it looks like it was checked.
  [null, '', 'abc', '13 93', '../admin'].forEach(id =>
    assert.strictEqual(M.inspectionUrl({ inspection_id: id }), null, JSON.stringify(id)));
});

t('no link still leaves the name and date to search by', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function moInspectionLink'),
    app.indexOf('function moCollectionsTable'));
  assert.match(fn, /NO LINK IS NOT NO INFORMATION/);
  assert.match(fn, /ins\.url\s*\n?\s*\?/);
});

// ---- the four states ---------------------------------------------------------------

t('Complete: the move-out inspection is done', () => {
  const r = one([turn()], [insp({ status: 'DONE' })]);
  assert.strictEqual(r.status, 'complete');
  assert.strictEqual(r.label, 'Complete');
  assert.strictEqual(r.inspection.id, '2001');
});

t('Empty: it exists and nobody marked it done', () => {
  const r = one([turn()], [insp({ status: 'NEW' })]);
  assert.strictEqual(r.status, 'empty');
  assert.match(r.label, /not completed/);
  assert.strictEqual(r.inspection.id, '2001');
});

t('None: nothing on the unit at all', () => {
  const r = one([turn()], []);
  assert.strictEqual(r.status, 'none');
  assert.strictEqual(r.inspection, null);
});

t('Done under another name: the walk somebody really did', () => {
  // Made up, deliberately — see the blind-spot test below for why 1393 is not
  // the example for this.
  const r = one([turn()], [
    insp({ inspection_id: '2001', status: 'NEW' }),
    insp({ inspection_id: '2002', inspection_name: 'Andres luevano', status: 'DONE' }),
  ]);
  assert.strictEqual(r.status, 'done_elsewhere');
  assert.strictEqual(r.label, 'Done under another name');
  assert.strictEqual(r.inspection.name, 'Andres luevano');
  assert.strictEqual(r.inspection.url,
    'https://metricpropertymanagement.appfolio.com/inspections/2002');
  // And the official one still needs closing — two jobs, not one.
  assert.ok(r.officialEmpty, 'the empty official record was dropped');
  assert.strictEqual(r.officialEmpty.id, '2001');
});

t('"Untitled" counts as another name', () => {
  const r = one([turn()], [insp({ inspection_id: '2003', inspection_name: 'Untitled', status: 'DONE' })]);
  assert.strictEqual(r.status, 'done_elsewhere');
  assert.strictEqual(r.inspection.name, 'Untitled');
});

t('a make-ready is not a move-out walk', () => {
  // isUnrecognised already drops these by name. A make-ready marked done is
  // not evidence that anybody inspected the move-out.
  ['Inspection make ready', 'Monthly Property Inspection', 'Inspeccion de make ready']
    .forEach(name => {
      const r = one([turn()], [insp({ inspection_id: '2004', inspection_name: name, status: 'DONE' })]);
      assert.strictEqual(r.status, 'none', name + ' was counted as a walk');
    });
});

// ---- the blind spot, documented on purpose -------------------------------------------

t('DONE but EMPTY reads as Complete — the known blind spot', () => {
  // Inspection 1393 is the real example: iConic Downtown 103, "Move Out - FAS
  // Inspection", marked DONE on 2026-10-14 by Erick, and his review that same
  // day found it EMPTY — no areas, no photos.
  //
  // inspection_detail has no areas or photo column (14 columns, probed
  // 2026-10-14), so `status` is the only signal available and it answers
  // "did somebody click Done", not "is there anything inside". This test is
  // here to make that explicit rather than leave it to be rediscovered by
  // somebody who trusts a green row.
  //
  // scripts/probe-inspection-columns.js is the way out: if the report carries
  // an areas or photo count that the sync has been dropping, this stops being
  // a blind spot.
  const r = one(
    [turn({ property_name: 'iConic Downtown', unit: '103', move_out_date: '2026-10-01' })],
    [insp({
      inspection_id: '1393', inspection_name: 'Move Out - FAS Inspection',
      property_name: 'iConic Downtown', unit: '103',
      status: 'DONE', marked_done_by: 'Erick Frey', inspected_on: '2026-10-14',
    })]);
  assert.strictEqual(r.status, 'complete',
    'if this changed, the blind spot may be closed — re-read the comment');
  assert.strictEqual(r.inspection.url,
    'https://metricpropertymanagement.appfolio.com/inspections/1393');
});

// ---- dates and keys --------------------------------------------------------------------

t('an inspection from the previous tenancy does not count', () => {
  const r = one([turn({ move_out_date: '2026-10-05' })],
    [insp({ inspection_id: '2005', inspection_name: 'Andres luevano',
      status: 'DONE', inspected_on: '2026-09-01' })]);
  assert.strictEqual(r.status, 'none', 'a walk from before the move-out was counted');
});

t('the same day counts', () => {
  const r = one([turn({ move_out_date: '2026-10-05' })],
    [insp({ inspection_id: '2006', inspection_name: 'Untitled',
      status: 'DONE', inspected_on: '2026-10-05' })]);
  assert.strictEqual(r.status, 'done_elsewhere');
});

t('the turn id beats the date', () => {
  // AppFolio saying "this inspection belongs to that move-out" is a stronger
  // statement than any date comparison, and matchWalk already treats it so.
  const r = one([turn({ unit_turn_id: '777', move_out_date: '2026-10-05' })],
    [insp({ inspection_id: '2007', unit_turn_id: '777', status: 'DONE', inspected_on: '2026-01-01' })]);
  assert.strictEqual(r.status, 'complete');
});

t('a move-out with no unit and no turn id is counted, not hidden', () => {
  // 83 of 110 recent inspections carry no unit_turn_id and 10 no unit at all.
  // "No inspection" here can mean "nothing to look it up by", and reading that
  // as a unit nobody walked is how somebody gets sent back to a finished unit.
  const v = view([turn({ unit: '', unit_turn_id: '' })], []);
  assert.strictEqual(v.unmatchable, 1);
  assert.strictEqual(v.rows[0].unmatchable, true);
  assert.strictEqual(v.rows[0].status, 'none');
});

t('a move-out nobody could look up offers no candidates either', () => {
  // A turn with no unit matches every unit-less inspection at that property.
  // On real data one such row offered TWENTY-NINE candidates going back to
  // 2025 — not a shortlist, but the manual search this screen replaces.
  const v = view([turn({ unit: '', unit_turn_id: '' })], [
    insp({ inspection_id: '3001', unit: '', inspection_name: 'Andres luevano', status: 'DONE' }),
    insp({ inspection_id: '3002', unit: '', inspection_name: 'Untitled', status: 'DONE' }),
  ]);
  assert.strictEqual(v.rows[0].status, 'none');
  assert.deepStrictEqual(v.rows[0].alsoOnUnit, [],
    'it offered inspections that match nothing but an empty unit');
  assert.strictEqual(v.rows[0].alsoOnUnitMore, 0);
});

t('a long candidate list is capped AND the remainder counted', () => {
  // Truncating in silence hides that there are more; not truncating buries
  // the one that matters.
  const many = [];
  for (let i = 0; i < 9; i++) {
    many.push(insp({ inspection_id: '40' + i, inspection_name: 'Untitled',
      status: 'NEW', inspected_on: '2026-10-06' }));
  }
  const r = one([turn()], many);
  assert.ok(r.alsoOnUnit.length <= 5, 'it showed ' + r.alsoOnUnit.length);
  // Nine candidates and none chosen: every one of them is NEW, so there is no
  // walk to open and the whole nine are "also on this unit". Counting a
  // chosen one that does not exist is what the first version of this
  // assertion did.
  const chosen = r.inspection ? 1 : 0;
  assert.strictEqual(r.alsoOnUnit.length + r.alsoOnUnitMore + chosen, 9,
    'the shown, the remainder and the chosen one do not add up');
  assert.strictEqual(r.alsoOnUnitMore, 4);
});

t('the screen says how many more there are', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function moCollectionsTable'),
    app.indexOf('async function loadMoveOutAlerts'));
  assert.match(fn, /alsoOnUnitMore/);
  assert.match(fn, /and ' \+ r\.alsoOnUnitMore \+ ' more/);
});

t('the screen shows that count', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function moCollectionsTable'),
    app.indexOf('async function loadMoveOutAlerts'));
  assert.match(fn, /c\.unmatchable/);
  assert.match(fn, /may have been walked/);
});

// ---- the window and the totals ------------------------------------------------------------

t('ninety days, and nothing outside it', () => {
  const v = view([
    turn({ unit: 'in', move_out_date: '2026-08-01' }),
    turn({ unit: 'out', move_out_date: '2026-06-01' }),
    turn({ unit: 'future', move_out_date: '2026-12-01' }),
  ], []);
  assert.deepStrictEqual(v.rows.map(r => r.unit), ['in']);
  assert.strictEqual(v.days, 90);
});

t('the counts add up to the rows', () => {
  const v = view([
    turn({ unit: 'a', move_out_date: '2026-10-01' }),
    turn({ unit: 'b', move_out_date: '2026-10-02' }),
    turn({ unit: 'c', move_out_date: '2026-10-03' }),
  ], [
    insp({ inspection_id: '1', unit: 'a', status: 'DONE', inspected_on: '2026-10-02' }),
    insp({ inspection_id: '2', unit: 'b', status: 'NEW', inspected_on: '2026-10-03' }),
  ]);
  const total = Object.values(v.counts).reduce((n, x) => n + x, 0);
  assert.strictEqual(total, v.rows.length);
  assert.strictEqual(v.counts.complete, 1);
  assert.strictEqual(v.counts.empty, 1);
  assert.strictEqual(v.counts.none, 1);
});

t('newest move-out first', () => {
  const v = view([
    turn({ unit: 'old', move_out_date: '2026-09-01' }),
    turn({ unit: 'new', move_out_date: '2026-10-10' }),
  ], []);
  assert.deepStrictEqual(v.rows.map(r => r.unit), ['new', 'old']);
});

// ---- the route carries what the match needs -------------------------------------------------

t('the query selects the two fields the match depends on', () => {
  // unit_turn_id is the structural link and inspected_on is the real date.
  // Both were missing from this select, so the turn pass could never fire from
  // this route and the date fell back to when somebody clicked Done. A column
  // left out of a select is invisible exactly like a column nobody syncs.
  const server = read('server.js');
  const at = server.indexOf("const insp = await selectAll(() => db.from('maintenance_inspections')");
  assert.ok(at > 0, 'the query is gone');
  const q = server.slice(at, at + 420);
  assert.match(q, /unit_turn_id/);
  assert.match(q, /inspected_on/);
  assert.match(q, /marked_done_by/);
});

t('the route returns the Collections view', () => {
  const server = read('server.js');
  assert.match(server, /collections: MOVEOUT\.collectionsView\(\{ turns, inspections: insp \}, todayCT, \{ days: 90 \}\)/);
});

t('the probe prints no value from any row', () => {
  const probe = read('scripts/probe-inspection-columns.js');
  assert.match(probe, /NOTHING BUT COLUMN NAMES AND FILL COUNTS/);
  assert.ok(!/JSON\.stringify\(rows\[0\]\)|console\.log\(rows\[0\]\)/.test(probe));
  // A 429 is not an answer.
  assert.match(probe, /r\.status === 429/);
  assert.match(probe, /after 6 PM CT/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
