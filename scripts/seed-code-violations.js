#!/usr/bin/env node
//
// Seed / re-seed the Code Violations tracker from an export of Jay's workbook.
//
//   node scripts/seed-code-violations.js exports/code_violations_09172026.json
//   node scripts/seed-code-violations.js <file> --dry-run
//
// The input is an array of objects whose keys match the workbook's columns:
//   property_name, case_number, work_order, address_unit, deficiency_date,
//   deficiency_description, status, pending_items, completed_items,
//   maintenance_remarks, client_vendor_remarks, category, progress_notes,
//   notice_date, due_date
//
// IDEMPOTENT. Rows upsert on deficiency_key, so running this against a newer
// export of the same workbook updates the rows it recognises and inserts only
// what is genuinely new — which is what "mirror the workbook during the
// transition" needs (open question 2 in code-violations.js).
//
// NOTHING IS SKIPPED QUIETLY. A row that fails validation is printed and
// counted, and the script exits non-zero. A cited deficiency vanishing between
// the workbook and the tracker is the one failure this module cannot have, so
// it is never a warning buried in a summary line.
//
// The export itself is deliberately NOT in the repo: exports/ is gitignored
// because these files carry city case numbers and per-building detail.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cv = require(path.join(__dirname, '..', 'code-violations.js'));

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!file) {
  console.error('Usage: node scripts/seed-code-violations.js <export.json> [--dry-run]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(raw)) {
  console.error('Expected a JSON array of row objects.');
  process.exit(2);
}

const now = new Date().toISOString();
const rows = [], rejected = [];
raw.forEach((r, i) => {
  const out = cv.normaliseImportRow(r, { source: 'excel' });
  if (out.ok) rows.push({ ...out.row, imported_at: now, updated_at: now, updated_by: 'seed script' });
  else rejected.push({ line: i + 1, property: r.property_name, wo: r.work_order, error: out.error });
});

// A duplicate key means two workbook rows the key cannot tell apart. That is a
// data question for Jay, not something to resolve by letting one overwrite the
// other — Postgres would accept the upsert and the tracker would quietly lose a
// citation.
const seen = new Map();
const collisions = [];
rows.forEach(r => {
  if (seen.has(r.deficiency_key)) collisions.push([seen.get(r.deficiency_key), r]);
  else seen.set(r.deficiency_key, r);
});

console.log(`read      ${raw.length} rows from ${path.basename(file)}`);
console.log(`valid     ${rows.length}`);
console.log(`rejected  ${rejected.length}`);
console.log(`distinct  ${seen.size} keys`);

const byProperty = {};
rows.forEach(r => { byProperty[r.property_name] = (byProperty[r.property_name] || 0) + 1; });
console.log('\nby property:');
cv.PROPERTIES.forEach(p => console.log(`  ${p.padEnd(24)} ${byProperty[p] || 0}`));
const strays = Object.keys(byProperty).filter(p => !cv.PROPERTIES.includes(p));
if (strays.length) console.log(`  NOT ONE OF THE NINE: ${strays.join(', ')}`);

const byStatus = {};
rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
console.log('\nby status:');
cv.STATUSES.forEach(s => console.log(`  ${s.padEnd(32)} ${byStatus[s] || 0}`));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
console.log(`\npast a city deadline: ${rows.filter(r => cv.pastDeadline(r, today)).length}`);
console.log(`unverified closures:  ${rows.filter(r => r.unverified_closure).length}`);

if (rejected.length) {
  console.log('\nREJECTED — these rows are NOT in the tracker:');
  rejected.forEach(r => console.log(`  line ${r.line}: ${r.property} / ${r.wo} — ${r.error}`));
}
if (collisions.length) {
  console.log('\nKEY COLLISIONS — two rows the composite key cannot tell apart:');
  collisions.forEach(([a, b]) => {
    console.log(`  ${a.deficiency_key}`);
    [a, b].forEach(r => console.log(`    ${r.case_number} | ${r.work_order} | ${r.address_unit} | ${r.deficiency_description}`));
  });
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(rejected.length || collisions.length ? 1 : 0);
}
if (collisions.length) {
  console.error('\nRefusing to write while keys collide — one row would overwrite the other.');
  process.exit(1);
}

(async () => {
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await db.from('code_violations')
      .upsert(chunk, { onConflict: 'deficiency_key' }).select('deficiency_key');
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        console.error('\ncode_violations does not exist yet — run supabase/migrations/057_code_violations.sql first.');
        process.exit(1);
      }
      console.error('\nupsert failed:', error.message);
      process.exit(1);
    }
    written += (data || chunk).length;
  }
  console.log(`\nwritten   ${written}`);
  // process.exitCode, not process.exit(): the Supabase client keeps a handle
  // open, and tearing the process down under it trips a libuv assertion in the
  // Windows build AFTER the write has already succeeded — alarming output for a
  // run that worked. Letting the event loop drain exits on its own.
  process.exitCode = rejected.length ? 1 : 0;
})();
