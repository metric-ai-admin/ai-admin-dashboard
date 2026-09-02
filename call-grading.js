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
const GRADE_MODEL = process.env.CALL_GRADE_MODEL || 'claude-sonnet-4-6';

// Strip a ```json … ``` fence if the model wrapped its JSON, then parse.
function parseModelJson(text) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(clean);
}

// Grades one transcript. Returns the parsed rubric object (the same shape the
// tool renders). Throws on missing key, API error, or unparseable output.
async function gradeTranscript({ callType, agent, duration, transcript }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Grading is not configured: set ANTHROPIC_API_KEY on the server.');
  if (!transcript || !String(transcript).trim()) throw new Error('No transcript to grade.');

  const userContent = 'Call Type: ' + (callType || 'unknown')
    + '\nAgent: ' + (agent || 'unknown')
    + '\nDuration: ' + (duration || 'unknown') + ' seconds'
    + '\n\nTRANSCRIPT:\n' + transcript;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: GRADE_MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
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

module.exports = { SYSTEM_PROMPT, gradeTranscript, GRADE_MODEL };
