#!/usr/bin/env node
//
// Why does the stored table hold 2 "Ready to Bill" when a live pull shows 27,
// on the same 133 rows this morning's sync wrote?
// READ ONLY — report reads only, nothing written anywhere.
//
//   node scripts/probe-wo-ready-to-bill.js
//
// WHAT IS ALREADY RULED OUT. The sync stores `status` verbatim — APPFOLIO_WO_
// FIELDS maps status -> ['status'] with no translation — so a mapping is not
// hiding them, and the stored distribution of this morning's 133 rows is
//
//   68 Assigned · 31 Assigned by AppFolio · 16 Work Done · 10 Scheduled
//    4 Waiting · 2 Ready to Bill · 1 Canceled · 1 Estimate Requested
//
// against a live 102 open / 27 Ready to Bill / 4 Work Done. Same 133, split
// differently. So either the two pulls ASK different questions, or the answer
// CHANGED between them.
//
// THE TWO CANDIDATES, and this settles which:
//
//   1. The filters differ. The sync sends status_date '0' (Created On) with a
//      range, nine status codes and three work-order types. The reconciliation
//      sends all 31 codes and no date filter. One of those could be moving
//      rows in or out.
//   2. The work orders really moved. The sync runs at 06:00 and techs close
//      jobs through the day; 25 rows reaching Ready to Bill by the afternoon
//      is a lot but not impossible.
//
// Both pulls are made HERE, seconds apart, so candidate 2 cannot explain a
// difference between them. If the counts match each other, time was the
// answer; if they differ, the filter is, and the run says which field did it.
require('dotenv').config();

const WOS = require('../lib/work-order-status.js');
const WEEK = require('../lib/week.js');

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

const SYNC_CODES = ['0', '1', '2', '9', '11', '3', '6', '8', '12'];
const ALL_CODES = Array.from({ length: 31 }, (_, i) => String(i));
const TYPES = ['internal', 'tenant_requested', 'unit_turn'];

async function pull(label, body) {
  const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
  const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
  const host = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
  const r = await global.fetch('https://' + host + '/api/v2/reports/work_order.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(label + ': AppFolio ' + r.status);
  const j = await r.json().catch(() => null);
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  return { label, rows };
}

function summarise({ label, rows }) {
  const by = {};
  rows.forEach(r => { const s = clean(r.status) || '(blank)'; by[s] = (by[s] || 0) + 1; });
  const rtb = rows.filter(r => WOS.isAwaitingBilling(clean(r.status))).length;
  const wd = rows.filter(r => WOS.isWorkDone(clean(r.status))).length;
  console.log('\n' + label);
  console.log('   rows: ' + rows.length + '   Ready to Bill: ' + rtb + '   Work Done: ' + wd);
  Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([k, v]) => console.log('      ' + pad(v, 6) + k));
  return { rtb, wd, rows };
}

(async () => {
  if (!process.env.APPFOLIO_REPORTS_CLIENT_ID) {
    console.error('APPFOLIO_REPORTS_* are not set. Run on Render.');
    process.exitCode = 1;
    return;
  }
  const today = WEEK.todayYMD();
  console.log('READ ONLY. Two pulls, seconds apart, so time cannot explain a gap.\n');

  // Exactly what the nightly sync asks for.
  const asSync = summarise(await pull('AS THE SYNC ASKS (status_date 0, 9 codes)', {
    status_date: '0',
    status_date_range_from: '2020-01-01',
    status_date_range_to: today,
    work_order_statuses: SYNC_CODES,
    work_order_types: TYPES,
    property_visibility: 'active',
    paginate_results: false,
  }));

  // Exactly what the reconciliation asks for.
  const asRecon = summarise(await pull('AS THE RECONCILIATION ASKS (31 codes, no date)', {
    property_visibility: 'active',
    priority: 'All',
    work_order_statuses: ALL_CODES,
    work_order_types: TYPES,
    paginate_results: false,
  }));

  // The same question with ONE difference at a time, so the field that moves
  // the number is named rather than inferred.
  const noDate = summarise(await pull('SYNC CODES, no status_date filter', {
    work_order_statuses: SYNC_CODES,
    work_order_types: TYPES,
    property_visibility: 'active',
    paginate_results: false,
  }));

  console.log('\nVERDICT');
  if (asSync.rtb === asRecon.rtb) {
    console.log('   Both pulls see ' + asSync.rtb + ' Ready to Bill right now. The filters are');
    console.log('   not the cause, so the stored 2 is a figure from an earlier moment —');
    console.log('   the work orders moved after the sync ran. Nothing is wrong with the');
    console.log('   sync except how often it runs.');
  } else {
    console.log('   The two filters DISAGREE: ' + asSync.rtb + ' against ' + asRecon.rtb + '.');
    console.log('   ' + (noDate.rtb === asRecon.rtb
      ? 'Dropping status_date closes the gap — the Created On range is excluding them.'
      : 'Dropping status_date does NOT close it — the status codes or the types are.'));
    console.log('   The sync is not seeing work orders the reconciliation does, which');
    console.log('   means the stored table is missing them rather than lagging.');
  }
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
