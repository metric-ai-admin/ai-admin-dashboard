// Tests for the vendor/third-party pre-grade filter.
// Run: node test/vendor-prefilter.test.js
//
// Mirrors the matcher in server.js (vendorPrefilterMatch). The terms themselves
// were each measured at zero false positives against 1,177 graded calls on
// 2026-09-22; these tests guard the MATCHING, which is where an earlier draft
// went wrong by using substring matching.

const assert = require('assert');

const TERMS = ['republic services', 'panthera', 'yardimatrix', 'yardi matrix', 'chariot energy',
  'blink charging', 'austin window works', 'delvin electrical', 'iowa electrical',
  'amazing auto repair', 'argus verify', 'roadrunner', 'thunder solutions', 'hd supply', 'ferguson'];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = TERMS.map(t => new RegExp('\\b' + esc(t) + '\\b', 'i'));
const match = (transcript, caller) => {
  const hay = String(transcript || '') + '\n' + String(caller || '');
  for (let i = 0; i < RX.length; i++) if (RX[i].test(hay)) return TERMS[i];
  return null;
};

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('\nMatches vendors');
t('vendor named in the transcript', () => assert.strictEqual(match('Hi, this is Republic Services about the pickup schedule', ''), 'republic services'));
t('vendor in the caller field', () => assert.strictEqual(match('', 'Ferguson'), 'ferguson'));
t('returns the term, for logging and traceability', () => assert.strictEqual(match('we use Blink Charging for the EV stalls', ''), 'blink charging'));
t('case insensitive', () => assert.strictEqual(match('CHARIOT ENERGY calling', ''), 'chariot energy'));

console.log('\nWord boundaries — the bug that nearly shipped');
t('does not match inside another word', () => {
  // An earlier draft used substring matching and hit "orkin" inside "working",
  // which would have skipped maintenance calls about broken appliances.
  assert.strictEqual(match('the stove is not working right now', ''), null);
  assert.strictEqual(match('I was rampaging through the paperwork', ''), null);
  assert.strictEqual(match('she is a roadrunners fan', ''), null, 'plural should not match');
});

console.log('\nDoes NOT skip real resident calls');
t('a prospect naming a listing site', () => {
  // Apartments.com and Zillow are deliberately absent: they caught 3 real
  // leasing calls between them, which is exactly what the rubric grades.
  assert.strictEqual(match('Hi, I saw your listing on Zillow and wanted a tour', ''), null);
  assert.strictEqual(match('found you on Apartments.com, is the two-bed available', ''), null);
});
t('a resident asking about the portal', () => assert.strictEqual(match('I cannot log into the AppFolio portal to pay my rent', ''), null));
t("a resident's own utilities", () => {
  assert.strictEqual(match('my Spectrum router needs somewhere to plug in', ''), null);
  assert.strictEqual(match('los proveedores son AT&T y Spectrum', ''), null);
  assert.strictEqual(match('I found the number on Google', ''), null);
});
t('an anonymous caller is still graded', () => assert.strictEqual(match('hello, I need help with my lease', 'Anonymous'), null));

console.log('\nSafety');
t('null and undefined are safe', () => {
  assert.strictEqual(match(null, null), null);
  assert.strictEqual(match(undefined, undefined), null);
  assert.strictEqual(match('', ''), null);
});
t('an ordinary resident call is untouched', () => {
  assert.strictEqual(match('Thank you for calling Metric Property Management, this is Danny, how can I help?', '5125551234'), null);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
