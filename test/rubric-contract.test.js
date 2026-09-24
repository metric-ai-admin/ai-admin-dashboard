// The rubric contract: every rule the 2026-09-25 audit restored, asserted
// against the BUILT prompt — the artifact the model actually receives.
//
// This exists because the audit found that rules present in Lyndsay's June 2026
// original had silently vanished from the live rubric, while surviving in a
// duplicate file nobody graded with. Nothing caught it for three months. A
// rubric is a contract; this is the test for it.
const assert = require('assert');
const fs = require('fs');
const p = String(JSON.parse(fs.readFileSync(
  require('path').join(__dirname, '..', 'call-grade-prompt.json'), 'utf8')));
// Collapse whitespace on BOTH sides: the rubric is wrapped prose, so a probe
// that spans a line break is a false negative about formatting, not content.
const flat = t => String(t).replace(/\s+/g, ' ').toLowerCase();
const lc = flat(p);
const has = t => lc.includes(flat(t));

let pass = 0, bad = 0;
const check = (label, probes) => {
  const ok = probes.every(has);
  if (ok) pass++; else bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) probes.filter(t => !has(t)).forEach(t => console.log(`          missing: "${t}"`));
};

console.log('1  ASR TOLERANCE');
check('whisper notes, verbatim', ['"Metrics" vs "Metric"', 'assess" for "assist', 'verify on playback']);
check('name mishears', ['name mishears']);
check('scoped: missing is still a miss', ['covers text that is garbled, not text that is missing']);

console.log('\n2  THE NINE STANDUP DECISIONS');
check('brief pause is not a hold', ['A BRIEF PAUSE IS NOT A HOLD']);
check('Erick need not read the WO number', ['does NOT have to read the work-order NUMBER']);
check('vendor solicitation: polite, message, end', ['Took a message, or directed them to the right channel', 'Ended the call promptly']);
check('re-transfer needs no second script', ['RE-TRANSFERS NEED NO SECOND SCRIPT']);
check('Danny non-resident routing + AppFolio activity', ['NON-RESIDENT CALLING ABOUT A RESIDENT', 'AppFolio activity for Bekah']);
check('translation: grade the working language', ['grade ONLY the language the agent actually conducted business in']);
check('invoice calls need no follow-up email', ['No follow-up email offer is required']);
check('outbound vendor needs no closing question', ['No closing question is required']);
check('Erick WO flag is an exception', ['exception a resident may ask for, not the standard']);

console.log('\n3  COMPLIANCE ITEMS');
check('PTP = specific date AND amount', ['an exact date AND an exact amount', 'Tuesday the 14th']);
check('call hours compliance', ['CALL HOURS COMPLIANCE', '8:00 AM and 9:00 PM']);
check('credit bureau as a requirement', ['Explained the credit bureau impact']);
check('7-day deadline', ['7 days unless a different date was agreed']);
check('leasing: live availability + self-serve', ['it carries live availability', 'Encouraged self-serve']);
check('applicant: income + ID + fee, all adults', ['proof of income, photo ID, and the application fee', 'EVERY adult']);

console.log('\n4-5  CALL TYPES AND RUBRICS');
check('Move-in Coordination call type', ['**MOVE-IN COORDINATION**']);
check('Rubric J exists', ['RUBRIC J — MOVE-IN COORDINATION']);
check('Vendor call type, split from BD', ['**VENDOR** —', 'Vendors are NOT business']);
check('Rubric K exists', ['RUBRIC K — VENDOR CALL']);
check('Rubric H excludes vendors', ['VENDORS ARE NOT BUSINESS DEVELOPMENT']);

console.log('\n6  TERMINOLOGY');
check('never "listing department"', ['NEVER "listing department"', 'leasing department" or "leasing team']);

console.log('\nUNTOUCHED (must be unchanged)');
const c4c = p.slice(p.indexOf('### 4C'), p.indexOf('### 4D'));
console.log(`  ${c4c.length ? 'ok  ' : 'FAIL'}  §4C closing section still present (${c4c.length} chars)`);
console.log(`  ${/RUBRIC A[\s\S]*RUBRIC K/.test(p) ? 'ok  ' : 'FAIL'}  rubrics A through K all present`);
console.log(`  ${has('## STEP 0 — HARD GATES') ? 'ok  ' : 'FAIL'}  STEP 0 hard gates injected exactly once (${(p.match(/## STEP 0/g) || []).length})`);
console.log(`  ${has('Respond with ONE valid JSON object') ? 'ok  ' : 'FAIL'}  STEP 10 is the JSON contract, not the authored block`);
console.log(`  ${!has('Note for the build') ? 'ok  ' : 'FAIL'}  authored Step 10 was swapped out`);

// An assertion, not a printed warning: this has to FAIL the suite, because the
// failure mode it guards is a rule quietly disappearing and nobody noticing.
assert.strictEqual(bad, 0, `${bad} rubric rule(s) missing from the built prompt`);
console.log(`\n${pass} passing — built prompt ${p.length} chars`);
