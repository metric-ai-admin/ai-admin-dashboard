// Which number goes in the archive, and which never does.
//
// simplevoip_daily_calls held no number at all until 2026-09-30. `caller` is
// from_name when there is one, so it carried the AGENT's name on every outbound
// call — and outbound is 65% of a week's traffic and the whole of the
// collections use case ("Karla called Vasquez Jose").
//
// The rule is one sentence: store the FAR side, never ours. Metric's own
// numbers stay out of the table by construction rather than by keeping a list
// of them to exclude, which would be one more thing to maintain and to get
// wrong.
const assert = require('assert');
const sv = require('../simplevoip.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const METRIC_LINE = '5125550100';   // stands in for one of ours

console.log('the far side, and only the far side');
t('inbound keeps who called US', () => {
  assert.strictEqual(sv.counterpartyNumber({
    direction: 'inbound', caller_number: '(512) 673-9783', to_number: METRIC_LINE,
  }), '5126739783');
});
t('outbound keeps who WE called', () => {
  assert.strictEqual(sv.counterpartyNumber({
    direction: 'outbound', caller_number: METRIC_LINE, to_number: '(737) 393-1285',
  }), '7373931285');
});
t("our own line is never what gets stored, either way round", () => {
  const inbound = sv.counterpartyNumber({ direction: 'inbound', caller_number: '5126739783', to_number: METRIC_LINE });
  const outbound = sv.counterpartyNumber({ direction: 'outbound', caller_number: METRIC_LINE, to_number: '7373931285' });
  assert.notStrictEqual(inbound, METRIC_LINE);
  assert.notStrictEqual(outbound, METRIC_LINE);
});
t('an unknown direction stores nothing rather than guessing', () => {
  // Guessing puts our own line in a resident directory, where it would match
  // every call at once. A missing number is recoverable; that is not.
  [undefined, null, '', 'internal', 'unknown'].forEach(direction =>
    assert.strictEqual(sv.counterpartyNumber({ direction, caller_number: '5126739783', to_number: '7373931285' }), null,
      String(direction)));
});
t('case and spacing in the direction do not matter', () => {
  assert.strictEqual(sv.counterpartyNumber({ direction: 'INBOUND', caller_number: '5126739783' }), '5126739783');
  assert.strictEqual(sv.counterpartyNumber({ direction: 'Outbound', to_number: '7373931285' }), '7373931285');
});
t('a missing call, or a missing number, is null not a crash', () => {
  assert.strictEqual(sv.counterpartyNumber(null), null);
  assert.strictEqual(sv.counterpartyNumber({ direction: 'inbound' }), null);
  assert.strictEqual(sv.counterpartyNumber({ direction: 'outbound', to_number: null }), null);
});

console.log('\nten digits, because that is what both sides can agree on');
t('every spelling of the same number normalises to one key', () => {
  // The left column is how SimpleVOIP spells it; AppFolio's phone_numbers
  // column spells it its own way again ("Phone: (512) 673-9783").
  ['(512) 673-9783', '+1 512-673-9783', '512.673.9783', '1-512-673-9783',
   '5126739783', ' +15126739783 ', 'Phone: (512) 673-9783',
  ].forEach(v => assert.strictEqual(sv.normalizeNumber(v), '5126739783', v));
});
t('an internal extension is dropped, not stored as a number', () => {
  // Three digits would match half a resident directory.
  ['202', '1', '4321', '', null, undefined, 'unknown'].forEach(v =>
    assert.strictEqual(sv.normalizeNumber(v), null, String(v)));
});
t('an international number keeps its last ten and is not mangled', () => {
  // Everything here is Texas, so the last ten is the comparable part. This is
  // documented rather than clever: a genuinely foreign number would collide
  // only with another sharing its final ten digits.
  assert.strictEqual(sv.normalizeNumber('+44 20 7946 0958'), '2079460958');
});
t('normalisation is stable — running it twice changes nothing', () => {
  const once = sv.normalizeNumber('+1 (512) 673-9783');
  assert.strictEqual(sv.normalizeNumber(once), once);
});

console.log('\nit is wired into the archive, not just defined');
const fs = require('fs');
const path = require('path');
const routes = fs.readFileSync(path.join(__dirname, '..', 'metric-routes.js'), 'utf8');
t('the nightly archive stores the number', () => {
  const i = routes.indexOf('async function archiveCallsForDate(');
  assert.ok(i > 0, 'archiveCallsForDate is gone — update this test');
  assert.ok(/counterparty_number: simplevoip\.counterpartyNumber\(c\)/.test(routes.slice(i, i + 2200)),
    'the archive writes rows without the counterparty number again');
});
t('the numbers-only fill does not re-fetch transcripts', () => {
  // The point of that path is one CDR listing per roster user and nothing else;
  // re-running the full archive would be one API call per call on top.
  const i = routes.indexOf('async function fillNumbersForDate(');
  assert.ok(i > 0, 'fillNumbersForDate is gone — update this test');
  const body = routes.slice(i, i + 1400);
  assert.ok(!/fetchCallTranscript/.test(body),
    'the numbers-only fill fetches transcripts, which is what it exists to avoid');
  assert.ok(/\.update\(\{ counterparty_number/.test(body),
    'it no longer updates only the number column');
});

console.log(`\n${pass} passing`);
