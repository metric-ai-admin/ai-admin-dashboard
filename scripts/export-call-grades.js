#!/usr/bin/env node
/**
 * Call Analyzer — full grade export for rubric review (CLI).
 *
 * Writes two CSVs:
 *   call_grades_detail_<date>.csv   one row per graded call, agent ascending
 *                                   then call_date descending
 *   call_grades_summary_<date>.csv  per-agent grade distribution, score
 *                                   statistics and most common failure reasons
 *
 * The shaping lives in ../call-grades-export.js, shared with the dashboard's
 * /api/calls/export endpoint so both produce identical files from one
 * definition. This script is the unfiltered whole-table export; the dashboard
 * is the filtered, self-serve one.
 *
 * Output carries resident and prospect names in the summary text. Treat the
 * files as resident PII — exports/ is gitignored for that reason.
 *
 * Usage:
 *   node scripts/export-call-grades.js [--out exports] [--env .env]
 */

const fs = require('fs');
const path = require('path');
const X = require('../call-grades-export.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', 'exports');
const ENV = arg('env', '.env');

for (const m of fs.readFileSync(ENV, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
  process.env[m[1]] = m[2].trim();
}
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ' + ENV);
  process.exit(2);
}
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

// PostgREST caps a response at 1000 rows; page or the export silently truncates.
async function pageAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(URL + '/rest/v1/' + pathAndQuery, {
      headers: { ...H, Range: from + '-' + (from + 999) },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const b = await r.json();
    out.push(...b);
    if (b.length < 1000) return out;
  }
}

(async () => {
  console.log('Fetching call_grades…');
  const grades = await pageAll('call_grades?select=*');
  console.log('  ' + grades.length + ' rows');

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);

  const { rows, unbucketed, withCategories } = X.detailRows(grades);
  const f1 = path.join(OUT, 'call_grades_detail_' + stamp + '.csv');
  fs.writeFileSync(f1, X.toCSV(X.DETAIL_HEADERS, rows), 'utf8');
  console.log('Wrote ' + f1 + ' (' + rows.length + ' rows, ' + X.DETAIL_HEADERS.length + ' columns)');

  const summary = X.summaryRows(grades);
  const f2 = path.join(OUT, 'call_grades_summary_' + stamp + '.csv');
  fs.writeFileSync(f2, X.toCSV(X.SUMMARY_HEADERS, summary), 'utf8');
  console.log('Wrote ' + f2 + ' (' + summary.length + ' rows)');

  console.log('\nCategory bucketing: ' + withCategories + ' of ' + grades.length
    + ' rows carried categories; ' + unbucketed
    + ' category entries did not match a bucket and are in other_categories.');
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
