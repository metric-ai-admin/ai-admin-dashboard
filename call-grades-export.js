// call-grades-export.js
//
// Shaping call_grades rows into the two review CSVs — the detail sheet (one row
// per graded call) and the per-agent summary.
//
// Extracted so scripts/export-call-grades.js and the dashboard's
// /api/calls/export endpoint produce byte-identical output from one definition.
// The alternative was a second copy in server.js, and this codebase already has
// a worked example of where that ends: the grading prompt lives in
// call-grade-prompt.json AND in public/tools/call-quality-analyzer.html, the
// comment says they are byte-identical, and they stopped being so.
//
// Read-only. Nothing here queries the database; callers pass rows in.

// The rubric fixes no category taxonomy, so the model invents category names per
// call — 519 distinct names across 681 scored calls as of 2026-09-18 ("greeting",
// "greeting & professionalism", "professionalism & communication"…). These
// patterns map them onto the four headings a reviewer asked for.
//
// FIRST MATCH WINS, so the order matters: "greeting & professionalism" is
// counted once, as greeting. compliance is tested before call_handling because
// "policy adherence" and "call hours compliance" would otherwise be swallowed by
// the much broader handling pattern.
//
// A category matching nothing lands in other_categories rather than being
// dropped, and the callers report the count, so the mapping stays auditable.
// Once the rubric pins the taxonomy down, these columns become exact and this
// bucketing can go.
const CATEGORY_BUCKETS = [
  ['greeting',        /greet|identif|introduc|opening/i],
  ['compliance',      /complian|fair housing|legal|liabilit|call hours|disclos|verif|policy|procedure|terminolog/i],
  ['call_handling',   /handl|transfer|rout|protocol|leasing|collection|maintenance|portal|voicemail|outbound|applicant|role|urgency|engagement|resolution|follow.?through|closure|closing|wrap.?up|tour|schedul|information gather|needs assess|resource|promise.?to.?pay|ptp|balance|handoff|hand.?off|escalat/i],
  ['professionalism', /professional|communicat|tone|courte|empath|rapport|clarity|listen|resident experience|resident service|customer|brand|control|efficien/i],
];

function bucketOf(name) {
  const n = String(name || '');
  for (const [bucket, re] of CATEGORY_BUCKETS) if (re.test(n)) return bucket;
  return null;
}

const round1 = n => Math.round(n * 10) / 10;

// Excel reads a bare UTF-8 CSV as the system codepage and turns "Rocío" into
// mojibake; the BOM is what makes it open correctly.
const BOM = '﻿';

function csvCell(v) {
  if (v === null || v === undefined) return '';
  // Newlines inside a quoted field are legal CSV but break naive splitters and
  // make the sheet unreadable, so summaries and coaching are flattened to one
  // line rather than quoted across several.
  const s = String(v).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCSV(headers, rows) {
  return BOM + [headers.join(',')]
    .concat(rows.map(r => headers.map(h => csvCell(r[h])).join(',')))
    .join('\r\n');
}

// Column order is the contract with the reviewer's spreadsheet — keep it stable.
const DETAIL_HEADERS = [
  'recording_id', 'call_date', 'agent_name', 'call_direction', 'duration_seconds',
  'property_name', 'overall_grade', 'overall_score', 'not_scoreable', 'not_scoreable_reason',
  'score_greeting', 'score_call_handling', 'score_professionalism', 'score_compliance',
  'other_categories', 'summary', 'outcome', 'flags',
  'coaching_strengths', 'coaching_improvements',
  'fair_housing_flag', 'liability_flag', 'legal_violation', 'graded_at',
];

const SUMMARY_HEADERS = [
  'agent_name', 'total_calls', 'scored_calls', 'not_scoreable',
  'grade_A', 'grade_B', 'grade_C', 'grade_D', 'grade_F',
  'pct_A', 'pct_B', 'pct_C', 'pct_D', 'pct_F',
  'avg_score', 'median_score', 'min_score', 'max_score',
  'fair_housing_flags', 'liability_flags',
  'top_failure_1', 'top_failure_2', 'top_failure_3', 'top_failure_4', 'top_failure_5',
];

/**
 * One detail row per grade. Returns { rows, unbucketed, withCategories } so the
 * caller can report how much of the category mapping landed.
 */
function detailRows(grades) {
  let unbucketed = 0, withCategories = 0;
  const rows = grades.map(g => {
    const buckets = { greeting: [], call_handling: [], professionalism: [], compliance: [] };
    const other = [];
    for (const c of (g.categories || [])) {
      const b = bucketOf(c.name);
      const score = Number.isFinite(+c.score) ? +c.score : null;
      if (b) buckets[b].push(score);
      else { other.push(String(c.name || '?') + (score === null ? '' : ' ' + score)); unbucketed++; }
    }
    if ((g.categories || []).length) withCategories++;
    const avg = arr => arr.length ? round1(arr.reduce((s, v) => s + (v || 0), 0) / arr.length) : '';
    const coaching = Array.isArray(g.coaching) ? g.coaching : [];
    return {
      recording_id: g.recording_id,
      call_date: g.call_date,
      agent_name: g.agent_name,
      call_direction: g.call_direction,
      duration_seconds: g.duration_seconds,
      property_name: g.property_name,
      // N/S is shown in the grade column because that is how the dashboard reads
      // it; the boolean is kept alongside so the sheet can still be filtered on.
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

  // agent ascending, then call_date descending, then recording_id.
  //
  // The recording_id tiebreak makes the ordering TOTAL. Without it, calls
  // sharing an agent and a date kept whatever order the caller happened to
  // supply, so the CLI (unordered query) and the endpoint (ordered query)
  // produced different files from identical data — caught by diffing the two.
  rows.sort((a, b) => {
    // Unattributed sorts last rather than first — an empty agent at the top of
    // the sheet reads like a data error.
    const an = String(a.agent_name || '~').localeCompare(String(b.agent_name || '~'));
    if (an) return an;
    const dt = String(b.call_date || '').localeCompare(String(a.call_date || ''));
    if (dt) return dt;
    return String(a.recording_id || '').localeCompare(String(b.recording_id || ''));
  });
  return { rows, unbucketed, withCategories };
}

// Failure reasons come from the model's own flags plus any criterion it scored
// at or below 50. Both are free text, so they are lowercased, whitespace-collapsed
// and truncated before counting — otherwise two wordings of the same miss each
// count as their own reason and nothing rises to the top.
function failureReasons(scored) {
  const reasons = {};
  const add = k => { if (k) reasons[k] = (reasons[k] || 0) + 1; };
  for (const g of scored) {
    for (const f of (g.flags || [])) {
      add(String(f).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 70));
    }
    for (const c of (g.categories || [])) {
      for (const it of (c.items || [])) {
        if (typeof it.score === 'number' && it.score <= 50) {
          add(('criterion: ' + String(it.label || '')).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 70));
        }
      }
    }
  }
  // Count descending, then the reason text, so equally common reasons rank in a
  // fixed order. Without the tiebreak two reasons on the same count fell back to
  // insertion order — which follows row order — and the same data exported twice
  // gave different top-5 lists.
  return Object.entries(reasons).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

function agentStats(agent, list) {
  const scored = list.filter(g => !g.not_scoreable);
  const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const g of scored) if (dist[g.overall_grade] !== undefined) dist[g.overall_grade]++;
  const s = scored.map(g => g.overall_score).filter(Number.isFinite).sort((x, y) => x - y);
  const pct = n => scored.length ? Math.round(100 * n / scored.length) + '%' : '';
  const top = failureReasons(scored).slice(0, 5);
  const row = {
    agent_name: agent,
    total_calls: list.length,
    scored_calls: scored.length,
    not_scoreable: list.length - scored.length,
    grade_A: dist.A, grade_B: dist.B, grade_C: dist.C, grade_D: dist.D, grade_F: dist.F,
    pct_A: pct(dist.A), pct_B: pct(dist.B), pct_C: pct(dist.C), pct_D: pct(dist.D), pct_F: pct(dist.F),
    avg_score: s.length ? round1(s.reduce((p, q) => p + q, 0) / s.length) : '',
    median_score: s.length ? s[Math.floor(s.length / 2)] : '',
    min_score: s.length ? s[0] : '',
    max_score: s.length ? s[s.length - 1] : '',
    fair_housing_flags: scored.filter(g => g.fair_housing_flag).length,
    liability_flags: scored.filter(g => g.liability_flag).length,
  };
  for (let i = 0; i < 5; i++) {
    row['top_failure_' + (i + 1)] = top[i] ? top[i][0] + ' (' + top[i][1] + ')' : '';
  }
  return row;
}

/** Per-agent rows, busiest first, with an ALL AGENTS total appended. */
function summaryRows(grades) {
  const byAgent = {};
  for (const g of grades) {
    const a = g.agent_name || '(unattributed)';
    (byAgent[a] = byAgent[a] || []).push(g);
  }
  const rows = Object.entries(byAgent)
    // Busiest agent first, then by name — same reason as the tiebreaks above:
    // two agents with an equal call count must not swap places between exports.
    .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
    .map(([agent, list]) => agentStats(agent, list));
  if (grades.length) {
    // Totals last, so the parts can be checked against the whole. Computed over
    // every row rather than summed from the per-agent rows, so a bug in those
    // shows up as a mismatch instead of being carried into the total.
    const all = agentStats('ALL AGENTS', grades);
    all.top_failure_1 = all.top_failure_2 = all.top_failure_3 = all.top_failure_4 = all.top_failure_5 = '';
    rows.push(all);
  }
  return rows;
}

const detailCSV  = grades => toCSV(DETAIL_HEADERS, detailRows(grades).rows);
const summaryCSV = grades => toCSV(SUMMARY_HEADERS, summaryRows(grades));

module.exports = {
  CATEGORY_BUCKETS, bucketOf,
  DETAIL_HEADERS, SUMMARY_HEADERS,
  detailRows, summaryRows, failureReasons,
  toCSV, csvCell, detailCSV, summaryCSV,
};
