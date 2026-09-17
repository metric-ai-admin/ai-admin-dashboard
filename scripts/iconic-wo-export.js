#!/usr/bin/env node
/**
 * iConic WO Scheduling Tool — pilot data export + analysis.
 *
 * Pulls the three AppFolio report feeds the pilot needs — work_order_labor_summary
 * (90-day rolling window), wo_all (open work orders) and wo_completed (statuses
 * 4 + 7, the only pull carrying completed_on) — filters them to the iConic
 * properties, writes one CSV per dataset, and prints a summary: hours per tech
 * per property, WO type mix, status mix, cycle time, open-WO age and scheduling
 * coverage.
 *
 * Reads export.csv, NOT /data. The /data route slices to `limit` (max 1000) with
 * no paging, and every one of these reports is now larger than that, so /data
 * would silently hand back a truncated subset.
 *
 * Usage — live, against the deployed dashboard:
 *   node scripts/iconic-wo-export.js --base https://HOST --key METRIC_API_KEY
 *
 * Usage — offline, against JSON already saved from the /data route:
 *   node scripts/iconic-wo-export.js --labor labor.json --wo wo_all.json --done wo_completed.json
 *
 * Options:
 *   --out <dir>     output directory (default: ./exports)
 *   --match <text>  property name substring (default: iConic)
 */

const fs = require('fs');
const path = require('path');
const { toCSV } = require('../appfolio-reports.js');

// /api/appfolio/reports/:id/data slices to `limit` (max 1000) with no paging,
// so it silently truncates any report bigger than that — and since the 90-day
// windows landed, both of these are (2230 labor rows, 1468 completed WOs).
// export.csv runs off the same synced rows with no slice at all, so that is the
// endpoint we read. Nothing here can quietly analyse a subset.
const ENDPOINT = 'export.csv';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT   = arg('out', 'exports');
const MATCH = arg('match', 'iConic');
const BASE  = arg('base');
const KEY   = arg('key', process.env.METRIC_API_KEY || '');

// Column names vary between AppFolio reports, so resolve by candidate list —
// the same approach appfolio-reports.js uses for its derived feeds.
const canon = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (row, keys, dflt = '') => {
  for (const k of keys) {
    for (const actual of Object.keys(row)) {
      if (canon(actual) === canon(k)) {
        const v = row[actual];
        if (v !== null && v !== undefined && String(v).trim() !== '') return v;
      }
    }
  }
  return dflt;
};
const num = v => {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const PROP_KEYS   = ['property_name', 'property', 'building'];
const TECH_KEYS   = ['maintenance_tech', 'technician', 'tech', 'assigned_to', 'vendor_name'];
const HOURS_KEYS  = ['worked_hours', 'hours', 'labor_hours', 'total_hours'];
// work_order_type is a clean categorical field on the WO report; the labor
// report has no such column, so it falls back to work_order_issue. Free-text
// job_description/description are last resorts — they are one-off prose and
// produce a count of 1 per row, which tells you nothing.
const TYPE_KEYS   = ['work_order_type', 'vendor_trade', 'unit_turn_category'];
const ISSUE_KEYS  = ['work_order_issue', 'issue', 'job_description', 'description'];
const STATUS_KEYS = ['work_order_status', 'status'];
const OPEN_KEYS   = ['created_at', 'created', 'date_created', 'work_order_date', 'submitted_date'];
const SCHED_KEYS  = ['scheduled_start'];
const DONE_KEYS   = ['completed_on', 'work_completed_on', 'completed_at', 'completed', 'date_completed', 'completed_date', 'closed_date'];

// Minimal RFC4180-ish CSV reader: quoted fields, doubled quotes, embedded
// commas and newlines. Mirrors parseCSV in metric-routes.js, which is not
// exported — requiring that module here would drag express/multer/jwt into a
// CLI script for twenty lines of parsing.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');   // strip the BOM toCSV writes for Excel
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch.charCodeAt(0) === 13) { /* CR: ignore */ }
    else if (ch.charCodeAt(0) === 10) { row.push(field); rows.push(row); row = []; field = ""; }  // LF
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function csvToObjects(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) return [];
  const headers = grid[0];
  return grid.slice(1).map(cells => {
    const o = {};
    headers.forEach((h, i) => { o[h] = cells[i] === undefined ? '' : cells[i]; });
    return o;
  });
}

async function fetchReport(id) {
  const url = BASE.replace(/\/$/, '') + '/api/appfolio/reports/' + id + '/' + ENDPOINT;
  const r = await fetch(url, { headers: KEY ? { 'x-metric-key': KEY } : {} });
  if (!r.ok) throw new Error(id + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const rows = csvToObjects(await r.text());
  console.log('  ' + id + ': ' + rows.length + ' rows');
  return rows;
}

function loadLocal(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(j) ? j : (j.rows || []);
  console.log('  ' + path.basename(file) + ': ' + rows.length + ' rows');
  return rows;
}

const round = (n, p = 1) => Math.round(n * Math.pow(10, p)) / Math.pow(10, p);

function summarise(labor, wo, done) {
  const out = [];
  const say = s => { out.push(s); console.log(s); };

  // --- hours per tech per property ---
  say('\n=== HOURS PER TECH PER PROPERTY ===');
  const grid = {}, techTotals = {}, propTotals = {};
  let totalHours = 0;
  for (const r of labor) {
    const tech = String(pick(r, TECH_KEYS, 'Unassigned')).trim() || 'Unassigned';
    const prop = String(pick(r, PROP_KEYS, 'Unknown')).trim() || 'Unknown';
    const h = num(pick(r, HOURS_KEYS));
    (grid[tech] || (grid[tech] = {}))[prop] = (grid[tech][prop] || 0) + h;
    techTotals[tech] = (techTotals[tech] || 0) + h;
    propTotals[prop] = (propTotals[prop] || 0) + h;
    totalHours += h;
  }
  const byTech = Object.entries(grid).sort((a, b) => techTotals[b[0]] - techTotals[a[0]]);
  for (const [tech, props] of byTech) {
    say(tech + ' — ' + round(techTotals[tech]) + 'h total');
    for (const [p, h] of Object.entries(props).sort((a, b) => b[1] - a[1])) {
      say('    ' + p + ': ' + round(h) + 'h');
    }
  }
  say('\nBy property: ' + Object.entries(propTotals).sort((a, b) => b[1] - a[1])
    .map(([p, h]) => p + ' ' + round(h) + 'h').join(' | '));
  say('TOTAL: ' + round(totalHours) + 'h across ' + labor.length + ' labor rows, '
    + Object.keys(grid).length + ' techs');

  // --- most common WO types ---
  say('\n=== MOST COMMON WORK ORDER TYPES ===');
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  for (const [label, rows] of [['labor rows', labor], ['open WOs', wo]]) {
    const counts = {};
    for (const r of rows) {
      const issue = norm(pick(r, TYPE_KEYS, '') || pick(r, ISSUE_KEYS, ''));
      if (issue) counts[issue] = (counts[issue] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    say('-- from ' + label + ' (' + rows.length + ') --');
    if (!top.length) say('    (no issue/description column found on these rows)');
    for (const [issue, n] of top) say('    ' + String(n).padStart(4) + '  ' + issue);
  }

  // --- status mix ---
  say('\n=== STATUS MIX (open WO pull) ===');
  const st = {};
  for (const r of wo) {
    const s = String(pick(r, STATUS_KEYS, 'unknown')).trim();
    st[s] = (st[s] || 0) + 1;
  }
  for (const [s, n] of Object.entries(st).sort((a, b) => b[1] - a[1])) {
    say('    ' + String(n).padStart(4) + '  ' + s);
  }

  // --- completion time ---
  // Cycle time comes from wo_completed (work_order_statuses 4 + 7), the only
  // pull whose rows carry completed_on. wo_all and the labor summary are still
  // scanned as a fallback so the section degrades to a warning rather than a
  // blank if wo_completed has not been synced.
  say('\n=== COMPLETION TIME (created -> completed) ===');
  const spans = [];
  const source = done.length ? done : wo.concat(labor);
  for (const r of source) {
    const a = pick(r, OPEN_KEYS), b = pick(r, DONE_KEYS);
    if (!a || !b) continue;
    const t0 = Date.parse(a), t1 = Date.parse(b);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) continue;
    spans.push((t1 - t0) / 86400000);
  }
  const eligible = source.length;
  say('    source: ' + (done.length ? 'wo_completed (' + done.length + ' completed WOs)'
    : 'wo_all + labor fallback — wo_completed not available'));
  if (!spans.length) {
    say('    NOT CALCULABLE — no row carries both an opened and a completed date.');
  } else if (spans.length < 10 || spans.length / eligible < 0.2) {
    // A handful of stragglers that happen to carry a completion date are not a
    // sample — quoting a mean off them would read as a real cycle-time metric.
    say('    NOT RELIABLE — only ' + spans.length + ' of ' + eligible + ' rows carry both dates.');
    say('    Values: ' + spans.map(v => round(v) + 'd').join(', '));
    say('    Too few to average.');
  } else {
    spans.sort((x, y) => x - y);
    const mean = spans.reduce((s, v) => s + v, 0) / spans.length;
    say('    n=' + spans.length + '  mean ' + round(mean) + 'd'
      + '  median ' + round(spans[Math.floor(spans.length / 2)]) + 'd'
      + '  p90 ' + round(spans[Math.floor(spans.length * 0.9)]) + 'd'
      + '  max ' + round(spans[spans.length - 1]) + 'd');
  }

  // --- age of open WOs: the schedulable backlog signal ---
  const ages = [];
  for (const r of wo) {
    const t0 = Date.parse(pick(r, OPEN_KEYS));
    if (Number.isFinite(t0)) ages.push((Date.now() - t0) / 86400000);
  }
  if (ages.length) {
    ages.sort((x, y) => x - y);
    say('\n=== AGE OF OPEN WOs ===');
    say('    n=' + ages.length + '  mean ' + round(ages.reduce((s, v) => s + v, 0) / ages.length) + 'd'
      + '  median ' + round(ages[Math.floor(ages.length / 2)]) + 'd'
      + '  oldest ' + round(ages[ages.length - 1]) + 'd');
  }
  // --- scheduling coverage: the baseline the scheduling tool has to improve on ---
  say('\n=== SCHEDULING COVERAGE ===');
  const sched = wo.filter(r => pick(r, SCHED_KEYS, ''));
  say('    ' + sched.length + ' of ' + wo.length + ' open WOs carry a scheduled_start ('
    + round(100 * sched.length / (wo.length || 1)) + '%)');
  const unassigned = wo.filter(r => !String(pick(r, ['assigned_user'], '')).trim()).length;
  say('    ' + unassigned + ' of ' + wo.length + ' open WOs have no assigned_user');

  return out.join('\n');
}

(async () => {
  if (!BASE && !arg('labor')) {
    console.error('Need either --base <url> [--key <METRIC_API_KEY>] '
      + 'or --labor <file.json> [--wo <file.json>].');
    process.exit(2);
  }
  console.log('Loading reports...');
  const laborAll = BASE ? await fetchReport('work_order_labor_summary') : loadLocal(arg('labor'));
  let woAll = [];
  try {
    woAll = BASE ? await fetchReport('wo_all') : (arg('wo') ? loadLocal(arg('wo')) : []);
  } catch (err) {
    console.warn('  wo_all unavailable (' + err.message + ') — falling back to work_order');
    if (BASE) woAll = await fetchReport('work_order');
  }
  // wo_completed (work_order_statuses 4 + 7) is the only source that carries a
  // completion date, so cycle time comes from here. Optional: if it has not been
  // synced the rest of the analysis still runs, with cycle time reported absent.
  let done = [];
  try {
    done = BASE ? await fetchReport('wo_completed') : (arg('done') ? loadLocal(arg('done')) : []);
  } catch (err) {
    console.warn('  wo_completed unavailable (' + err.message + ') — cycle time will be skipped');
  }

  const hit = r => String(pick(r, PROP_KEYS, '')).toLowerCase().includes(MATCH.toLowerCase());
  const labor = laborAll.filter(hit);
  const wo = woAll.filter(hit);
  const doneIc = done.filter(hit);
  console.log('\nFiltered to "' + MATCH + '": ' + labor.length + '/' + laborAll.length
    + ' labor rows, ' + wo.length + '/' + woAll.length + ' open WOs, '
    + doneIc.length + '/' + done.length + ' completed WOs');
  if (!labor.length && !wo.length) {
    const seen = [...new Set(laborAll.concat(woAll).map(r => pick(r, PROP_KEYS, '?')))];
    console.error('No rows matched "' + MATCH + '". Property names present: '
      + seen.slice(0, 20).join(' | '));
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const f1 = path.join(OUT, 'iconic_labor_summary_' + stamp + '.csv');
  const f2 = path.join(OUT, 'iconic_open_work_orders_' + stamp + '.csv');
  const f4 = path.join(OUT, 'iconic_completed_work_orders_' + stamp + '.csv');
  fs.writeFileSync(f1, toCSV(labor), 'utf8');
  fs.writeFileSync(f2, toCSV(wo), 'utf8');
  console.log('\nWrote ' + f1 + ' (' + labor.length + ' rows)');
  console.log('Wrote ' + f2 + ' (' + wo.length + ' rows)');
  if (doneIc.length) {
    fs.writeFileSync(f4, toCSV(doneIc), 'utf8');
    console.log('Wrote ' + f4 + ' (' + doneIc.length + ' rows)');
  }

  const report = summarise(labor, wo, doneIc);
  const f3 = path.join(OUT, 'iconic_summary_' + stamp + '.txt');
  fs.writeFileSync(f3, report, 'utf8');
  console.log('\nWrote ' + f3);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
