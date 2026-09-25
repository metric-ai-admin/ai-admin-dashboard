// What an import may write to a row somebody is holding.
//
// Bekah set a status in the dashboard; re-running the workbook import replaced
// it with the spreadsheet's value and stamped updated_by with the importer's
// name. There was no record that her value had ever existed. Jay reported it as
// the Refresh button re-syncing from AppFolio — Refresh is a GET and nothing
// syncs this table from AppFolio at all, but the overwrite was real and import
// was the trigger.
const assert = require('assert');
const cv = require('../code-violations.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const NOW = '2026-09-26T15:00:00.000Z';
const held = (over = {}) => ({
  deficiency_key: 'k1',
  property_name: 'The Highlander',
  work_order: '22882-1',
  status: 'Assigned - In Progress',
  status_set_by: 'Bekah Hanes',
  status_set_at: '2026-09-25T10:00:00.000Z',
  pending_items: 'Waiting on the electrician',
  progress_notes: 'Called the city Thursday',
  due_date: '2026-10-01',
  closed_by: null,
  closed_at: null,
  ...over,
});
const untouched = (over = {}) => ({ ...held(), status_set_by: null, status_set_at: null, ...over });
const incoming = (over = {}) => ({
  deficiency_key: 'k1',
  property_name: 'The Highlander',
  work_order: '22882-1',
  status: 'Completed by Maintenance',
  pending_items: 'None yet',
  progress_notes: null,
  due_date: '2026-10-15',
  ...over,
});

console.log('a row nobody has touched');
t('the workbook wins — that is what the import is for', () => {
  const out = cv.resolveImportRow(untouched(), incoming(), { now: NOW });
  assert.strictEqual(out.row.status, 'Completed by Maintenance');
  assert.strictEqual(out.flagged, false);
});
t('and a stale parked value is cleared', () => {
  const out = cv.resolveImportRow(
    untouched({ pending_import_status: 'Assigned - In Progress' }), incoming(), { now: NOW });
  assert.strictEqual(out.row.pending_import_status, null);
});
t('a row that does not exist yet is inserted as-is', () => {
  const out = cv.resolveImportRow(null, incoming(), { now: NOW });
  assert.strictEqual(out.row.status, 'Completed by Maintenance');
  assert.strictEqual(out.flagged, false);
});

console.log('\na row somebody is holding');
t('the manual status stands', () => {
  const out = cv.resolveImportRow(held(), incoming(), { now: NOW });
  assert.strictEqual(out.row.status, 'Assigned - In Progress');
});
t('the disagreement is parked, not discarded', () => {
  const out = cv.resolveImportRow(held(), incoming(), { now: NOW });
  assert.strictEqual(out.row.pending_import_status, 'Completed by Maintenance');
  assert.strictEqual(out.row.pending_import_at, NOW);
  assert.strictEqual(out.flagged, true);
});
t('who held it, and when, survive the import', () => {
  const out = cv.resolveImportRow(held(), incoming(), { now: NOW });
  assert.strictEqual(out.row.status_set_by, 'Bekah Hanes');
  assert.strictEqual(out.row.status_set_at, '2026-09-25T10:00:00.000Z');
});
t('the source of the proposal is recorded', () => {
  const out = cv.resolveImportRow(held(), incoming(), { now: NOW, source: 'seed' });
  assert.strictEqual(out.row.pending_import_source, 'seed');
});
t('an agreeing import parks nothing', () => {
  const out = cv.resolveImportRow(held(), incoming({ status: 'Assigned - In Progress' }), { now: NOW });
  assert.strictEqual(out.flagged, false);
  assert.strictEqual(out.row.pending_import_status, null);
});
t('an import with no status at all does not park a blank', () => {
  const out = cv.resolveImportRow(held(), incoming({ status: '' }), { now: NOW });
  assert.strictEqual(out.flagged, false);
  assert.strictEqual(out.row.status, 'Assigned - In Progress');
});

console.log('\nthe close is not reverted');
t('closed_by and closed_at are kept, not taken from the spreadsheet', () => {
  const stored = held({ status: 'Closed by Code Compliance', closed_by: 'Jay Manuel', closed_at: '2026-09-20T12:00:00.000Z' });
  const out = cv.resolveImportRow(stored, incoming({ closed_by: 'Excel', closed_at: null }), { now: NOW });
  assert.strictEqual(out.row.status, 'Closed by Code Compliance');
  assert.strictEqual(out.row.closed_by, 'Jay Manuel');
  assert.strictEqual(out.row.closed_at, '2026-09-20T12:00:00.000Z');
});

console.log('\nhand-written fields on a held row');
t('notes and pending items a person filled in are preserved', () => {
  // Fixing the status overwrite while still losing Bekah's notes would be
  // worse than the original bug: it would look solved.
  const out = cv.resolveImportRow(held(), incoming(), { now: NOW });
  assert.strictEqual(out.row.pending_items, 'Waiting on the electrician');
  assert.strictEqual(out.row.progress_notes, 'Called the city Thursday');
  assert.deepStrictEqual(out.preserved.sort(), ['due_date', 'pending_items', 'progress_notes']);
});
t('an empty manual field takes the import value', () => {
  const out = cv.resolveImportRow(held({ progress_notes: '   ' }), incoming({ progress_notes: 'From the workbook' }), { now: NOW });
  assert.strictEqual(out.row.progress_notes, 'From the workbook');
});
t('identical values are not reported as preserved', () => {
  const out = cv.resolveImportRow(held({ pending_items: 'None yet' }), incoming(), { now: NOW });
  assert.ok(!out.preserved.includes('pending_items'));
});
t('an untouched row has its notes overwritten as before', () => {
  const out = cv.resolveImportRow(untouched(), incoming(), { now: NOW });
  assert.strictEqual(out.row.pending_items, 'None yet');
  assert.deepStrictEqual(out.preserved, []);
});

console.log('\nresolving it');
t('keep discards the parked value and leaves the status alone', () => {
  const stored = held({ pending_import_status: 'Completed by Maintenance' });
  const out = cv.resolveConflict(stored, 'keep', { by: 'Bekah Hanes', now: NOW });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.patch.pending_import_status, null);
  assert.strictEqual(out.patch.status, undefined, 'keep must not touch the status');
});
t('sync applies the parked value', () => {
  const stored = held({ pending_import_status: 'Completed by Maintenance' });
  const out = cv.resolveConflict(stored, 'sync', { by: 'Bekah Hanes', now: NOW });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.patch.status, 'Completed by Maintenance');
  assert.strictEqual(out.patch.pending_import_status, null);
});
t('and the synced value becomes manually held in its turn', () => {
  // Somebody chose it, so the next import must not silently overwrite it
  // either — accepting a value is as deliberate as typing one.
  const stored = held({ pending_import_status: 'Completed by Maintenance' });
  const out = cv.resolveConflict(stored, 'sync', { by: 'Bekah Hanes', now: NOW });
  assert.strictEqual(out.patch.status_set_by, 'Bekah Hanes');
  assert.strictEqual(out.patch.status_set_at, NOW);
});
t('sync reports the status so the route can gate the close', () => {
  const stored = held({ pending_import_status: 'Closed by Code Compliance' });
  const out = cv.resolveConflict(stored, 'sync', { by: 'Erick Frey', now: NOW });
  assert.strictEqual(out.status, 'Closed by Code Compliance');
});
t('a parked value that is not one of the seven is refused', () => {
  const stored = held({ pending_import_status: 'Sort of done' });
  const out = cv.resolveConflict(stored, 'sync', { now: NOW });
  assert.strictEqual(out.ok, false);
  assert.ok(/not one of the seven/.test(out.error), out.error);
});
t('a row with nothing parked cannot be resolved', () => {
  const out = cv.resolveConflict(held(), 'keep', { now: NOW });
  assert.strictEqual(out.ok, false);
});
t('an unknown decision is refused', () => {
  const stored = held({ pending_import_status: 'Assigned - In Progress' });
  ['', 'maybe', 'overwrite', null].forEach(d => {
    assert.strictEqual(cv.resolveConflict(stored, d, { now: NOW }).ok, false, String(d));
  });
});

console.log('\nthe whole round trip');
t('import, park, keep — the manual status never moves', () => {
  let stored = untouched();
  // Bekah sets it by hand: the route writes status_set_at.
  stored = { ...stored, status: 'Assigned - In Progress', status_set_by: 'Bekah Hanes', status_set_at: '2026-09-25T10:00:00.000Z' };
  // The workbook disagrees.
  const imported = cv.resolveImportRow(stored, incoming(), { now: NOW });
  assert.strictEqual(imported.row.status, 'Assigned - In Progress');
  stored = { ...stored, ...imported.row };
  // She keeps hers.
  const kept = cv.resolveConflict(stored, 'keep', { by: 'Bekah Hanes', now: NOW });
  stored = { ...stored, ...kept.patch };
  assert.strictEqual(stored.status, 'Assigned - In Progress');
  assert.strictEqual(stored.pending_import_status, null);
  // A second identical import must not re-park what she already declined.
  const again = cv.resolveImportRow(stored, incoming(), { now: NOW });
  assert.strictEqual(again.flagged, true, 'it re-parks, because the spreadsheet still disagrees');
  assert.strictEqual(again.row.status, 'Assigned - In Progress', 'but her status still stands');
});

console.log(`\n${pass} passing`);
