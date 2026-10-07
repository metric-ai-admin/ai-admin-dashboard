#!/usr/bin/env node
//
// Repair the two cc_daily_state rows the first nightly snapshot got wrong.
//
//   node scripts/fix-cc-snapshot-2026-10-06.js            # dry run, writes nothing
//   node scripts/fix-cc-snapshot-2026-10-06.js --write
//
// WHAT WENT WRONG
//
// ccNightlySnapshot ran at 23:30 America/Chicago on 2026-10-06 and asked
// reportDateStr() which day it was. That function reads the SERVER's local
// date, and Render runs on UTC, where it was already 04:30 on the 7th. So the
// job looked up 2026-10-07, found no board, and wrote a "nobody opened it" row
// for a day that had not happened yet.
//
// Two rows are wrong because of it:
//
//   2026-10-06  never recounted. Its counts are whatever Erick's browser last
//               saved at 15:54 CT, eight hours and several closure runs before
//               the day ended.
//   2026-10-07  created with board_opened:false. Erick opened the board that
//               morning and his save wrote 153 tasks into the same row, but
//               board_opened was not part of the save until the fix, so the row
//               still claims nobody was there.
//
// WHAT THIS DOES, AND WHAT IT CANNOT DO
//
// It runs the snapshot's own logic for 2026-10-06, which counts a card as
// closed only when its work order's completed_on is on or before that date —
// so this is not "as of now" dressed up as the 6th.
//
// It is still a RECONSTRUCTION, not the measurement that should have been
// taken. maintenance_work_orders holds one status per work order, not a
// history, so a work order closed on the 6th and reopened since would read
// differently now, and the four Hyde Park Square cancellations written on
// 2026-10-07 carry completed_on 2026-10-06 and therefore count toward that
// day. Both are the honest reading of the data we have; neither is what a
// snapshot taken at the time would have seen.
//
// Only the count columns and board_opened are touched. tasks, checks,
// total_tasks and generated_at are left exactly as they are.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const ccAuto = require('../lib/cc-autocomplete.js');

const WRITE = process.argv.includes('--write');
const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } });

const show = o => JSON.stringify(o);

(async () => {
  const [wo, insp] = await Promise.all([
    db.from('maintenance_work_orders').select('work_order_id, status, completed_on'),
    db.from('maintenance_inspections').select('inspection_id, status, marked_done_on'),
  ]);
  if (wo.error) throw new Error('work orders: ' + wo.error.message);
  if (insp.error) throw new Error('inspections: ' + insp.error.message);
  const wos = new Map();
  (wo.data || []).forEach(r => { if (r.work_order_id) wos.set(String(r.work_order_id).trim(), r); });
  const inspections = new Map();
  (insp.data || []).forEach(r => { if (r.inspection_id) inspections.set(String(r.inspection_id).trim(), r); });

  // ---- 2026-10-06: the recount it never got -------------------------------
  const { data: six, error: e6 } = await db.from('cc_daily_state')
    .select('*').eq('state_date', '2026-10-06').maybeSingle();
  if (e6) throw new Error(e6.message);
  if (!six) { console.log('2026-10-06: no row — nothing to repair'); return; }

  const auto = ccAuto.autoMap(six.tasks, { wos, inspections, on: '2026-10-06' });
  const counts = ccAuto.countsFor(six.tasks, six.checks, auto);
  const cancelled = Object.values(auto).filter(a => a.kind === 'cancelled').length;

  console.log('=== 2026-10-06 ===');
  console.log('  tasks        ', (six.tasks || []).length, ' (unchanged)');
  console.log('  stored       ',
    show({ completed_tasks: six.completed_tasks, completed_manual: six.completed_manual,
      completed_auto: six.completed_auto, completed_routine: six.completed_routine,
      board_opened: six.board_opened }));
  console.log('  recounted    ', show({ ...counts, board_opened: true }));
  console.log('  of which cancelled:', cancelled);

  // ---- 2026-10-07: the stale flag -----------------------------------------
  const { data: sev, error: e7 } = await db.from('cc_daily_state')
    .select('state_date, total_tasks, board_opened').eq('state_date', '2026-10-07').maybeSingle();
  if (e7) throw new Error(e7.message);
  console.log('\n=== 2026-10-07 ===');
  if (!sev) {
    console.log('  no row');
  } else {
    console.log('  total_tasks', sev.total_tasks, '| board_opened', sev.board_opened,
      sev.total_tasks > 0 && sev.board_opened === false
        ? '  -> a board with tasks on it was plainly opened; correcting to true'
        : '  -> nothing to correct');
  }

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to apply.');
    return;
  }

  // Only the fields above. An update, not an upsert: the row exists, and a
  // whole-row write would be a chance to lose tasks or checks for nothing.
  const { error: u6 } = await db.from('cc_daily_state')
    .update({ ...counts, board_opened: true }).eq('state_date', '2026-10-06');
  if (u6) throw new Error('2026-10-06: ' + u6.message);
  console.log('\n2026-10-06 updated.');

  if (sev && sev.total_tasks > 0 && sev.board_opened === false) {
    const { error: u7 } = await db.from('cc_daily_state')
      .update({ board_opened: true }).eq('state_date', '2026-10-07');
    if (u7) throw new Error('2026-10-07: ' + u7.message);
    console.log('2026-10-07 board_opened corrected.');
  }

  const { data: after } = await db.from('cc_daily_state')
    .select('state_date,total_tasks,completed_tasks,completed_manual,completed_auto,completed_routine,board_opened')
    .in('state_date', ['2026-10-05', '2026-10-06', '2026-10-07']).order('state_date');
  console.log('\nafter:');
  (after || []).forEach(r => console.log('  ' + show(r)));
})().catch(e => { console.error(e.message); process.exit(1); });
