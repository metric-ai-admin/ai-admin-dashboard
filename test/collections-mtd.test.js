// Month-to-date collections, and the alert that must never go quiet.
//
// THE FAILURE THIS GUARDS AGAINST is a silence that reads as good news.
// income_statement cannot be asked about September, so the comparison Kara
// wants is impossible until a month of our own captures exists. Every path
// through `alert` that cannot answer has to SAY it cannot answer: "not
// measurable" is a result, "no property is collecting less" on an empty table
// is a lie that looks like a pass.
//
// The second half is about the sync writing only what it was asked to write,
// and about the eight properties being eight on purpose — BY_ID holds sixteen
// ids, half of them entities nobody is asking about.
// Placeholder credentials, set BEFORE anything requires the sync: it reads
// these at module load, and the fold cannot be exercised without them. Every
// test that runs the sync stubs global.fetch, so these never reach AppFolio —
// and they are obvious nonsense so that a request escaping the stub fails
// loudly rather than authenticating.
process.env.APPFOLIO_REPORTS_CLIENT_ID =
  process.env.APPFOLIO_REPORTS_CLIENT_ID || 'test-not-a-real-id';
process.env.APPFOLIO_REPORTS_CLIENT_SECRET =
  process.env.APPFOLIO_REPORTS_CLIENT_SECRET || 'test-not-a-real-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/collections-mtd.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('collections MTD');

// ---- reading the report ----------------------------------------------------
//
// The account name and the amount are found BY SHAPE, not by column name. We
// have been wrong about a column name three times this month.

t('rent income is read whatever the columns are called', () => {
  const rows = [
    { AccountName: 'Rent Income', Amount: '56,335.98' },
    { AccountName: 'Total Income', Amount: '61,000.00' },
  ];
  const s = C.readStatement(rows);
  assert.strictEqual(s.rentIncome, 56335.98);
  assert.strictEqual(s.totalIncome, 61000);
});

t('the same rows under different column names read the same', () => {
  const a = C.readStatement([{ account: 'Rent Income', total: '100.00' }]);
  const b = C.readStatement([{ gl_account_name: 'Rent Income', period_amount: '100.00' }]);
  assert.strictEqual(a.rentIncome, 100);
  assert.strictEqual(b.rentIncome, 100);
});

t('parentheses are a negative, not a word', () => {
  assert.strictEqual(C.num('(1,234.50)'), -1234.5);
  assert.strictEqual(C.num('$1,234.50'), 1234.5);
  assert.strictEqual(C.num(''), null);
  assert.strictEqual(C.num('Rent Income'), null);
});

t('every income line is kept, not just the one we compare on', () => {
  // "Which accounts are cash receipts" is unsettled. A sync that stored only
  // today's answer could not be re-asked tomorrow without re-syncing a month
  // that AppFolio will not hand back.
  const s = C.readStatement([
    { a: 'Rent Income', v: '100' },
    { a: 'Other Income', v: '25' },
    { a: 'Laundry Revenue', v: '10' },
    { a: 'Repairs and Maintenance', v: '999' },
  ]);
  assert.strictEqual(s.accounts['Rent Income'], 100);
  assert.strictEqual(s.accounts['Other Income'], 25);
  assert.strictEqual(s.accounts['Laundry Revenue'], 10);
  assert.ok(!('Repairs and Maintenance' in s.accounts), 'an expense line is not income');
});

// ---- the alert never passes quietly ----------------------------------------

t('nothing captured at all says so', () => {
  const a = C.alert([], '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.match(a.note, /NOT MEASURABLE/);
  assert.match(a.note, /Nothing has been captured/);
});

t('history that starts today names the month the comparison becomes possible', () => {
  const h = [{ captured_on: '2026-10-16', property: 'Ascent', rent_income: 56335.98 }];
  const a = C.alert(h, '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.strictEqual(a.startedOn, '2026-10-16');
  assert.match(a.note, /history starts 2026-10-16/);
  assert.match(a.note, /2026-11/, 'says when it can first be answered');
});

t('last month on file but nothing captured today is a BROKEN SYNC, not a pass', () => {
  // The whole point. compare() finds no `now` row for anybody, returns an
  // empty list, and "no property is collecting less than last month" would be
  // a clean bill of health computed from zero rows.
  const h = [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 60000 }];
  const a = C.alert(h, '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.match(a.note, /NOT MEASURABLE TODAY/);
  assert.match(a.note, /sync did not run/);
  assert.ok(!/No property is collecting less/.test(a.note));
});

t('no reachable path reports an all-clear from an empty comparison', () => {
  // Belt and braces: whatever the history, if the alert claims it is
  // measurable it must have rows behind it.
  const histories = [
    [],
    [{ captured_on: '2026-10-16', property: 'Ascent', rent_income: 1 }],
    [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 1 }],
    [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 1 },
      { captured_on: '2026-10-16', property: 'Ascent', rent_income: 1 }],
  ];
  histories.forEach((h, i) => {
    const a = C.alert(h, '2026-10-16');
    if (a.measurable) {
      assert.ok(a.rows.length > 0, 'history ' + i + ' claimed measurable with no rows');
    } else {
      assert.match(a.note, /NOT MEASURABLE/, 'history ' + i + ' went quiet');
    }
  });
});

// ---- the comparison --------------------------------------------------------

t('this month to date against the same day last month', () => {
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 56335.98 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].delta, -3664.02);
  assert.strictEqual(rows[0].pct, -6.1);
  assert.strictEqual(rows[0].comparedOn, '2026-09-14');
});

t('a later capture in the same month is not used as the comparison point', () => {
  // Comparing the 14th against the 30th would make every property look like a
  // collapse. The match is the LATEST capture at or before the same day.
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-09-30', property: 'Ascent', rent_income: 95000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 59000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows[0].comparedOn, '2026-09-14');
  assert.strictEqual(rows[0].delta, -1000);
});

t('the 31st of a month after a 30-day month falls back rather than comparing nothing', () => {
  const h = [
    { captured_on: '2026-09-30', property: 'Ascent', rent_income: 95000 },
    { captured_on: '2026-10-31', property: 'Ascent', rent_income: 90000 },
  ];
  const rows = C.compare(h, '2026-10-31');
  assert.strictEqual(rows[0].comparedOn, '2026-09-30');
  assert.strictEqual(rows[0].delta, -5000);
});

t('a property with no capture last month is named, not dropped', () => {
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Hyde Park Square', rent_income: 12000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  const hps = rows.find(r => r.property === 'Hyde Park Square');
  assert.ok(hps, 'the new property is in the list');
  assert.strictEqual(hps.delta, null);
  assert.match(hps.why, /no capture from 2026-09/);
});

t('the portfolio is a row like any other, under *', () => {
  const h = [
    { captured_on: '2026-09-14', property: '*', rent_income: 311166.4 },
    { captured_on: '2026-10-14', property: '*', rent_income: 300000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows[0].property, C.PORTFOLIO);
  assert.strictEqual(rows[0].delta, -11166.4);
});

t('prevMonth crosses the year', () => {
  assert.strictEqual(C.prevMonth('2026-01'), '2025-12');
  assert.strictEqual(C.prevMonth('2026-10'), '2026-09');
  assert.strictEqual(C.nextMonth('2026-12-16'), '2027-01');
});

// ---- what period is this ---------------------------------------------------

t('the period check is a ratio with reasoning, never a verdict', () => {
  const full = C.periodCheck(56000, 60000, '2026-10-14');
  assert.ok(full.ratio > 0.8);
  assert.match(full.note, /consistent with the current month/);
  const tiny = C.periodCheck(600, 60000, '2026-10-14');
  assert.match(tiny.note, /probably NOT the current month/);
  // Nothing in it asserts an answer.
  assert.ok(!('period' in full) && !('isCurrentMonth' in full));
});

t('no monthly rent means no check, rather than a check against zero', () => {
  assert.strictEqual(C.periodCheck(56000, 0, '2026-10-14'), null);
  assert.strictEqual(C.periodCheck(null, 60000, '2026-10-14'), null);
});

// ---- the sync ---------------------------------------------------------------

const syncSrc = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'sync-collections-mtd.js'), 'utf8');

// My own prose has tripped my own tests five times. Comments and string
// literals are stripped before anything is searched for.
//
// SCANNED, NOT PATTERN-MATCHED. The first version of this used one regex per
// quote character. A comment containing an apostrophe — "each property's
// monthly rent" — put every quote after it out of phase, which silently ate
// the write statement and made "the sync writes to collections_mtd" fail by
// finding nothing at all. A regex cannot know whether a quote opens or closes.
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      out += c + c;                       // an empty literal keeps the syntax
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const code = strip(syncSrc);

t('the sync writes to collections_mtd and to nothing else', () => {
  // db.from, not Buffer.from — the Basic auth header is also a .from() call.
  const tables = [...code.matchAll(/db\.from\(([^)]*)\)/g)].map(m => m[1].trim());
  // Every table name was a string literal and is now ''. What matters is that
  // there is exactly one write target, and the raw source names only the one.
  assert.strictEqual(tables.length, 1, 'one .from() call: ' + JSON.stringify(tables));
  const named = [...syncSrc.matchAll(/db\.from\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepStrictEqual(named, ['collections_mtd']);
});

t('the only write verb is the daily upsert', () => {
  assert.ok(/\.upsert\(/.test(code), 'it upserts');
  assert.ok(!/\.insert\(/.test(code), 'no insert');
  assert.ok(!/\.delete\(/.test(code), 'no delete');
  assert.ok(!/\.update\(/.test(code), 'no update');
});

t('--dry-run reaches the upsert check before the upsert', () => {
  assert.ok(code.indexOf('if (DRY)') < code.indexOf('.upsert('),
    'the dry-run return is above the write');
});

t('the capture is ONE call, not one per property', () => {
  // The per-property breakdown made nine spaced calls unnecessary, and with
  // them went the ten-minute window across which eight properties used to be
  // captured from eight different instants.
  const fetches = (code.match(/global\.fetch\(/g) || []).length;
  assert.strictEqual(fetches, 1, 'one fetch in the file');
  assert.ok(/429/.test(syncSrc), 'rate limiting is still handled');
});

t('it asks for the cash basis explicitly', () => {
  // accounting_basis is honoured on this report and ignored on
  // income_statement, which is the entire reason the report changed.
  assert.match(syncSrc, /accounting_basis: 'Cash'/);
  assert.match(syncSrc, /income_statement_comparison/);
  assert.ok(!/reports\/income_statement\.json/.test(code),
    'the endpoint that ignores the basis is no longer called');
});

t('the property filter is the one shape that actually filters', () => {
  // properties_ids inside a `properties` object. property_ids, property_id and
  // a bare array were all accepted and IGNORED — same portfolio number every
  // time, which is indistinguishable from a working filter if you count rows.
  assert.ok(/properties_ids/.test(syncSrc));
  assert.ok(!/body\.property_ids/.test(code));
});

t('ids it cannot resolve are printed, not dropped quietly', () => {
  // A property added in AppFolio and not yet in the id map would otherwise
  // vanish from the capture and look exactly like one that collected nothing.
  assert.ok(/unresolved/.test(code), 'unresolved ids are tracked');
  assert.ok(/not captured/.test(syncSrc), 'and they are printed');
});

t('an unreadable breakdown stops the capture instead of storing zeroes', () => {
  assert.ok(/shapeProblem/.test(code), 'an unrecognised shape is noticed');
  assert.ok(/throw new Error/.test(code.slice(code.indexOf('shapeProblem'))),
    'and it throws rather than continuing');
  assert.ok(code.indexOf('shapeProblem') < code.indexOf('.upsert('),
    'the check is before the write');
});

t('the sync is importable, so the cron runs the tested code', () => {
  const m = require('../scripts/sync-collections-mtd.js');
  assert.strictEqual(typeof m.syncCollectionsMtd, 'function');
});

t('requiring the sync does not run it', () => {
  // It used to be a bare IIFE. Required from server.js that would fire nine
  // AppFolio calls at boot.
  assert.ok(/require\.main === module/.test(code),
    'the CLI entry point is guarded');
});

// ---- the cron ---------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The schedule is read by walking BACK from the require to the cron.schedule
// above it. Matching forward from cron.schedule across a block that contains a
// semicolon is how the first version of this test found nothing and said so.
function cronSlot() {
  const at = server.indexOf('sync-collections-mtd.js');
  if (at < 0) return null;
  const before = server.slice(0, at);
  const starts = [...before.matchAll(/cron\.schedule\('(\d+) (\d+) \* \* \*'/g)];
  const last = starts[starts.length - 1];
  return last ? { minute: Number(last[1]), hour: Number(last[2]) } : null;
}

t('the capture runs before the 06:00 brief that reads it', () => {
  const slot = cronSlot();
  assert.ok(slot, 'the collections sync has its own cron slot');
  const hour = slot.hour;
  assert.ok(hour < 6, 'it is scheduled before 06:00, not after (hour ' + hour + ')');
});

t('it does not land inside the 05:00 block', () => {
  // That hour is full to :55 and the comment at delinquency_kpi says anything
  // else has to displace something rather than squeeze between.
  assert.notStrictEqual(cronSlot().hour, 5, 'not in the 05:00 hour');
});

t('the capture does not run until the basis is settled', () => {
  // Arturo, 2026-10-14: income_statement reports BILLED income, not cash
  // received — Ascent came back above its own monthly rent while carrying
  // 16,118 of delinquency. A month of history on the wrong basis would look
  // healthy the whole time and then answer the wrong question, by property, in
  // Kara's 6 AM email. The cron stays gated until a cash source is found or
  // the alert is relabelled.
  const at = server.indexOf('sync-collections-mtd.js');
  const block = server.slice(server.lastIndexOf('cron.schedule', at), at);
  assert.ok(/COLLECTIONS_MTD_ON/.test(block), 'the job checks the gate');
  assert.ok(/COLLECTIONS_MTD_SYNC/.test(server), 'the gate is an environment variable');
  // Default OFF: the gate opens only on the exact string, so an unset or
  // misspelled variable keeps it closed.
  // The const line, not the comment above it that names the variable in prose.
  const def = server.match(/const COLLECTIONS_MTD_ON[^\n]*\n/)[0];
  assert.ok(/\|\|\s*''/.test(def), 'an unset variable is empty, not undefined');
  assert.ok(/===\s*'on'/.test(def), 'it opens only on the exact string');
});

t('the alert is not labelled as cash until it is cash', () => {
  // Point 2 of the same message: if there is no cash-basis source, the alert
  // must not say "collections". This holds the file to carrying that warning
  // so the next person to wire it up meets the question.
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collections-mtd.js'), 'utf8');
  assert.ok(/billed/i.test(lib), 'the basis problem is written down in the module');
});

// ---- the comparison report's per-property field -----------------------------

t('an object keyed by property is read', () => {
  const b = C.breakdown({ 'Ascent at Northgate': '42,164.55', 'Hyde Park Square': 12000 });
  assert.strictEqual(b.map['Ascent at Northgate'], 42164.55);
  assert.strictEqual(b.map['Hyde Park Square'], 12000);
  assert.match(b.how, /object with 2 keys/);
});

t('an array of name/amount pairs is read', () => {
  const b = C.breakdown([
    { name: 'Ascent at Northgate', amount: '42,164.55' },
    { property_name: 'Hyde Park Square', value: 12000 },
  ]);
  assert.strictEqual(b.map['Ascent at Northgate'], 42164.55);
  assert.strictEqual(b.map['Hyde Park Square'], 12000);
});

t('an UNRECOGNISED shape says so instead of returning an empty map', () => {
  // An empty breakdown and an absent one look identical from the outside.
  // That is exactly how the tenant directory synced 411 rows and zero phone
  // numbers: the projection could not report what it had thrown away.
  const b = C.breakdown([{ unexpected: 1, fields: 2 }]);
  assert.deepStrictEqual(b.map, {});
  assert.match(b.how, /unrecognised shape/);
  assert.match(b.how, /unexpected/, 'and it shows what it actually got');
});

t('a single number is not mistaken for a breakdown', () => {
  const b = C.breakdown('311,166.40');
  assert.deepStrictEqual(b.map, {});
  assert.match(b.how, /not per property/);
});

t('an absent field is distinguished from an empty one', () => {
  assert.match(C.breakdown(null).how, /absent/);
  assert.match(C.breakdown(undefined).how, /absent/);
  assert.match(C.breakdown({}).how, /object with 0 keys/);
});

// ---- seeding October from Katie's workbooks ---------------------------------
//
// The workbooks hold two tabs of the SAME report: MTD Cash and MTD Accrual.
// Ascent at 10/12 is 42,164.55 cash against 48,175.63 accrual. Seeding the
// wrong one would put the wrong basis into the history silently — which is the
// whole reason the daily capture is switched off.
const XLSX = require('xlsx');
const { spawnSync } = require('child_process');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtd-seed-'));
function workbook(name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([tab, aoa]) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), tab));
  const file = path.join(tmp, name);
  XLSX.writeFile(wb, file);
  return file;
}
const CASH_SHEET = [
  ['Income Statement - Property Comparison', null, null, null],
  ['Accounting Basis: Cash   Period Basis: Calendar', null, null, null],
  ['Account', 'Ascent at Northgate', 'Hyde Park Square', 'Some Other LLC'],
  ['Rent Income', 42164.55, 12000.11, 999.99],
  ['Total Income', 43364.55, 12300.11, 1009.99],
];
const ACCRUAL_SHEET = CASH_SHEET.map((r, i) =>
  (i === 3 ? ['Rent Income', 48175.63, 13000, 1100] : r.slice()));

const seed = (...args) => spawnSync(process.execPath,
  [path.join(__dirname, '..', 'scripts', 'seed-collections-mtd.js'), ...args],
  { encoding: 'utf8' });

t('the seed reads the cash tab and ignores the accrual one', () => {
  const f = workbook('both.xlsx', { 'MTD Cash': CASH_SHEET, 'MTD Accrual': ACCRUAL_SHEET });
  const r = seed('--as-of', '2026-10-12', '--dry-run', f);
  assert.match(r.stdout, /42,164\.55/, 'the cash figure');
  assert.ok(!/48,175\.63/.test(r.stdout), 'the accrual figure never appears');
  assert.match(r.stdout, /MTD Cash/);
});

t('a workbook with only an accrual tab is REFUSED, not read anyway', () => {
  const f = workbook('accrual.xlsx', { 'MTD Accrual': ACCRUAL_SHEET });
  const r = seed('--as-of', '2026-10-12', '--dry-run', f);
  assert.notStrictEqual(r.status, 0, 'it fails rather than seeding the wrong basis');
  assert.match(r.stderr + r.stdout, /no cash tab/);
});

t('the header is found below the title rows', () => {
  // Row 0 is the report title and row 1 the settings line. Reading row 0 as
  // the header would make every column unrecognisable and seed nothing, which
  // looks identical to a workbook with no properties in it.
  const f = workbook('titled.xlsx', { 'MTD Cash': CASH_SHEET });
  const r = seed('--describe', f);
  assert.match(r.stdout, /header row: #3/);
  assert.match(r.stdout, /Rent Income" row: FOUND/);
});

t('columns that are not one of our properties are named, not dropped', () => {
  const f = workbook('extra.xlsx', { 'MTD Cash': CASH_SHEET });
  const r = seed('--as-of', '2026-10-12', '--dry-run', f);
  assert.match(r.stdout, /not seeded: Some Other LLC/);
});

t('no portfolio row is seeded', () => {
  // The sum of the columns we recognise is not the portfolio — the report
  // carries sixteen entities. Storing it under '*' would make November's
  // portfolio comparison show a cliff that is pure arithmetic.
  const f = workbook('port.xlsx', { 'MTD Cash': CASH_SHEET });
  const r = seed('--as-of', '2026-10-12', '--dry-run', f);
  assert.match(r.stdout, /NO PORTFOLIO ROW IS WRITTEN/);
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'seed-collections-mtd.js'), 'utf8');
  assert.ok(!/property:\s*C\.PORTFOLIO/.test(src), 'it never builds a portfolio row');
});

t('--as-of is required, and --write without it reaches no database', () => {
  const f = workbook('noasof.xlsx', { 'MTD Cash': CASH_SHEET });
  const r = seed('--write', f);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--as-of/);
  assert.ok(!/stored:/.test(r.stdout), 'nothing was stored');
});

t('two workbooks at once are refused — each has its own as-of date', () => {
  const a = workbook('a.xlsx', { 'MTD Cash': CASH_SHEET });
  const b = workbook('b.xlsx', { 'MTD Cash': CASH_SHEET });
  const r = seed('--as-of', '2026-10-12', '--dry-run', a, b);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /One file at a time/);
});

t('seeded rows are marked as seeded', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'seed-collections-mtd.js'), 'utf8');
  assert.match(src, /katie_workbook_cash/, 'the source distinguishes them from captures');
  assert.match(src, /cash basis/, 'the period note records the basis');
});

t('the seed writes to collections_mtd and nothing else', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'seed-collections-mtd.js'), 'utf8');
  const named = [...src.matchAll(/db\.from\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepStrictEqual(named, ['collections_mtd']);
  assert.ok(!/\.delete\(/.test(src) && !/\.insert\(/.test(src));
});

// ---- the fold, against a stubbed report -------------------------------------
//
// The transpose — account lines carrying a per-property breakdown, turned into
// one account map per property — is the riskiest new code, and grepping the
// source for words cannot tell whether it adds up. This runs it.
//
// These are async, so they go last and own the exit.
const ta = (name, fn) => fn().then(
  () => { pass++; console.log('  ok   ' + name); },
  e => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); });

const REPORT_ROWS = [
  { account_name: 'Rent Income', total: '54164.66',
    properties: [{ id: 1703, value: '42164.55' }, { id: 1803, value: '12000.11' },
      { id: 1925, value: '0.00' }] },
  { account_name: 'Other Income', total: '1510.00',
    properties: [{ id: 1703, value: '1200.00' }, { id: 1803, value: '300.00' }] },
  { account_name: 'Repairs and Maintenance', total: '9999.00',
    properties: [{ id: 1703, value: '9999.00' }] },
];

async function runSync(rows) {
  const real = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => rows, text: async () => JSON.stringify(rows),
  });
  const out = [];
  try {
    const { syncCollectionsMtd } = require('../scripts/sync-collections-mtd.js');
    // A stand-in period: the real parameter is not known yet, and without one
    // the sync refuses to run (see the test below). This exercises the fold.
    const result = await syncCollectionsMtd({
      dryRun: true, period: { probe_only: '2026-10' }, log: m => out.push(String(m)),
    });
    return { result, text: out.join('\n') };
  } finally { global.fetch = real; }
}

(async () => {
  await ta('one call produces the portfolio row and a row per property', async () => {
    const { result, text } = await runSync(REPORT_ROWS);
    assert.ok(result.captured >= 2, 'the portfolio plus at least one property');
    assert.strictEqual(result.written, 0, 'a dry run writes nothing');
    assert.match(text, /one call/);
    assert.match(text, /PORTFOLIO/);
  });

  await ta('entities we choose not to capture are named', async () => {
    // 1925 is 17th Street, held out until somebody confirms it is a managed
    // property. Holding it out quietly would make it indistinguishable, a
    // month from now, from a property that fell out of the capture.
    const { text } = await runSync(REPORT_ROWS);
    assert.match(text, /not captured \(not one of the eight/);
  });

  await ta('an expense line is not folded into income', async () => {
    const { text } = await runSync(REPORT_ROWS);
    assert.ok(!/Repairs and Maintenance/.test(text),
      'an expense account never reaches the income lines');
  });

  await ta('an unreadable breakdown throws rather than capturing zeroes', async () => {
    // The shape changed once already: [{id, value}] was not recognised by the
    // first version of breakdown(). If it changes again the capture must stop
    // — a row of zeroes would enter the history as a month in which nobody
    // paid, and every property would read as a collapse for thirty days.
    await assert.rejects(
      () => runSync([{ account_name: 'Rent Income', total: '100',
        properties: [{ surprise: 1, newShape: 2 }] }]),
      /not readable|nothing captured/i);
  });

  await ta('a genuine zero is captured, not treated as a missing property', async () => {
    const { text } = await runSync([{ account_name: 'Rent Income', total: '0.00',
      properties: [{ id: 1703, value: '0.00' }] }]);
    assert.match(text, /income lines/, 'the capture still happens');
    assert.ok(!/FAILED/.test(text));
  });

  await ta('without a period parameter the sync REFUSES to capture', async () => {
    // The report answers for a period of its own choosing — 311,166.40 where
    // AppFolio shows October as 278,803.67 — and the row would be stored under
    // today's date. A history of the wrong month under the right dates is
    // worse than no history: every figure in it is real, so nothing ever looks
    // wrong. This is what the cron hits today, by design.
    const real = global.fetch;
    global.fetch = async () => { throw new Error('the sync must not reach AppFolio at all'); };
    try {
      const { syncCollectionsMtd } = require('../scripts/sync-collections-mtd.js');
      await assert.rejects(() => syncCollectionsMtd({ dryRun: true, log: () => {} }),
        /period parameter has not been found/);
    } finally { global.fetch = real; }
  });

  await ta('the refusal happens before any request is made', async () => {
    // Not after fetching and discarding: a refusal that still calls AppFolio
    // every morning is a quota spent on a result thrown away.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'sync-collections-mtd.js'), 'utf8');
    assert.ok(src.indexOf('period parameter has not been found') < src.indexOf('await statement('),
      'the guard is above the call');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
