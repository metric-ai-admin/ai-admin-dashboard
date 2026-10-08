// The measurement pass for "following" evictions, writs and time-off requests.
//
// It counts and does nothing else, so what is worth testing is whether the
// keywords catch what they claim and — more importantly — what they catch by
// accident. Every "must NOT match" below is a real shape of mail that would
// have ended up on Lyndsay's list.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const FS = require('../lib/followable-scan.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const msg = (subject, from, extra) => Object.assign({
  id: 'm' + Math.random(), subject,
  from: { emailAddress: { address: from || 'someone@example.com' } },
  receivedDateTime: '2026-09-15T12:00:00Z',
}, extra || {});
const topicsOf = m => FS.classify(m).map(h => h.topic);

console.log('followable scan (measurement only)');

// ---- evictions -----------------------------------------------------------
t('it catches the eviction mail it is meant to', () => {
  ['Eviction filing — Unit 214', 'Forcible Detainer hearing set',
   'J.P. Court docket for Tuesday', 'Default judgment entered',
   'RE: evicting the tenant in 3B'].forEach(s =>
    assert.deepStrictEqual(topicsOf(msg(s)), ['evictions'], s));
});

t('"filing" alone is NOT an eviction — it needs eviction context', () => {
  // Measured with a requirement precisely because the bare word appears in
  // tax, insurance and corporate mail every month.
  assert.deepStrictEqual(topicsOf(msg('Annual franchise tax filing due')), []);
  assert.deepStrictEqual(topicsOf(msg('Insurance claim filing deadline')), []);
  const hit = FS.classify(msg('Eviction filing — Unit 214'))[0];
  assert.ok(hit.terms.includes('filing (with eviction)'), 'the paired term did not fire');
});

t('it catches the court e-filing mail, which says neither eviction nor writ', () => {
  // Measured against the live mailbox on 2026-10-08: searching "eviction"
  // returned 12 messages and NONE had the word in the subject. The only real
  // eviction mail was the e-filing receipt below, which every keyword in
  // Lyndsay's own description would have missed.
  const real = 'Fw: Filing Submitted for Case: 120519758; ; Envelope Number:  120519758';
  assert.deepStrictEqual(topicsOf(msg(real, 'lyndsay@metricpropertymanagement.com')), ['evictions']);
  const hit = FS.classify(msg(real))[0];
  assert.deepStrictEqual(hit.terms, ['court e-filing'],
    'it matched on something other than the e-filing pattern');
});

t('an EOD report that MENTIONS evictions in its body is not a match', () => {
  // The daily EOD mentions evictions and writs every day. Following it would
  // put the report itself on the list and bury everything else.
  ['EOD REPORT — Tuesday, October 6, 2026', 'Re: EOD REPORT — Tuesday, October 6, 2026',
   'End of Day Report — AI Admin & Operations | 10/07/2026'].forEach(s =>
    assert.deepStrictEqual(topicsOf(msg(s)), [], s));
});

// ---- writs ---------------------------------------------------------------
t('it catches writs and lockouts', () => {
  ['Writ of Possession issued', 'writ granted', 'Lockout scheduled Thursday',
   'Lock-out set for 9am', 'Constable will attend'].forEach(s =>
    assert.deepStrictEqual(topicsOf(msg(s)), ['writs'], s));
});

t('"writ" does not match "written", "write" or "rewrite"', () => {
  // The single most likely false positive in the whole list, and a substring
  // test would hit every one of these.
  ['Please find the written notice attached', 'Can you write this up?',
   'Rewrite of the lease addendum', 'Underwriting review'].forEach(s =>
    assert.deepStrictEqual(topicsOf(msg(s)), [], s));
});

// ---- time off ------------------------------------------------------------
t('it catches a time-off request', () => {
  ['Time off request — next Friday', 'PTO request', 'Vacation 10/20-10/24',
   'Taking a day off Monday', 'Sick leave today', 'Leave request for November']
    .forEach(s => assert.deepStrictEqual(topicsOf(msg(s, 'kara@metricpropertymanagement.com')), ['timeoff'], s));
});

t('PTO is case-SENSITIVE, so it does not fire on fragments', () => {
  assert.deepStrictEqual(topicsOf(msg('PTO balance', 'a@metricpropertymanagement.com')), ['timeoff']);
  assert.deepStrictEqual(topicsOf(msg('Your pto.example.com account')), []);
});

t('an external sender is still counted, but reported separately', () => {
  // The rule is NOT applied silently — the report shows both numbers so the
  // cost of restricting to internal senders is visible.
  const ext = FS.classify(msg('Vacation rentals near Austin — 50% off', 'deals@travel.example'))[0];
  assert.strictEqual(ext.topic, 'timeoff');
  assert.strictEqual(ext.internal, false);
  assert.strictEqual(ext.wouldCountInternalOnly, false, 'an advert would be counted as a request');

  const int = FS.classify(msg('Vacation 10/20', 'rocio@metricpropertymanagement.com'))[0];
  assert.strictEqual(int.wouldCountInternalOnly, true);
});

t('internal means a Metric address, by domain', () => {
  assert.ok(FS.isInternal('jay@metricpropertymanagement.com'));
  assert.ok(FS.isInternal('support@livewithmetric.com'));
  assert.ok(!FS.isInternal('someone@metricpropertymanagement.com.example.net'), 'lookalike domain');
  assert.ok(!FS.isInternal('zach@elsewhere.com'));
  assert.ok(!FS.isInternal(''));
});

// ---- the shape of the result --------------------------------------------
t('a message can hit two topics and both are reported', () => {
  const hits = FS.classify(msg('Eviction — writ of possession granted'));
  assert.deepStrictEqual(hits.map(h => h.topic).sort(), ['evictions', 'writs']);
});

t('an unrelated subject matches nothing', () => {
  ['Invoice from SimpleVoIP', 'Weekly Leasing Goal Board',
   'End of Day Report', 'Re: Rebrand Review'].forEach(s =>
    assert.deepStrictEqual(topicsOf(msg(s)), [], s));
});

t('a missing or empty subject does not throw', () => {
  [undefined, null, ''].forEach(s => assert.deepStrictEqual(FS.classify(msg(s)), []));
  assert.deepStrictEqual(FS.classify({}), []);
});

t('the tally counts per term, per folder and per sender', () => {
  const a = FS.tally([
    msg('Eviction filing — Unit 214', 'legal@lawfirm.example'),
    msg('Writ of possession granted', 'legal@lawfirm.example'),
    msg('PTO request', 'kara@metricpropertymanagement.com'),
    msg('Vacation rentals — 50% off', 'deals@travel.example'),
    msg('Nothing to see here', 'a@b.com'),
  ], 'Legal / Lawsuits');
  assert.strictEqual(a.scanned, 5);
  assert.deepStrictEqual(a.byTopic, { evictions: 1, writs: 1, timeoff: 2 });
  // The internal-only rule halves the time-off count — which is the number
  // that decides whether the rule is worth having.
  assert.strictEqual(a.internalOnly.timeoff, 1);
  assert.strictEqual(a.byTerm['evictions / eviction'], 1);
  assert.strictEqual(a.byTerm['writs / writ of possession'], 1);
  assert.strictEqual(a.byFolder['evictions / Legal / Lawsuits'], 1);
  assert.strictEqual(a.bySender['timeoff / kara@metricpropertymanagement.com'], 1);
});

t('samples are capped so the report is not a dump of resident names', () => {
  const many = Array.from({ length: 30 }, (_, i) => msg('Eviction notice ' + i));
  const a = FS.tally(many, 'Legal / Lawsuits');
  assert.strictEqual(a.byTopic.evictions, 30);
  assert.strictEqual(a.samples.evictions.length, 5);
});

t('tally accumulates across folders', () => {
  let a = FS.tally([msg('Eviction filing')], 'A');
  a = FS.tally([msg('Eviction filing')], 'B', a);
  assert.strictEqual(a.byTopic.evictions, 2);
  assert.strictEqual(a.byFolder['evictions / A'], 1);
  assert.strictEqual(a.byFolder['evictions / B'], 1);
});

// ---- the route -----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const route = CODE.slice(CODE.indexOf("followable-scan'"), CODE.indexOf("app.get('/api/email/lyndsay/message-rules'"));

t('the route is admin-only and is a GET', () => {
  assert.ok(/app\.get\('\/api\/email\/lyndsay\/followable-scan', requireAuth, requireRole\('admin'\)/.test(CODE));
});

t('it writes absolutely nothing', () => {
  ['/move', 'method: \'POST\'', 'method: \'PATCH\'', 'method: \'DELETE\'',
   '.insert(', '.upsert(', '.update(', '.delete('].forEach(bad =>
    assert.ok(!route.includes(bad), 'the measurement pass does ' + bad));
});

t('it reads subjects, not bodies', () => {
  assert.ok(/\$select=id,subject,from,receivedDateTime,sentDateTime/.test(route));
  assert.ok(!/\$search/.test(route), 'a $search would match on body content');
  assert.ok(!/bodyPreview|,body/.test(route));
});

t('Sent Items IS read here — a reply is part of the thread being followed', () => {
  assert.ok(/'sent items'\) return true/.test(route));
  assert.ok(/sentDateTime/.test(route), 'Sent Items must be dated by sentDateTime');
});

t('the protected folders are still skipped', () => {
  assert.ok(/SV\.PROTECTED\.has\(name\)/.test(route),
    'it should reuse the same protected-folder list, not invent a second one');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
