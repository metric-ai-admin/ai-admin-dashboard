#!/usr/bin/env node
//
// Put back the grades a --write-grades run overwrote.
//
//   node scripts/restore-call-grades.js exports/call_grades_backup_2026-09-22_<stamp>.json
//   node scripts/restore-call-grades.js <file> --dry-run
//
// There is no grade history table, so the backup file regrade-sample.js writes
// before it overwrites is the only way back. This is the other half of that:
// a backup nobody can restore from is a comfort, not a safeguard.
//
// Restores every column the regrade touched, including graded_by and graded_at,
// so a restored row is indistinguishable from the one the nightly run wrote —
// which is the point. Rows in the file that no longer exist are reported rather
// than silently skipped.

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const file = process.argv[2];
const DRY = process.argv.includes('--dry-run');

if (!file) {
  console.error('Usage: node scripts/restore-call-grades.js <backup.json> [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('No such backup file: ' + file);
  process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(rows) || !rows.length) {
  console.error('Backup is empty or not an array of rows — refusing to restore.');
  process.exit(2);
}

// Only the columns a regrade writes. id and created_at are identity and are
// deliberately not restored: the row is being put back, not recreated.
const COLUMNS = ['overall_score', 'overall_grade', 'not_scoreable', 'not_scoreable_reason',
  'legal_violation', 'fair_housing_flag', 'liability_flag', 'summary', 'outcome',
  'flags', 'categories', 'coaching', 'key_moments', 'agent_role', 'call_type',
  'rubric_applied', 'graded_by', 'graded_at'];

(async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

  console.log(`backup: ${file}`);
  console.log(`  ${rows.length} row(s), call_date ${[...new Set(rows.map(r => r.call_date))].join(', ')}`);
  console.log(`  graded_by in the backup: ${[...new Set(rows.map(r => r.graded_by))].join(', ')}`);

  // What is in the database RIGHT NOW, so the operator sees what they are undoing.
  const ids = rows.map(r => r.recording_id);
  const { data: live } = await db.from('call_grades')
    .select('recording_id,overall_grade,overall_score,graded_by').in('recording_id', ids);
  const liveBy = Object.fromEntries((live || []).map(r => [r.recording_id, r]));
  const changed = rows.filter(r => {
    const l = liveBy[r.recording_id];
    return l && (l.overall_score !== r.overall_score || l.overall_grade !== r.overall_grade);
  });
  console.log(`\n  currently differing from the backup: ${changed.length} of ${rows.length}`);
  changed.slice(0, 10).forEach(r => {
    const l = liveBy[r.recording_id];
    console.log(`    ${String(r.agent_name || '?').padEnd(16)} live ${l.overall_grade} ${String(l.overall_score).padStart(3)}  →  restoring ${r.overall_grade} ${String(r.overall_score).padStart(3)}`);
  });
  if (changed.length > 10) console.log(`    … and ${changed.length - 10} more`);

  const missing = rows.filter(r => !liveBy[r.recording_id]);
  if (missing.length) console.log(`\n  ${missing.length} row(s) in the backup no longer exist in call_grades — they will be skipped.`);

  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  let ok = 0, failed = 0;
  for (const r of rows) {
    if (!liveBy[r.recording_id]) continue;
    const patch = {};
    COLUMNS.forEach(c => { if (c in r) patch[c] = r[c]; });
    const { error } = await db.from('call_grades').update(patch).eq('recording_id', r.recording_id);
    if (error) { failed++; console.log(`  FAILED ${r.recording_id}: ${error.message}`); }
    else ok++;
  }
  console.log(`\nrestored ${ok} row(s)${failed ? `, ${failed} FAILED` : ''}`);
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
