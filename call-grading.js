// call-grading.js
//
// Server-side call-quality grading. The rubric prompt lives in
// call-grade-prompt.json, extracted VERBATIM from Lyndsay's Call Quality
// Analyzer (public/tools/call-quality-analyzer.html — the SYSTEM_PROMPT literal)
// so it stays byte-identical; it encodes Metric's compliance rules. It is stored
// as JSON purely to avoid escaping drift — do not paraphrase it.
//
// The one deliberate difference from the tool is WHERE the model is called: the
// tool calls Anthropic from the browser with a pasted key; we call it from the
// server with a key held in ANTHROPIC_API_KEY, so no key ever reaches the
// browser (per Metric's key-safety rule).

const SYSTEM_PROMPT = require('./call-grade-prompt.json');
// Danny is a receptionist, not a leasing agent — his calls are graded against a
// routing/transfer protocol (call-grade-prompt-danny.json), same output schema.
const DANNY_PROMPT = require('./call-grade-prompt-danny.json');
const GRADE_MODEL = process.env.CALL_GRADE_MODEL || 'claude-sonnet-4-6';

// Agents whose name in "this is <name>" reliably identifies who was on the call.
// Rebekah's line is shared, so the graded agent comes from self-identification,
// not the line owner.
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
const isDanny = agent => /\bdanny\b/i.test(String(agent || ''));

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

// Grades one transcript. Returns the parsed rubric object (the same shape the
// tool renders). Throws on missing key, API error, or unparseable output.
async function gradeTranscript({ callType, agent, duration, transcript }) {
  if (!transcript || !String(transcript).trim()) throw new Error('No transcript to grade.');
  const userContent = 'Call Type: ' + (callType || 'unknown')
    + '\nAgent: ' + (agent || 'unknown')
    + '\nDuration: ' + (duration || 'unknown') + ' seconds'
    + '\n\nTRANSCRIPT:\n' + transcript;
  // Danny gets the receptionist rubric; everyone else the standard leasing rubric.
  const system = isDanny(agent) ? DANNY_PROMPT : SYSTEM_PROMPT;
  return anthropicJson({ system, user: userContent, maxTokens: 4000 });
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

module.exports = { SYSTEM_PROMPT, DANNY_PROMPT, gradeTranscript, anthropicJson, anthropicText, GRADE_MODEL, detectAgentFromTranscript, canonicalAgentName, AGENT_ALIASES };
