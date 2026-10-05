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

console.log('the migration');
t('inquiry_id is the primary key', () => {
  // Probed live 2026-10-05: 524 rows, 524 distinct inquiry_id, against 479
  // distinct guest_card_uuid. The uuid is the card grain and the bug.
  assert.ok(/inquiry_id\s+bigint primary key/.test(sql), 'the key is not inquiry_id');
  assert.ok(!/guest_card_uuid\s+text primary key/.test(sql), 'keyed on the card again');
});
t('it carries every column that was approved', () => {
  ['guest_card_uuid', 'guest_card_id', 'property', 'property_id', 'interest_received',
    'first_contact_date', 'source', 'lead_type', 'status', 'inquiry_type',
    'interests_received_in_range', 'total_interests_received', 'showings',
    'follow_ups', 'last_activity_date', 'synced_at',
  ].forEach(c => assert.ok(new RegExp('\\n  ' + c + '\\s').test(sql), 'missing column: ' + c));
});
t('it carries no resident contact details', () => {
  // The interest grain does not need them, and copying PII into a second table
  // to use as a join key is not worth it.
  assert.ok(!/\n  (name|email|phone)\s/.test(sql), 'resident PII was added to the table');
});
t('the timestamps are timestamptz, since the API sends times', () => {
  // first_contact_date comes back as "2026-07-06T14:04:04Z". Storing it as a
  // date would force a timezone decision on write instead of on read.
  assert.ok(/first_contact_date\s+timestamptz/.test(sql));
  assert.ok(/interest_received\s+timestamptz not null/.test(sql));
});

console.log('\nthe sync writes interests without touching leads');
t('leasing_leads keeps its key and its filter', () => {
  assert.ok(/onConflict: 'appfolio_id'/.test(code), 'the leads upsert key changed');
  assert.ok(/appfolio_id: uuid \|\|/.test(code), 'the leads identity rule changed');
});
t('interests are written from raw, not from the deduped rows', () => {
  // `kept` has already been collapsed onto guest_card_uuid and filtered to the
  // week — exactly the collapse this table exists to undo.
  const i = code.indexOf("from('leasing_lead_interests')");
  assert.ok(i > 0, 'nothing writes the table');
  const block = code.slice(code.indexOf('let interests = 0'), i + 200);
  assert.ok(/for \(const r of raw\)/.test(block), 'it writes from the deduped set');
  assert.ok(!/of kept\b/.test(block), 'it writes from `kept`');
});
t('it upserts on inquiry_id', () => {
  assert.ok(/onConflict: 'inquiry_id'/.test(code));
});
t('a missing table does not fail the leads sync', () => {
  // The table may not exist yet, and the leads sync succeeding must not depend
  // on this one.
  const i = code.indexOf('let interests = 0');
  const block = code.slice(i, code.indexOf('res.json({ ok: true, synced', i));
  assert.ok(/catch \(e\)/.test(block), 'a missing table takes the whole sync down');
  assert.ok(/interestsError = e\.message/.test(block), 'the failure is swallowed');
  assert.ok(/interests, interestsError/.test(code),
    '"0 interests" would be indistinguishable from "nothing to write"');
});
t('the interests write comes AFTER the leads upsert', () => {
  assert.ok(code.indexOf("onConflict: 'appfolio_id'") < code.indexOf("from('leasing_lead_interests')"),
    'the additive write runs before the one it must not affect');
});
t('a row with no id or no date is dropped, not invented', () => {
  const i = code.indexOf('function leasingInterestFromReport');
  const body = code.slice(i, i + 1400);
  assert.ok(/if \(inq == null \|\| !uuid \|\| !received\) return null;/.test(body),
    'a row without a key would be written anyway');
  assert.ok(/if \(!receivedIso\) return null;/.test(body), 'an unparseable date becomes null and the row is kept');
});
t('it reads property straight off the row', () => {
  // Not through APPFOLIO_LEASING_FIELDS.property, which points at a field this
  // report does not return.
  const i = code.indexOf('function leasingInterestFromReport');
  const body = code.slice(i, i + 1600);
  assert.ok(/property: leasingVal\(r, 'property'\)/.test(body));
  assert.ok(/property_id: int\(leasingVal\(r, 'property_id'\)\)/.test(body));
});

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
const rows = (spec) => spec.map((s, i) => ({
  guest_card_uuid: s[0], property: s[1], interest_received: s[2] || '2026-09-29T10:00:00Z',
}));
t('two interests from one card at one property are one lead', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 9315 Northgate Blvd'],
    ['card-a', 'Ascent at Northgate - 9315 Northgate Blvd'],
    ['card-b', 'Ascent at Northgate - 9315 Northgate Blvd'],
  ]), W, E);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 2, 'interests are counted raw');
});
t('the two iConics share one dedupe bucket', () => {
  // Her canonicalProperty returns the literal 'Round Rock' for both, so a card
  // that enquired at each counts ONCE.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'iConic Downtown - 1 Main St'],
    ['card-a', 'iConic Round Rock - 2 Main St'],
  ]), W, E);
  const total = Object.values(r).reduce((t2, b) => t2 + (b.leadsByInterest || 0), 0);
  assert.strictEqual(total, 1, 'the iConic pair is deduped separately');
});
t('but the count stays on the real property, not on Round Rock', () => {
  // The dedupe bucket is hers; the attribution is ours, so the two iConic tabs
  // keep their own numbers.
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'iConic Downtown - 1 Main St'],
    ['card-b', 'iConic Round Rock - 2 Main St'],
  ]), W, E);
  assert.strictEqual(r['iConic Downtown'].leadsByInterest, 1);
  assert.strictEqual(r['iConic Round Rock'].leadsByInterest, 1);
  assert.ok(!r['Round Rock'], 'a roll-up bucket swallowed the real properties');
});
t('the same card at two different properties counts twice', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St'],
    ['card-a', 'Sunset Palms - 2 Main St'],
  ]), W, E);
  assert.strictEqual(r['Ascent at Northgate'].leadsByInterest, 1);
  assert.strictEqual(r['Sunset Palms'].leadsByInterest, 1);
});
t('interests outside the week do not count', () => {
  const r = K.leadsByInterestFrom(rows([
    ['card-a', 'Ascent at Northgate - 1 Main St', '2026-09-20T10:00:00Z'],
  ]), W, E);
  assert.ok(!r['Ascent at Northgate'] || !r['Ascent at Northgate'].leadsByInterest);
});
t('it survives build() instead of being dropped by METRICS', () => {
  const o = K.build({ leadInterests: rows([['card-a', 'Ascent at Northgate - 1 Main St']]) },
    { weekStart: W, weekEnd: E, asOf: E });
  assert.strictEqual(o.byProperty['Ascent at Northgate'].leadsByInterest, 1,
    'computed and then thrown away');
});
t('the other two readings of leads still exist', () => {
  // Three questions, three numbers: interests deduped (hers), guest cards by
  // interest date, guest cards by first contact (Traffic / the Goal Board).
  ['leads', 'leadsByFirstContact', 'leadsByInterest'].forEach(m =>
    assert.ok(K.METRICS.indexOf(m) !== -1, m + ' is not in METRICS'));
});

console.log(`\n${pass} passing`);
