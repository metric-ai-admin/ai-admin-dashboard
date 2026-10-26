// created_by on inspections, and the resident off them.
//
// TWO PLACES OR NEITHER WORKS. A column has to be in the sync map AND in the
// view's select; leave it out of the second and you get a populated column and
// an empty field on screen, which looks exactly like AppFolio having stopped
// sending it. That failure has now cost this repo three times — unit_turn_id
// and inspected_on on this very screen, the call grades, and rubric_applied —
// so it is asserted rather than remembered.
//
// AND THE RESIDENT IS GONE. maintenance_inspections.primary_resident was
// filled on 78 of 642 rows and nothing read it. Migration 115 cleared them;
// what keeps them cleared is the ABSENCE of the mapping, because this table is
// full-replaced each sync and a map that still carried the key would re-insert
// every name at the next 06:05 run. That absence is the thing under test.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Comments stripped. Every comment added with this change mentions both
// `created_by` and `primary_resident`, so a test reading raw source would pass
// on the prose alone — including the test for the mapping being GONE.
const codeOf = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');

const server = codeOf(read('server.js'));
const client = codeOf(read('public/app.js'));
const MO = require('../lib/moveout-alerts.js');

console.log('inspections — created_by in, resident out');

// ---- the sync map ----------------------------------------------------------

// The inspections slot of MAINT_SUPPORT_REPORTS, by its own table name.
const inspectionMap = (() => {
  const at = server.indexOf("table: 'maintenance_inspections'");
  assert.ok(at > 0, 'the inspections sync slot moved');
  const start = server.lastIndexOf('report:', at);
  const end = server.indexOf('billable: {', at);
  assert.ok(end > start, 'could not find the end of the inspections slot');
  return server.slice(start, end);
})();

t('the sync maps created_by', () => {
  assert.match(inspectionMap, /created_by:\s*mwoPick/, 'created_by is not synced');
});

t('THE RESIDENT IS NOT MAPPED', () => {
  // The whole point. If this ever comes back, migration 115 is undone by the
  // next sync and nobody is told.
  assert.ok(!/primary_resident:/.test(inspectionMap),
    'primary_resident is being written to maintenance_inspections again');
  assert.ok(!/primary_tenant/.test(inspectionMap),
    'the resident is being mapped in under another name');
});

t('the other maintenance feeds are untouched', () => {
  // maintenance_work_orders legitimately keeps primary_resident and this
  // change must not have reached it.
  assert.match(server, /primary_resident:\s*mwoPick\(r, F\.primary_resident\)/,
    'the work-order resident mapping was removed by accident');
});

// ---- the view's select -----------------------------------------------------

const inspectionSelect = (() => {
  const at = server.indexOf("'inspection_id,inspection_name,property_name,unit,status,marked_done_on");
  assert.ok(at > 0, 'the move-out alerts select moved');
  return server.slice(at, server.indexOf("'", server.indexOf(',unit_turn_id', at)) + 1);
})();

t('THE VIEW SELECTS created_by TOO', () => {
  // Synced but not selected is the failure this file exists for: a full column
  // in the database and an empty field on screen.
  assert.ok(/created_by/.test(inspectionSelect),
    'created_by is synced but never read back — the row will show nothing');
});

t('the select did not lose anything else', () => {
  ['inspection_id', 'inspection_name', 'property_name', 'unit', 'status',
    'marked_done_on', 'marked_done_by', 'created_on', 'inspected_on', 'unit_turn_id']
    .forEach(c => assert.ok(new RegExp('\\b' + c + '\\b').test(inspectionSelect),
      c + ' fell out of the projection'));
});

t('the select does not ask for the resident', () => {
  assert.ok(!/primary_resident/.test(inspectionSelect),
    'the view still reads the resident column');
});

// ---- describeInspection ----------------------------------------------------

t('describeInspection carries createdBy through', () => {
  const d = MO.describeInspection({
    inspection_id: '1451', inspection_name: 'Jose reyes', status: 'DONE',
    inspected_on: '2026-10-15', marked_done_by: 'Jose Hernandez',
    created_by: 'Erick Frey',
  });
  assert.strictEqual(d.createdBy, 'Erick Frey');
  // And it is not confused with who closed it — two different people here, on
  // purpose, because on real rows they often are.
  assert.strictEqual(d.markedDoneBy, 'Jose Hernandez');
});

t('a row with no created_by says nothing rather than something', () => {
  // Rows synced before 115 have no such column. Null, never '' and never a
  // placeholder that reads as an inspection nobody created.
  const d = MO.describeInspection({ inspection_id: '1442', inspection_name: 'Untitled' });
  assert.strictEqual(d.createdBy, null);
});

t('describeInspection still returns null for no row at all', () => {
  assert.strictEqual(MO.describeInspection(null), null);
});

// ---- the screen ------------------------------------------------------------

t('the row shows created by, on done_elsewhere', () => {
  assert.match(client, /r\.status === 'done_elsewhere' && r\.inspection && r\.inspection\.createdBy/,
    'the row never shows who created the inspection');
  assert.match(client, /'created by ' \+ esc\(r\.inspection\.createdBy\)/,
    'the name is printed unescaped, or not printed');
});

t('IT IS OMITTED WHEN ABSENT, NOT BLANKED', () => {
  // The guard has to test the value, not just the state, or every pre-115 row
  // grows a "created by —" that reads as an inspection nobody owns.
  const at = client.indexOf("createdBy)");
  assert.ok(at > 0, 'the createdBy branch is gone');
  const line = client.slice(client.lastIndexOf('if (', at), at + 40);
  assert.ok(/&&\s*r\.inspection\.createdBy/.test(line),
    'the branch does not check that there is a name to show');
});

t('it is escaped like every other name on the row', () => {
  assert.ok(!/\+ r\.inspection\.createdBy/.test(client),
    'createdBy is concatenated without esc() somewhere');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
