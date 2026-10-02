#!/usr/bin/env node
//
// READ ONLY. Compares Lyndsay's KPI workbook against lib/kpi-lyndsay.js,
// property by property and metric by metric.
//
//   node scripts/kpi-compare-lyndsay.js
//   node scripts/kpi-compare-lyndsay.js --xlsx "<path>" --start 2026-09-20 --end 2026-09-26
//
// It reads the workbook and reads Supabase. It writes nothing to either, and
// nothing the dashboard shows changes because this runs.
//
// THE POINT IS THE DISAGREEMENTS. A matching column proves one rule was copied
// correctly; a mismatch is either a bug in our module or a gap in our data, and
// the two need telling apart before anything replaces her report. Every
// difference gets a one-line probable cause rather than being left as a number.
//
// Her side is computed here with HER rules, read off kpi_dashboard_17.html —
// fixed column positions, tours = Status starting with "Completed", preleased
// = occupied + vacant rented. Not our module's rules applied to her sheets,
// which would agree by construction and prove nothing.

require('dotenv').config();
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const { createClient } = require('@supabase/supabase-js');
const K = require(path.join(__dirname, '..', 'lib', 'kpi-lyndsay.js'));

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const XLSX_PATH = arg('xlsx') || 'C:/Users/artur/Downloads/Data Source End of Last Week 09.20.26 to 09.26.26.xlsx';
const START = arg('start') || '2026-09-20';
const END = arg('end') || '2026-09-26';

const num = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : 0;
};
const canon = K.canonicalProperty;

// Properties the dashboard syncs that are NOT in Lyndsay's workbook. They are
// not disagreements — her report does not cover them — and leaving them in the
// table made eleven of the forty-three "differences" noise that buried the ones
// that matter. Excluded by name, with the reason, so adding one back is a
// visible decision rather than a silent widening of scope.
const NOT_IN_HER_REPORT = new Map([
  ['Brazos Lofts',    'not in her workbook'],
  ['Cedar and Sage',  'not in her workbook'],
  ['513 Wolf Ridge',  'not in her workbook'],
  ['Live With Metric', 'the corporate entity, not a managed property'],
  ['The Sidney',      'under assignment'],
]);
const inScope = name => {
  if (NOT_IN_HER_REPORT.has(name)) return false;
  // "513 Wolf Ridge Georgetown, TX 78628" is one property under a long name.
  for (const skip of NOT_IN_HER_REPORT.keys()) if (String(name).startsWith(skip)) return false;
  return true;
};
const rowsOf = (wb, name) => {
  const ws = wb.Sheets[wb.SheetNames.find(n => n.toLowerCase() === name.toLowerCase())];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) : [];
};

// ── Lyndsay's side, with Lyndsay's rules ────────────────────────────────────
function hers(wb) {
  const out = {};
  const b = p => { const k = canon(p); if (!k) return null; if (!out[k]) out[k] = {}; return out[k]; };
  const add = (p, key, n) => { const x = b(p); if (x) x[key] = (x[key] || 0) + n; };

  // occupancy: C units, D occupied, H vacant rented, I vacant unrented,
  // J notice rented, K notice unrented
  rowsOf(wb, 'occupancy').forEach(r => {
    if (!r[0] || r[0] === 'Property' || r[0] === 'Total' || r[2] === '') return;
    const p = canon(r[0]); if (!p) return;
    add(p, 'units', num(r[2]));
    add(p, 'occupied', num(r[3]));
    add(p, 'vacantRentedOcc', num(r[7]));
    add(p, 'vacantUnrented', num(r[8]));
    add(p, 'notices', num(r[9]) + num(r[10]));
  });

  // guest card interests: property is column J
  rowsOf(wb, 'guest card interests').forEach(r => {
    if (!r[9] || String(r[9]).indexOf(' - ') === -1) return;
    add(r[9], 'leads', 1);
  });

  // showings: property column O ("Property Name", bare — no address, unlike
  // column D), status column J, "Completed" prefix only
  rowsOf(wb, 'showings').forEach(r => {
    if (!r[14] || r[14] === 'Property Name') return;
    add(r[14], 'showings', 1);
    if (String(r[9] || '').indexOf('Completed') === 0) add(r[14], 'tours', 1);
  });

  // apps: A applicant, B property, C received, F status, M detailed status
  rowsOf(wb, 'apps').forEach(r => {
    if (!r[0] || !r[1] || r[1] === 'Property Name') return;
    const rec = K.ymd(r[2]);
    if (!rec || rec < START || rec > END) return;
    add(r[1], 'applications', 1);
    const s = String(r[5] || '').trim();
    if (s === 'Approved') add(r[1], 'approved', 1);
    else if (/^cancel/i.test(s)) add(r[1], 'canceled', 1);
    else if (/denied|declined/i.test(s)) add(r[1], 'denied', 1);
    else add(r[1], 'pending', 1);
    if (String(r[12] || '').trim() === 'Converting') add(r[1], 'vacantRented', 1);
  });

  // box score: C event, matched on text; property is column A when it has ' - '
  let currentProp = null;
  rowsOf(wb, 'box score').forEach(r => {
    const c0 = String(r[0] || '');
    if (c0.indexOf(' - ') !== -1) { currentProp = c0; return; }
    if (!r[2] || !currentProp) return;
    const ev = String(r[2]).toLowerCase();
    if (ev.indexOf('move-in') !== -1 || ev.indexOf('move in') !== -1) add(currentProp, 'moveIns', 1);
    else if (ev.indexOf('move-out') !== -1 || ev.indexOf('move out') !== -1) add(currentProp, 'moveOuts', 1);
    else if (ev.indexOf('notice') !== -1) add(currentProp, 'newNotices', 1);
  });

  Object.keys(out).forEach(p => {
    const x = out[p];
    x.preleased = (x.occupied || 0) + (x.vacantRentedOcc || 0);
    x.occPct = x.units ? x.occupied / x.units : null;
  });
  return out;
}

// ── Our side, from Supabase ─────────────────────────────────────────────────
async function ours() {
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const grab = async (t, cols) => {
    const { data, error } = await db.from(t).select(cols).limit(20000);
    if (error) { console.error(`  (${t}: ${error.message})`); return []; }
    return data || [];
  };
  const [occupancy, leads, showings, applications, leaseHistory, workOrders] = await Promise.all([
    grab('leasing_occupancy', 'property_name,total_units,occupied_units,vacant_rented,notice_units,as_of'),
    grab('leasing_leads', 'property,interest_received'),
    grab('leasing_showings', 'property_name,showing_date,status'),
    grab('leasing_applications', 'property_name,application_date,status'),
    grab('leasing_lease_history', 'property_name,move_in_date,move_out_date,renewal'),
    grab('maintenance_work_orders', 'property_name,status,created_at_appfolio,updated_at'),
  ]);
  // Move-outs come from unit_turn_detail, which lives in the saved-report store
  // on Render rather than in Supabase. Locally it is usually absent, and an
  // empty array is honest: the comparison then shows 0 move-outs rather than
  // silently falling back to lease_history, which has three in its history.
  let unitTurns = [];
  try {
    const af = require(path.join(__dirname, '..', 'appfolio-reports.js'));
    const d = await af.readReportData('unit_turn_detail');
    unitTurns = (d && d.rows) || (Array.isArray(d) ? d : []);
  } catch { /* not synced here — reported below */ }
  if (!unitTurns.length) {
    console.log('  (unit_turn_detail not in the local store — move-outs will read 0;');
    console.log('   run this on Render, or sync the report, for a real comparison)\n');
  }
  // detailed_status is what Vacant Rented reads. Pull it explicitly so a row
  // synced before migration 075 is visibly null rather than missing.
  const applications2 = await grab('leasing_applications',
    'property_name,application_date,status,detailed_status');
  return K.build({ occupancy, leads, showings, applications: applications2, leaseHistory, workOrders, unitTurns },
    { weekStart: START, weekEnd: END, asOf: END });
}

// ── Why they differ ─────────────────────────────────────────────────────────
function explain(metric, h, o, ctx) {
  if (o === null) {
    if (metric === 'vacantRented') return 'we cannot compute it — no "Converting" status in leasing_applications';
    return 'we have no value for this metric yet';
  }
  if (h === undefined || h === null) return 'her workbook has no row for this property';
  if (metric === 'units' || metric === 'occupied' || metric === 'notices'
    || metric === 'preleased' || metric === 'occPct' || metric === 'vacantUnrented') {
    return `snapshot date — her sheet is as of ${END}, leasing_occupancy holds ${ctx.asOf.join(' / ') || 'nothing'}`;
  }
  if (metric === 'moveIns' || metric === 'moveOuts' || metric === 'newNotices') {
    return 'hers comes from the box score event list, ours from lease_history dates';
  }
  if (metric === 'tours' || metric === 'showings') return 'showing_date window or a status spelled differently';
  if (metric === 'leads') return 'hers filters Interest Received, ours the same column — check the sync window';
  return 'rule or window differs';
}

(async () => {
  console.log('KPI comparison — READ ONLY, nothing is written anywhere.');
  console.log(`Week    : ${START} .. ${END}`);
  console.log(`Workbook: ${XLSX_PATH}\n`);

  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true });
  const H = hers(wb);
  const O = await ours();
  console.log(`leasing_occupancy as_of in our data: ${O.occupancyAsOf.join(', ') || '(none)'}\n`);

  const METRICS = ['units', 'occupied', 'preleased', 'occPct', 'vacantUnrented', 'notices',
    'leads', 'showings', 'tours', 'applications', 'approved', 'canceled',
    'vacantRented', 'moveIns', 'moveOuts'];
  const all = [...new Set(Object.keys(H).concat(Object.keys(O.byProperty)))].sort();
  const props = all.filter(inScope);
  const skipped = all.filter(p => !inScope(p));
  if (skipped.length) {
    console.log('Out of scope:');
    skipped.forEach(p2 => {
      const why = NOT_IN_HER_REPORT.get(p2)
        || [...NOT_IN_HER_REPORT.entries()].find(([k]) => String(p2).startsWith(k))?.[1] || '';
      console.log(`   ${p2}  —  ${why}`);
    });
    console.log('');
  }

  const fmt = v => v === null || v === undefined ? '—'
    : (typeof v === 'number' && !Number.isInteger(v) ? (v * 100).toFixed(1) + '%' : String(v));
  let agree = 0, differ = 0, cannot = 0;
  const notes = {};

  for (const p of props) {
    const h = H[p] || {}, o = O.byProperty[p] || {};
    const lines = [];
    for (const m of METRICS) {
      const hv = h[m] === undefined ? null : h[m];
      const ov = o[m] === undefined ? null : o[m];
      if (hv === null && (ov === null || ov === 0)) continue;
      let mark, diff;
      if (ov === null) { mark = 'n/a '; diff = '—'; cannot++; }
      else if (typeof hv === 'number' && typeof ov === 'number'
        && Math.abs(hv - ov) < (Number.isInteger(hv) ? 0.5 : 0.001)) { mark = ' ok '; diff = '0'; agree++; }
      else {
        mark = 'DIFF'; differ++;
        diff = (typeof hv === 'number' && typeof ov === 'number')
          ? (ov - hv > 0 ? '+' : '') + fmt(ov - hv) : '—';
        const why = explain(m, hv, ov, { asOf: O.occupancyAsOf });
        notes[m + ' :: ' + why] = (notes[m + ' :: ' + why] || 0) + 1;
      }
      lines.push(`   ${mark}  ${m.padEnd(15)} hers ${fmt(hv).padStart(9)}   ours ${fmt(ov).padStart(9)}   ${diff}`);
    }
    if (!lines.length) continue;
    console.log('='.repeat(78));
    console.log(p);
    console.log('='.repeat(78));
    lines.forEach(l => console.log(l));
  }

  console.log('\n' + '='.repeat(78));
  console.log(`matching: ${agree}   differing: ${differ}   not computable yet: ${cannot}`);
  console.log('\nProbable causes, by how often they came up:');
  Object.entries(notes).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    const [metric, why] = k.split(' :: ');
    console.log(`  ${String(n).padStart(3)}x  ${metric.padEnd(16)} ${why}`);
  });
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
