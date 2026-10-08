const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SV = require('../lib/simplevoip-mail.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const msg = (addr, extra) => Object.assign({
  id: 'm' + Math.random(), subject: 's', receivedDateTime: '2026-10-01T12:00:00Z',
  from: { emailAddress: { address: addr } },
}, extra || {});

console.log('simplevoip mail consolidation');

// ---- which sender counts -------------------------------------------------
t('the real senders match', () => {
  ['noreply@simplevoip.com', 'marketing@simplevoip.com', 'support@simplevoip.com',
   'billing@SimpleVoip.com', '  Help@simplevoip.com  '].forEach(a =>
    assert.ok(SV.isDomainSender(a), a + ' should match'));
});

t('a LOOKALIKE domain does not match — this is why it is endsWith, not includes', () => {
  ['noreply@simplevoip.com.example.net', 'billing@notsimplevoip.com.ru',
   'x@simplevoip.co', 'simplevoip.com@gmail.com'].forEach(a =>
    assert.ok(!SV.isDomainSender(a), a + ' must NOT match'));
});

t('an empty or missing sender does not match and does not throw', () => {
  [undefined, null, '', '   '].forEach(a => assert.strictEqual(SV.isDomainSender(a), false));
  assert.strictEqual(SV.senderOf({}), '');
  assert.strictEqual(SV.senderOf(null), '');
});

// ---- which folders get read ----------------------------------------------
const FOLDERS = [
  { id: 'tgt', displayName: 'Simple VOIP', totalItemCount: 0 },
  { id: 'src', displayName: 'Simple Voip Daily Report', totalItemCount: 95 },
  { id: 'arc', displayName: 'Archive', totalItemCount: 29236 },
  { id: 'snt', displayName: 'Sent Items', totalItemCount: 18401 },
  { id: 'drf', displayName: 'Drafts', totalItemCount: 21 },
  { id: 'del', displayName: 'Deleted Items', totalItemCount: 2398 },
  { id: 'jnk', displayName: 'Junk Email', totalItemCount: 325 },
  { id: 'rec', displayName: 'Recovered Deleted Items (Oct 1)', totalItemCount: 80333 },
  { id: 'inb', displayName: 'Inbox', totalItemCount: 1 },
  { id: 'fin', displayName: 'Financial', totalItemCount: 33 },
  { id: 'emp', displayName: 'Banking', totalItemCount: 0 },
];
const scanIds = o => SV.foldersToScan(FOLDERS, Object.assign({ targetId: 'tgt', sourceId: 'src' }, o))
  .scan.map(f => f.id);

t('the target and the source folder are not scanned for strays', () => {
  const ids = scanIds();
  assert.ok(!ids.includes('tgt'));
  assert.ok(!ids.includes('src'));
});

t("Lyndsay's own mail and her already-made decisions are never read", () => {
  const ids = scanIds();
  ['snt', 'drf', 'del', 'jnk', 'rec'].forEach(id =>
    assert.ok(!ids.includes(id), id + ' must not be scanned'));
});

t('Archive is excluded by default', () => {
  assert.ok(!scanIds().includes('arc'));
  const sk = SV.foldersToScan(FOLDERS, { targetId: 'tgt', sourceId: 'src' }).skipped;
  assert.ok(sk.some(x => x.folder === 'Archive' && /includeArchive/.test(x.why)),
    'the dry run must say HOW to include it');
});

t('Archive is included on request — excluded, not protected', () => {
  assert.ok(scanIds({ includeArchive: true }).includes('arc'));
});

t('includeArchive does not unlock the protected folders too', () => {
  const ids = scanIds({ includeArchive: true });
  ['snt', 'drf', 'del', 'jnk', 'rec'].forEach(id =>
    assert.ok(!ids.includes(id), id + ' escaped protection via includeArchive'));
});

t('an empty folder is not searched', () => {
  assert.ok(!scanIds().includes('emp'));
});

t('ordinary folders ARE searched', () => {
  const ids = scanIds();
  assert.ok(ids.includes('inb'));
  assert.ok(ids.includes('fin'));
});

// ---- the search is re-checked -------------------------------------------
t("Graph's relevance search is filtered down to real matches", () => {
  const { kept, discarded } = SV.keepRealHits([
    msg('noreply@simplevoip.com'),
    msg('someone@elsewhere.com'),                 // search matched the body, not the sender
    msg('billing@simplevoip.com.attacker.net'),   // lookalike
  ]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(discarded.length, 2);
  assert.strictEqual(SV.senderOf(kept[0].message), 'noreply@simplevoip.com');
});

// ---- the support ticket, which no single test catches on its own ---------
t('support tickets come from .us, and that is not a typo', () => {
  assert.ok(SV.isDomainSender('support@simplevoip.us'));
  assert.ok(SV.isDomainSender('tickets@SimpleVoip.US'));
  assert.ok(!SV.isDomainSender('support@simplevoip.us.example.net'), 'lookalike .us');
});

t("Jay's replies carry an INTERNAL address and are caught by subject", () => {
  // The whole reason a subject rule exists: no sender test can see a reply
  // sent from admin@metricpropertymanagement.com, and the ticket thread would
  // end up split across two folders.
  const jay = msg('admin@metricpropertymanagement.com',
    { subject: 'Re: [SimpleVoIP Support] SV#66134 — call recording gap' });
  assert.strictEqual(SV.isDomainSender(SV.senderOf(jay)), false);
  assert.strictEqual(SV.matchReason(jay), 'subject says SimpleVoIP');
});

t('the subject test is case-insensitive and matches the bare word', () => {
  ['[SimpleVoIP Support] SV#66134', 'simplevoip outage', 'RE: SIMPLEVOIP billing']
    .forEach(sub => assert.ok(SV.isSubjectMatch(sub), sub));
  // "Simple Voip" with a space is the old FOLDER name, not the product string
  // the ticket system emits — it is not a subject match.
  ['Simple Voip daily report', 'voip issues', ''].forEach(sub =>
    assert.strictEqual(SV.isSubjectMatch(sub), false, 'unexpectedly matched: ' + sub));
});

t('the reason names which test caught a message, so a surprise is explainable', () => {
  assert.strictEqual(SV.matchReason(msg('noreply@simplevoip.com')), 'sender simplevoip.com');
  assert.strictEqual(SV.matchReason(msg('support@simplevoip.us')), 'sender simplevoip.us');
  assert.strictEqual(SV.matchReason(msg('a@b.com', { subject: 'about SimpleVoIP' })), 'subject says SimpleVoIP');
  assert.strictEqual(SV.matchReason(msg('a@b.com', { subject: 'unrelated' })), null);
});

t('a sender match wins over the subject, so the reason is the stronger one', () => {
  assert.strictEqual(
    SV.matchReason(msg('support@simplevoip.us', { subject: '[SimpleVoIP Support] SV#66134' })),
    'sender simplevoip.us');
});

t('the three searches are issued separately, and all three are re-checked', () => {
  assert.deepStrictEqual(SV.searchTerms(),
    ['"from:@simplevoip.com"', '"from:@simplevoip.us"', '"subject:SimpleVoIP"']);
});

t('summarizeReasons counts how each message was caught', () => {
  const plan = [
    { why: 'sender simplevoip.com' },
    { why: 'sender simplevoip.us' },
    { why: 'subject says SimpleVoIP' },
    { why: 'subject says SimpleVoIP' },
  ];
  assert.deepStrictEqual(SV.summarizeReasons(plan),
    { 'sender simplevoip.com': 1, 'sender simplevoip.us': 1, 'subject says SimpleVoIP': 2 });
});

t('an empty search result is not an error', () => {
  assert.deepStrictEqual(SV.keepRealHits([]), { kept: [], discarded: [] });
  assert.deepStrictEqual(SV.keepRealHits(null), { kept: [], discarded: [] });
});

// ---- the dry-run report --------------------------------------------------
t('the summary counts by folder and by sender, and dates the range', () => {
  const plan = [
    SV.planRow(msg('noreply@simplevoip.com', { receivedDateTime: '2026-07-01T00:00:00Z' }), 'Simple Voip Daily Report', 'whole folder'),
    SV.planRow(msg('noreply@simplevoip.com', { receivedDateTime: '2026-10-08T00:00:00Z' }), 'Simple Voip Daily Report', 'whole folder'),
    SV.planRow(msg('support@simplevoip.com', { receivedDateTime: '2026-09-01T00:00:00Z' }), 'Financial', 'sender @simplevoip.com'),
  ];
  const s = SV.summarize(plan);
  assert.strictEqual(s.total, 3);
  assert.deepStrictEqual(s.byFolder, { 'Simple Voip Daily Report': 2, Financial: 1 });
  assert.deepStrictEqual(s.bySender, { 'noreply@simplevoip.com': 2, 'support@simplevoip.com': 1 });
  assert.deepStrictEqual(s.received, { first: '2026-07-01', last: '2026-10-08' });
  assert.strictEqual(s.sample.length, 3);
});

t('an empty plan summarises to zero rather than throwing', () => {
  const s = SV.summarize([]);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.received, null);
  assert.deepStrictEqual(s.sample, []);
});

// ---- the wiring ----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

t('the route is admin-only and dry-run by default', () => {
  assert.ok(/simplevoip-consolidate', requireAuth, requireRole\('admin'\)/.test(CODE));
  assert.ok(/const write = !!\(req\.body && req\.body\.write === true\)/.test(CODE),
    'write must be opt-in, not the default');
});

t('it moves and never deletes', () => {
  const route = CODE.slice(CODE.indexOf('simplevoip-consolidate'),
    CODE.indexOf("app.get('/api/email/lyndsay/message-rules'"));
  assert.ok(/\/move`/.test(route), 'no move call');
  assert.ok(!/method: 'DELETE'/.test(route), 'the route can delete mail');
});

t('every SimpleVoIP rule files to Simple VOIP, none to Archive', () => {
  const rules = CODE.split('\n').filter(l => /displayName:.*SimpleVoip|displayName:.*SimpleVoIP/.test(l));
  assert.strictEqual(rules.length, 5, 'expected 5 SimpleVoIP rules, found ' + rules.length);
  rules.forEach(r => {
    assert.ok(/folder: 'Simple VOIP'/.test(r), 'still filing elsewhere: ' + r.trim().slice(0, 80));
  });
});

t('there is a .us sender rule and a subject-only rule', () => {
  assert.ok(/senderContains: \['@simplevoip\.us'\]/.test(CODE), 'no .us rule');
  assert.ok(/subjectContains: \['\[SimpleVoIP Support\]', 'SimpleVoIP'\]/.test(CODE), 'no subject rule');
});

t('the subject rule carries NO sender condition — Graph ANDs them', () => {
  // With a sender condition attached it could never fire for the internal
  // replies it exists to catch, and would look correct in a code review.
  const i = CODE.indexOf('SimpleVoIP subject -> Simple VOIP');
  assert.ok(i > 0);
  const block = CODE.slice(i, i + 220);
  assert.ok(!/senderContains/.test(block), 'the subject rule is ANDed with a sender and can never fire');
});

t('the catch-all is pinned to the domain, not a bare substring', () => {
  assert.ok(/senderContains: \['@simplevoip\.com'\]/.test(CODE),
    "the catch-all should match '@simplevoip.com', not 'simplevoip.com'");
});

t('the no-reply rule is defined in exactly ONE array', () => {
  // It used to sit in setup-outlook-rules, which SKIPS rules that already
  // exist — so a destination change there would have silently done nothing.
  const occurrences = (CODE.match(/'SimpleVoip no-reply → Archive'/g) || []).length;
  assert.strictEqual(occurrences, 1, 'defined ' + occurrences + ' times; two definitions is a trap');
  assert.ok(!/moveToFolder: archiveId[\s\S]{0,200}noreply@simplevoip/.test(CODE));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
