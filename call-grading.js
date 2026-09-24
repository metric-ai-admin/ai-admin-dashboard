// call-grading.js
//
// Server-side call-quality grading.
//
// The rubric is Lyndsay's "Metric Property Management — Call Quality Grading
// Prompt", Version 2.0 (2026-09-18), authored as markdown and reviewed as a
// document. call-grade-prompt.json is BUILT from that markdown by
// scripts/build-grade-prompt.js, which changes exactly one thing: it swaps the
// authored Step 10 output block for the JSON contract this pipeline parses.
// Edit the markdown and re-run the build — do not hand-edit this JSON, and do
// not paraphrase the rubric.
//
// Version 2.0 is role-aware and call-type-aware: Step 1 maps agent to role,
// Step 2 maps the call to a type, and Step 5 selects one of eleven rubrics.
// Danny's receptionist protocol is Rubric A within it, which is why there is no
// longer a separate Danny prompt.
//
// public/tools/call-quality-analyzer.html used to carry a SECOND copy of the
// prompt for Lyndsay's browser tool. It was deleted on 2026-09-25: it had
// drifted to the point of being a different rubric, it was reachable on the
// public internet with no auth, and the audit found the original June rules
// surviving there while the server had lost them. One rubric, one file.
//
// Anthropic is called from the SERVER with ANTHROPIC_API_KEY, so no key ever
// reaches the browser (per Metric's key-safety rule).

const SYSTEM_PROMPT = require('./call-grade-prompt.json');
// call-grade-prompt-danny.json is retired: rubric v2.0 carries Danny's
// receptionist protocol as Rubric A and routes to it from Step 1, so a separate
// prompt file would be a second place for his rules to live and drift.
const GRADE_MODEL = process.env.CALL_GRADE_MODEL || 'claude-sonnet-4-6';

// Agents whose name in "this is <name>" reliably identifies who was on the call.
//
// The note that used to sit here said Rebekah's line was shared. The SimpleVOIP
// admin portal was checked on 2026-09-22 and every extension is uniquely
// assigned — hers is ext 101, and the apparent sharing was outbound admin
// dialling into vendor phone trees, not another person. Her line is now skipped
// by autoGradeDay entirely (AUTOGRADE_EXCLUDED_LINES in server.js).
const KNOWN_AGENTS = ['Danny', 'Rebekah', 'Bekah', 'Katie', 'Rhoxie', 'Katrina', 'Oscar', 'Erick', 'Lyndsay', 'Rocío', 'Rocio', 'Yeni', 'Sammy'];
// ---- Canonical agent names --------------------------------------------------
//
// One agent must be ONE name in call_grades, or the leaderboard and every
// per-agent average silently splits them in two. As of 2026-09-18 the table held
// "Rocío" (45) beside "Rocio" (36), and "Sammy" (10) beside "Sammy Ramos" (4) —
// the same two people, scored as four.
//
// Three things produce the same person under different spellings:
//   1. the SimpleVOIP roster suffix — "Danny Metric" vs "Danny"
//   2. the accent — the line owner arrives as "Rocio", self-identification as "Rocío"
//   3. first name vs full name — "Sammy" from the transcript, "Sammy Ramos" from the roster
//
// ALIASES resolves 2 and 3; the suffix strip resolves 1. Targets are the form
// already dominant in the data, so the migration moves as few rows as possible.
// Everything that writes agent_name goes through here — server.js's
// normalizeAgentName() delegates to it.
// Keys are lowercase; the lookup lowercases and collapses whitespace first, so
// full-name keys are listed alongside short ones — that way "sammy  ramos" from
// a sloppy roster edit lands on the same canonical form as "Sammy".
const AGENT_ALIASES = {
  'rocio': 'Rocío',
  'rocío': 'Rocío',
  'bekah': 'Rebekah Tuckner',
  'rebekah': 'Rebekah Tuckner',
  'rebekah tuckner': 'Rebekah Tuckner',
  'sammy': 'Sammy Ramos',
  'sammy ramos': 'Sammy Ramos',
};

// How the transcription service mis-renders an agent's name, per agent.
//
// SimpleVOIP's ASR is unreliable on proper nouns. Daria Rodriguez's line (ext
// 109, 90% inbound) produced "This is Daria", "This is Diane" and "This is
// Diana" across three calls on the SAME line, plus Dory, Stacy and Ally
// elsewhere. The grader compared the heard name against the attributed agent,
// correctly concluded they differed, and marked the call Not Scoreable for
// identity mismatch — roughly 88 of ~150 such rows as of 2026-09-22.
//
// DELIBERATELY NOT part of AGENT_ALIASES. That map feeds canonicalAgentName(),
// which normalises the stored agent_name for every call in the system; putting
// "stacy" in it would rename a real agent called Stacy to Daria everywhere.
// These variants are only ever consulted for the specific agent whose line the
// call arrived on, which is what makes common first names safe to list.
//
// Keyed by canonical name. Extend when a new mis-transcription shows up; the
// grader is told about them rather than the text being rewritten, so a genuine
// mismatch is still reportable.
const AGENT_ASR_VARIANTS = {
  'Daria Rodriguez': ['Diane', 'Diana', 'Dory', 'Stacy', 'Ally'],
};

function agentAsrVariants(name) {
  const canon = canonicalAgentName(name);
  return (canon && AGENT_ASR_VARIANTS[canon]) || [];
}

function canonicalAgentName(name) {
  const trimmed = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  // "Danny Metric" -> "Danny". Keep the original if stripping empties it.
  const stripped = trimmed.replace(/\s+metric\s*$/i, '').trim() || trimmed;
  return AGENT_ALIASES[stripped.toLowerCase()] || stripped;
}

// Detect the agent from how they introduce themselves in the transcript
// ("this is <Name>", "my name is <Name>", "speaking with <Name>"). Returns the
// canonical name, or null when no known agent self-identifies.
function detectAgentFromTranscript(transcript) {
  if (!transcript) return null;
  const text = String(transcript);
  const canon = canonicalAgentName;
  for (const name of KNOWN_AGENTS) {
    // "this is Danny", "my name is Danny", "thank you for calling … this is Danny",
    // "you've reached Danny", "Danny speaking", "Danny here".
    const before = new RegExp('(?:this is|my name is|speaking with|you(?:\'re| are) speaking with|you(?:\'ve| have) reached)\\s+' + name + '\\b', 'i');
    const after = new RegExp('\\b' + name + '\\s+(?:speaking|here)\\b', 'i');
    if (before.test(text) || after.test(text)) return canon(name);
  }
  return null;
}

// Strip a ```json … ``` fence if the model wrapped its JSON, then parse.
//
// A parse failure is tagged with code MALFORMED_JSON so callers can tell it
// apart from a transport/API error. The distinction matters for retries: an API
// error (429, 5xx, credits) is worth retrying, but a malformed response for a
// given transcript reproduces every time — re-grading it just spends the money
// again. The auto-grade path stores those as Not Scoreable instead of retrying.
function parseModelJson(text) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(clean);
  } catch (err) {
    const e = new Error('Model returned malformed JSON: ' + err.message);
    e.code = 'MALFORMED_JSON';
    // First 300 chars only — a transcript excerpt is resident PII and this ends
    // up in logs. Enough to recognise a truncation or a prose preamble.
    e.rawExcerpt = clean.slice(0, 300);
    throw e;
  }
}

// A response cut off at the token limit is truncated mid-string, so the JSON
// never parses. That is not a malformed model — it is a cap that was too low for
// a long call, and it reproduces at the same cap every time. Retry ONCE with
// double the budget before giving up: long calls carry real content worth
// grading, and marking them Not Scoreable loses it permanently.
const MAX_TOKENS_CEILING = 16000;

async function anthropicRequest({ system, user, maxTokens, model, key }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || GRADE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    let msg = 'Anthropic API error (' + r.status + ').';
    try { const j = JSON.parse(errText); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

// Generic "ask Claude for JSON" call — the single outbound Anthropic path,
// reused by call grading and the 6PM action-item extraction. Throws on a missing
// key (message says "not configured" so callers can tell it apart), an API
// error, or unparseable output.
async function anthropicJson({ system, user, maxTokens = 2000, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic is not configured: set ANTHROPIC_API_KEY on the server.');

  let data = await anthropicRequest({ system, user, maxTokens, model, key });

  // stop_reason is the reliable signal — check it BEFORE parsing, because a
  // truncated body fails to parse for a reason the parse error cannot explain.
  if (data.stop_reason === 'max_tokens') {
    const bigger = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
    if (bigger > maxTokens) {
      console.warn('[anthropic] response hit max_tokens at ' + maxTokens + ' — retrying once at ' + bigger);
      data = await anthropicRequest({ system, user, maxTokens: bigger, model, key });
    }
    // Still truncated at the ceiling: fall through and let the parse fail with
    // MALFORMED_JSON, which the auto-grade path stores as Not Scoreable rather
    // than retrying forever.
    if (data.stop_reason === 'max_tokens') {
      console.warn('[anthropic] still truncated at ' + bigger + ' — giving up on this transcript');
    }
  }

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text response from the model.');
  return parseModelJson(textBlock.text);
}

// Grades one transcript against the unified rubric. Throws on missing key, API
// error, or unparseable output.
//
// ONE prompt now, not two. Rubric v2.0 does its own role routing in Step 1 and
// its own call-type routing in Step 2, so Danny's receptionist protocol is
// Rubric A inside the same document. The old isDanny() branch picked the rubric
// by matching the agent name in server code, which meant the routing lived in
// two places and only knew about one special case. Passing the agent name and
// letting Step 1 decide is what makes the other eight rubrics reachable.
//
// maxTokens is 6000 rather than 4000: the v2.0 output carries a per-criterion
// breakdown for rubrics with up to twenty criteria, which is a longer response
// than the previous format. anthropicJson() still retries once at double on a
// max_tokens stop, so an unusually long call is covered.
async function gradeTranscript({ callType, agent, duration, transcript }) {
  if (!transcript || !String(transcript).trim()) throw new Error('No transcript to grade.');
  // Tell the grader how this agent's name gets mangled, so a transcription
  // error is not read as the wrong person being on the call. Phrased as
  // information about the TRANSCRIPT, not permission to assume — a call where
  // someone genuinely different is speaking should still be flagged.
  const variants = agentAsrVariants(agent);
  const variantNote = variants.length
    ? `\nNOTE ON THE TRANSCRIPT: the transcription service mis-renders this agent's name. On this line it has produced ${variants.join(', ')} for the same person. Treat those spellings as ${canonicalAgentName(agent)} and do not report an identity mismatch on the strength of the name alone. If the speaker is identifiably a different person for other reasons, still report it.`
    : '';
  const userContent = 'Call Direction: ' + (callType || 'unknown')
    + '\nAgent: ' + (agent || 'unknown')
    + '\nDuration: ' + (duration || 'unknown') + ' seconds'
    + variantNote
    + '\n\nTRANSCRIPT:\n' + transcript;
  const graded = await anthropicJson({ system: SYSTEM_PROMPT, user: userContent, maxTokens: 6000 });
  return normaliseScoreability(graded);
}

// The N/S verdict has to agree with itself.
//
// The output contract says an N/S call sets not_scoreable true, overall_grade
// "N/S", overall_score null and gives a reason. On the 2026-09-22 regrade the
// model said "N/S" in overall_grade on eight calls while leaving not_scoreable
// false — so the rows landed as SCOREABLE calls carrying a null score and a
// grade nothing filters on. Every average over that day quietly included a null,
// and the N/S count read 2 when the real answer was 10.
//
// Nothing checked, because gradeTranscript returned the model's JSON verbatim.
// A contract the caller never verifies is a comment. Both directions are
// reconciled here, in the one place both the nightly job and the regrade script
// go through.
function normaliseScoreability(g) {
  if (!g || typeof g !== 'object') return g;
  const saysNS = String(g.overall_grade || '').trim().toUpperCase() === 'N/S';
  const flagged = !!g.not_scoreable;
  if (!saysNS && !flagged) return g;

  const out = { ...g, not_scoreable: true, overall_grade: 'N/S', overall_score: null };
  if (!String(out.not_scoreable_reason || '').trim()) {
    // Say which half of the contract was missing rather than inventing a
    // reason — a blank reason on the dashboard is indistinguishable from a
    // reason nobody wrote down.
    out.not_scoreable_reason = saysNS && !flagged
      ? 'Graded N/S without a stated reason (model set overall_grade "N/S" but not not_scoreable).'
      : 'Marked not scoreable without a stated reason.';
  }
  // An N/S call was never scored against a rubric, so a breakdown here is
  // leftover, not evidence.
  if (Array.isArray(out.categories) && !out.categories.length) out.categories = null;
  return out;
}

// Like anthropicJson but returns the model's raw text (no JSON parse) — for
// prompts that produce prose/HTML (e.g. the Collections Review report).
async function anthropicText({ system, user, maxTokens = 2000, model, timeoutMs = 90000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic is not configured: set ANTHROPIC_API_KEY on the server.');
  // Optional hard timeout so a slow/hung call fails fast instead of hitting the
  // platform's request timeout with no useful error.
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || GRADE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Anthropic request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw err;
  } finally { if (timer) clearTimeout(timer); }
  if (!r.ok) {
    const errText = await r.text();
    let msg = 'Anthropic API error (' + r.status + ').';
    try { const j = JSON.parse(errText); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  const data = await r.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text response from the model.');
  return textBlock.text;
}

module.exports = { SYSTEM_PROMPT, gradeTranscript, normaliseScoreability, anthropicJson, anthropicText, GRADE_MODEL, detectAgentFromTranscript, canonicalAgentName, AGENT_ALIASES, AGENT_ASR_VARIANTS, agentAsrVariants };
