const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/collections-order.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const line = r => r.name + ' | ' + r.unit + ' | ' + r.property + ' | $' + r.bal;

// Already the top-N by balance, in balance order — which is what `arrange`
// and `render` are always handed.
const PICKED = [
  { name: 'Alvarez', unit: '10', property: 'Hyde Park Square', bal: 4000 },
  { name: 'Brooks', unit: '2', property: 'Hyde Park Square', bal: 3000 },
  { name: 'Chen', unit: 'B12', property: 'Ascent at Northgate', bal: 2000 },
  { name: 'Diaz', unit: 'B2', property: 'Ascent at Northgate', bal: 1000 },
];

console.log('collections-order');

t('balance is the default, and the default leaves the order alone', () => {
  assert.strictEqual(C.normalizeMode(undefined), 'balance');
  assert.strictEqual(C.normalizeMode(null), 'balance');
  assert.strictEqual(C.normalizeMode(''), 'balance');
  assert.deepStrictEqual(C.arrange(PICKED, undefined).map(r => r.name),
    ['Alvarez', 'Brooks', 'Chen', 'Diaz']);
});

t('an unrecognised mode falls back to balance rather than throwing', () => {
  assert.strictEqual(C.normalizeMode('PROPERTYY'), 'balance');
  assert.strictEqual(C.normalizeMode(7), 'balance');
  assert.strictEqual(C.normalizeMode('Property'), 'property');  // case-insensitive
});

t('property mode sorts by property, then by unit', () => {
  assert.deepStrictEqual(C.arrange(PICKED, 'property').map(r => r.property + '/' + r.unit),
    ['Ascent at Northgate/B2', 'Ascent at Northgate/B12',
     'Hyde Park Square/2', 'Hyde Park Square/10']);
});

t('units sort naturally — 2 before 10, not 10 before 2', () => {
  const rows = ['10', '2', '1', '21', '3'].map(u => ({ unit: u, property: 'P', name: 'x' }));
  assert.deepStrictEqual(C.arrange(rows, 'property').map(r => r.unit), ['1', '2', '3', '10', '21']);
});

t('a letter prefix still groups before the number is compared', () => {
  const rows = ['B12', 'A2', 'B2', 'A10'].map(u => ({ unit: u, property: 'P', name: 'x' }));
  assert.deepStrictEqual(C.arrange(rows, 'property').map(r => r.unit), ['A2', 'A10', 'B2', 'B12']);
});

t('same property and unit falls back to the tenant name', () => {
  const rows = [{ name: 'Zhao', unit: '5', property: 'P' }, { name: 'Abe', unit: '5', property: 'P' }];
  assert.deepStrictEqual(C.arrange(rows, 'property').map(r => r.name), ['Abe', 'Zhao']);
});

t('a missing unit or property does not throw and sorts first', () => {
  const rows = [{ name: 'a', unit: '3', property: 'P' }, { name: 'b' }, { name: 'c', property: 'P' }];
  const out = C.arrange(rows, 'property');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].name, 'b');
});

t('arrange never mutates the list it was given', () => {
  const before = PICKED.map(r => r.name);
  C.arrange(PICKED, 'property');
  assert.deepStrictEqual(PICKED.map(r => r.name), before);
});

t('SELECTION is untouched — arrange returns exactly the rows it was handed', () => {
  // The guard that matters: ordering must never drop or add an account. If a
  // future change starts selecting here, this fails.
  const out = C.arrange(PICKED, 'property');
  assert.strictEqual(out.length, PICKED.length);
  assert.deepStrictEqual(new Set(out.map(r => r.name)), new Set(PICKED.map(r => r.name)));
});

t('balance mode renders a flat list, with no headings', () => {
  const txt = C.render(PICKED, 'balance', line);
  assert.ok(!txt.includes('--'));
  assert.strictEqual(txt.split('\n').length, 4);
  assert.ok(txt.startsWith('Alvarez'));
});

t('property mode names each property once, as a heading', () => {
  const txt = C.render(PICKED, 'property', line);
  const lines = txt.split('\n');
  assert.strictEqual(lines[0], '-- Ascent at Northgate --');
  assert.strictEqual(lines[3], '-- Hyde Park Square --');
  assert.strictEqual(lines.filter(l => l.startsWith('-- ')).length, 2);
  // Still four accounts, plus the two headings.
  assert.strictEqual(lines.length, 6);
});

t('a row with no property gets a named heading, not a blank one', () => {
  const txt = C.render([{ name: 'x', unit: '1' }], 'property', line);
  assert.ok(txt.startsWith('-- (no property) --'));
});

t('an empty list renders as an empty string, not a stray heading', () => {
  assert.strictEqual(C.render([], 'property', line), '');
  assert.strictEqual(C.render([], 'balance', line), '');
});

// The wiring: server.js must actually use this, and the client must send it.
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

t('server.js takes the mode from the request body through this module', () => {
  assert.ok(/CORDER\.normalizeMode\(req\.body && req\.body\.sort\)/.test(SERVER));
  assert.ok(/CORDER\.render\(topByBalance\(rows\), sortMode, line\)/.test(SERVER),
    'delinqText should render the top-by-balance selection');
});

t('the prompt tells the model which order it is reading', () => {
  assert.ok(/GROUPED BY PROPERTY/.test(SERVER));
  assert.ok(/ranked by balance, highest first/.test(SERVER));
});

t('the client offers the choice and sends it', () => {
  assert.ok(/id="col-sort"/.test(HTML), 'no sort control in index.html');
  assert.ok(/value="property"/.test(HTML));
  assert.ok(/sort: \(\$\('#col-sort'\)\?\.value === 'property' \? 'property' : 'balance'\)/.test(APP),
    'app.js does not send the sort field');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
