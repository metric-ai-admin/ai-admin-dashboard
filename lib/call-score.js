// What a graded call is actually worth — the one definition.
//
// THE SCORE IS COMPUTED HERE, NOT TAKEN FROM THE MODEL.
//
// Rubric v2.0 asks for a per-criterion breakdown and a total. The breakdown is
// reliable — across the 2026-09-18 canaries every category score equalled the
// sum of its items — but the total was not. Two rounds of prompt instruction
// failed to fix it, the second stating the division as an explicit formula:
//
//     breakdown 53/100 -> reported 72      breakdown 52/100 -> reported 72
//     breakdown  4/75  -> reported 38      breakdown 35/90  -> reported 43
//
// The model judged a grade holistically and then wrote a breakdown that did not
// produce it, always erring high. A score a reviewer cannot derive from the
// criteria printed beside it is not reviewable, and review is the entire point
// of the export. So the model supplies the evidence and the server does the
// arithmetic — deterministic, and auditable by adding up the column.
//
// ---- WHY THIS IS A LIBRARY AND NOT A FUNCTION IN server.js -----------------
//
// It was in server.js, and scripts/regrade-sample.js could not reach it. So the
// comparison script printed the model's SELF-REPORTED total while production
// stored the computed one, and the two were read side by side as if they were
// the same quantity.
//
// On 2026-10-26 that produced a false alarm that took a day to run down: two
// control runs over the same twenty calls both came back ~4 points above the
// stored grades, with two Not Scoreable calls apparently "now scored" and one
// call scoring 0 against a stored 45. Nothing had changed. The model had
// self-reported 0 on a call whose own breakdown computes 45 — exactly the drift
// this file exists to correct — and the two N/S calls were N/S by the FLAG rule
// below, which the script also did not apply.
//
// A second definition of a number is a second answer to the same question. Both
// callers use this one.
'use strict';

// Step 9 bands. Kept as a table so the thresholds read the way the rubric
// writes them rather than as a chain of comparisons.
const GRADE_BANDS = [[90, 'A'], [80, 'B'], [70, 'C'], [60, 'D'], [0, 'F']];
const gradeForScore = score => (GRADE_BANDS.find(([min]) => score >= min) || [0, 'F'])[1];

// Step 9: "A LEGAL flag ... should result in a score no higher than D (60)
// regardless of other performance."
const LEGAL_VIOLATION_CAP = 60;

// The flags that mean "do not score this", beyond an explicit not_scoreable.
// The model sometimes scores a call AND flags it as the wrong agent; the flag
// wins, because a number attached to the wrong person is worse than no number.
const NOT_SCOREABLE_FLAGS =
  /agent identity mismatch|wrong call|mislabel|not[\s_]*scoreable|no scoreable criteria/i;

function computeGradeScore(parsed) {
  const cats = Array.isArray(parsed.categories) ? parsed.categories : [];
  const weight = cats.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const earned = cats.reduce((s, c) => s + (Number(c.score) || 0), 0);

  // No usable breakdown — fall back to whatever the model reported rather than
  // discarding the grade. Rare, and flagged in the return so callers can log it.
  // null/undefined must stay null, not become 0: +null is 0 and passes
  // Number.isFinite, which would turn "the model gave us nothing" into a
  // legitimate-looking score of 0 and an F on a call nobody scored.
  const asScore = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v))
    ? null : Math.round(+v);

  if (!cats.length || !(weight > 0)) {
    const fallback = asScore(parsed.overall_score);
    return { score: fallback, computed: false, modelScore: fallback };
  }

  let score = Math.round(100 * earned / weight);
  score = Math.max(0, Math.min(100, score));   // a mis-scored item cannot push it out of range
  if (parsed.legal_violation === true) score = Math.min(score, LEGAL_VIOLATION_CAP);

  const modelScore = asScore(parsed.overall_score);
  return { score, computed: true, modelScore };
}

/**
 * Is this call scoreable, and if not, why?
 *
 * Returns the flag list too, with a canonical "Not Scoreable — …" entry added
 * when the verdict came from the flags rather than from not_scoreable, so any
 * flag-based consumer still detects it.
 */
function scoreability(parsed) {
  const flags = Array.isArray(parsed.flags) ? parsed.flags.slice() : [];
  const flagStr = flags.join(' | ').toLowerCase();
  const notScoreable = parsed.not_scoreable === true || NOT_SCOREABLE_FLAGS.test(flagStr);
  const reason = notScoreable
    ? (parsed.not_scoreable_reason || parsed.reason
        || flags.find(f => /identity mismatch|wrong call|mislabel|scoreable/i.test(String(f)))
        || 'Vendor/internal or wrong-agent call')
    : null;
  if (notScoreable && !/not[\s_]*scoreable/i.test(flagStr)) {
    flags.unshift('Not Scoreable — ' + reason);
  }
  return { notScoreable, reason, flags };
}

/**
 * THE VERDICT, as it will be stored. One call, one answer.
 *
 * Anything that wants to know what a grade is worth — the writer, the
 * comparison script, a dry run over rows already on disk — asks this, so none
 * of them can drift from the others.
 *
 * @returns {{score:number|null, grade:string|null, notScoreable:boolean,
 *            reason:string|null, flags:string[], computed:boolean,
 *            modelScore:number|null}}
 */
function verdict(parsed) {
  const p = parsed || {};
  const { notScoreable, reason, flags } = scoreability(p);
  const scoring = computeGradeScore(p);
  return {
    score: notScoreable ? null : scoring.score,
    grade: notScoreable
      ? 'N/S'
      : (scoring.score === null ? (p.overall_grade || null) : gradeForScore(scoring.score)),
    notScoreable,
    reason,
    flags,
    computed: scoring.computed,
    // What the model said about itself, kept so a caller can report the drift
    // rather than silently correcting it.
    modelScore: scoring.modelScore,
  };
}

module.exports = {
  GRADE_BANDS, gradeForScore, LEGAL_VIOLATION_CAP, NOT_SCOREABLE_FLAGS,
  computeGradeScore, scoreability, verdict,
};
