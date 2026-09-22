// DM Review conditional sub-questions.
//
// Exercises the real DM_CONDITIONALS map and the clear/visibility helpers from
// public/app.js against a DOM shim, so the rules are pinned rather than
// described.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = app.split(/\r?\n/);
const slice = (a, b) => {
  const i = lines.findIndex(l => l.includes(a));
  const j = lines.findIndex((l, k) => k > i && l.includes(b));
  return lines.slice(i, j).join('\n');
};

// ---- minimal DOM: one row + one note element per criterion
const made = {};
const mkEl = (section, key) => {
  const note = { cls: new Set(), classList: { toggle(c, on) { on ? note.cls.add(c) : note.cls.delete(c); }, contains: c => note.cls.has(c) } };
  const row = {
    cls: new Set(),
    classList: { toggle(c, on) { on ? row.cls.add(c) : row.cls.delete(c); }, contains: c => row.cls.has(c) },
    nextElementSibling: note,
  };
  note.cls.add('crm-dm-note-marker');
  note.classList.contains = c => (c === 'crm-dm-note' ? true : note.cls.has(c));
  const picker = { dataset: { section, key }, closest: () => row };
  made[`${section}.${key}`] = { row, note, picker };
  return picker;
};
['apts_listed', 'apts_photos', 'apts_pricing', 'zillow_listed', 'zillow_photos'].forEach(k => mkEl('ils', k));
global.document = { querySelector: sel => { const m = sel.match(/data-section="([^"]+)"\]\[data-key="([^"]+)"/); return m && made[`${m[1]}.${m[2]}`] ? made[`${m[1]}.${m[2]}`].picker : null; } };
global.crmState = { dmScores: {} };

eval([
  'const dmNoteKey = key => key + "__note";',
  slice('// Conditional sub-questions.', 'function crmInitDMPickers'),
  // const/arrow declarations are block-scoped to this eval, so hand the ones
  // the assertions need back out explicitly.
  'global.DM_CONDITIONALS = DM_CONDITIONALS; global.dmIsChild = dmIsChild; global.dmChildKeys = dmChildKeys;',
].join('\n'));

const visible = key => !made[`ils.${key}`].row.cls.has('hidden');
const noteVisible = key => !made[`ils.${key}`].note.cls.has('hidden');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

console.log('\nVisibility follows the parent answer');
t('unanswered -> children hidden', () => {
  crmState.dmScores = { ils: {} };
  crmApplyDMConditionals();
  assert.strictEqual(visible('apts_photos'), false);
  assert.strictEqual(visible('apts_pricing'), false);
  assert.strictEqual(visible('zillow_photos'), false);
});
t('Yes (5) -> children shown, notes too', () => {
  crmState.dmScores = { ils: { apts_listed: 5 } };
  crmApplyDMConditionals();
  assert.strictEqual(visible('apts_photos'), true);
  assert.strictEqual(visible('apts_pricing'), true);
  assert.strictEqual(noteVisible('apts_photos'), true);
});
t('No (0) -> children hidden', () => {
  crmState.dmScores = { ils: { apts_listed: 0 } };
  crmApplyDMConditionals();
  assert.strictEqual(visible('apts_photos'), false);
  assert.strictEqual(noteVisible('apts_photos'), false);
});
t('parents themselves are never hidden', () => {
  crmState.dmScores = { ils: { apts_listed: 0, zillow_listed: 0 } };
  crmApplyDMConditionals();
  assert.strictEqual(visible('apts_listed'), true);
  assert.strictEqual(visible('zillow_listed'), true);
});
t('the two platforms are independent', () => {
  crmState.dmScores = { ils: { apts_listed: 5, zillow_listed: 0 } };
  crmApplyDMConditionals();
  assert.strictEqual(visible('apts_photos'), true);
  assert.strictEqual(visible('zillow_photos'), false);
});

console.log('\nClearing on an explicit No');
t('clears child scores and their notes', () => {
  crmState.dmScores = { ils: { apts_listed: 0, apts_photos: 4, apts_pricing: 5, apts_photos__note: 'blurry' } };
  crmClearDMChildren('ils', 'apts_listed');
  assert.deepStrictEqual(crmState.dmScores.ils, { apts_listed: 0 });
});
t('does not touch the other platform', () => {
  crmState.dmScores = { ils: { apts_listed: 0, apts_photos: 4, zillow_listed: 5, zillow_photos: 3 } };
  crmClearDMChildren('ils', 'apts_listed');
  assert.deepStrictEqual(crmState.dmScores.ils, { apts_listed: 0, zillow_listed: 5, zillow_photos: 3 });
});
t('is safe when the section is absent', () => {
  crmState.dmScores = {};
  assert.doesNotThrow(() => crmClearDMChildren('ils', 'apts_listed'));
});

console.log('\nLoading an old review must NOT rewrite it');
t('parent=No with scored children: hidden but values kept', () => {
  // 22 live reviews look exactly like this. Opening one must not alter it —
  // applying visibility is not allowed to mutate stored values.
  crmState.dmScores = { ils: { zillow_listed: 0, zillow_photos: 3 } };
  crmApplyDMConditionals();
  assert.strictEqual(visible('zillow_photos'), false, 'hidden');
  assert.strictEqual(crmState.dmScores.ils.zillow_photos, 3, 'value preserved');
});

console.log('\nMap shape');
t('only the two requested platforms are conditional', () => {
  assert.deepStrictEqual(Object.keys(DM_CONDITIONALS), ['ils']);
  assert.deepStrictEqual(Object.keys(DM_CONDITIONALS.ils).sort(), ['apts_listed', 'zillow_listed']);
});
t('dmIsChild identifies sub-questions', () => {
  assert.strictEqual(dmIsChild('ils', 'apts_photos'), true);
  assert.strictEqual(dmIsChild('ils', 'apts_listed'), false);
  assert.strictEqual(dmIsChild('website', 'seo'), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
