#!/usr/bin/env node
//
// Katie's workbook vs the COMBINED REPORT — not vs lib/kpi-lyndsay.js.
//
//   node scripts/kpi-compare-report.js --week 2026-10-03 \
//     --workbook "C:/Users/artur/Downloads/Data Source End of Last Week 09.27.26 to 10.03.26.xlsx"
//
// READ-ONLY. Nothing is written to Supabase, AppFolio or the workbook.
//
// scripts/kpi-compare-lyndsay.js compares her sheets against the METRICS
// module. This compares them against what /api/kpi/report actually returns, by
// calling lib/kpi-build.js — the same function the route calls. A script that
// reassembled the report would be comparing itself.
//
// Monday 2026-10-12 is the last side-by-side against the Excel. What this
// prints is the list of things to settle before then.
require('dotenv').config();

const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const { buildKpiReport } = require('../lib/kpi-build.js');
const kpiReport = require('../lib/kpi-report.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const WEEK_END = arg('week', '2026-10-03');
const BOOK = arg('workbook');

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = v => {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[$,%\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
};
const canon = raw => {
  let n = String(raw == null ? '' : raw).trim();
  if (!n || norm(n) === 'total') return null;
  const i = n.indexOf(' - ');
  if (i !== -1) n = n.slice(0, i).trim();
  return n || null;
};

// ---- her side ---------------------------------------------------------------
function herSheets(path) {
  const wb = XLSX.readFile(path);
  const find = pats => wb.SheetNames.find(n => pats.some(p => norm(n).includes(norm(p))));
  const rows = name => (name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }) : []);
  return {
    names: wb.SheetNames,
    occupancy: rows(find(['occupancy']) && !norm(find(['occupancy'])).includes('goal') ? find(['occupancy']) : find(['occupancy'])),
    delinquency: rows(find(['delinquency'])),
  };
}

// Her delinquency sheet is GROUPED: a row with text in the property column and
// nothing else opens a section, and the resident rows beneath it belong to it.
// Her DQ Total is the sum of the aging buckets on the resident rows.
function herDelinquency(rows) {
  if (!rows.length) return { byProperty: {}, note: 'no delinquency sheet' };
  // Find the header: the row carrying the aging buckets.
  let hdr = -1, cols = {};
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const r = (rows[i] || []).map(norm);
    const b0 = r.findIndex(c => /^0 30$/.test(c));
    if (b0 === -1) continue;
    hdr = i;
    r.forEach((c, j) => {
      if (/^0 30$/.test(c)) cols.b0 = j;
      if (/^31 60$/.test(c)) cols.b1 = j;
      if (/^61 90$/.test(c)) cols.b2 = j;
      if (/^90|over 90|91/.test(c)) cols.b3 = j;
      if (/total/.test(c) && cols.total === undefined) cols.total = j;
      if (/tenant|resident|name/.test(c) && cols.name === undefined) cols.name = j;
      if (/status/.test(c) && cols.status === undefined) cols.status = j;
    });
    break;
  }
  if (hdr === -1) return { byProperty: {}, note: 'no aging-bucket header found' };

  const byProperty = {};
  let current = null, ungrouped = 0;
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const first = String(r[0] == null ? '' : r[0]).trim();
    const rest = r.slice(1).some(c => String(c == null ? '' : c).trim() !== '');
    if (first && !rest) { current = canon(first); continue; }      // group header
    if (!first && !rest) continue;
    const bucketSum = ['b0', 'b1', 'b2', 'b3']
      .reduce((a, k) => a + (cols[k] === undefined ? 0 : num(r[cols[k]])), 0);
    if (!bucketSum) continue;
    const p = current || canon(first);
    if (!p) { ungrouped += bucketSum; continue; }
    if (!byProperty[p]) byProperty[p] = { total: 0, residents: 0 };
    byProperty[p].total += bucketSum;
    byProperty[p].residents++;
  }
  return { byProperty, ungrouped, cols, note: null };
}

// ---- ours -------------------------------------------------------------------
function flatten(sections) {
  const out = {};
  (sections || []).forEach(sec => {
    (sec.cards || []).concat(sec.funnel || []).forEach(c => { out[c.metric] = c; });
  });
  return out;
}

const METRICS = ['units', 'occupied', 'occPct', 'preleased', 'vacantRented', 'vacantUnrented',
  'notices', 'moveIns', 'moveOuts', 'newNotices', 'leadsByInterest', 'tours', 'applications',
  'approved', 'denied', 'canceled', 'renewals', 'didNotRenew',
  'newWos', 'openWos', 'closedThisWeek', 'dqTotal', 'evictionsInProcess', 'needToFile'];

const fmt = v => (v === null || v === undefined ? '\u2014'
  : typeof v === 'number' ? (Math.abs(v) < 1 && v !== 0 ? (v * 100).toFixed(1) + '%' : String(Math.round(v * 100) / 100))
    : String(v));

(async () => {
  if (!BOOK) { console.error('--workbook is required'); process.exit(2); }
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  console.log('KPI COMPARISON — the COMBINED REPORT vs Katie\u2019s workbook. READ ONLY.');
  console.log('Week     : ' + WEEK_END);
  console.log('Workbook : ' + BOOK);
  console.log('Built by : lib/kpi-build.js — the same function /api/kpi/report calls\n');

  const report = await buildKpiReport(db, { week_ending: WEEK_END });
  console.log('range    : ' + report.range.from + ' .. ' + report.range.to);
  if (report.gaps && report.gaps.length) {
    console.log('GAPS     : ' + report.gaps.join(' | '));
  }
  console.log('workbook : ' + (report.workbook.loaded ? report.workbook.sheets.join(', ') : 'not uploaded — ' + report.workbook.note));
  console.log('columns  : ' + report.columns.join(', ') + '\n');

  const sheets = herSheets(BOOK);
  console.log('her tabs : ' + sheets.names.length + ' (' + sheets.names.slice(0, 6).join(', ') + ', …)\n');

  const dq = herDelinquency(sheets.delinquency);
  console.log('='.repeat(78));
  console.log('DELINQUENCY — the one we understand least');
  console.log('='.repeat(78));
  if (dq.note) console.log('  could not read her sheet: ' + dq.note);
  console.log('  her aging-bucket columns: ' + JSON.stringify(dq.cols));
  console.log('  rows with a bucket total but no property group: ' + (dq.ungrouped || 0));
  console.log('');
  console.log('  ' + 'PROPERTY'.padEnd(24) + 'HERS'.padStart(12) + 'OURS'.padStart(12) + 'DIFF'.padStart(12) + '   HER RESIDENTS');
  let hTot = 0, oTot = 0;
  const props = Object.keys(report.properties).sort();
  props.forEach(p => {
    const ours = flatten(report.properties[p]).dqTotal;
    const o = ours && ours.value !== null ? ours.value : null;
    const h = dq.byProperty[p] ? dq.byProperty[p].total : null;
    if (h === null && o === null) return;
    hTot += h || 0; oTot += o || 0;
    const d = (h === null || o === null) ? null : o - h;
    console.log('  ' + p.padEnd(24) + fmt(h).padStart(12) + fmt(o).padStart(12)
      + (d === null ? '\u2014' : fmt(d)).padStart(12)
      + '   ' + (dq.byProperty[p] ? dq.byProperty[p].residents : '\u2014'));
  });
  // Properties she has and we do not list at all.
  Object.keys(dq.byProperty).filter(p => !props.includes(p)).forEach(p => {
    console.log('  ' + p.padEnd(24) + fmt(dq.byProperty[p].total).padStart(12)
      + '\u2014'.padStart(12) + '\u2014'.padStart(12) + '   ' + dq.byProperty[p].residents
      + '   (no column in our report)');
  });
  console.log('  ' + 'TOTAL'.padEnd(24) + fmt(hTot).padStart(12) + fmt(oTot).padStart(12) + fmt(oTot - hTot).padStart(12));
  console.log('');

  console.log('='.repeat(78));
  console.log('PORTFOLIO');
  console.log('='.repeat(78));
  const port = flatten(report.portfolio);
  console.log('  ' + 'METRIC'.padEnd(22) + 'OURS'.padStart(12) + '  SOURCE');
  METRICS.forEach(m => {
    const c = port[m];
    if (!c) return;
    console.log('  ' + m.padEnd(22) + fmt(c.value).padStart(12) + '  ' + c.source
      + (c.reason ? '  (' + c.reason + ')' : ''));
  });
  console.log('');

  console.log('='.repeat(78));
  console.log('BY PROPERTY — ours, with provenance');
  console.log('='.repeat(78));
  props.forEach(p => {
    const f = flatten(report.properties[p]);
    const unavailable = METRICS.filter(m => f[m] && f[m].source === 'unavailable');
    console.log('  ' + p);
    console.log('    ' + METRICS.filter(m => f[m] && f[m].source !== 'unavailable')
      .map(m => m + '=' + fmt(f[m].value)).join('  '));
    if (unavailable.length) console.log('    unavailable: ' + unavailable.join(', '));
  });
  console.log('');
  const groups = [kpiReport.ROUND_ROCK.name].concat(Object.keys(kpiReport.VIRTUAL_GROUPS));
  groups.forEach(g => {
    if (!report.properties[g]) { console.log('  ' + g + ': not built this week'); return; }
    const f = flatten(report.properties[g]);
    console.log('  ' + g + ' (' + (report.properties[g].__members || []).join(', ') + ')');
    console.log('    units=' + fmt(f.units && f.units.value) + '  occupied=' + fmt(f.occupied && f.occupied.value));
  });
})().catch(e => { console.error(e); process.exit(1); });
