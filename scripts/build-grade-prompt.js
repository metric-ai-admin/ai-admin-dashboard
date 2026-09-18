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

const md = fs.readFileSync(SRC, 'utf8');

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

- "overall_score" is the NORMALISED score out of 100 from Step 9, after the
  rubric total has been converted to a percentage. Rubric B totals 115 and
  Rubric D totals 125; normalise both to 100. It is a number, not a string, and
  is null when not_scoreable is true.
- "overall_grade" is the Step 9 band: A 90-100, B 80-89, C 70-79, D 60-69,
  F below 60. Use exactly one of "A", "B", "C", "D", "F" — or "N/S" when
  not_scoreable is true.
- "not_scoreable": true for any Step 3 condition, for an indeterminate call type
  (Step 2), or for a suspected agent mismatch (Step 1). Give a short
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
