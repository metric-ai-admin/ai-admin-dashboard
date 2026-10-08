// "Following" = a follow-up flag, nothing moved and nothing deleted.
//
// The rules are deliberately narrow. The measurement pass on 2026-10-08 showed
// that "eviction", "writ" and "PTO" as loose words return EOD reports, Slab SOP
// mail and vacation advertising — so most of this file is about what must NOT
// be flagged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const FF = require('../lib/follow-flag.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const msg = (subject, extra) => Object.assign({
  id: 'm' + Math.random(), subject,
  from: { emailAddress: { address: 'a@b.com' } },
  receivedDateTime: '2026-09-15T12:00:00Z',
}, extra || {});

console.log('follow-flag');

// ---- 1. court e-filing ---------------------------------------------------
t('it flags the court e-filing acknowledgement, in the shape it really has', () => {
  // Verbatim from the mailbox, 2026-10-08.
  assert.strictEqual(FF.ruleFor(msg(
    'Fw: Filing Submitted for Case: 120519758; ; Envelope Number:  120519758')), 'court-filing');
  assert.strictEqual(FF.ruleFor(msg('Filing Submitted for Case: 120523224')), 'court-filing');
  assert.strictEqual(FF.ruleFor(msg('Notice — Envelope Number: 998877')), 'court-filing');
});

// ---- 2. the AppFolio report ---------------------------------------------
t('it flags the MTD Evictions Filed report', () => {
  assert.strictEqual(FF.ruleFor(msg('MTD Evictions Filed')), 'mtd-evictions');
  assert.strictEqual(FF.ruleFor(msg('Your report: MTD Evictions Filed — October')), 'mtd-evictions');
});

// ---- 3. leave requests ---------------------------------------------------
t('it flags a leave request, which needs BOTH halves', () => {
  assert.strictEqual(FF.ruleFor(msg('Leave | Leave Request — Oct 20-24')), 'leave-request');
  assert.strictEqual(FF.ruleFor(msg('leave |  leave request for November')), 'leave-request');
});

t('the "Leave |" prefix alone is not a request', () => {
  // Otherwise a policy note or an FYI on the same prefix gets followed as
  // though somebody had asked for days off.
  ['Leave | Policy update', 'Leave | FYI holiday calendar', 'Leave | reminder']
    .forEach(s => assert.strictEqual(FF.ruleFor(msg(s)), null, s));
});

t('the words alone, without the prefix, are not a request either', () => {
  assert.strictEqual(FF.ruleFor(msg('Re: leave request policy discussion')), null);
  assert.strictEqual(FF.ruleFor(msg('FW: leave request from a vendor')), null);
});

// ---- what must NOT be flagged -------------------------------------------
t('the loose words that the measurement pass rejected stay rejected', () => {
  [
    'EOD REPORT — Tuesday, October 6, 2026',          // mentions evictions daily
    'Re: EOD REPORT — Tuesday, October 6, 2026',
    'End of Day Report — AI Admin & Operations | 10/07/2026',
    'Writ of possession discussion',                  // a word, not the court's mail
    'Eviction process SOP',                           // Slab SOP mail
    'PTO balance report',
    'Vacation rentals near Austin — 50% off',
    'Underwriting review',
    'Please find the written notice attached',
    'Annual franchise tax filing due',                // "filing" without the case
    'Insurance claim filing deadline',
  ].forEach(s => assert.strictEqual(FF.ruleFor(msg(s)), null, 'wrongly flagged: ' + s));
});

t('"filing" needs the case, and "envelope" needs the number', () => {
  assert.strictEqual(FF.ruleFor(msg('Filing submitted yesterday')), null);
  assert.strictEqual(FF.ruleFor(msg('Envelope for the new signage')), null);
});

t('an empty or missing subject does not throw', () => {
  [undefined, null, ''].forEach(s => assert.strictEqual(FF.ruleFor(msg(s)), null));
  assert.strictEqual(FF.ruleFor({}), null);
});

t('there are exactly three rules — no fourth crept in', () => {
  assert.deepStrictEqual(FF.RULES.map(r => r.key),
    ['court-filing', 'mtd-evictions', 'leave-request']);
});

// ---- already-flagged mail ------------------------------------------------
t('a message that is already flagged is left alone', () => {
  assert.ok(FF.isFlagged({ flag: { flagStatus: 'flagged' } }));
  assert.ok(!FF.isFlagged({ flag: { flagStatus: 'notFlagged' } }));
  assert.ok(!FF.isFlagged({ flag: { flagStatus: 'complete' } }), 'a completed flag is not re-flagged open');
  assert.ok(!FF.isFlagged({}));
  const a = FF.plan([
    msg('Filing Submitted for Case: 1', { flag: { flagStatus: 'flagged' } }),
    msg('Filing Submitted for Case: 2'),
  ], 'Legal / Lawsuits');
  assert.strictEqual(a.alreadyFlagged, 1);
  assert.strictEqual(a.toFlag.length, 1, 'it would re-write a flag that is already set');
});

// ---- the dry-run detail --------------------------------------------------
t('the plan reports per rule, per folder, and every subject', () => {
  const a = FF.plan([
    msg('Filing Submitted for Case: 120519758'),
    msg('MTD Evictions Filed'),
    msg('Leave | Leave Request — Oct 20'),
    msg('Nothing to see'),
  ], 'Legal / Lawsuits');
  assert.strictEqual(a.scanned, 4);
  assert.strictEqual(a.toFlag.length, 3);
  assert.deepStrictEqual(a.byRule, { 'court-filing': 1, 'mtd-evictions': 1, 'leave-request': 1 });
  assert.strictEqual(a.byFolder['court-filing / Legal / Lawsuits'], 1);
  // Every subject, not a sample: three narrow rules over ninety days is a
  // short list, and reading it is the point of the dry run.
  assert.strictEqual(a.subjects['court-filing'].length, 1);
  assert.ok(a.subjects['court-filing'][0].includes('120519758'));
});

t('the plan accumulates across folders', () => {
  let a = FF.plan([msg('MTD Evictions Filed')], 'A');
  a = FF.plan([msg('MTD Evictions Filed')], 'B', a);
  assert.strictEqual(a.toFlag.length, 2);
  assert.strictEqual(a.byRule['mtd-evictions'], 2);
});

t('a message is followed for ONE reason, not a list', () => {
  const a = FF.plan([msg('MTD Evictions Filed — Envelope Number: 5')], 'X');
  assert.strictEqual(a.toFlag.length, 1);
  assert.strictEqual(a.toFlag[0].rule, 'court-filing');   // first rule wins
});

// ---- the route -----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const run = CODE.slice(CODE.indexOf('async function followFlagRun'),
  CODE.indexOf("app.get('/api/email/lyndsay/followable-scan'"));

t('it is admin-only and dry-run by default', () => {
  assert.ok(/app\.post\('\/api\/email\/lyndsay\/follow-flag', requireAuth, requireRole\('admin'\)/.test(CODE));
  assert.ok(/write: !!\(req\.body && req\.body\.write === true\)/.test(CODE));
});

t('IT ONLY FLAGS — it cannot move, file, mark read or delete', () => {
  assert.ok(/flag: \{ flagStatus: 'flagged' \}/.test(run), 'it does not set a flag');
  ['/move', 'destinationId', 'moveToFolder', 'markAsRead', 'isRead',
   "method: 'DELETE'", 'copyToFolder', 'forwardTo'].forEach(bad =>
    assert.ok(!run.includes(bad), 'the follow-flag pass does ' + bad));
});

t('it reuses the SimpleVoIP folder exclusions rather than a second copy', () => {
  assert.ok(/SV\.PROTECTED\.has\(name\)/.test(run));
  assert.ok(/includeArchive/.test(run));
});

t('it returns the ids it flagged, so a wrong call can be walked back', () => {
  assert.ok(/flaggedIds: acc\.toFlag\.map/.test(run));
});

t('the daily pass is OFF unless FOLLOW_FLAG_ENABLED is set', () => {
  // It writes to Lyndsay's mailbox on a schedule. A standing automation that
  // starts itself on deploy, before anyone has read the dry run, is how three
  // months of mail gets flagged overnight.
  assert.ok(/process\.env\.FOLLOW_FLAG_ENABLED !== '1'\) return;/.test(CODE),
    'the cron is not gated');
  const cronIdx = CODE.indexOf("cron.schedule('30 6 * * *'");
  assert.ok(cronIdx > 0, 'no daily pass');
  const block = CODE.slice(cronIdx, cronIdx + 420);
  assert.ok(/days: 3, write: true/.test(block),
    'the daily pass should use a short overlapping window, not the full 90 days');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
