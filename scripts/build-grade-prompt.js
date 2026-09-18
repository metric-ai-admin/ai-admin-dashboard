#!/usr/bin/env node
/**
 * Build call-grade-prompt.json from Lyndsay's rubric markdown.
 *
 * The rubric is authored as a document (Version 2.0, 2026-09-18) and reviewed as
 * one. This keeps that document as the source of truth and does exactly one
 * thing to it: swaps STEP 10's human-readable output block for the JSON contract
 * the grading pipeline actually needs.
 *
 * That swap is not optional. callGrading.anthropicJson() runs JSON.parse over
 * the response, so the plain-text format in the authored Step 10 would fail to
 * parse on every call, be stored as not_scoreable 'malformed_response', and
 * spend the API budget producing nothing. Every field in the authored Step 10
 * survives the swap — the names change, the meaning does not:
 *
 *   AGENT / ROLE / CALL TYPE  -> agent_role, call_type   (+ agent_name from the caller)
 *   NOT SCOREABLE + reason    -> not_scoreable, not_scoreable_reason
 *   RUBRIC APPLIED            -> rubric_applied
 *   SCORE BREAKDOWN           -> categories[].items[]
 *   TOTAL SCORE / GRADE       -> overall_score, overall_grade
 *   FLAGS                     -> flags[]
 *   COACHING STRENGTHS/IMPROV -> coaching[{strength, improve}]
 *   FAIR HOUSING / LIABILITY / LEGAL VIOLATION -> the three booleans
 *
 * Re-run this after any edit to the markdown so the two never drift:
 *   node scripts/build-grade-prompt.js --src <path-to.md>
 */

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SRC = arg('src', path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'metric_call_grading_prompt.md'));
const OUT = arg('out', 'call-grade-prompt.json');

const md0 = fs.readFileSync(SRC, 'utf8');

// ---- Hard gate, injected before STEP 1 -------------------------------------
//
// Step 3 already lists "Agent identity cannot be confirmed (voice mismatch,
// name mismatch)" as a NOT SCOREABLE condition, but it sits third in a list
// read AFTER the agent and call type have been identified, and the 2026-09-18
// canary showed it being passed over: a call whose own summary said the agent
// "identif[ied] himself as 'Gustavo Moreno'" while attributed to Oscar was
// graded 38/F instead of marked N/S. Restating it as a gate evaluated before
// any rubric is selected is what makes it bind.
const HARD_GATE = `## STEP 0 — HARD GATES (evaluate FIRST, before Steps 1-9)

Check these BEFORE identifying the role, the call type, or any rubric. If a gate
trips, STOP: return not_scoreable = true with the reason, do NOT select a rubric,
do NOT score any criteria, and do NOT return a letter grade other than "N/S".

**GATE 1 — AGENT IDENTITY MISMATCH.** The agent this call is attributed to is
given to you as "Agent:" in the message. If the person speaking as the agent
identifies themselves by a DIFFERENT name, or is evidently a different person,
the call cannot be scored against that agent. Mark not_scoreable = true with
reason "Suspected agent mismatch — attributed to [attributed name], speaker
identified as [spoken name]". This applies no matter how well or badly the call
went: a grade recorded against the wrong person is worse than no grade. Note
that Step 1 flags Daria Rodriguez as a known case, but the gate applies to EVERY
agent, not only to her.

**GATE 2 — NOT GRADEABLE AT ALL.** Any Step 3 condition: voicemail with no live
conversation, garbled or incomplete audio, under 20 seconds with no substantive
content, wrong number, or a language barrier that makes the content ungradeable.

**GATE 3 — CALL TYPE INDETERMINATE.** If Step 2 cannot classify the call, mark
not_scoreable with reason "Call type indeterminate."

---

`;

const step1 = md0.indexOf('## STEP 1 —');
if (step1 < 0) { console.error('Could not locate STEP 1 in ' + SRC); process.exit(1); }
const md = md0.slice(0, step1) + HARD_GATE + md0.slice(step1);

// Replace the authored Step 10 block, up to the Appendix, with the JSON contract.
const startMarker = '## STEP 10 — OUTPUT FORMAT';
const endMarker = '## APPENDIX';
const start = md.indexOf(startMarker);
const end = md.indexOf(endMarker);
if (start < 0 || end < 0 || end < start) {
  console.error('Could not locate STEP 10 / APPENDIX markers in ' + SRC);
  process.exit(1);
}

const JSON_CONTRACT = `## STEP 10 — OUTPUT FORMAT

Respond with ONE valid JSON object and nothing else. No markdown, no code fence,
no commentary before or after. Every field below must be present on every
response.

{
  "agent_role": "the role from Step 1, e.g. Receptionist / Leasing Agent / Collections Specialist / Maintenance Coordinator / Resident Success / Administrative",
  "call_type": "the type from Step 2, e.g. LEASING / APPLICANT / MAINTENANCE / COLLECTIONS-PAYMENT / RENEWAL-NTV / COMPLAINT-DISPUTE / TRANSFER-ROUTING / PORTAL-TECH / BUSINESS DEVELOPMENT / PACKAGE-MAIL / GENERAL INQUIRY",
  "rubric_applied": "the rubric letter and name applied, e.g. 'A — Receptionist' or 'I — Transfer/Routing'",
  "property_name": "the property discussed, or 'Unidentified'",
  "not_scoreable": false,
  "not_scoreable_reason": "",
  "overall_score": 0,
  "overall_grade": "A",
  "legal_violation": false,
  "fair_housing_flag": false,
  "liability_flag": false,
  "summary": "2 sentence summary of what happened on the call",
  "outcome": "1 sentence on how the call ended",
  "flags": ["exact flag names from Step 8, or an empty array"],
  "categories": [
    {
      "name": "criterion group from the applied rubric",
      "weight": 0,
      "score": 0,
      "items": [{ "label": "the criterion as written in the rubric table", "score": 0, "note": "brief evidence from the call" }]
    }
  ],
  "coaching": [{ "category": "area", "strength": "what the agent did well", "improve": "what to do differently, citing this call" }],
  "key_moments": ["notable moment 1", "notable moment 2"]
}

FIELD RULES — these carry the requirements from the steps above:

- "overall_score" is COMPUTED, not judged. It must satisfy exactly:

      overall_score = round( 100 * SUM(categories[].score) / SUM(categories[].weight) )

  Work it out from the numbers you put in "categories" and report that result.
  Do not adjust it afterwards toward what the call "felt" like — if the figure
  looks wrong, the per-criterion scores are what to revise, then recompute.
  It is a number, not a string, and is null when not_scoreable is true.

  On the 2026-09-18 canary this was off by up to 20 points in both directions —
  one call showed 8 out of 95 in its own breakdown and reported 28. A score a
  reviewer cannot derive from the criteria beside it is not reviewable.

- CATEGORY WEIGHTS ARE FIXED BY THE RUBRIC TABLE. Every "weight" must be the
  points that criterion carries in the applied rubric, copied exactly, and
  SUM(categories[].weight) must equal that rubric's published total:

      Rubric A 100 · Rubric B 115 · Rubric C 100 · Rubric D 125 (Erick)
      Rubric E 100 · Rubric F 100 · Rubric G 100 · Rubric H 100 · Rubric I 100

  Do not invent weights, do not rescale them, and do not drop a criterion to
  make them add up. Rubric B is a 115-point rubric and must sum to 115 even
  though the final score is out of 100 — the division above is what converts it.
  If a criterion genuinely does not apply to this call, omit it AND subtract its
  points from the denominator by leaving it out of categories entirely, so the
  remaining weights still describe what was actually assessed.

- "categories[].score" must equal the sum of that category's "items[].score",
  and no item may score above its own share of the weight.
- "overall_grade" is the Step 9 band: A 90-100, B 80-89, C 70-79, D 60-69,
  F below 60. Use exactly one of "A", "B", "C", "D", "F" — or "N/S" when
  not_scoreable is true.
- "not_scoreable": true whenever a STEP 0 gate trips — agent identity mismatch,
  any Step 3 condition, or an indeterminate call type. Check the gates before
  choosing a rubric, not after scoring one. Give a short
  "not_scoreable_reason", set "overall_grade" to "N/S", set "overall_score" to
  null, and do NOT grade the call against a rubric.
- "categories" IS the Step 10 score breakdown. One entry per criterion group of
  the applied rubric; "weight" is that group's points from the rubric table and
  "items" are the individual criteria with the points earned. Include ONLY
  criteria from the rubric that applies. A criterion that does not apply to this
  call type is omitted, never scored zero — scoring an inapplicable criterion is
  the grading error Step 5 warns about.
- "flags" uses the exact flag names from the Step 8 table. Never include any
  item from the Step 8 "Do NOT flag" list, and never include the Step 4E items:
  "I" versus "we", a missing last name, or informal-but-professional filler.
- "legal_violation" is true only for a Step 8 LEGAL flag — identity not verified
  before balance disclosure, or a collections voicemail mentioning a balance.
  When it is true, Step 9 caps "overall_score" at 60.
- "fair_housing_flag" and "liability_flag" mirror their Step 8 flags.
- "coaching" carries the Step 10 strengths and improvements, one entry per area,
  each with both a "strength" and an "improve".

`;

const rebuilt = md.slice(0, start) + JSON_CONTRACT + '---\n\n' + md.slice(end);

fs.writeFileSync(OUT, JSON.stringify(rebuilt), 'utf8');
console.log('Wrote ' + OUT);
console.log('  source: ' + SRC);
console.log('  prompt length: ' + rebuilt.length + ' chars (authored ' + md.length + ')');
const version = (md.match(/Version\s+([\d.]+)/) || [])[1];
console.log('  rubric version: ' + (version || 'unknown'));
for (const marker of ['RUBRIC A', 'RUBRIC B', 'RUBRIC C', 'RUBRIC D', 'RUBRIC E', 'RUBRIC F', 'RUBRIC G', 'RUBRIC H', 'RUBRIC I']) {
  if (!rebuilt.includes(marker)) console.warn('  WARNING: ' + marker + ' missing from the built prompt');
}
