// The read-only dry run on /api/leasing/sync.
//
// It exists to answer one question: does the guest_cards report return an id at
// INTEREST level? leasing_leads upserts on appfolio_id = guest_card_uuid, which
// is one row per CARD, so every interest after the first on a card overwrites
// the one before — 136 interests became 79 rows for 09/27–10/03. We only ever
// mapped 18 fields, so the raw response has never been looked at.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROUTE = (() => {
  const i = code.indexOf("app.post('/api/leasing/sync'");
  assert.ok(i > 0, 'the leasing sync route moved');
  const j = code.indexOf('app.post(', i + 10);
  return code.slice(i, j > i ? j : i + 9000);
})();
const DRY = (() => {
  const i = ROUTE.indexOf('if (req.body && req.body.dryRun === true) {');
  assert.ok(i > 0, 'there is no dry run branch');
  const j = ROUTE.indexOf('const db = supabaseAdmin || supabasePublic;', i);
  assert.ok(j > i, 'the dry run branch does not end before the database is resolved');
  return ROUTE.slice(i, j);
})();

console.log('it cannot write');
t('the branch returns before the database is even resolved', () => {
  // Not "it happens not to write" — there is no path from here to a write,
  // because `db` does not exist yet.
  const dbAt = ROUTE.indexOf('const db = supabaseAdmin || supabasePublic;');
  const dryAt = ROUTE.indexOf('if (req.body && req.body.dryRun === true) {');
  assert.ok(dryAt < dbAt, 'the dry run is declared after the database handle');
  assert.ok(/return res\.json\(/.test(DRY), 'it falls through into the sync');
});
t('nothing in the branch mutates anything', () => {
  assert.ok(!/\.upsert\(|\.insert\(|\.update\(|\.delete\(|writeJSON\(/.test(DRY), 'the dry run writes');
  assert.ok(/wrote: 0/.test(DRY));
});
t('it is off unless explicitly asked for', () => {
  // The daily cron posts {date_from, date_to}. A looser test — req.body.dryRun
  // alone — would turn any truthy value into a no-op sync, and the cron would
  // silently stop syncing while reporting success.
  assert.ok(/req\.body\.dryRun === true/.test(DRY), 'a truthy value could disable the real sync');
});
t('leasing_leads and the Goal Board are untouched', () => {
  assert.ok(/onConflict: 'appfolio_id'/.test(code),
    'the leasing_leads upsert key was changed — it was explicitly to be left alone');
  assert.ok(/appfolio_id: uuid \|\|/.test(code), 'the appfolio_id rule was changed');
});

console.log('\nit answers the question it was added for');
t('it reports EVERY field, not the 18 we mapped', () => {
  assert.ok(/rows\.flatMap\(r => Object\.keys\(r \|\| \{\}\)\)/.test(DRY),
    'it reads keys from one row, so a field only some rows carry is missed');
  assert.ok(/unmappedFields/.test(DRY), 'nothing says which fields we never mapped');
  assert.ok(/totalFields/.test(DRY));
});
t('it classifies each field by grain rather than leaving it to the eye', () => {
  // "distinct === rows.length" is the whole answer: a field with one distinct
  // value per row is interest-level and is the key we want.
  assert.ok(/distinct === rows\.length \? 'PER INTEREST/.test(DRY), 'no interest-level test');
  assert.ok(/distinct === cards \? 'per card'/.test(DRY), 'no card-level test');
  assert.ok(/interestLevelFields/.test(DRY), 'the answer is not surfaced on its own');
});
t('it counts what the current key loses', () => {
  assert.ok(/interestsLostToTheCurrentKey: rows\.length - cards/.test(DRY),
    'the size of the problem is not stated');
});
t('a field that is always empty is not called interest-level', () => {
  // With no rows, distinct and rows.length are both 0 and every field would
  // read as a perfect key.
  assert.ok(/!vals\.length \? 'always empty'/.test(DRY),
    'an empty field would be classified as a unique id');
  assert.ok(DRY.indexOf("'always empty'") < DRY.indexOf("'PER INTEREST"),
    'the empty check does not come first');
});

console.log('\nresident data is masked');
t('name, email and phone are masked in the samples', () => {
  assert.ok(/const PII = new Set\(\['name', 'email_address', 'phone_number'\]\)/.test(DRY));
  assert.ok(/email_address.*\$1\*\*\*\$2/.test(DRY), 'emails come out whole');
  assert.ok(/phone_number.*\\d\{4\}/.test(DRY), 'phone numbers come out whole');
});
t('masking does not hide any field name', () => {
  // The question is which FIELDS exist. Masking values answers it just as well
  // and does not put resident contact details into output that gets pasted
  // around; dropping fields would not.
  assert.ok(/Object\.keys\(r\)\.sort\(\)\.forEach/.test(DRY), 'sample rows are filtered, not masked');
});
t('only a handful of rows come back', () => {
  assert.ok(/rows\.slice\(0, 3\)/.test(DRY), 'the whole report would be dumped');
});

console.log(`\n${pass} passing`);
