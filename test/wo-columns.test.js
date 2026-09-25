// Which column of a work-order export is which.
//
// Jay audited the analyzer on 2026-09-25 and reported that it marked work
// orders complete when they were not, in a pattern where one of two adjacent
// rows appeared closed. Nothing in the analyzer marks anything complete. What
// it did was label every row by work_order_TYPE — so two different "Plumbing"
// work orders were indistinguishable — and put a green tick and the words "No
// action needed" under whichever of them matched no rule.
//
// The cause was a first-match-wins matcher: the first header containing
// "workorder" won, and on the real 78-column export that is work_order_type.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildHeaderMap, scoreHeader, FIELDS } = require('../wo-columns.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// The real export, read from the synced file rather than typed out here — a
// hand-copied list would drift from what AppFolio actually sends.
const REAL = Object.keys(JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'appfolio_api', 'wo_all.json'), 'utf8')).rows[0]);

console.log('the binding that caused the report');
t('wo binds to the NUMBER, not work_order_type', () => {
  const { map, bound } = buildHeaderMap(REAL);
  assert.strictEqual(REAL[map.wo], 'work_order_number');
  assert.notStrictEqual(bound.wo.column, 'work_order_type');
});
t('work_order_type can never win, whatever else is missing', () => {
  // Even as the ONLY candidate it must not bind: a type is not an identifier,
  // and labelling rows by it is what made two work orders look like one.
  const { map } = buildHeaderMap(['work_order_type', 'status', 'property_name']);
  assert.strictEqual(map.wo, undefined);
});
t('a scored runner-up does not beat an exact name', () => {
  const { bound } = buildHeaderMap(REAL);
  assert.strictEqual(bound.wo.column, 'work_order_number');
  assert.ok(bound.wo.score >= 90, String(bound.wo.score));
});

console.log('\nthe other mis-bindings on the real export');
t('assignee binds to a person, not vendor_id', () => {
  const { map } = buildHeaderMap(REAL);
  assert.strictEqual(REAL[map.assignee], 'assigned_user');
});
t('unit binds to the unit, not its street address', () => {
  const { map } = buildHeaderMap(REAL);
  assert.strictEqual(REAL[map.unit], 'unit_name');
});
t('status binds to status, not estimate_approval_status or status_notes', () => {
  const { map } = buildHeaderMap(REAL);
  assert.strictEqual(REAL[map.status], 'status');
});
t('created binds to a DATE, not created_by', () => {
  // created_by is a person's name. daysBetween() on a name is NaN, and the
  // "open for N days" escalation then silently never fires.
  const { map } = buildHeaderMap(REAL);
  assert.strictEqual(REAL[map.created], 'created_at');
});
t('property binds to the name, not property_id or property_street', () => {
  const { map } = buildHeaderMap(REAL);
  assert.ok(['property_name', 'property'].includes(REAL[map.property]), REAL[map.property]);
});
t('every field on the real export binds or is honestly unbound', () => {
  const { bound, unbound } = buildHeaderMap(REAL);
  assert.ok(bound.wo && bound.status && bound.property && bound.assignee, Object.keys(bound).join(','));
  // The export genuinely has no photo or updated column. Saying so beats
  // binding to something that is not one.
  assert.deepStrictEqual(unbound.sort(), ['photos', 'updated']);
});

console.log('\nrefusing to bind beats binding wrongly');
t('an empty header list binds nothing', () => {
  const { map, unbound } = buildHeaderMap([]);
  assert.deepStrictEqual(map, {});
  assert.strictEqual(unbound.length, Object.keys(FIELDS).length);
});
t('unrelated headers bind nothing', () => {
  const { map } = buildHeaderMap(['first_name', 'email', 'balance', 'zip']);
  assert.strictEqual(map.wo, undefined);
  assert.strictEqual(map.status, undefined);
});
t('an id column loses to a readable one', () => {
  assert.ok(scoreHeader('assigned_user', FIELDS.assignee) > scoreHeader('vendor_id', FIELDS.assignee));
  assert.ok(scoreHeader('unit_name', FIELDS.unit) > scoreHeader('unit_id', FIELDS.unit));
});
t('a "never" term is a hard no, not a penalty', () => {
  assert.strictEqual(scoreHeader('work_order_type', FIELDS.wo), 0);
  assert.strictEqual(scoreHeader('estimate_approval_status', FIELDS.status), 0);
  assert.strictEqual(scoreHeader('status_notes', FIELDS.status), 0);
  assert.strictEqual(scoreHeader('created_by', FIELDS.created), 0);
});

console.log('\nthe web UI export, which uses human labels');
const UI_HEADERS = ['Work Order #', 'Property', 'Unit', 'Status', 'Assigned To',
  'Description', 'Created Date', 'Last Updated', 'Photos', 'Completed On'];
t('spaces, hashes and title case all resolve', () => {
  const { map } = buildHeaderMap(UI_HEADERS);
  assert.strictEqual(UI_HEADERS[map.wo], 'Work Order #');
  assert.strictEqual(UI_HEADERS[map.assignee], 'Assigned To');
  assert.strictEqual(UI_HEADERS[map.created], 'Created Date');
  assert.strictEqual(UI_HEADERS[map.updated], 'Last Updated');
  assert.strictEqual(UI_HEADERS[map.photos], 'Photos');
});
t('nothing is left unbound when the file actually has every column', () => {
  assert.deepStrictEqual(buildHeaderMap(UI_HEADERS).unbound, []);
});

console.log('\nwhat it reports about itself');
t('the runners-up are listed, so a mis-binding is diagnosable', () => {
  const { rejected } = buildHeaderMap(REAL);
  assert.ok(rejected.wo && rejected.wo.length, 'wo should have had other candidates');
  assert.ok(rejected.wo.every(r => r.header !== 'work_order_number'));
});
t('bound reports the column and the score', () => {
  const { bound } = buildHeaderMap(REAL);
  Object.values(bound).forEach(b => {
    assert.ok(typeof b.column === 'string' && b.column.length);
    assert.ok(typeof b.score === 'number' && b.score > 0);
  });
});

console.log('\nthe analyzer no longer guesses at a missing column');
t('rules that need an unbound column are skipped, not run against nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'metric-routes.js'), 'utf8');
  // hasPhotos was false for every row because photos never bound, so "Request
  // photos" fired on everything and "Ready for QC" could never fire at all.
  assert.ok(/has\('photos'\) && isWorkDone && !rec\.hasPhotos/.test(src),
    'the photo rule must be guarded on the column existing');
  assert.ok(/const has = field => map\[field\] !== undefined;/.test(src));
});
t('the "no action" bucket no longer says complete, and carries no tick', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'metric-routes.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(/action: 'Nothing flagged'/.test(routes), 'the action label still says No action needed');
  assert.ok(!/label: 'No action needed'/.test(app), 'the bucket label still says No action needed');
  assert.ok(/Open, no action flagged/.test(app));
  assert.ok(!/none: *\{ icon: '✅'/.test(app), 'the green tick is still on the open bucket');
});

console.log(`\n${pass} passing`);
