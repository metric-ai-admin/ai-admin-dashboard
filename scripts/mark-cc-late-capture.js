#!/usr/bin/env node
//
// Mark cc_daily_state rows that were captured before their own day began.
//
//   node scripts/mark-cc-late-capture.js            # DRY RUN
//   node scripts/mark-cc-late-capture.js --write
//
// NOTHING IS DELETED. A row that exists is evidence of what the nightly job
// did; removing it would make the day look like one the job never ran, which
// is a different fact. It is marked, and lib/daily-report-history.js shows
// "no record (captured late)" in place of figures that belong to another day.
//
// The rule is lateCapture() in that module, not a hand-written list of dates,
// so running this again after the next occurrence finds it.
//
// Requires migration 090. Without it the update fails on capture_note and says
// so — the dry run still works, because it only reads.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const DRH = require('../lib/daily-report-history.js');

const WRITE = process.argv.includes('--write');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  // No personal data is read: the task payloads in this table carry resident
  // names and phone numbers, and none of those columns are selected.
  const rows = await selectAll(() => db.from('cc_daily_state')
    .select('id,state_date,generated_at,total_tasks,completed_tasks'),
  { label: 'cc_daily_state', order: 'state_date' });

  console.log('cc_daily_state: ' + rows.length + ' rows');
  const late = rows.filter(r => DRH.capturedBeforeItsDay(r));

  if (!late.length) { console.log('\nnothing captured before its own day.'); return; }

  console.log('\nCAPTURED BEFORE THE DAY BEGAN: ' + late.length);
  late.forEach(r => {
    const prev = rows.find(x => x.state_date === shiftDay(r.state_date, -1));
    console.log('   ' + r.state_date + '  generated ' + r.generated_at
      + '  total ' + r.total_tasks
      + (prev ? '   (previous day: ' + prev.total_tasks + ')' : ''));
  });
  console.log('\nThe history will show: "' + DRH.LATE_CAPTURE + '"');

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  let done = 0;
  for (const r of late) {
    const { error } = await db.from('cc_daily_state')
      .update({ capture_note: DRH.LATE_CAPTURE }).eq('id', r.id);
    if (error) {
      console.log('FAILED ' + r.state_date + ': ' + error.message);
      if (/capture_note/.test(error.message || '')) {
        console.log('   run supabase/migrations/090_cc_state_capture_note.sql first.');
        break;
      }
      continue;
    }
    done++;
  }
  console.log('\nmarked: ' + done + ' rows (0 deleted)');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });

function shiftDay(ymd, n) {
  const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
