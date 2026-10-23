// Does the cache change what the model reads, and does it actually cache?
//
// Two separate questions, and only the first one has a provable answer.
//
//   1. THE MODEL SEES THE SAME INPUT. Provable byte-for-byte, and it is the
//      whole guarantee that grades do not move. cache_control is cache
//      metadata, not prompt text.
//
//   2. THE SCORES ARE THE SAME. NOT provable by diffing two runs — two
//      UNCACHED runs of one transcript also differ, which
//      scripts/regrade-sample.js documents at its top. That one is a
//      distribution check on real calls, not an assertion in here, and
//      pretending otherwise would be a test that proves nothing.
//
// The second half of this file is about the failure that has no symptoms: a
// cache that is accepted and silently does nothing. Same grades, same latency,
// a bill 1.25x bigger than before. The only place it shows is the usage block.
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const G = require('../call-grading.js');

console.log('call grading — prompt caching');

// ---- 1. the prefix the model reads -------------------------------------------

t('caching adds cache_control and changes NOTHING else', () => {
  const sys = 'RUBRIC TEXT, pretend this is 10,500 tokens.';
  const plain = G.systemBlocks(sys, false);
  const cached = G.systemBlocks(sys, true);

  // Uncached is the bare string, exactly as it has always been sent.
  assert.strictEqual(plain, sys, 'the uncached shape changed');

  // Cached is one text block carrying the IDENTICAL text.
  assert.ok(Array.isArray(cached) && cached.length === 1, 'expected one block');
  assert.strictEqual(cached[0].type, 'text');
  assert.strictEqual(cached[0].text, sys, 'THE PROMPT TEXT MOVED — grades can change');
  assert.deepStrictEqual(cached[0].cache_control, { type: 'ephemeral' });

  // And nothing else rode along.
  assert.deepStrictEqual(Object.keys(cached[0]).sort(),
    ['cache_control', 'text', 'type']);
});

t('the real rubric survives the wrapping byte for byte', () => {
  // Not a stand-in: the actual 39,873-character prompt that grades every call.
  const cached = G.systemBlocks(G.SYSTEM_PROMPT, true);
  assert.strictEqual(cached[0].text, G.SYSTEM_PROMPT);
  assert.strictEqual(cached[0].text.length, G.SYSTEM_PROMPT.length);
});

t('the rubric clears every model cache minimum', () => {
  // Below the floor the marker is ACCEPTED and silently does not cache — no
  // error, just a 1.25x bill. The floor is 1024 tokens on Sonnet 4.6 and 4096
  // at the highest of any model, so this checks against the worst case rather
  // than against the model we happen to run today: CALL_GRADE_MODEL is an env
  // var and can be changed without touching this file.
  const WORST_FLOOR_TOKENS = 4096;
  // Deliberately pessimistic chars-per-token so the check cannot pass by
  // being generous with the estimate.
  const tokens = G.SYSTEM_PROMPT.length / 5;
  assert.ok(tokens > WORST_FLOOR_TOKENS,
    'the rubric is ~' + Math.round(tokens) + ' tokens, at or under the ' + WORST_FLOOR_TOKENS
    + '-token floor — it would stop caching silently');
});

t('caching is off unless asked for', () => {
  // A prompt cached and never read again costs 1.25x for nothing. The 6PM
  // extraction and the Collections Review each run once a day with their own
  // prompt and would only ever pay the write.
  assert.strictEqual(G.systemBlocks('x', undefined), 'x');
  assert.strictEqual(G.systemBlocks('x', false), 'x');
});

t('grading is the call site that asks for it', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'call-grading.js'), 'utf8');
  const from = src.indexOf('async function gradeTranscript');
  const to = src.indexOf('function normaliseScoreability');
  const body = src.slice(from, to > from ? to : undefined);
  assert.ok(/cache:\s*true/.test(body), 'gradeTranscript no longer caches');
  assert.ok(/system:\s*SYSTEM_PROMPT/.test(body), 'the system prompt is no longer the rubric');
});

// ---- 2. the failure with no symptoms -----------------------------------------

t('a read is reported as a read', () => {
  const u = G.readUsage({ usage: {
    input_tokens: 640, output_tokens: 1450,
    cache_read_input_tokens: 10500, cache_creation_input_tokens: 0 } });
  assert.strictEqual(u.cached, 'read');
  assert.strictEqual(u.cacheReadTokens, 10500);
  assert.strictEqual(u.inputTokens, 640);
  assert.strictEqual(u.outputTokens, 1450);
});

t('the first call of a batch is a write, not a failure', () => {
  const u = G.readUsage({ usage: {
    input_tokens: 640, output_tokens: 1450,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 10500 } });
  assert.strictEqual(u.cached, 'write');
  assert.strictEqual(u.cacheWriteTokens, 10500);
});

t('A SILENT MISS IS ITS OWN ANSWER, not a quiet false', () => {
  // THE WHOLE POINT. Zero and zero is the shape of "the marker was accepted and
  // nothing cached" — the bill goes up, the grades do not change, and no error
  // is raised anywhere. If this collapsed into a boolean, a miss would read the
  // same as a call that never asked to be cached.
  const u = G.readUsage({ usage: {
    input_tokens: 11140, output_tokens: 1450,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  assert.strictEqual(u.cached, 'miss');
  assert.notStrictEqual(u.cached, false);
});

t('a missing usage block is a miss, never a crash', () => {
  // The API has always returned usage, but a grade must not die because a
  // measurement field moved.
  assert.strictEqual(G.readUsage({}).cached, 'miss');
  assert.strictEqual(G.readUsage(null).cached, 'miss');
  assert.strictEqual(G.readUsage({ usage: {} }).inputTokens, 0);
});

t('a non-numeric token count does not become NaN', () => {
  // NaN propagates into every total downstream and prints as a number.
  const u = G.readUsage({ usage: { input_tokens: null, cache_read_input_tokens: 'x' } });
  assert.strictEqual(u.inputTokens, 0);
  assert.strictEqual(u.cacheReadTokens, 0);
  assert.strictEqual(u.cached, 'miss');
});

t('the retry reuses the cache instead of writing a second entry', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'call-grading.js'), 'utf8');
  const from = src.indexOf('async function anthropicJson');
  const body = src.slice(from, from + 2000);
  // max_tokens is not part of the cached prefix; the retry must carry `cache`
  // through or it pays the write twice for one transcript.
  assert.ok(/maxTokens:\s*bigger[^}]*cache/.test(body),
    'the max_tokens retry dropped the cache flag');
});

t('measurement can never fail a grade', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'call-grading.js'), 'utf8');
  const from = src.indexOf('async function anthropicJson');
  const body = src.slice(from, from + 2000);
  // A throwing onUsage must not cost us the grade we already paid for.
  const calls = body.match(/onUsage\(readUsage\(data\)\)/g) || [];
  assert.ok(calls.length >= 2, 'usage is not reported on both paths');
  assert.ok(/try \{ onUsage\(readUsage\(data\)\); \} catch/.test(body),
    'onUsage is called unguarded');
});

// ---- 3. the body that actually goes over the wire ------------------------------
//
// Everything above tests pieces. This grades a transcript with fetch stubbed
// and reads the real request body — the only check that covers the whole path
// from gradeTranscript() to JSON.stringify. Nothing leaves the process.

function captureGrade(transcript) {
  const real = global.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const seen = [];
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  global.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        stop_reason: 'end_turn',
        usage: { input_tokens: 640, output_tokens: 1450,
          cache_read_input_tokens: 10500, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: JSON.stringify({
          not_scoreable: false, overall_score: 90, overall_grade: 'A',
          categories: [], coaching: [], flags: [] }) }],
      }),
    };
  };
  try {
    return G.gradeTranscript({ callType: 'inbound', agent: 'nobody', duration: 120, transcript })
      .then(() => seen);
  } finally {
    global.fetch = real;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

const pending = [];
const ta = (name, fn) => {
  pending.push(fn().then(() => { pass++; console.log('  ok   ' + name); })
    .catch(e => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }));
};

ta('the request on the wire carries the rubric with cache_control', async () => {
  const seen = await captureGrade('Caller: hello. Agent: hello, how can I help?');
  assert.strictEqual(seen.length, 1, 'expected exactly one API call');
  const body = seen[0].body;
  assert.ok(Array.isArray(body.system), 'system is not a block array — not caching');
  assert.strictEqual(body.system.length, 1);
  assert.strictEqual(body.system[0].text, G.SYSTEM_PROMPT, 'the rubric text changed');
  assert.deepStrictEqual(body.system[0].cache_control, { type: 'ephemeral' });
  // The per-call half stays out of the cached block, or every call would write
  // a new entry and never read one.
  assert.strictEqual(body.messages.length, 1);
  assert.strictEqual(body.messages[0].role, 'user');
  assert.ok(/TRANSCRIPT:/.test(body.messages[0].content));
  assert.ok(!JSON.stringify(body.system).includes('TRANSCRIPT:'),
    'THE TRANSCRIPT IS INSIDE THE CACHED BLOCK — every call would miss');
});

ta('the transcript never reaches the cached prefix, however long it is', async () => {
  const seen = await captureGrade('x'.repeat(20000));
  assert.ok(!JSON.stringify(seen[0].body.system).includes('xxxxx'));
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
