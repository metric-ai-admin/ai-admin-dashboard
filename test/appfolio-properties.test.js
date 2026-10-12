// Property ids, and reading her workbook by column name.
//
// Katie's export changed on 2026-10-12: guest card inquiries, labor, MTD Labor
// and tenant custom fields now carry "Property ID" where a name used to be.
// The comparison parser read every column by fixed index, so it took whatever
// was at the old position and made a property out of it — the run came back
// with sixteen properties, seven of which were "1703", "1725", "1795", "1924",
// "26", "Property ID" and "Property Name".
//
// Nothing errored. That is the whole point of this file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AFP = require('../lib/appfolio-properties.js');
const KC = require('../lib/kpi-compare.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('appfolio property ids');

t('the two ids that were already known from other reports agree', () => {
  // 1703 and 1725 were seen elsewhere before this map existed. They are the
  // reason to believe the other fourteen, which were derived the same way.
  assert.strictEqual(AFP.nameForId(1703), 'Ascent at Northgate');
  assert.strictEqual(AFP.nameForId(1725), 'Windy Hill Apartment');
});

t('every id her workbook carries is in the map', () => {
  // The nine on the 2026-10-12 export.
  [26, 27, 43, 1703, 1725, 1795, 1812, 1885, 1924].forEach(id =>
    assert.ok(AFP.nameForId(id), id + ' is on her sheets and has no name'));
});

t('no two ids map to the same property', () => {
  const names = Object.values(AFP.BY_ID);
  assert.strictEqual(new Set(names).size, names.length, 'a name is claimed by two ids');
});

t('an id nobody has seen resolves to null, never to a guess', () => {
  assert.strictEqual(AFP.nameForId(9999), null);
  assert.strictEqual(AFP.resolveProperty('9999'), null);
  assert.deepStrictEqual(AFP.unknownIds(['1703', '9999', '26', '9999']), ['9999']);
});

// ---- resolving a property cell --------------------------------------------

t('it handles the three shapes her sheets use', () => {
  assert.strictEqual(AFP.resolveProperty('Ascent at Northgate'), 'Ascent at Northgate');
  assert.strictEqual(AFP.resolveProperty('Ascent at Northgate - 9315 Northgate Blvd Austin, TX 78758'),
    'Ascent at Northgate');
  assert.strictEqual(AFP.resolveProperty('1703'), 'Ascent at Northgate');
  assert.strictEqual(AFP.resolveProperty(1703), 'Ascent at Northgate', 'a numeric cell too');
});

t('header text is NOT a property', () => {
  // THE ONE THAT HAPPENED. When a sheet's header row shifted, "Property Name"
  // became a column in the comparison with real figures under it.
  ['Property Name', 'Property ID', 'Property', 'property name', 'Total', 'Totals', '', '   ']
    .forEach(v => assert.strictEqual(AFP.resolveProperty(v), null, JSON.stringify(v) + ' became a property'));
});

t('a unit number cannot become a property', () => {
  // A stray unit number reaching here is a bug upstream; surfacing it as an
  // unknown id beats accepting it as a community.
  assert.strictEqual(AFP.resolveProperty('104'), null);
});

// ---- her workbook, read by name -------------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-compare.js'), 'utf8');

t('every sheet reader goes through the header map', () => {
  ['occupancy', 'guest card interests', 'showings', 'apps', 'box score',
    'work order open', 'work order closed', 'tenant custom fields'].forEach(() => {});
  const readers = (SRC.match(/sheetReader\(rows\('([^']+)'\)/g) || [])
    .map(m => m.replace(/.*rows\('/, '').replace(/'\)/, ''));
  ['occupancy', 'guest card interests', 'showings', 'apps', 'box score',
    'work order open', 'work order closed', 'tenant custom fields'].forEach(s =>
    assert.ok(readers.includes(s), s + ' is still read by fixed column index'));
});

t('the old positions survive as a fallback', () => {
  // This parser reproduced her screen on 16 of 16 metrics using those indexes,
  // and an older workbook must keep parsing exactly as it did. A header that
  // IS found wins; a sheet without one falls back.
  assert.ok(/prop\(r, 14\)/.test(SRC), 'showings lost its fallback index');
  assert.ok(/prop\(r, 10\)/.test(SRC), 'work orders lost theirs');
  assert.ok(/fallbackIdx === undefined \? null : AFP\.resolveProperty\(r\[fallbackIdx\]\)/.test(SRC),
    'the fallback path must still resolve, not return the raw cell');
});

t('a property that cannot be placed is dropped, not invented', () => {
  const fn = SRC.slice(SRC.indexOf('    prop(r, fallbackIdx) {'), SRC.indexOf('    unknownIds()'));
  assert.ok(/AFP\.resolveProperty/.test(fn));
  assert.ok(/return null/.test(fn) || /\? null :/.test(fn));
});

// ---- the whole parser, on the shape that broke it -------------------------

// Her sheets, cut down to the columns that matter, with the five lines of
// filter text her exports really open with.
const preamble = [['Data: whatever'], ['Exported On: 10/12/2026'], [''], ['Filters: all'], ['headerSize=5&id=x']];
const sheetOf = (header, body) => preamble.concat([header]).concat(body);

t('a tab that gives Property ID instead of a name still lands on the property', () => {
  const sheets = {
    'occupancy': sheetOf(
      ['Property', 'Unit Type', 'Units', 'Occupied', 'e', 'f', 'g', 'Vacant Rented', 'Vacant Unrented', 'Notice Rented', 'Notice Unrented'],
      [['Ascent at Northgate - 9315 Northgate Blvd', '1x1', '111', '57', '', '', '', '0', '54', '0', '0']]),
    'tenant custom fields': sheetOf(
      ['Tenant Name', 'Occupancy ID', 'Unit ID', 'Property ID', 'Eviction Status'],
      [['Castilla, Dulce P.', '1547', '1860', '1703', 'Need To File Eviction']]),
    // Her Aged Receivable Detail shape: a section row opening the tenant, the
    // charge lines under it, then a SUBTOTAL row with a blank payer name and
    // the aging buckets — which is the row the total is actually read from.
    'delinquency': sheetOf(
      ['Payer Name', 'Charge Date', 'Posting Date', 'GL', 'GL Name', 'Amount Receivable', '0-30', '31-60', '61-90', '91+'],
      [['Ascent at Northgate - 9315 Northgate Blvd - Unit 10-124 - Castilla, Dulce P.'],
        ['Castilla, Dulce P.', '10/1/26', '10/1/26', '4110', 'Rent Income', '839'],
        ['', '', '', '', '', '839', '839', '0', '0', '0']]),
  };
  const her = KC.herAll(sheets, '2026-10-04', '2026-10-10');
  const names = Object.keys(her.byProperty);
  assert.deepStrictEqual(names, ['Ascent at Northgate'],
    'got: ' + JSON.stringify(names));
  assert.strictEqual(her.byProperty['Ascent at Northgate'].units, 111);
  assert.strictEqual(her.byProperty['Ascent at Northgate'].needToFile, 1,
    'the eviction join must survive the Property ID column');
  assert.deepStrictEqual(her.unknownIds, []);
});

t('an unrecognised Property ID is reported, not turned into a column', () => {
  const sheets = {
    'tenant custom fields': sheetOf(
      ['Tenant Name', 'Property ID', 'Eviction Status'],
      [['Somebody, A.', '9999', 'Need To File Eviction']]),
    'delinquency': sheetOf(['Payer Name'], []),
  };
  const her = KC.herAll(sheets, '2026-10-04', '2026-10-10');
  assert.deepStrictEqual(her.unknownIds, ['9999'], 'a new property must arrive as a question');
  assert.ok(!Object.keys(her.byProperty).includes('9999'),
    'an unknown id became a property with its own figures');
});

t('a header row that moves cannot invent a property', () => {
  // Two extra preamble lines, so every fixed index points one row out.
  const sheets = {
    'showings': [['x'], ['y']].concat(sheetOf(
      ['Prospect', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'Status', 'k', 'l', 'm', 'n', 'Property Name'],
      [['A Prospect', '', '', '', '', '', '', '', '', 'Completed', '', '', '', '', 'Sunset Palms']])),
    'delinquency': sheetOf(['Payer Name'], []),
  };
  const her = KC.herAll(sheets, '2026-10-04', '2026-10-10');
  assert.deepStrictEqual(Object.keys(her.byProperty), ['Sunset Palms']);
  assert.strictEqual(her.byProperty['Sunset Palms'].tours, 1);
});

t('the checker script exists and only reads', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-property-ids.js'), 'utf8');
  assert.ok(!/\.upsert\(|\.insert\(|\.update\(|\.delete\(/.test(s), 'the checker must not write');
  assert.ok(/process\.exit\(1\)/.test(s), 'a disagreement must fail, not just print');
  // More than one table, or the map is only being compared with its own source.
  const tables = (s.match(/\['leasing_|\['maintenance_/g) || []).length;
  assert.ok(tables >= 4, 'one table agreeing proves only that the map was copied from it');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
