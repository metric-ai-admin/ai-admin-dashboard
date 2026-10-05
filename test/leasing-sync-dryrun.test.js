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

console.log('\nit measures what the sync silently discards');
t('it says whether the report returns property_name at all', () => {
  // leasingRowFromReport resolves the property from property_name first. This
  // report does not return that field — it returns `property` (name plus
  // address) and property_id — so the fallback is the only path there is.
  assert.ok(/returnsPropertyName: keys\.includes\('property_name'\)/.test(DRY),
    'nothing states whether the field the mapping expects exists');
});
t('a dropped property is named and counted, not totalled', () => {
  // A total says rows are lost; a property_id with a row count says which
  // property and how many, which is the difference between a number and
  // something anyone can act on.
  assert.ok(/rowsDroppedForUnresolvableProperty/.test(DRY), 'no count of discarded rows');
  assert.ok(/properties,/.test(DRY), 'the per-property breakdown is not returned');
  assert.ok(/resolvesTo: resolvable\[b\.property_id\] \|\| null/.test(DRY),
    'it does not say what each property_id resolves to');
});
t('a row is only called dropped when BOTH paths fail', () => {
  // property_name present OR a propMap hit is enough to keep the row.
  // Checking one alone would overstate the loss.
  assert.ok(/dropped: !b\.hasPropertyName && !resolvable\[b\.property_id\]/.test(DRY),
    'the two resolution paths are not both considered');
});
t('the loss is broken down by leasing week, not just totalled', () => {
  // The pull ignores the date filter and returns months of rows, so one total
  // cannot say whether any given week on the Goal Board moved.
  assert.ok(/weeks: Object\.values\(byWeek\)/.test(DRY), 'there is no per-week breakdown');
  assert.ok(/6 - d\.getUTCDay\(\)/.test(DRY), 'weeks are not Sun–Sat like the rest of the dashboard');
  assert.ok(/droppedByFirstContact/.test(DRY) && /droppedByInterestReceived/.test(DRY),
    'only one of the two date readings is broken down');
});
t('a dropped row is named once, not once per date reading', () => {
  // The week tally walks each row twice, once per date field. Tallying the
  // property on both passes would double every entry in that breakdown while
  // the two counts beside it stayed correct.
  assert.ok(/if \(which === 'byFirstContact'\) \{/.test(DRY),
    'droppedProperties is counted on both passes and is therefore doubled');
});
t('the propMap is rebuilt from the same source the sync uses', () => {
  // leasing_leads, filtered to rows that have both halves — otherwise the dry
  // run would measure against a map the real sync does not have.
  assert.ok(/from\('leasing_leads'\)\.select\('property_id,property'\)/.test(DRY));
  assert.ok(/\.not\('property', 'is', null\)\.not\('property_id', 'is', null\)/.test(DRY),
    'rows with half the pair would seed a map the sync cannot build');
});
t('reading leasing_leads here is still a read', () => {
  const i = DRY.indexOf("from('leasing_leads')");
  assert.ok(i > 0);
  assert.ok(/\.select\(/.test(DRY.slice(i, i + 80)), 'the dry run touches leasing_leads with something other than select');
});

console.log('\nresident data is masked');
t('name, email and phone are masked in the samples', () => {
  assert.ok(/const PII = new Set\(\['name', 'email_address', 'phone_number'\]\)/.test(DRY));
  assert.ok(/email_address.*\$1\*\*\*\$2/.test(DRY), 'emails come out whole');
});
t('the phone mask survives brackets and dashes', () => {
  // It did not. /\d(?=\d{4})/ needs four CONTIGUOUS digits after, so
  // "(737) 881-7336" came back whole on the first live run and the number
  // reached a chat transcript. A masking bug prints the thing it was there to
  // hide and fails silently while doing it.
  const m = DRY.match(/if \(k === 'phone_number'\) return s\.replace\((\/[^/]+\/g), '\*'\);/);
  assert.ok(m, 'the phone branch is gone or was rewritten into another shape');
  const re = new RegExp(m[1].slice(1, -2), 'g');
  const mask = s => s.replace(re, '*');
  ['(737) 881-7336', '737-881-7336', '7378817336', '+1 (737) 881 7336']
    .forEach(raw => {
      const out = mask(raw);
      // Exactly the last four digits survive, whatever the formatting.
      assert.strictEqual(out.replace(/\D/g, ''), '7336', `${raw} -> ${out}`);
      assert.ok(out.endsWith('7336'), `the surviving digits are not the last four: ${raw} -> ${out}`);
    });
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
