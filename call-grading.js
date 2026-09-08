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
// Detect the agent from how they introduce themselves in the transcript
// ("this is <Name>", "my name is <Name>", "speaking with <Name>"). Returns the
// canonical name, or null when no known agent self-identifies.
function detectAgentFromTranscript(transcript) {
  if (!transcript) return null;
  const text = String(transcript);
  const canon = name => name === 'Bekah' ? 'Rebekah' : (name === 'Rocio' ? 'Rocío' : name);
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
function parseModelJson(text) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(clean);
}

// Generic "ask Claude for JSON" call — the single outbound Anthropic path,
// reused by call grading and the 6PM action-item extraction. Throws on a missing
// key (message says "not configured" so callers can tell it apart), an API
// error, or unparseable output.
async function anthropicJson({ system, user, maxTokens = 2000, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic is not configured: set ANTHROPIC_API_KEY on the server.');

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

  const data = await r.json();
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

module.exports = { SYSTEM_PROMPT, DANNY_PROMPT, gradeTranscript, anthropicJson, GRADE_MODEL, detectAgentFromTranscript };
