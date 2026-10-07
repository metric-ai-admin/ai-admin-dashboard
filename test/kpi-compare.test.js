// Comparing Katie's workbook against the combined report.
//
// This runs on the SERVER, which is the whole point: delinquency_kpi and
// unit_turn_detail live on the Render disk, and on a laptop without them DQ
// Total and move-outs read zero. The first run of the comparison script
// reported that as a −$332k difference, which was not a difference at all —
// it was where the script ran. The thing this file protects most is the line
// between "we disagree" and "I could not read it".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/kpi-compare.js');
const ACTS = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROUTE = server.slice(server.indexOf("app.post('/api/kpi/compare'"),
  server.indexOf('// The KPI exports.'));

// Her Aged Receivable Detail, in miniature: a group header is a row with text
// in column A and nothing else; the charge lines under it belong to it.
const DQ_ROWS = [
  ['Data: Delinquency as of last week'], [], [], [], [],
  ['Payer Name', 'Charge Date', 'Posting Date', 'GL', 'GL Name', 'Amount Receivable', '0-30', '31-60', '61-90', '91+'],
  [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
  ['Ascent at Northgate - 9315 Northgate Blvd - Unit 10-124 - Castilla, Dulce P.'],
  ['Castilla, Dulce P.', '10/1/26', '10/1/26', '4110', 'Rent Income', '839', '839', '0', '0', '0'],
  ['Castilla, Dulce P.', '10/1/26', '10/1/26', '4402', 'Utility Fee', '3', '3', '0', '0', '0'],
  ['Ascent at Northgate - 9315 Northgate Blvd - Unit 10-125 - Someone Else'],
  ['Someone Else', '10/1/26', '10/1/26', '4110', 'Rent Income', '500', '500', '0', '0', '0'],
  ['Someone Else', '10/1/26', '10/1/26', '4900', 'Concession', '(100)', '0', '0', '0', '0'],
  ['Sunset Palms - 902 Romeria - Unit 109 - A Tenant'],
  ['A Tenant', '10/1/26', '10/1/26', '4110', 'Rent Income', '1,200.50', '1200.5', '0', '0', '0'],
];

// ---- her delinquency --------------------------------------------------------
t('her sheet is grouped by property-unit-payer, and the groups are followed', () => {
  const d = C.herDelinquency(DQ_ROWS);
  assert.strictEqual(d.groups, 3);
  assert.strictEqual(Object.keys(d.byProperty).sort().join(','), 'Ascent at Northgate,Sunset Palms');
  assert.strictEqual(d.byProperty['Ascent at Northgate'].total, 1342);
  assert.strictEqual(d.byProperty['Sunset Palms'].total, 1200.5);
});

t('a payer counts once however many charge lines they have', () => {
  const d = C.herDelinquency(DQ_ROWS);
  assert.strictEqual(d.byProperty['Ascent at Northgate'].residents, 2, 'four lines, two payers');
});

t('concessions are left out, not netted off', () => {
  // Netting them would report LESS delinquency than there is, which is the
  // direction that matters on a report about money owed.
  const d = C.herDelinquency(DQ_ROWS);
  assert.strictEqual(d.negativeRows, 1);
  assert.strictEqual(d.negatives, -100);
  assert.strictEqual(d.byProperty['Ascent at Northgate'].total, 1342, 'the -100 must not reduce it');
});

t('it sums Amount Receivable, not the aging buckets', () => {
  // Reading the buckets instead gave $332k against her $106k: the two columns
  // do not agree on every row.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-compare.js'), 'utf8');
  const fn = src.slice(src.indexOf('function herDelinquency'), src.indexOf('// ---- her occupancy'));
  assert.ok(/num\(r\[5\]\)/.test(fn));
  assert.ok(!/r\[6\]|r\[7\]|r\[8\]|r\[9\]/.test(fn), 'the buckets must not be summed');
});

t('money with symbols, commas and parentheses parses', () => {
  assert.strictEqual(C.num('1,200.50'), 1200.5);
  assert.strictEqual(C.num('$839'), 839);
  assert.strictEqual(C.num('(100)'), -100);
  assert.strictEqual(C.num(''), 0);
});

t('a property name is taken from the group header, before the first dash', () => {
  assert.strictEqual(C.canon('Ascent at Northgate - 9315 Northgate Blvd - Unit 10-124 - X'),
    'Ascent at Northgate');
  assert.strictEqual(C.canon('Total'), null);
  assert.strictEqual(C.canon(''), null);
});

// ---- the comparison itself --------------------------------------------------
const report = {
  week_ending: '2026-10-03',
  range: { from: '2026-09-27', to: '2026-10-03' },
  gaps: [],
  portfolio: [],
  properties: {
    'Ascent at Northgate': [{ cards: [
      { metric: 'units', value: 111, source: 'appfolio' },
      { metric: 'occupied', value: 59, source: 'appfolio' },
      { metric: 'dqTotal', value: 21740.15, source: 'appfolio' },
    ] }],
    'Sunset Palms': [{ cards: [
      { metric: 'units', value: 60, source: 'appfolio' },
      { metric: 'occupied', value: 50, source: 'appfolio' },
      { metric: 'dqTotal', value: null, source: 'unavailable' },
    ] }],
    Greystone: Object.assign([{ cards: [] }], { __members: ['Sunset Palms'] }),
  },
};
const her = {
  occupancy: {
    'Ascent at Northgate': { units: 111, occupied: 58 },
    'Sunset Palms': { units: 60, occupied: 50 },
    'A Property We Do Not Have': { units: 10, occupied: 9 },
  },
  delinquency: C.herDelinquency(DQ_ROWS),
};

t('an agreement and a disagreement are told apart', () => {
  const out = C.compare(report, her);
  const units = out.rows.find(r => r.property === 'Ascent at Northgate' && r.metric === 'units');
  const occ = out.rows.find(r => r.property === 'Ascent at Northgate' && r.metric === 'occupied');
  assert.strictEqual(units.agrees, true);
  assert.strictEqual(units.diff, 0);
  assert.strictEqual(occ.agrees, false);
  assert.strictEqual(occ.diff, 1);
});

t('a metric we could not read is a GAP, never a disagreement', () => {
  // This is the whole lesson of the first run.
  const out = C.compare(report, her);
  const dq = out.rows.find(r => r.property === 'Sunset Palms' && r.metric === 'dqTotal');
  assert.strictEqual(dq.ours, null);
  assert.strictEqual(dq.diff, null, 'no difference can be computed from a missing value');
  assert.strictEqual(dq.source, 'unavailable');
  assert.ok(!out.rows.filter(r => r.diff !== null && r.diff !== 0).includes(dq));
});

t('a difference we can explain carries its explanation', () => {
  const out = C.compare(report, her);
  const occ = out.rows.find(r => r.property === 'Ascent at Northgate' && r.metric === 'occupied');
  assert.ok(/snapshot date/.test(occ.why));
});

t('a difference we cannot explain is left unexplained', () => {
  // A plausible-sounding wrong reason is worse than none: it stops the
  // question being asked.
  assert.ok(!Object.prototype.hasOwnProperty.call(C.EXPLANATIONS, 'vacantRented'));
  const out = C.compare(report, her);
  assert.strictEqual(typeof out.unexplained, 'number');
});

t('properties only one side has are listed, not silently dropped', () => {
  const out = C.compare(report, her);
  assert.ok(out.onlyHers.includes('A Property We Do Not Have'));
  assert.ok(!out.rows.some(r => r.property === 'A Property We Do Not Have'));
});

t('a roll-up group is not compared as if it were a property', () => {
  const out = C.compare(report, her);
  assert.ok(!out.rows.some(r => r.property === 'Greystone'),
    'her workbook has no Greystone rows; comparing it would invent a difference');
});

t('the portfolio row sums only the properties BOTH sides carry', () => {
  // Comparing our whole portfolio against her subset would manufacture a
  // difference out of scope rather than out of data.
  const out = C.compare(report, her);
  assert.deepStrictEqual(out.shared.sort(), ['Ascent at Northgate', 'Sunset Palms']);
  const units = out.portfolio.find(r => r.metric === 'units');
  assert.strictEqual(units.hers, 171, '111 + 60, without the property we do not have');
  assert.strictEqual(units.ours, 171);
});

t('the portfolio percentage is recomputed, never summed', () => {
  const out = C.compare(report, her);
  const pct = out.portfolio.find(r => r.metric === 'occPct');
  assert.ok(pct.hers > 0 && pct.hers < 1, 'got ' + pct.hers);
  assert.ok(Math.abs(pct.hers - 108 / 171) < 1e-9);
});

// ---- the route --------------------------------------------------------------
t('it is admin only', () => {
  assert.ok(/requireAuth, requireRole\('admin'\)/.test(ROUTE));
});

t('the workbook is never stored', () => {
  assert.ok(/req\.file\.buffer/.test(ROUTE), 'parsed out of the buffer');
  assert.ok(!/writeFile|fsp\.|from\('kpi_workbook_data'\)|upsert/.test(ROUTE),
    'this is a workbook of resident-level receivables; nothing here needs a copy');
});

t('it runs the same builder as the report and both exports', () => {
  assert.ok(/kpiBuild\.buildKpiReport\(db,/.test(ROUTE),
    'a second assembler would mean only one of them ever gets fixed');
});

t('the gaps travel with the answer', () => {
  assert.ok(/gaps: report\.gaps/.test(ROUTE),
    'a metric that reads zero because its store is missing must never be shown as a disagreement');
});

t('a missing tab is named along with the tabs that were found', () => {
  assert.ok(/This workbook has no tab for: /.test(ROUTE));
  assert.ok(/Tabs found: /.test(ROUTE));
});

t('comparing is named in Activity Logs', () => {
  const d = ACTS.describe('POST', '/api/kpi/compare');
  assert.ok(/Compared against/.test(d.label));
  assert.strictEqual(d.entity, 'kpi');
});

// ---- the page ---------------------------------------------------------------
t('the panel is on the KPI tab and starts hidden', () => {
  assert.ok(/id="kc-wrap" class="kc-wrap hidden"/.test(html));
  assert.ok(/id="kc-file"/.test(html));
  assert.ok(/nothing is stored/.test(html), 'and it says so where it is used');
});

t('it is shown to admin only', () => {
  assert.ok(/currentUser\.role !== 'admin'/.test(appjs));
});

t('a gap is rendered differently from a disagreement', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/\.kc-table tr\.gap/.test(css));
  assert.ok(/\.kc-table tr\.bad/.test(css));
  assert.ok(/one side has no value/.test(appjs),
    'and the row says which it is rather than leaving the colour to carry it');
});

t('everything rendered from the response is escaped', () => {
  const fn = appjs.slice(appjs.indexOf('function kcRender'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const interps = body.match(/\$\{[^}]*\}/g) || [];
  interps.forEach(x => assert.ok(
    /kcEsc\(|kcNum\(|\.length|\.map\(|\.join\(|d\.disagreements|d\.unexplained|r\.agrees|r\.diff|dq\.her/.test(x),
    'unescaped interpolation: ' + x));
});

console.log(`\n${pass} passing`);
