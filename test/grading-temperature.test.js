// Temperature is a measuring instrument, and it must not reach the nightly run.
//
// Grading runs at the API default (temperature 1.0), which is why two runs of
// one transcript disagree. scripts/regrade-sample.js can pin it to find out how
// much of the variance that accounts for.
//
// ADOPTING IT IN PRODUCTION IS NOT THIS CHANGE. It would alter every grade,
// which is Lyndsay's call, and it would pin us to anthropic-version 2023-06-01
// — on 2026-10-21 and later the parameter is rejected with a 400 on every
// model. So the only thing that may send it is the script, and the test that
// matters here is the one that says so.
//
// The other half: with no temperature passed, the request body must serialise
// to exactly the bytes it did before the parameter existed. Otherwise the
// nightly run's cached prefix stops matching and the bill goes up 1.25x for
// nothing — the failure that has no symptoms.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const pending = [];
// ASYNC-AWARE, and it has to be. The first version of this runner was the
// plain synchronous one: an async test returned a promise, `pass++` ran
// immediately, and whatever the assertions inside did was never looked at. It
// printed "ok" for a test that had not finished — and it did that in front of
// me for several runs before a syntax error exposed it.
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r
        .then(() => { pass++; console.log('  ok   ' + name); })
        .catch(e => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }));
      return;
    }
    pass++; console.log('  ok   ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const G = require('../call-grading.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const codeOf = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');
const server = codeOf(read('server.js'));
const script = codeOf(read('scripts/regrade-sample.js'));
const grading = codeOf(read('call-grading.js'));

console.log('grading temperature');

// ---- it cannot reach the nightly path --------------------------------------------

t('NOTHING IN server.js SENDS A TEMPERATURE', () => {
  // The whole point. autoGradeCall and the manual grade route both call
  // gradeTranscript; neither may pass this.
  assert.ok(!/temperature/i.test(server),
    'server.js now mentions temperature — the nightly run may be sampling-pinned');
});

t('autoGradeCall passes exactly the four grading inputs', () => {
  const at = server.indexOf('parsed = await callGrading.gradeTranscript({');
  assert.ok(at > 0, 'the nightly call to gradeTranscript moved');
  const call = server.slice(at, server.indexOf('});', at));
  ['callType', 'agent', 'duration', 'transcript']
    .forEach(k => assert.ok(call.includes(k + ':'), 'the nightly call lost ' + k));
  assert.ok(!/temperature/.test(call), 'the nightly call now pins sampling');
});

t('only the script sends it', () => {
  assert.match(script, /temperature: TEMPERATURE/, 'the script does not pass it');
  // And it is read from the command line, not hard-coded on.
  assert.match(script, /process\.argv\.indexOf\('--temperature'\)/,
    'the flag is no longer read from argv');
});

// ---- absent means ABSENT ------------------------------------------------------------

t('no temperature means the field is not in the body at all', () => {
  assert.deepStrictEqual(G.samplingFields(undefined), {});
  assert.deepStrictEqual(G.samplingFields(null), {});
  assert.deepStrictEqual(G.samplingFields(''), {});
});

t('ZERO IS A VALUE, NOT AN ABSENCE', () => {
  // The trap this whole test exists around: Number('0') is 0, 0 is falsy, and a
  // `|| undefined` anywhere on the path would silently drop the one setting the
  // experiment is about — producing a "temperature 0" run that ran at 1.0 and
  // a conclusion drawn from it.
  assert.deepStrictEqual(G.samplingFields(0), { temperature: 0 });
  assert.deepStrictEqual(G.samplingFields('0'), { temperature: 0 });
  assert.deepStrictEqual(G.samplingFields(0.5), { temperature: 0.5 });
});

t('the script does not drop a zero on the way through', () => {
  const at = script.indexOf("const tempAt = process.argv.indexOf('--temperature')");
  assert.ok(at > 0, 'the flag parsing moved');
  const block = script.slice(at, at + 500);
  assert.ok(!/\|\|\s*undefined/.test(block), 'a `|| undefined` would swallow 0');
  assert.ok(!/TEMPERATURE \|\|/.test(script), 'TEMPERATURE is used with || somewhere');
});

t('a missing or non-numeric value is refused, not defaulted', () => {
  const at = script.indexOf("const tempAt = process.argv.indexOf('--temperature')");
  const block = script.slice(at, at + 700);
  assert.match(block, /Number\.isNaN\(TEMPERATURE\)/, 'a bad value is not detected');
  assert.match(block, /process\.exit\(2\)/, 'a bad value does not stop the run');
});

// ---- the request body ----------------------------------------------------------------

t('the body is byte-identical when no temperature is sent', async () => {
  // Proven by building the request, not by reading the code.
  const bodies = [];
  const realFetch = global.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  global.fetch = async (url, opts) => {
    bodies.push(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: '{"categories":[],"flags":[]}' }],
      }),
    };
  };
  try {
    const args = { callType: 'inbound', agent: 'nobody', duration: 10, transcript: 'hello there' };
    await G.gradeTranscript(args);                       // nightly shape
    await G.gradeTranscript({ ...args, temperature: 0 }); // script shape
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
  assert.strictEqual(bodies.length, 2);
  const plain = JSON.parse(bodies[0]);
  const pinned = JSON.parse(bodies[1]);
  assert.ok(!('temperature' in plain), 'the default path now sends a temperature');
  assert.strictEqual(pinned.temperature, 0, 'the pinned path did not send 0');
  // Everything else identical, so the cached prefix is untouched either way.
  delete pinned.temperature;
  assert.strictEqual(JSON.stringify(plain), JSON.stringify(pinned),
    'pinning temperature changed something else in the request');
});

t('the cached prefix is the same object either way', () => {
  // temperature is not in the documented cache-invalidation hierarchy (tools,
  // system, messages). Asserted on our side of it: the system block the
  // breakpoint sits on does not depend on the sampling setting.
  const a = G.systemBlocks(G.SYSTEM_PROMPT, true);
  const b = G.systemBlocks(G.SYSTEM_PROMPT, true);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a[0].cache_control, { type: 'ephemeral' });
});

// ---- the columns the experiment needs -------------------------------------------------

t('the CSV records WHERE a score came from, not just what it was', () => {
  const at = script.indexOf("const header = 'recording_id");
  assert.ok(at > 0, 'the CSV header moved');
  const header = script.slice(at, script.indexOf(';', at));
  ['rubric_applied', 'agent_role', 'call_type', 'cat_count', 'total_weight',
    'denom_only', 'denom_share_pct', 'temperature']
    .forEach(c => assert.ok(header.includes(c), 'the CSV does not record ' + c));
});

t('two runs cannot overwrite each other', () => {
  // It was exports/regrade_<day>.csv for every run, so the second run of a
  // two-run comparison destroyed the first — silently, with a "wrote" line.
  const at = script.indexOf("const out = 'exports/regrade_");
  assert.ok(at > 0, 'the CSV path moved');
  const line = script.slice(at, script.indexOf(';', at));
  assert.match(line, /toISOString/, 'the filename carries no timestamp');
  assert.match(line, /tag/, 'the filename does not say which temperature produced it');
});

t('the denominator is decomposed, with the residual reported', () => {
  // denomOnly and numerOnly do not sum to the whole — there is an interaction
  // term — and folding it in silently would overstate whichever is reported.
  assert.match(script, /denomOnly = pct\(bs\.earned, bn\.weight\) - rawS/,
    'the denominator-only component is not held to the stored numerator');
  assert.match(script, /numerOnly = pct\(bn\.earned, bs\.weight\) - rawS/,
    'the numerator-only component is not held to the stored denominator');
  assert.match(script, /residual = total - denomOnly - numerOnly/,
    'the interaction term is not reported');
});

// AWAITED, then summarised. An async assertion that rejects after the summary
// has printed lands in a suite that already said "0 failed" — a test that
// cannot fail the build is worse than no test.
Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
});
