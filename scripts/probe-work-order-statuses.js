#!/usr/bin/env node
//
// Do "Work Done" and "Ready to Bill" exist anywhere in the work_order report?
//
//   node scripts/probe-work-order-statuses.js
//
// READ-ONLY. Run on Render Shell where the AppFolio credentials live.
//
// WHY THIS IS STILL WORTH ONE RUN
//
// The synced data already answers most of the hybrid question (see the report
// to Bekah): work_order carries real billing columns, but only on Completed
// rows, and the statuses it returns are Assigned / Assigned by AppFolio /
// Scheduled / New by AppFolio / Completed / Completed No Need To Bill. No Work
// Done, no Ready to Bill.
//
// That is not quite proof, for one specific reason: work_order's UNFILTERED
// pull is not everything. wo_all sends no params and returns 152 open work
// orders; wo_completed sends codes 4 and 7 and returns 1468. So the default
// omits whole statuses, and a status we have never asked for by code would not
// appear in either file. work_order's code vocabulary has never been swept the
// way work_order_billable_detail's was.
//
// One sweep settles it. If Work Done and Ready to Bill are not in work_order
// either, they are not reachable through this API at all, and no amount of
// joining two reports will produce them.

require('dotenv').config();

const SUBDOMAIN = process.env.APPFOLIO_SUBDOMAIN || 'metricpropertymanagement';
const CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const SECRET = process.env.APPFOLIO_CLIENT_SECRET;

if (!CLIENT_ID || !SECRET) {
  console.error('APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET are not set in this shell.');
  console.error('Run this on Render Shell for the dashboard service, where they are configured.');
  process.exit(2);
}

const AUTH = 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
const HOST = `https://${SUBDOMAIN}.appfolio.com`;
const pause = () => new Promise(r => setTimeout(r, 2300));

// Columns the Billable Labor Report needs from whichever source supplies the
// pending work. Checked per status, because on this account they are populated
// for Completed rows and empty for open ones — a column EXISTING is not the
// same as a column carrying a number.
const BILLING = ['vendor_bill_amount', 'corporate_charge_amount', 'vendor_charge_amount',
  'last_billed_on', 'invoice', 'amount'];

async function call(body) {
  let res, text = '';
  try {
    res = await fetch(`${HOST}/api/v2/reports/work_order.json`, {
      method: 'POST',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      redirect: 'manual',
    });
    text = await res.text();
  } catch (e) { return { error: e.code || e.message, rows: null }; }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const rows = json && (Array.isArray(json) ? json : json.results || json.rows || json.data);
  return { status: res.status, rows: Array.isArray(rows) ? rows : null,
    nextPage: !!(json && (json.next_page_url || json.nextPageUrl)) };
}

(async () => {
  console.log(`work_order — full status sweep   ${HOST}`);
  console.log('READ-ONLY. Only status values and column fill rates are printed.\n');

  console.log('=== 1. Codes 1..30 in ONE request =================================');
  const all = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const wide = await call({ work_order_statuses: all });
  const rows = wide.rows || [];
  console.log(`  status ${wide.status}  rows=${rows.length}${wide.nextPage ? '  (MORE PAGES)' : ''}`);
  const tally = {};
  rows.forEach(r => { const v = r.status; if (v) tally[v] = (tally[v] || 0) + 1; });
  console.log('  every status this credential can see through work_order:');
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));
  ['work done', 'ready to bill'].forEach(w => {
    const hit = Object.keys(tally).find(k => k.toLowerCase().includes(w));
    console.log(`  ${hit ? 'FOUND  ' : 'ABSENT '} "${w}"${hit ? ' -> ' + hit : ''}`);
  });
  await pause();

  console.log('\n=== 2. Which codes carry which status =============================');
  for (let code = 1; code <= 30; code++) {
    const r = await call({ work_order_statuses: [String(code)] });
    const rr = r.rows || [];
    const vals = [...new Set(rr.map(x => x.status).filter(Boolean))];
    if (rr.length) console.log(`  code ${String(code).padStart(2)}  ${String(rr.length).padStart(5)} rows  ${vals.join(' | ')}`);
    await pause();
  }

  console.log('\n=== 3. Are the billing columns POPULATED per status? ==============');
  console.log('    A column that exists but is empty on open work orders cannot feed');
  console.log('    a billable report. wo_all shows exactly that today.\n');
  const byStatus = {};
  rows.forEach(r => { const s = r.status || '(none)'; (byStatus[s] = byStatus[s] || []).push(r); });
  console.log(`  ${'status'.padEnd(28)} ${BILLING.map(c => c.slice(0, 12).padStart(13)).join('')}`);
  Object.entries(byStatus).forEach(([s, rs]) => {
    const cells = BILLING.map(c => {
      const n = rs.filter(r => r[c] !== null && r[c] !== undefined && r[c] !== '').length;
      return `${n}/${rs.length}`.padStart(13);
    }).join('');
    console.log(`  ${s.slice(0, 27).padEnd(28)}${cells}`);
  });

  console.log('\n  If the pending statuses show 0/N across the billing columns, joining');
  console.log('  work_order to work_order_billable_detail cannot produce the unbilled');
  console.log('  figures — the numbers do not exist on those rows in the API.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
