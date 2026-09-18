#!/usr/bin/env node
/**
 * Call Analyzer — full grade export for rubric review.
 *
 * Writes two CSVs:
 *   call_grades_detail_<date>.csv   one row per graded call, sorted by agent
 *                                   then call_date descending
 *   call_grades_summary_<date>.csv  per-agent grade distribution, average
 *                                   score, and most common failure reasons
 *
 * The four category columns (greeting / call handling / professionalism /
 * compliance) are BUCKETED, not read straight off the row. The rubric does not
 * fix a category taxonomy, so the model invents names per call — 519 distinct
 * names across 681 scored calls as of 2026-09-18 ("greeting", "greeting &
 * professionalism", "professionalism & communication"…). CATEGORY_BUCKETS maps
 * those onto the four the reviewer asked for by keyword. A category matching
 * none of them lands in `other_categories` rather than being dropped, and the
 * script prints how many it could not place, so the mapping is auditable rather
 * than silently lossy.
 *
 * Output contains resident and prospect names inside the summary text. Treat the
 * files as resident PII: exports/ is gitignored for exactly this reason.
 *
 * Usage:
 *   node scripts/export-call-grades.js [--out exports] [--env .env]
 */

const fs = require('fs');
const path = require('path');

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

// Keyword -> reviewer-facing bucket. Order matters: the first match wins, so
// "greeting & professionalism" is counted as greeting rather than split.
const CATEGORY_BUCKETS = [
  ['greeting',        /greet|identif|introduc|opening/i],
  ['compliance',      /complian|fair housing|legal|liabilit|call hours|disclos|verif|policy|procedure|terminolog/i],
  ['call_handling',   /handl|transfer|rout|protocol|leasing|collection|maintenance|portal|voicemail|outbound|applicant|role|urgency|engagement|resolution|follow.?through|closure|closing|wrap.?up|tour|schedul|information gather|needs assess|resource|promise.?to.?pay|ptp|balance|handoff|hand.?off|escalat/i],
  ['professionalism', /professional|communicat|tone|courte|empath|rapport|clarity|listen|resident experience|resident service|customer|brand|control|efficien/i],
];
function bucketOf(name) {
  const n = String(name || '');
  for (const [bucket, re] of CATEGORY_BUCKETS) if (re.test(n)) return bucket;
  return null;
}

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCSV = (headers, rows) =>
  '﻿' + [headers.join(',')]
    .concat(rows.map(r => headers.map(h => csvCell(r[h])).join(',')))
    .join('\r\n');

const round1 = n => Math.round(n * 10) / 10;

(async () => {
  console.log('Fetching call_grades…');
  const grades = await pageAll('call_grades?select=*');
  console.log('  ' + grades.length + ' rows');

  let unbucketed = 0, withCats = 0;
  const detail = grades.map(g => {
    const buckets = { greeting: [], call_handling: [], professionalism: [], compliance: [] };
    const other = [];
    for (const c of (g.categories || [])) {
      const b = bucketOf(c.name);
      const score = Number.isFinite(+c.score) ? +c.score : null;
      if (b) buckets[b].push(score);
      else { other.push(String(c.name || '?') + (score === null ? '' : ' ' + score)); unbucketed++; }
    }
    if ((g.categories || []).length) withCats++;
    const avg = arr => arr.length ? round1(arr.reduce((s, v) => s + (v || 0), 0) / arr.length) : '';

    // Coaching is [{category, strength, improve}] — flatten to two readable
    // columns so a reviewer can scan strengths and fixes without parsing JSON.
    const coaching = Array.isArray(g.coaching) ? g.coaching : [];
    return {
      recording_id: g.recording_id,
      call_date: g.call_date,
      agent_name: g.agent_name,
      call_direction: g.call_direction,
      duration_seconds: g.duration_seconds,
      property_name: g.property_name,
      overall_grade: g.not_scoreable ? 'N/S' : g.overall_grade,
      overall_score: g.overall_score,
      not_scoreable: g.not_scoreable === true ? 'true' : 'false',
      not_scoreable_reason: g.not_scoreable_reason,
      score_greeting: avg(buckets.greeting),
      score_call_handling: avg(buckets.call_handling),
      score_professionalism: avg(buckets.professionalism),
      score_compliance: avg(buckets.compliance),
      other_categories: other.join(' | '),
      summary: g.summary,
      outcome: g.outcome,
      flags: (g.flags || []).join(' | '),
      coaching_strengths: coaching.map(c => c.strength).filter(Boolean).join(' | '),
      coaching_improvements: coaching.map(c => c.improve).filter(Boolean).join(' | '),
      fair_housing_flag: g.fair_housing_flag === true ? 'true' : 'false',
      liability_flag: g.liability_flag === true ? 'true' : 'false',
      legal_violation: g.legal_violation === true ? 'true' : 'false',
      graded_at: g.graded_at,
    };
  });

  // agent ascending, then call_date descending
  detail.sort((a, b) => {
    const an = String(a.agent_name || '~').localeCompare(String(b.agent_name || '~'));
    if (an) return an;
    return String(b.call_date || '').localeCompare(String(a.call_date || ''));
  });

  const detailHeaders = Object.keys(detail[0] || {});
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const f1 = path.join(OUT, 'call_grades_detail_' + stamp + '.csv');
  fs.writeFileSync(f1, toCSV(detailHeaders, detail), 'utf8');
  console.log('Wrote ' + f1 + ' (' + detail.length + ' rows, ' + detailHeaders.length + ' columns)');

  // ---- per-agent summary ----
  const byAgent = {};
  for (const g of grades) {
    const a = g.agent_name || '(unattributed)';
    (byAgent[a] = byAgent[a] || []).push(g);
  }
  const summary = Object.entries(byAgent).sort((a, b) => b[1].length - a[1].length).map(([agent, list]) => {
    const scored = list.filter(g => !g.not_scoreable);
    const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const g of scored) if (dist[g.overall_grade] !== undefined) dist[g.overall_grade]++;
    const s = scored.map(g => g.overall_score).filter(Number.isFinite).sort((x, y) => x - y);
    const mean = s.length ? round1(s.reduce((p, q) => p + q, 0) / s.length) : '';
    const median = s.length ? s[Math.floor(s.length / 2)] : '';

    // Failure reasons: the model's own flags, plus any criterion it scored at or
    // below 50. Both are free text, so they are lowercased and truncated before
    // counting or near-identical wordings would each count as their own reason.
    const reasons = {};
    for (const g of scored) {
      for (const f of (g.flags || [])) {
        const k = String(f).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 70);
        if (k) reasons[k] = (reasons[k] || 0) + 1;
      }
      for (const c of (g.categories || [])) {
        for (const it of (c.items || [])) {
          if (typeof it.score === 'number' && it.score <= 50) {
            const k = ('criterion: ' + String(it.label || '')).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 70);
            if (k) reasons[k] = (reasons[k] || 0) + 1;
          }
        }
      }
    }
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const pct = n => scored.length ? Math.round(100 * n / scored.length) + '%' : '';
    return {
      agent_name: agent,
      total_calls: list.length,
      scored_calls: scored.length,
      not_scoreable: list.length - scored.length,
      grade_A: dist.A, grade_B: dist.B, grade_C: dist.C, grade_D: dist.D, grade_F: dist.F,
      pct_A: pct(dist.A), pct_B: pct(dist.B), pct_C: pct(dist.C), pct_D: pct(dist.D), pct_F: pct(dist.F),
      avg_score: mean,
      median_score: median,
      min_score: s.length ? s[0] : '',
      max_score: s.length ? s[s.length - 1] : '',
      fair_housing_flags: scored.filter(g => g.fair_housing_flag).length,
      liability_flags: scored.filter(g => g.liability_flag).length,
      top_failure_1: top[0] ? top[0][0] + ' (' + top[0][1] + ')' : '',
      top_failure_2: top[1] ? top[1][0] + ' (' + top[1][1] + ')' : '',
      top_failure_3: top[2] ? top[2][0] + ' (' + top[2][1] + ')' : '',
      top_failure_4: top[3] ? top[3][0] + ' (' + top[3][1] + ')' : '',
      top_failure_5: top[4] ? top[4][0] + ' (' + top[4][1] + ')' : '',
    };
  });

  // A TOTAL row, so the reviewer can sanity-check the parts against the whole.
  const allScored = grades.filter(g => !g.not_scoreable);
  const allS = allScored.map(g => g.overall_score).filter(Number.isFinite).sort((a, b) => a - b);
  const distAll = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const g of allScored) if (distAll[g.overall_grade] !== undefined) distAll[g.overall_grade]++;
  summary.push({
    agent_name: 'ALL AGENTS',
    total_calls: grades.length,
    scored_calls: allScored.length,
    not_scoreable: grades.length - allScored.length,
    grade_A: distAll.A, grade_B: distAll.B, grade_C: distAll.C, grade_D: distAll.D, grade_F: distAll.F,
    pct_A: Math.round(100 * distAll.A / allScored.length) + '%',
    pct_B: Math.round(100 * distAll.B / allScored.length) + '%',
    pct_C: Math.round(100 * distAll.C / allScored.length) + '%',
    pct_D: Math.round(100 * distAll.D / allScored.length) + '%',
    pct_F: Math.round(100 * distAll.F / allScored.length) + '%',
    avg_score: round1(allS.reduce((a, b) => a + b, 0) / allS.length),
    median_score: allS[Math.floor(allS.length / 2)],
    min_score: allS[0], max_score: allS[allS.length - 1],
    fair_housing_flags: allScored.filter(g => g.fair_housing_flag).length,
    liability_flags: allScored.filter(g => g.liability_flag).length,
    top_failure_1: '', top_failure_2: '', top_failure_3: '', top_failure_4: '', top_failure_5: '',
  });

  const f2 = path.join(OUT, 'call_grades_summary_' + stamp + '.csv');
  fs.writeFileSync(f2, toCSV(Object.keys(summary[0]), summary), 'utf8');
  console.log('Wrote ' + f2 + ' (' + summary.length + ' rows)');

  console.log('\nCategory bucketing: ' + withCats + ' of ' + grades.length + ' rows carried categories; '
    + unbucketed + ' category entries did not match a bucket and are in other_categories.');
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
