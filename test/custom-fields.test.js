// Custom fields, which arrive nested inside one column.
//
// occupancy_custom_fields returns five columns — custom_fields, occupancy_id,
// property_id, tenant_name, unit_id — and everything Katie's tab shows as its
// own column lives inside the first. "Eviction Status" was never a key; it was
// a value inside a value, which is why two rounds of looking for it among the
// keys found nothing and reported a confident zero.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CF = require('../lib/custom-fields.js');
const EV = require('../lib/evictions.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('custom fields');

// ---- the three shapes AppFolio has returned --------------------------------

const ARRAY_SHAPE = [{ name: 'Eviction Status', value: 'Need To File Eviction' },
  { name: 'JP Court Date', value: '2026-11-01' }];
const OBJECT_SHAPE = { 'Eviction Status': 'Need To File Eviction', 'JP Court Date': '2026-11-01' };

t('an array of {name, value} is read', () => {
  assert.deepStrictEqual(CF.parse(ARRAY_SHAPE).map(x => x.name),
    ['Eviction Status', 'JP Court Date']);
});

t('an object keyed by name is read', () => {
  assert.deepStrictEqual(CF.parse(OBJECT_SHAPE).map(x => x.name),
    ['Eviction Status', 'JP Court Date']);
});

t('a JSON string holding either is read', () => {
  assert.strictEqual(CF.parse(JSON.stringify(ARRAY_SHAPE))[0].value, 'Need To File Eviction');
  assert.strictEqual(CF.parse(JSON.stringify(OBJECT_SHAPE))[0].value, 'Need To File Eviction');
});

t('label/value and field_name/field_value are read too', () => {
  // AppFolio has used all of these. Guessing one and getting a silent empty
  // result is how the last two rounds of this went.
  assert.strictEqual(CF.parse([{ label: 'Eviction Status', value: 'X' }])[0].name, 'Eviction Status');
  assert.strictEqual(CF.parse([{ field_name: 'Eviction Status', field_value: 'X' }])[0].value, 'X');
});

t('a single-key object is itself a name/value pair', () => {
  assert.deepStrictEqual(CF.parse([{ 'Eviction Status': 'Need To File Eviction' }]),
    [{ name: 'Eviction Status', value: 'Need To File Eviction' }]);
});

t('malformed JSON is empty, never a throw', () => {
  // One bad cell must not take down a report over 827 of them.
  assert.deepStrictEqual(CF.parse('{not json'), []);
  assert.deepStrictEqual(CF.parse(null), []);
  assert.deepStrictEqual(CF.parse(''), []);
  assert.deepStrictEqual(CF.parse(42), []);
});

t('the shape is reported, not assumed', () => {
  assert.strictEqual(CF.shapeOf(ARRAY_SHAPE), 'array');
  assert.strictEqual(CF.shapeOf(OBJECT_SHAPE), 'object');
  assert.strictEqual(CF.shapeOf('[{"name":"x"}]'), 'json');
  assert.strictEqual(CF.shapeOf(''), 'empty');
  assert.strictEqual(CF.shapeOf(42), 'unknown');
});

// ---- flattening ------------------------------------------------------------

const ROW = {
  property_id: '1703', tenant_name: 'Castilla, Dulce P.', unit_id: '1860',
  custom_fields: ARRAY_SHAPE,
};

t('a nested field becomes a top-level key', () => {
  const f = CF.flatten(ROW);
  assert.strictEqual(f['Eviction Status'], 'Need To File Eviction');
  assert.strictEqual(f['JP Court Date'], '2026-11-01');
});

t('the real columns survive, and win a clash', () => {
  // A custom field called property_id must not rename the real one: a report
  // whose contents can change its structure is unreadable.
  const f = CF.flatten({
    property_id: '1703',
    custom_fields: [{ name: 'property_id', value: 'NONSENSE' }],
  });
  assert.strictEqual(f.property_id, '1703');
});

t('flatten does not mutate the row it was given', () => {
  const row = { property_id: '1', custom_fields: ARRAY_SHAPE };
  CF.flatten(row);
  assert.deepStrictEqual(Object.keys(row).sort(), ['custom_fields', 'property_id']);
});

t('a row with no custom fields comes back unchanged', () => {
  const f = CF.flatten({ property_id: '1703' });
  assert.deepStrictEqual(f, { property_id: '1703' });
});

// ---- names and counts, never values ---------------------------------------

t('fieldCounts returns names and counts only', () => {
  const rows = [
    { custom_fields: [{ name: 'Eviction Status', value: 'Need To File Eviction' }] },
    { custom_fields: [{ name: 'Eviction Status', value: '' }, { name: 'Cause', value: '12345' }] },
  ];
  const c = CF.fieldCounts(rows);
  const ev = c.find(x => x.name === 'Eviction Status');
  assert.strictEqual(ev.present, 2, 'the column is on both rows');
  assert.strictEqual(ev.filled, 1, 'only one carries a stage');
  const printed = JSON.stringify(c);
  ['Need To File Eviction', '12345'].forEach(v =>
    assert.ok(!printed.includes(v), v + ' reached the output'));
});

t('describe says the shape and the entry keys, no values', () => {
  const d = CF.describe([{ custom_fields: ARRAY_SHAPE }]);
  assert.deepStrictEqual(d.shapes, { array: 1 });
  assert.deepStrictEqual(d.entryKeys, ['name', 'value']);
  assert.ok(!JSON.stringify(d).includes('Need To File'));
});

// ---- end to end: the evictions actually count -----------------------------

t('flattened rows reach the eviction count, in all three shapes', () => {
  const resolveValue = v => ({ 1703: 'Ascent at Northgate', 1795: 'Sunset Palms' })[v] || null;
  const cases = [
    ['array', [{ name: 'Eviction Status', value: 'Need To File Eviction' }]],
    ['object', { 'Eviction Status': 'Need To File Eviction' }],
    ['json', JSON.stringify([{ label: 'Eviction Status', value: 'Need To File Eviction' }])],
  ];
  cases.forEach(([label, cf]) => {
    const rows = CF.flattenAll([{ property_id: '1703', tenant_name: 'A', custom_fields: cf }]);
    const r = EV.countFrom(rows, { resolveValue });
    assert.strictEqual(r.__stats.statusField, 'Eviction Status', label);
    assert.strictEqual(r['Ascent at Northgate'].needToFile, 1, label);
  });
});

t('EHO inside a nested field is still EHO', () => {
  const rows = CF.flattenAll([{
    property_name: 'X', tenant_name: 'A',
    custom_fields: [{ name: 'Eviction Status', value: 'EHO Signed/Good Standing' }],
  }]);
  const r = EV.countFrom(rows, {});
  assert.strictEqual(r.X.evictionsEho, 1);
  assert.strictEqual(r.X.evictionsInProcess, 1, 'hers counts it; the mode decides');
});

// ---- wiring ----------------------------------------------------------------

t('the report flattens before counting', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  assert.ok(/CF\.flattenAll\(evictionRows\)/.test(build));
  assert.ok(/EV\.countFrom\(evictionFlat/.test(build), 'it still counts the unflattened rows');
});

t('the probe prints structure and names, never a value', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'probe-custom-fields.js'), 'utf8');
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/CF\.fieldCounts/.test(code) && /CF\.describe/.test(code));
  assert.ok(!/\.value/.test(code), 'it reads an entry value');
  assert.ok(!/JSON\.stringify\(\s*(r|row|rows|sample)\s*\)/.test(code), 'it prints a row');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
