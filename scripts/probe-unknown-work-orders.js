#!/usr/bin/env node
//
// What is actually true about the 104 "Unknown — not in feed" work orders?
//
//   node scripts/probe-unknown-work-orders.js
//
// READ-ONLY. Nothing is written to Supabase or to AppFolio. Run on Render
// Shell, where the AppFolio credentials live.
//
// WHY
//
// The reconciliation on 2026-10-05 settled 362 work orders and left 104 it
// could not speak for. It compares two feeds:
//
//   wo_all        work_order with no params      -> 95 open
//   wo_completed  work_order_statuses ['4','7']  -> 1157 Completed / Completed
//                                                   No Need To Bill
//
// A row in neither becomes Unknown. Two reasons it can land there, and they
// need different fixes:
//
//   1. It closed before wo_completed's window opened. The pull returned
//      completions from 2026-07-02 to 2026-10-02 only — 12 of the 104 were
//      created before that date.
//
//   2. It is in a status NEITHER pull asks for. Code 5 (Canceled) is
//      deliberately excluded from wo_completed, and any status beyond 4/5/7
//      has never been requested by code at all. 92 of the 104 were created
//      INSIDE the window, so this is where they most likely are.
//
// The sweep below asks for codes 1..30 in a single request. If a work order
// exists under any status this credential can see, it comes back with its
// real status — which is both the answer and the fix: one request, not 104.
//
// The output ends with the dry run: how many would close, under what status,
// and how many would still have nothing to say for them.

require('dotenv').config();

const { fetchReport, isConfigured } = require('../appfolio-client.js');
const { createClient } = require('@supabase/supabase-js');
const WOS = require('../lib/work-order-status.js');

if (!isConfigured()) {
  console.error('AppFolio is not configured in this shell.');
  console.error('Run this on Render Shell for the dashboard service.');
  process.exit(2);
}

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

const ALL_CODES = Array.from({ length: 30 }, (_, i) => String(i + 1));
const key = r => String(r && r.work_order_number == null ? '' : r.work_order_number).trim();
const dateOf = r => String(r.completed_on || r.work_completed_on || r.canceled_on || '').slice(0, 10);

(async () => {
  console.log('Unknown work orders — what does AppFolio say today?');
  console.log('READ-ONLY. Pauses are handled by the shared 7-req/15s limiter.\n');

  // ---- 1. The rows we cannot speak for ------------------------------------
  const { data: table, error } = await db.from('maintenance_work_orders')
    .select('work_order_number,status,property_name,created_at_appfolio').limit(50000);
  if (error) throw new Error('supabase: ' + error.message);

  const unknown = table.filter(r => WOS.isUnknown(r.status));
  console.log(`=== 1. Our table ===================================================`);
  console.log(`  ${table.length} rows, ${unknown.length} Unknown`);
  if (!unknown.length) { console.log('  nothing to resolve.'); return; }

  // ---- 2. The sweep --------------------------------------------------------
  console.log(`\n=== 2. work_order, statuses 1..30, one request =====================`);
  const sweep = await fetchReport('work_order', { work_order_statuses: ALL_CODES });
  const rows = sweep.rows || [];
  console.log(`  ${rows.length} rows   pages=${sweep.pages}  truncated=${sweep.truncated}`);
  if (sweep.truncated) console.log('  WARNING: truncated — the page cap was hit, this is not everything.');

  const tally = {};
  rows.forEach(r => { const s = r.status || '(none)'; tally[s] = (tally[s] || 0) + 1; });
  console.log('  every status this credential can see:');
  Object.entries(tally).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));

  const dates = rows.map(dateOf).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length) {
    console.log(`  dated rows span ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} of ${rows.length})`);
    console.log('  NOTE: a window here is a second, separate limit — a work order older');
    console.log('  than it cannot be resolved by this route no matter what status it is in.');
  }

  // ---- 3. Does the sweep actually contain more than the two pulls? ---------
  // A sweep that returns exactly wo_all + wo_completed would mean the extra
  // codes are silently ignored, the same way `status: 'Completed'` was.
  console.log(`\n=== 3. Is the sweep wider than the two pulls we already have? ======`);
  const af = require('../appfolio-reports.js');
  const openStore = await af.readReportData('wo_all');
  const compStore = await af.readReportData('wo_completed');
  const known = new Set([
    ...(((openStore && openStore.rows) || []).map(key)),
    ...(((compStore && compStore.rows) || []).map(key)),
  ].filter(Boolean));
  const sweepKeys = new Set(rows.map(key).filter(Boolean));
  const extra = [...sweepKeys].filter(k => !known.has(k));
  console.log(`  wo_all + wo_completed cover ${known.size} work orders`);
  console.log(`  the sweep covers           ${sweepKeys.size}`);
  console.log(`  rows ONLY the sweep has:   ${extra.length}`);
  if (!extra.length) {
    console.log('  The extra status codes were IGNORED — this route cannot resolve anything.');
    console.log('  Do not wire it in. The Unknowns stay Unknown and that is the honest answer.');
  }

  // ---- 4. The dry run ------------------------------------------------------
  console.log(`\n=== 4. DRY RUN — what would change, nothing written ================`);
  const found = new Map();
  rows.forEach(r => { const k = key(r); if (k) found.set(k, r); });

  const toClose = [], toOpen = [], stillUnknown = [];
  unknown.forEach(r => {
    const hit = found.get(key(r));
    if (!hit) { stillUnknown.push(r); return; }
    const s = String(hit.status || '').trim();
    (WOS.isClosed(s) ? toClose : toOpen).push({ ...r, found_status: s, found_on: dateOf(hit) });
  });

  const byStatus = {};
  toClose.forEach(c => { byStatus[c.found_status] = (byStatus[c.found_status] || 0) + 1; });

  console.log(`  of ${unknown.length} Unknown:`);
  console.log(`    ${toClose.length}  would become CLOSED`);
  Object.entries(byStatus).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`        ${String(v).padStart(4)}  ${k}`));
  console.log(`    ${toOpen.length}  come back OPEN — they are live work Erick is not seeing`);
  toOpen.slice(0, 20).forEach(c => console.log(`        ${c.work_order_number.padEnd(10)} ${c.found_status.padEnd(24)} ${c.property_name}`));
  if (toOpen.length > 20) console.log(`        ... and ${toOpen.length - 20} more`);
  console.log(`    ${stillUnknown.length}  stay Unknown — AppFolio does not return them at all`);

  const oldest = stillUnknown.map(r => String(r.created_at_appfolio || '').slice(0, 10)).filter(Boolean).sort();
  if (oldest.length) console.log(`        created ${oldest[0]} .. ${oldest[oldest.length - 1]}`);
  stillUnknown.slice(0, 20).forEach(r => console.log(`        ${r.work_order_number.padEnd(10)} ${String(r.created_at_appfolio).slice(0, 10)}  ${r.property_name}`));
  if (stillUnknown.length > 20) console.log(`        ... and ${stillUnknown.length - 20} more`);

  console.log('\n  Nothing was written. The apply step is');
  console.log('    POST /api/maintenance/reconcile  {"write":true,"sweep":true}');
  console.log('  which backs up to disk and to work_order_reconcile_log first.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
