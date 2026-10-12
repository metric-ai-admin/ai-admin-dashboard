// Evictions, and the decision inside them.
//
// Katie reads 34 in process and 13 need-to-file for 10/04–10/10. Our side read
// 2 and 0, because delinquency_as_of returns the eviction columns blank — so
// needToFile could only ever be zero, and evictionsInProcess was counting
// tenant_status = Evict, a different question.
//
// Of the 120 residents with a stage on her export, 32 are "EHO Signed / Good
// Standing": keeping to a payment agreement. Whether they belong in the
// headline is Kara's call, so it is a setting with both answers available.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EV = require('../lib/evictions.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const row = (prop, name, status) => ({ property_name: prop, tenant_name: name, eviction_status: status });

console.log('evictions');

t('the default is HERS, so the report can replace hers unnoticed', () => {
  assert.strictEqual(EV.DEFAULT_MODE, 'all');
  assert.deepStrictEqual(EV.MODES, ['all', 'excluding-eho']);
});

t('an unknown mode falls back to hers rather than throwing', () => {
  // A typo in an environment variable must not change a number on an owner's
  // report, and it must not take the report down either.
  ['', null, undefined, 'ALL', 'nonsense'].forEach(m =>
    assert.strictEqual(EV.mode(m), 'all', JSON.stringify(m)));
  assert.strictEqual(EV.mode('excluding-eho'), 'excluding-eho');
  assert.strictEqual(EV.mode('EXCLUDING-EHO'), 'excluding-eho', 'case must not matter');
});

t('EHO is recognised however it is spelled', () => {
  ['EHO Signed/Good Standing', 'EHO Signed / Good Standing', 'eho signed/good standing',
    'Good Standing'].forEach(s => assert.ok(EV.isEho(s), s));
  ['Need To File Eviction', 'Pending JP Court Date', ''].forEach(s =>
    assert.ok(!EV.isEho(s), s + ' was read as EHO'));
});

t('Need to Refile is the same queue as Need To File', () => {
  // A stage spelled two ways would split one queue into two.
  assert.ok(EV.needsFiling('Need To File Eviction'));
  assert.ok(EV.needsFiling('Need to Refile'));
  assert.ok(!EV.needsFiling('Writ Needs to be Filed'), 'a writ is a later stage, not this queue');
});

// ---- the two answers -------------------------------------------------------

const ROWS = [
  row('Ascent at Northgate', 'Castilla, Dulce P.', 'Need To File Eviction'),
  row('Ascent at Northgate', 'Smith, John', 'EHO Signed/Good Standing'),
  row('Ascent at Northgate', 'Boyd, Evan D.', 'Pending JP Court Date'),
  row('Ascent at Northgate', 'Nobody, A.', ''),            // no stage at all
  row('Sunset Palms', 'Lopez, Maria', 'Need to Refile'),
  row('Sunset Palms', 'Chan, Wei', 'EHO Signed / Good Standing'),
];

t('"all" is her figure: everyone carrying a stage', () => {
  const r = EV.countFrom(ROWS, { mode: 'all' });
  assert.strictEqual(r['Ascent at Northgate'].evictionsInProcess, 3);
  assert.strictEqual(r['Sunset Palms'].evictionsInProcess, 2);
});

t('"excluding-eho" drops the residents on a payment agreement', () => {
  const r = EV.countFrom(ROWS, { mode: 'excluding-eho' });
  assert.strictEqual(r['Ascent at Northgate'].evictionsInProcess, 2);
  assert.strictEqual(r['Sunset Palms'].evictionsInProcess, 1);
});

t('the EHO count is reported under BOTH modes', () => {
  // The line exists so somebody can see what the choice is worth. It cannot do
  // that if it disappears under one of the two options.
  ['all', 'excluding-eho'].forEach(m => {
    const r = EV.countFrom(ROWS, { mode: m });
    assert.strictEqual(r['Ascent at Northgate'].evictionsEho, 1, m);
    assert.strictEqual(r['Sunset Palms'].evictionsEho, 1, m);
  });
});

t('needToFile is unaffected by the mode — EHO is not a filing queue', () => {
  ['all', 'excluding-eho'].forEach(m => {
    const r = EV.countFrom(ROWS, { mode: m });
    assert.strictEqual(r['Ascent at Northgate'].needToFile, 1, m);
    assert.strictEqual(r['Sunset Palms'].needToFile, 1, m);
  });
});

t('a blank stage is nobody, not a zero-stage eviction', () => {
  const r = EV.countFrom([row('X', 'A', ''), row('X', 'B', '   ')], {});
  assert.deepStrictEqual(r, {}, 'a property with no stages must not appear at all');
});

// ---- her restriction to delinquent residents ------------------------------

t('only residents who are ALSO delinquent count, which is her rule', () => {
  // Without this every resident with a stage counts: 120 against her 34 on the
  // 2026-10-12 export.
  const delinquent = new Set(['castilla dulce']);
  const r = EV.countFrom(ROWS, {
    mode: 'all',
    isDelinquent: n => delinquent.has(String(n).toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').replace(/\b[a-z]\b/g, '').replace(/\s+/g, ' ').trim()),
  });
  assert.strictEqual(r['Ascent at Northgate'].evictionsInProcess, 1);
  assert.ok(!r['Sunset Palms'], 'nobody at Sunset Palms is on the delinquency sheet');
});

t('a row whose property cannot be placed is dropped, not bucketed as blank', () => {
  const r = EV.countFrom([{ property_id: '9999', tenant_name: 'A', eviction_status: 'Need To File Eviction' }],
    { resolve: () => null });
  assert.deepStrictEqual(r, {});
});

// ---- it is wired in --------------------------------------------------------

const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');

t('the report reads the stage from Occupancy Custom Fields, not delinquency', () => {
  assert.ok(/occupancy_custom_fields/.test(build), 'the new source is not read');
  assert.ok(/EV\.countFrom\(evictionRows/.test(build));
  assert.ok(/isDelinquent:/.test(build), 'without her restriction this counts a different population');
});

t('the mode is a setting, and the report says which one it used', () => {
  assert.ok(/KPI_EVICTION_MODE/.test(build), 'it cannot be changed without a deploy');
  assert.ok(/\n      evictionMode,/.test(build), 'the report does not say which rule produced its figures');
});

t('a stale delinquency store is refreshed before the figures are read', () => {
  assert.ok(/refreshIfStale\('delinquency_kpi'/.test(build));
  assert.ok(/DEFAULT_MAX_AGE_HOURS = 6/.test(build));
  // A failed refresh must not cost the report.
  const fn = build.slice(build.indexOf('async function refreshIfStale'), build.indexOf('const built = KPI.build'));
  assert.ok(/using the copy on disk/.test(fn), 'a refresh failure must fall back, and say so');
});

t('the report is registered for the morning cron', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/'occupancy_custom_fields'/.test(server));
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  assert.ok(/id: 'occupancy_custom_fields'/.test(reports), 'the report is not registered');
});


// ---- 2026-10-12: a zero has to say which zero it is ------------------------

t('the stage column is detected, not pinned', () => {
  // THE BUG. The first wiring read `eviction_status` and nothing else, so a
  // report calling it anything else produced a silent zero — indistinguishable
  // from "nobody is in eviction", the one reading that needs no action.
  const r = EV.countFrom([{ property_name: 'X', tenant_name: 'A', eviction_stage: 'Need To File Eviction' }], {});
  assert.strictEqual(r.__stats.statusField, 'eviction_stage');
  assert.strictEqual(r.X.needToFile, 1);
});

t('every row is accounted for in the tally', () => {
  const rows = [
    { property_name: 'X', tenant_name: 'A', eviction_status: 'Need To File Eviction' },
    { property_name: 'X', tenant_name: 'B', eviction_status: '' },
    { property_name: '', tenant_name: 'C', eviction_status: 'Pending JP Court Date' },
  ];
  const r = EV.countFrom(rows, {});
  assert.strictEqual(r.__stats.rows, 3);
  assert.strictEqual(r.__stats.withStage, 2, 'the blank one has no stage');
  assert.strictEqual(r.__stats.unresolvedProperty, 1);
  assert.strictEqual(r.__stats.counted, 1);
});

t('the tally does not leak into the counts', () => {
  // byProperty is iterated by the report; a __stats key in it would be read as
  // a property called __stats.
  const r = EV.countFrom([{ property_name: 'X', tenant_name: 'A', eviction_status: 'Pending Writ Wait Period' }], {});
  assert.deepStrictEqual(Object.keys(r), ['X']);
  assert.ok(r.__stats, 'but it is still reachable');
});

t('each cause of a zero gets its own sentence', () => {
  assert.ok(/store is empty/.test(EV.diagnose(EV.countFrom([], {}).__stats)));
  assert.ok(/calls it something else/.test(
    EV.diagnose(EV.countFrom([{ property_name: 'X', foo: 1 }], {}).__stats)));
  assert.ok(/none with a value/.test(
    EV.diagnose(EV.countFrom([{ property_name: 'X', eviction_status: '' }], {}).__stats)));
  const notDq = EV.countFrom([{ property_name: 'X', tenant_name: 'A', eviction_status: 'Need To File Eviction' }],
    { isDelinquent: () => false }).__stats;
  assert.ok(/not on the delinquency sheet/.test(EV.diagnose(notDq)));
});

t('a working count says nothing — silence is the success case', () => {
  const r = EV.countFrom([{ property_name: 'X', tenant_name: 'A', eviction_status: 'Pending JP Court Date' }], {});
  assert.strictEqual(EV.diagnose(r.__stats), null);
});

t('the report turns a zero into a named gap', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-build.js'), 'utf8');
  assert.ok(/EV\.diagnose\(evictions\.__stats\)/.test(build));
  assert.ok(/gaps\.push\('evictions: '/.test(build));
  assert.ok(/evictionStats:/.test(build), 'the tally must reach the response');
  // And it must not pin the column names, or detection never runs.
  assert.ok(!/status: r => EV\.clean\(r\.eviction_status\)/.test(build),
    'pinning the column is the bug this fixed');
});

t('a human label is found as readily as a snake_case name', () => {
  // THE SECOND BUG. These are CUSTOM fields and the report returns them under
  // their labels — "Eviction Status", with a capital and a space. The first
  // version listed snake_case spellings and found none on 827 rows, and no
  // amount of guessing more of them would have reached it.
  const labelled = [{ 'Tenant Name': 'A', 'Property ID': '1703', 'Eviction Status': 'Need To File Eviction' }];
  const r = EV.countFrom(labelled, { resolveValue: v => (v === '1703' ? 'Ascent at Northgate' : null) });
  assert.strictEqual(r.__stats.statusField, 'Eviction Status');
  assert.strictEqual(r.__stats.propertyField, 'Property ID');
  assert.strictEqual(r['Ascent at Northgate'].needToFile, 1);
});

t('snake_case still works — this is a widening, not a swap', () => {
  const snake = [{ tenant_name: 'A', property_name: 'X', eviction_status: 'Pending JP Court Date' }];
  const r = EV.countFrom(snake, {});
  assert.strictEqual(r.__stats.statusField, 'eviction_status');
  assert.strictEqual(r.X.evictionsInProcess, 1);
});

t('every spelling of the same label lands on one answer', () => {
  ['Eviction Status', 'eviction_status', 'EvictionStatus', 'eviction-status', 'Eviction  Status']
    .forEach(k => {
      const r = EV.countFrom([{ property_name: 'X', tenant_name: 'A', [k]: 'Need To File Eviction' }], {});
      assert.strictEqual(r.__stats.statusField, k, k + ' was not recognised');
      assert.strictEqual(r.X.needToFile, 1, k);
    });
});

t('the column probe prints names and counts, never a value', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'probe-store-columns.js'), 'utf8');
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/filled\[k\] = rows\.filter/.test(code), 'it must count, not read');
  assert.ok(!/JSON\.stringify\(\s*(r|row|sample)\s*\)/.test(code), 'it prints a row');
  assert.ok(/clean\(r\[k\]\)/.test(code), 'a cell may only be tested for emptiness');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
