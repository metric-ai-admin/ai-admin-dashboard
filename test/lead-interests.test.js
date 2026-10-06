// One row per interest (migration 078), and the property mapping that was
// dropping leads in silence.
//
// leasing_leads upserts on guest_card_uuid, one row per CARD, while the report
// is one row per INTEREST — 136 interests became 79 rows for 09/27–10/03.
// Separately, the sync resolved the property from a field the report does not
// return, so a property with no previously-synced rows dropped its own leads
// for ever.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kpi-lyndsay.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
  '078_leasing_lead_interests.sql'), 'utf8');
const W = '2026-09-27', E = '2026-10-03';

// The 078 block that was here — inquiry_id as the key, and the sync writing
// interests out of guest_card_inquiries — is superseded by migration 080 and
// covered by test/lead-interests-sync.test.js.
//
// 078 was built on the wrong report. guest_card_inquiries returns 84 rows for
// 09/27-10/03 where Katie's report has 136, and inquiry_id exists only there.
// Deleting the assertions rather than relaxing them: they described a design
// that is gone, and a test kept passing against a dead design is worse than no
// test at all.
//
// What stays below is the half that is still true — the property mapping fix,
// and leads counted Lyndsay's way.

console.log('\nthe property mapping no longer drops a new property');
t('there is a third step, reading `property`', () => {
  // Step 1 reads property_name, which this report never returns. Step 2 reads
  // a map built only from already-synced rows, so a new property resolves to
  // nothing and drops its own leads for ever.
  const i = code.indexOf('let property = leasingVal(r, F.property);');
  assert.ok(i > 0, 'the resolution chain moved');
  const body = code.slice(i, i + 500);
  assert.ok(/const withAddress = leasingVal\(r, 'property'\);/.test(body),
    'the field that IS on every row is still unused');
  assert.ok(/String\(withAddress\)\.split\(' - '\)\[0\]\.trim\(\)/.test(body),
    'the name is not separated from the address');
});
t('the map is still tried first, so nothing already working changes', () => {
  const i = code.indexOf('let property = leasingVal(r, F.property);');
  const body = code.slice(i, i + 500);
  assert.ok(body.indexOf('propMap[propIdStr]') < body.indexOf("leasingVal(r, 'property')"),
    'the new fallback overrides the existing resolution');
});
t('a row with neither is still excluded', () => {
  const i = code.indexOf('let property = leasingVal(r, F.property);');
  const body = code.slice(i, i + 600);
  assert.ok(/if \(!property\) return null;/.test(body), 'unattributable rows are now kept as Unknown');
});

console.log('\nleads counted her way, from the interest rows');
const rows = (spec) => spec.map(s => ({
  guest_card_uuid: s[0], property: s[1], interest_received: s[2] || '2026-09-29T10:00:00Z',
}));
// The card map the caller joins from leasing_leads on appfolio_id.
const CARDS = {
  'card-a': { phone: '(737) 555-0101', email: 'a@example.com', name: 'Alvarez, Ana' },
  'card-b': { phone: '(737) 555-0202', email: 'b@example.com', name: 'Boyd, Ben' },
  // Same person, two cards, one phone — her key merges them, a uuid key would
  // not. This is the case that makes the rule hers rather than ours.
  'card-c': { phone: '(737) 555-0101', email: 'c@example.com', name: 'Alvarez, A.' },
  // No phone: her chain falls to email.
  'card-d': { phone: '', email: 'd@example.com', name: 'Diaz, Dee' },
  // No phone, no email: falls to name.
  'card-e': { phone: '', email: '', name: 'Escobar, Eve' },
};

t('two interests from one card at one property are one lead', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 9315 Northgate Blvd'],
    ['card-a', 'Ascent at Northgate - 9315 Northgate Blvd'],
    ['card-b', 'Ascent at Northgate - 9315 Northgate Blvd'],
  ]), W, E, CARDS);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 2, 'interests are counted raw');
});
t('her key is phone first — two cards on one phone are ONE lead', () => {
  // The whole reason for joining back to leasing_leads. Keying on
  // guest_card_uuid would call this two leads and miss her number.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St'],
    ['card-c', 'Ascent at Northgate - 1 Main St'],
  ]), W, E, CARDS);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 1,
    'the phone key is not being used');
});
t('no phone falls to email, no email falls to name', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-d', 'Sunset Palms - 1 Main St'],
    ['card-d', 'Sunset Palms - 1 Main St'],
    ['card-e', 'Sunset Palms - 1 Main St'],
    ['card-e', 'Sunset Palms - 1 Main St'],
  ]), W, E, CARDS);
  assert.strictEqual(r['Sunset Palms'].leadsByInterest, 2, 'the fallback chain is wrong');
});
t('an interest with no card falls back to the uuid AND is counted', () => {
  // It has no contact details to key on. The uuid can only ever split one
  // person into more leads, never merge two — and the fallback is reported so
  // it is never silent.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St'],
    ['card-zz', 'Ascent at Northgate - 1 Main St'],
    ['card-zz', 'Ascent at Northgate - 1 Main St'],
  ]), W, E, CARDS);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 2, 'the unmatched card was dropped');
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterestUnmatched, 1,
    'the fallback is not reported');
});
t('a fully matched week reports no fallbacks at all', () => {
  const r = K.leadsByInterestFrom(rows([['card-a', 'Ascent at Northgate - 1 Main St']]), W, E, CARDS);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterestUnmatched, undefined);
});
t('the two iConics share one dedupe bucket', () => {
  // Her canonicalProperty returns the literal 'Round Rock' for both, so a card
  // that enquired at each counts ONCE.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'iConic Downtown - 1 Main St'],
    ['card-a', 'iConic Round Rock - 2 Main St'],
  ]), W, E, CARDS);
  const total = Object.values(r).reduce((t2, b) => t2 + (b.leadsByInterest || 0), 0);
  assert.strictEqual(total, 1, 'the iConic pair is deduped separately');
});
t('but the count stays on the real property, not on Round Rock', () => {
  // The dedupe bucket is hers; the attribution is ours, so the two iConic tabs
  // keep their own numbers.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'iConic Downtown - 1 Main St'],
    ['card-b', 'iConic Round Rock - 2 Main St'],
  ]), W, E, CARDS);
  assert.strictEqual(r['iConic Downtown'].leadsByInterest, 1);
  assert.strictEqual(r['iConic Round Rock'].leadsByInterest, 1);
  assert.ok(!r['Round Rock'], 'a roll-up bucket swallowed the real properties');
});
t('the same card at two different properties counts twice', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St'],
    ['card-a', 'Sunset Palms - 2 Main St'],
  ]), W, E, CARDS);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 1);
  assert.strictEqual(r['Sunset Palms'].leadsByInterest, 1);
});
t('interests outside the week do not count', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St', '2026-09-20T10:00:00Z'],
  ]), W, E, CARDS);
  assert.ok(!r['Ascent at Northgate'] || !r['Ascent at Northgate'].leadsByInterest);
});
t('build() passes the card map through', () => {
  const o = K.build({
    leadInterests: rows([['card-a', 'Ascent at Northgate - 1 Main St'],
      ['card-c', 'Ascent at Northgate - 1 Main St']]),
    leadCards: CARDS,
  }, { weekStart: W, weekEnd: E, asOf: E });
  assert.strictEqual(o.byProperty['Ascent at Northgate'].leadsByInterest, 1,
    'build() drops the card map, so the phone key never applies');
});
t('no card map at all degrades to the uuid, and says so', () => {
  const o = K.build({
    leadInterests: rows([['card-a', 'Ascent at Northgate - 1 Main St'],
      ['card-c', 'Ascent at Northgate - 1 Main St']]),
  }, { weekStart: W, weekEnd: E, asOf: E });
  assert.strictEqual(o.byProperty['Ascent at Northgate'].leadsByInterest, 2);
  assert.strictEqual(o.byProperty['Ascent at Northgate'].leadsByInterestUnmatched, 2,
    'a missing join would silently produce a different number');
});
t('the other two readings of leads still exist', () => {
  // Three questions, three numbers: interests deduped (hers), guest cards by
  // interest date, guest cards by first contact (Traffic / the Goal Board).
  ['leads', 'leadsByFirstContact', 'leadsByInterest'].forEach(m =>
    assert.ok(K.METRICS.indexOf(m) !== -1, m + ' is not in METRICS'));
});

console.log(`\n${pass} passing`);
