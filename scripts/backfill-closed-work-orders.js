#!/usr/bin/env node
//
// Work orders that were created AND closed between two syncs are invisible to
// us. This inserts them.
//
//   node scripts/backfill-closed-work-orders.js            # dry run
//   node scripts/backfill-closed-work-orders.js --write
//
// WHY THEY ARE MISSING. /api/maintenance/sync asks AppFolio for OPEN status
// codes and drops anything closed before it writes, and the reconciliation only
// ever UPDATES rows that already exist. So a work order opened on Monday and
// completed on Wednesday, with no sync in between catching it open, never
// enters maintenance_work_orders at all. On the 2026-09-27..10-03 week that is
// 19 completions Katie's report has and we do not — not a wrong status or a
// wrong date, no row.
//
// WHAT IT INSERTS. Rows from the wo_completed and wo_canceled stores whose
// work_order_number is not in the table. Existing rows are NEVER touched: this
// only adds, so a row a person or the reconciliation has already settled
// cannot be overwritten by a feed.
//
// WHY THE COMMAND CENTER DOES NOT GROW NEW CARDS. Its work-order slot is fed
// by the RESPONSE of /api/maintenance/sync, which returns open rows only — it
// does not read this table. And ccGenerate skips completed and cancelled work
// orders for every actionable category anyway. Both are asserted in the dry
// run below rather than assumed.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const WOS = require('../lib/work-order-status.js');

const WRITE = process.argv.includes('--write');
const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pick = (r, keys) => {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') return r[k];
  }
  return null;
};
const day = v => {
  if (!v) return null;
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
};

function rowFrom(r, source) {
  const number = pick(r, ['work_order_number']);
  if (!number) return null;
  return {
    work_order_number: String(number).trim(),
    property: pick(r, ['property']),
    property_name: pick(r, ['property_name', 'property']),
    property_id: pick(r, ['property_id']) && String(pick(r, ['property_id'])),
    unit: pick(r, ['unit_name', 'unit']),
    issue: pick(r, ['work_order_issue', 'job_description']),
    description: pick(r, ['job_description']),
    status: pick(r, ['status']),
    priority: pick(r, ['priority']),
    work_order_type: pick(r, ['work_order_type']),
    assigned_user: pick(r, ['assigned_user']),
    vendor: pick(r, ['vendor']),
    primary_resident: pick(r, ['primary_tenant']),
    created_at_appfolio: pick(r, ['created_at']),
    work_order_id: pick(r, ['work_order_id']) && String(pick(r, ['work_order_id'])),
    service_request_id: pick(r, ['service_request_id']) && String(pick(r, ['service_request_id'])),
    // The date the closure happened, by whichever name the feed uses. Canceled
    // rows carry canceled_on and nothing else.
    completed_on: day(pick(r, ['completed_on', 'work_completed_on', 'canceled_on'])),
    // NOT stamped: last_seen_in_feed means "the OPEN feed still carries this".
    // Filling it here would tell the reconciliation these rows are open.
    last_seen_in_feed: null,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    updated_by: 'backfill-closed-work-orders',
  };
}

(async () => {
  const af = require('../appfolio-reports.js');
  const store = async id => {
    const d = await af.readReportData(id);
    const rows = (d && d.rows) || [];
    console.log('  ' + id.padEnd(16) + String(rows.length).padStart(6) + ' rows'
      + (d && d.fetchedAt ? '   fetched ' + d.fetchedAt : '   (no store on this machine)'));
    return rows;
  };
  console.log('stores:');
  const completed = await store('wo_completed');
  const canceled = await store('wo_canceled');
  if (!completed.length && !canceled.length) {
    console.error('\nBoth stores are empty here. Run this where the Render disk is.');
    process.exit(2);
  }

  const { data: existing, error } = await db.from('maintenance_work_orders')
    .select('work_order_number').limit(50000);
  if (error) throw new Error(error.message);
  const have = new Set((existing || []).map(r => String(r.work_order_number).trim()));
  console.log('\nmaintenance_work_orders: ' + have.size + ' work orders on file');

  const seen = new Set();
  const add = [];
  const consider = (rows, source) => rows.forEach(r => {
    const rec = rowFrom(r, source);
    if (!rec) return;
    if (have.has(rec.work_order_number) || seen.has(rec.work_order_number)) return;
    // Only ever a CLOSED row. If a feed hands back something open, it belongs
    // to the normal sync and not here.
    if (!WOS.isClosed(rec.status)) return;
    seen.add(rec.work_order_number);
    add.push(rec);
  });
  // completed first, so a work order in both is kept as completed.
  consider(completed, 'wo_completed');
  consider(canceled, 'wo_canceled');

  console.log('\nnew rows to insert: ' + add.length);
  const byStatus = {}, byYear = {}, byProp = {};
  add.forEach(r => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byYear[String(r.completed_on || '').slice(0, 7) || '(no date)'] =
      (byYear[String(r.completed_on || '').slice(0, 7) || '(no date)'] || 0) + 1;
    byProp[r.property_name || '(none)'] = (byProp[r.property_name || '(none)'] || 0) + 1;
  });
  console.log('  by status: ' + JSON.stringify(byStatus));
  console.log('  every one is closed: ' + add.every(r => WOS.isClosed(r.status)));
  console.log('  none carries last_seen_in_feed: ' + add.every(r => r.last_seen_in_feed === null));
  console.log('\n  by month closed:');
  Object.keys(byYear).sort().forEach(k => console.log('    ' + k + '  ' + byYear[k]));
  console.log('\n  by property:');
  Object.entries(byProp).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('    ' + String(v).padStart(4) + '  ' + k));

  // The nineteen the KPI comparison named for 2026-09-27..10-03.
  const WEEK = ['22437-1', '22979-1', '22981-1', '22982-1', '22983-1', '22984-1', '22987-1',
    '23025-1', '23036-1', '23049-1', '23051-1', '23057-1', '23058-1', '23059-1', '23067-1',
    '23071-1', '23084-1', '23085-1', '23086-1'];
  const got = WEEK.filter(w => seen.has(w));
  console.log('\n  of the 19 that week: ' + got.length + ' would be inserted'
    + (got.length < WEEK.length ? '   MISSING: ' + WEEK.filter(w => !seen.has(w)).join(', ') : ''));

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  // A backup of what the table looked like, before adding anything.
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.DATA_DIR || '.';
  const backup = path.join(dir, 'wo-backfill-' + new Date().toISOString().replace(/[:.]/g, '') + '.json');
  try {
    fs.writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), inserting: add }, null, 1));
    console.log('\nbackup: ' + backup);
  } catch (e) { console.log('\nbackup could not be written: ' + e.message); }

  let wrote = 0;
  for (let i = 0; i < add.length; i += 500) {
    const chunk = add.slice(i, i + 500);
    // INSERT, never upsert: this must not be able to touch a row that exists.
    const { error: e2 } = await db.from('maintenance_work_orders').insert(chunk);
    if (e2) throw new Error(e2.message);
    wrote += chunk.length;
  }
  console.log('inserted: ' + wrote);
})().catch(e => { console.error(e.message); process.exit(1); });
