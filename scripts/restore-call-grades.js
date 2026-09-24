#!/usr/bin/env node
//
// Put back the grades a --write-grades run overwrote.
//
//   node scripts/restore-call-grades.js exports/call_grades_backup_2026-09-22_<stamp>.json
//   node scripts/restore-call-grades.js --batch regrade_2026-09-22_<stamp>
//   ... either form takes --dry-run
//
// Two sources, same restore. The exports/ file is local and disappears with the
// Render disk; call_grades_history (migration 060) is in the database and does
// not. --batch is the one to reach for from Render Shell, where the file that
// a previous deploy wrote is very likely already gone.
//
// A backup nobody can restore from is a comfort, not a safeguard.
//
// Restores every column the regrade touched, including graded_by and graded_at,
// so a restored row is indistinguishable from the one the nightly run wrote —
// which is the point. Rows in the file that no longer exist are reported rather
// than silently skipped.

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const DRY = process.argv.includes('--dry-run');
const batchAt = process.argv.indexOf('--batch');
const BATCH = batchAt > -1 ? process.argv[batchAt + 1] : null;
const file = batchAt > -1 ? null : process.argv[2];

if (batchAt > -1 && !BATCH) {
  console.error('--batch needs a batch id, e.g. --batch regrade_2026-09-22_2026-09-25T18-04-11-902Z');
  process.exit(2);
}
if (!BATCH && !file) {
  console.error('Usage: node scripts/restore-call-grades.js <backup.json> [--dry-run]');
  console.error('   or: node scripts/restore-call-grades.js --batch <batch_id> [--dry-run]');
  process.exit(2);
}
if (file && !fs.existsSync(file)) {
  console.error('No such backup file: ' + file);
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

  let rows;
  if (BATCH) {
    // `previous` is the whole pre-overwrite call_grades row, so history rows
    // restore through exactly the same path as file rows below.
    const { data, error } = await db.from('call_grades_history')
      .select('previous').eq('batch_id', BATCH);
    if (error) {
      throw new Error('could not read call_grades_history: ' + error.message
        + '\nIf the table is missing, run supabase/migrations/060_call_grades_history.sql.');
    }
    if (!data || !data.length) throw new Error(`no history rows for batch ${BATCH}`);
    rows = data.map(r => r.previous);
  } else {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Nothing to restore from — refusing to touch call_grades.');
  }

  console.log(`source: ${BATCH ? 'call_grades_history batch ' + BATCH : file}`);
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
