// Yesterday's failed call scores, for Kara's 6 AM brief.
//
// KARA ASKED FOR OPTION 1: a COUNT, per property, and NOT red. "12 calls below
// 70 yesterday (of 15)". A low score is a coaching conversation, not an
// emergency, and a section that turns a property red every time somebody has a
// bad morning on the phone teaches the reader to skip the red.
//
// THE DENOMINATOR IS THE HONEST PART. "12 below 70" means nothing without the
// 15: twelve out of fifteen is a problem with the property, twelve out of two
// hundred is Tuesday. And calls that could not be scored at all are excluded
// from BOTH numbers — they are neither passes nor failures, and counting them
// as either is a lie in one direction or the other. They get their own line.
//
// THE THRESHOLD IS THE CALL ANALYZER'S. 70 is where the rubric's bands put the
// boundary between C and D (server.js GRADE_BANDS), so "below 70" in the brief
// means the same thing as a D or an F on the Call Analyzer screen. If the two
// ever disagree, the brief is quietly grading on a different curve than the
// tool people actually look at. brief_thresholds.call_score_min can move it,
// per property or for everybody.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// The Call Analyzer's own boundary: GRADE_BANDS puts C at 70 and D at 60, so
// below 70 is a D or an F.
const DEFAULT_MIN = 70;

// "Unidentified" and "Unknown" are the same thing wearing two labels — one is
// what the AI writes when it cannot tell, the other what the backfill writes.
// Kara asked for them merged, in their own group, away from the properties:
// they are a data-quality number, not a property's performance.
const UNIDENTIFIED = /^(unidentified|unknown|n\/a|none|)$/i;
const UNIDENTIFIED_LABEL = 'Unidentified / Unknown';

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// The threshold for one property: its own row, then '*', then the Call
// Analyzer's. Same shape as the other brief thresholds.
function minScoreFor(property, rows) {
  const all = rows || [];
  const star = all.find(r => clean(r.property) === '*') || {};
  const mine = all.find(r => clean(r.property).toLowerCase() === clean(property).toLowerCase()) || {};
  const v = num(mine.call_score_min);
  if (v !== null) return v;
  const s = num(star.call_score_min);
  return s !== null ? s : DEFAULT_MIN;
}

/**
 * Yesterday's calls, counted by property.
 *
 * @param {object[]} calls  call_grades rows: { call_date, property_name,
 *                          overall_score, not_scoreable }
 * @param {string} dayCT    the day to count, YYYY-MM-DD (Central)
 * @param {object[]} thresholds  brief_thresholds rows
 */
function failedCalls(calls, dayCT, thresholds, opts) {
  const o = opts || {};
  // Injected rather than required, so this module stays testable without the
  // alias table and so a caller can decide what "ours" means.
  const isManaged = o.isManaged || null;
  const day = clean(dayCT).slice(0, 10);
  const onDay = (calls || []).filter(c => clean(c.call_date).slice(0, 10) === day);

  const groups = new Map();
  const bump = (label, key) => {
    if (!groups.has(label)) {
      groups.set(label, { property: label, below: 0, scored: 0, notScoreable: 0, min: null });
    }
    groups.get(label)[key] += 1;
    return groups.get(label);
  };

  onDay.forEach(c => {
    const raw = clean(c.property_name);
    const label = UNIDENTIFIED.test(raw) ? UNIDENTIFIED_LABEL : raw;
    // A call nobody could score is neither a pass nor a failure. It stays out
    // of both numbers and gets counted separately, because a property whose
    // calls are mostly unscoreable has a recording problem, not a service one
    // — and that reads as a clean sheet if the unscoreable ones are dropped.
    if (c.not_scoreable) { bump(label, 'notScoreable'); return; }
    const score = num(c.overall_score);
    if (score === null) { bump(label, 'notScoreable'); return; }
    const g = bump(label, 'scored');
    g.min = g.min === null
      ? (label === UNIDENTIFIED_LABEL ? DEFAULT_MIN : minScoreFor(label, thresholds))
      : g.min;
    if (score < g.min) g.below += 1;
  });

  // Fill in the threshold for groups that only ever saw unscoreable calls, so
  // every line can say what it was measured against.
  groups.forEach((g, label) => {
    if (g.min === null) {
      g.min = label === UNIDENTIFIED_LABEL ? DEFAULT_MIN : minScoreFor(label, thresholds);
    }
  });

  const all = [...groups.values()];
  const worstFirst = (a, b) =>
    (b.scored ? b.below / b.scored : 0) - (a.scored ? a.below / a.scored : 0)
    || a.property.localeCompare(b.property);

  // THREE GROUPS, not two.
  //
  // Kara asked for Cedar & Sage "separate but present". It takes calls and is
  // not one of the eight we manage, so putting it in the main list makes the
  // portfolio look worse than it is, and dropping it loses calls that really
  // happened. `isManaged` decides — a name that resolves to one of ours is a
  // property line; a name that does not is an `other` line, under its own
  // heading, with its own total.
  const managed = n => (isManaged ? !!isManaged(n) : true);
  const named = all.filter(g => g.property !== UNIDENTIFIED_LABEL);
  const rows = named.filter(g => managed(g.property)).sort(worstFirst);
  const others = named.filter(g => !managed(g.property)).sort(worstFirst);
  const unidentified = all.find(g => g.property === UNIDENTIFIED_LABEL) || null;

  const totals = all.reduce((t, g) => ({
    below: t.below + g.below,
    scored: t.scored + g.scored,
    notScoreable: t.notScoreable + g.notScoreable,
  }), { below: 0, scored: 0, notScoreable: 0 });

  return {
    day,
    rows,
    others,
    unidentified,
    totals,
    // NO CALLS AT ALL IS NOT A GOOD DAY. The Call Analyzer has gone quiet
    // before — "No calls since 9/29" — and a section that renders nothing when
    // the table is empty reads as "nobody scored badly yesterday".
    empty: onDay.length === 0,
    // HOW MANY CALLS REACHED THE ANALYZER, which is a different question from
    // how many were graded. null means nobody could ask.
    //
    // With both, "none were graded" splits into two findings that need
    // opposite actions: no calls arrived (look at the phone system) and calls
    // arrived but none were graded (look at the grader). On 2026-10-20 the
    // brief said the first and the truth was the second — 61 calls with
    // transcripts, and the grading step had been dead for four days.
    arrived: o.arrived === undefined ? null : o.arrived,
    defaultMin: DEFAULT_MIN,
  };
}

// One line per group: "12 calls below 70 yesterday (of 15)".
function line(g) {
  if (!g.scored) {
    return g.notScoreable
      ? 'no calls could be scored (' + g.notScoreable + ' unscoreable)'
      : 'no calls';
  }
  return g.below + ' call' + (g.below === 1 ? '' : 's') + ' below ' + g.min
    + ' (of ' + g.scored + ')'
    + (g.notScoreable ? ', ' + g.notScoreable + ' unscoreable' : '');
}

module.exports = {
  DEFAULT_MIN, UNIDENTIFIED_LABEL, UNIDENTIFIED,
  minScoreFor, failedCalls, line, num, clean,
};
