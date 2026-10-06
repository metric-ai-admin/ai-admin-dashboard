// Erick's Excel Connect workbook, and what the page tells him afterwards.
//
// Six things were wrong at once, and five of them were invisible:
//   1. Excel Connect groups by property WITHOUT a Group column, so the three
//      detail sheets had no property at all.
//   2. A sheet with no rows was refused, which bounced the whole workbook on
//      any day with no billable work.
//   3. A refused upload left the previous week's files in place and Generate
//      still worked, so a stale report could go out looking normal.
//   4. The reason for the refusal was never written down.
//   5. There was no confirmation that an upload had landed.
//   6. There was no record of what had been emailed.
// And, found while checking (1): Excel Connect writes M/D/YY, which the date
// parser rejected — so every workbook upload had an empty date range and the
// staleness warning could never fire.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../billable-report.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---- fixtures ---------------------------------------------------------------
// Excel Connect: no Group column. The property is a row whose only filled cell
// is the first one; on the rows beneath it, that same column holds the WO.
const EXCEL_CSV = [
  'count(Work Order Number),Unit,Vendor,Billable Type,Created Date,Description,Billable Hours,Billed Amount,Unbilled Amount,Work Order Status',
  'Ascent at Northgate,,,,,,,,,',
  '23092-1,8-116,Metric Maintenance,Billable,10/2/26,Leak under sink,2.0,250.00,0.00,Completed',
  '23093-1,8-117,Metric Maintenance,Billable,10/3/26,Door lock,1.0,0.00,125.00,Ready to Bill',
  'The Chateau,,,,,,,,,',
  '23100-1,4-201,Metric Maintenance,Billable,10/1/26,Disposal,1.5,180.00,0.00,Completed',
].join('\n');

// Web CSV: the shape that already worked and must not change.
const WEB_CSV = [
  'Group,count(Work Order Number),Work Order Number,Work Order Status,Billable Hours,Billed Amount,Work Completed On',
  '-> Ascent at Northgate,2,,,,,',
  ',,23092-1,Completed,2.0,250.00,10/02/2026',
  ',,23093-1,Ready to Bill,1.0,0.00,10/03/2026',
].join('\n');

// A flat sheet with a real Property column — the labor summary.
const FLAT_CSV = [
  'Property,Maintenance Tech,Worked Hours,Billable Hours',
  'Ascent at Northgate,Alex Worley,8.0,7.5',
  'The Chateau,Jose Hernandez,4.0,4.0',
].join('\n');

// ---- 1. the grouped Excel Connect export ------------------------------------
t('the Excel export resolves a property, with no Group column in the file', () => {
  const p = B.parseCsv(EXCEL_CSV);
  assert.strictEqual(p.grouped, true);
  const cols = B.resolveColumns(p.headers);
  assert.strictEqual(cols.property, '__property');
  assert.deepStrictEqual(p.rows.map(r => r.__property),
    ['Ascent at Northgate', 'Ascent at Northgate', 'The Chateau']);
});

t('the property name is not left behind in the work order column', () => {
  const p = B.parseCsv(EXCEL_CSV);
  const wo = B.resolveColumns(p.headers).workOrder;
  // Every data row keeps its own number; no row carries a property name there.
  assert.deepStrictEqual(p.rows.map(r => r[wo]), ['23092-1', '23093-1', '23100-1']);
});

t('a flat sheet is untouched — its own Property column still wins', () => {
  const p = B.parseCsv(FLAT_CSV);
  assert.strictEqual(p.grouped, false);
  assert.strictEqual(B.resolveColumns(p.headers).property, 'Property');
  assert.strictEqual(p.rows.length, 2);
  assert.ok(!('Group' in p.rows[0]), 'no Group column should be invented on a flat sheet');
});

t('the web CSV path is unchanged — the arrow form still groups', () => {
  const p = B.parseCsv(WEB_CSV);
  assert.strictEqual(p.grouped, true);
  assert.deepStrictEqual(p.rows.map(r => r.__property),
    ['Ascent at Northgate', 'Ascent at Northgate']);
  assert.strictEqual(p.groupCounts['Ascent at Northgate'], 2);
});

t('a header-only sheet parses as zero rows rather than throwing', () => {
  const p = B.parseCsv(EXCEL_CSV.split('\n')[0]);
  assert.strictEqual(p.rows.length, 0);
  assert.deepStrictEqual(B.exportDate(p.rows, B.resolveColumns(p.headers)),
    { first: null, last: null });
});

// ---- the two-digit year -----------------------------------------------------
t('M/D/YY from Excel Connect yields a date range, not a blank one', () => {
  const p = B.parseCsv(EXCEL_CSV);
  const range = B.exportDate(p.rows, B.resolveColumns(p.headers));
  assert.deepStrictEqual(range, { first: '2026-10-01', last: '2026-10-03' });
});

t('M/D/YYYY and ISO still parse the same as before', () => {
  const cols = { date: 'd' };
  assert.strictEqual(B.exportDate([{ d: '10/02/2026' }], cols).first, '2026-10-02');
  assert.strictEqual(B.exportDate([{ d: '2026-10-02' }], cols).first, '2026-10-02');
});

// ---- the report survives an empty slot --------------------------------------
t('an empty daily sheet reports zeros and leaves the other periods alone', () => {
  const files = { daily: EXCEL_CSV.split('\n')[0], weekly: EXCEL_CSV, monthly: EXCEL_CSV, labor: FLAT_CSV };
  const full = { ...files, daily: EXCEL_CSV };
  const a = B.buildReport(files, { today: '2026-10-06' });
  const b = B.buildReport(full, { today: '2026-10-06' });
  assert.strictEqual(a.summary.daily.rows, 0);
  assert.strictEqual(a.summary.daily.billed, 0);
  // The period that was NOT emptied is identical in both reports.
  assert.deepStrictEqual(a.summary.weekly, b.summary.weekly);
});

// ---- 2. the route accepts an empty sheet ------------------------------------
t('the upload route refuses a missing header but accepts missing rows', () => {
  assert.ok(/has no header row\. Has it been refreshed\?/.test(server),
    'a sheet with no header must still be refused');
  assert.ok(/came through empty — no billable work in that period\./.test(server),
    'an empty sheet must be accepted with a notice');
  // The old refusal must be gone, or an empty MDaily still bounces the file.
  assert.ok(!/has no rows below the header/.test(server),
    'the "no rows below the header" refusal should no longer exist');
});

t('an empty slot skips the property-column check it could never pass', () => {
  const route = server.slice(server.indexOf("app.post('/api/billable/upload-workbook'"));
  const body = route.slice(0, route.indexOf('app.post(\'/api/billable/generate\''));
  assert.ok(body.indexOf('notices.push') < body.indexOf('has no property column'),
    'the empty-sheet branch must come before the property-column check');
  assert.ok(/continue;/.test(body.slice(body.indexOf('notices.push'))),
    'the empty branch must continue rather than fall through');
});

// ---- 3 + 4. the refusal is recorded, and it blocks --------------------------
t('every refusal in the workbook route goes through the recorder', () => {
  const start = server.indexOf("app.post('/api/billable/upload-workbook'");
  const body = server.slice(start, server.indexOf("app.post('/api/billable/generate'", start));
  // No bare 400 may remain: a refusal that is not recorded is one that cannot
  // block, and the whole failure mode is a stale report sent in silence.
  assert.ok(!/res\.status\(400\)/.test(body),
    'the workbook route should refuse only via billableRecordUploadFailure');
  assert.ok(body.split('billableRecordUploadFailure').length - 1 >= 5,
    'each refusal path should record');
});

t('the recorder writes the reason, the file and who uploaded it', () => {
  const fn = server.slice(server.indexOf('async function billableRecordUploadFailure'));
  const body = fn.slice(0, fn.indexOf('app.post('));
  assert.ok(/_lastUploadError = entry/.test(body));
  assert.ok(/reason,/.test(body) && /filename:/.test(body) && /by:/.test(body));
  assert.ok(/console\.error/.test(body), 'the reason belongs in the server log too');
});

t('Generate and Email both consult the block, and answer 409', () => {
  const gen = server.slice(server.indexOf("app.post('/api/billable/generate'"));
  assert.ok(/billableUploadBlock\(\)/.test(gen.slice(0, 1200)), 'Generate must check');
  const mail = server.slice(server.indexOf("app.post('/api/billable/email'"));
  assert.ok(/billableUploadBlock\(\)/.test(mail.slice(0, 1200)), 'Email must check');
  assert.strictEqual(server.split('res.status(409).json(blocked)').length - 1, 2);
});

t('a successful upload clears the block — both upload paths', () => {
  assert.strictEqual(server.split('delete manifest._lastUploadError').length - 1, 2,
    'the workbook upload and the per-slot CSV upload should both clear it');
});

// ---- 5. the confirmation ----------------------------------------------------
t('status exposes the last workbook, the refusal and the history', () => {
  const st = server.slice(server.indexOf("app.get('/api/billable/status'"));
  const body = st.slice(0, st.indexOf("app.post('/api/billable/upload/:slot'"));
  assert.ok(/lastWorkbook: manifest\._lastWorkbook/.test(body));
  assert.ok(/uploadError: manifest\._lastUploadError/.test(body));
  assert.ok(/sendHistory:/.test(body));
});

t('the manifest keeps the file name, the time, the sheets and the rows', () => {
  const m = server.slice(server.indexOf('manifest._lastWorkbook = {'));
  const body = m.slice(0, m.indexOf('await writeJSON'));
  ['at:', 'filename:', 'by:', 'sheets,', 'rows:', 'notices,'].forEach(k =>
    assert.ok(body.includes(k), 'the confirmation needs ' + k));
});

t('the banner is above the upload control, not below the report', () => {
  const i = html.indexOf('id="bl-last-upload"');
  assert.ok(i > 0, 'the confirmation element must exist');
  assert.ok(i < html.indexOf('id="bl-workbook-file"'),
    'it should be the first thing read on the page, before the chooser');
});

t('the confirmation is written in Central time, not sliced off the ISO string', () => {
  assert.ok(/function blWhen/.test(appjs));
  assert.ok(/timeZone: 'America\/Chicago'/.test(appjs));
  assert.ok(/'\s*CT'|' CT'/.test(appjs), 'the zone should be named on screen');
  const fn = appjs.slice(appjs.indexOf('function blRenderLastUpload'));
  const body = fn.slice(0, fn.indexOf('function blRenderSends'));
  assert.ok(/blWhen\(/.test(body), 'the banner must use it');
  assert.ok(!/\.slice\(0, 16\)/.test(body), 'no UTC string-slicing in the banner');
});

t('the banner escapes everything it renders — the file name is user input', () => {
  const fn = appjs.slice(appjs.indexOf('function blRenderLastUpload'));
  const body = fn.slice(0, fn.indexOf('function blRenderSends'));
  // Every interpolation is either escaped or a number formatter.
  const interps = body.match(/\$\{[^}]*\}/g) || [];
  interps.forEach(x => assert.ok(
    /blEsc\(|blNum\(|\.map\(|\.join\(|=== 0 \? 'empty'|sheets \|\|/.test(x),
    'unescaped interpolation in the banner: ' + x));
});

t('the buttons go dark while a refusal stands', () => {
  const fn = appjs.slice(appjs.indexOf('async function blLoadStatus'));
  const body = fn.slice(0, fn.indexOf('async function blUpload('));
  assert.ok(/const blocked = !!st\.uploadError/.test(body));
  assert.ok(/gen\.disabled = !st\.ready \|\| blocked/.test(body));
  assert.ok(/mail\.disabled = !st\.lastGenerated \|\| blocked/.test(body));
});

t('a failed upload still refreshes the page state', () => {
  const fn = appjs.slice(appjs.indexOf('async function blUploadWorkbook'));
  const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('catch (e)')));
  assert.ok(/catch \(e\) \{[\s\S]*blLoadStatus\(\)/.test(body),
    'the banner must appear without a manual reload');
});

// ---- 6. the send history ----------------------------------------------------
t('each send records the period and the workbook it came from', () => {
  const m = server.slice(server.indexOf('history.unshift({'));
  const body = m.slice(0, m.indexOf('manifest._sendHistory = history'));
  ['at:', 'by:', 'subject:', 'to:', 'cc:', 'reportDate:', 'workbook:'].forEach(k =>
    assert.ok(body.includes(k), 'the history needs ' + k));
});

t('the history is capped, so the manifest cannot grow without bound', () => {
  assert.ok(/history\.slice\(0, 30\)/.test(server));
});

t('the history is appended newest first and never replaces the list', () => {
  assert.ok(/const history = Array\.isArray\(manifest\._sendHistory\) \? manifest\._sendHistory : \[\]/
    .test(server), 'a manifest written before this feature must not throw');
  assert.ok(/history\.unshift\(/.test(server));
});

t('the history table escapes every cell', () => {
  const fn = appjs.slice(appjs.indexOf('function blRenderSends'));
  const body = fn.slice(0, fn.indexOf('async function blLoadStatus'));
  const interps = body.match(/\$\{[^}]*\}/g) || [];
  interps.forEach(x => assert.ok(
    /blEsc\(|hist\.length|hist\.map\(|\.join\('\)/.test(x),
    'unescaped interpolation in the history: ' + x));
});

t('the history element exists on the page', () => {
  assert.ok(html.includes('id="bl-sends"'));
});


// ---- the work-order count on a grouped Excel sheet --------------------------
//
// It read 0 on all three detail sheets beside 7 / 85 / 53 completed, because
// the header counts were summed UNCONDITIONALLY and Excel Connect has none:
// the property name occupies the column the count would be in. 85 distinct
// numbers were being overridden by an empty object summing to zero.
t('distinct work order numbers are counted when the headers carry no counts', () => {
  const s = B.summarisePeriod(B.parseCsv(EXCEL_CSV));
  assert.strictEqual(s.workOrders, 3);
  assert.ok(/distinct/.test(s.countedBy), s.countedBy);
});

t('the web export still trusts its header counts, which are authoritative', () => {
  // The header says 2 and only ONE data row follows: the missing one is a work
  // order with nothing billed yet, which exists only in that count.
  const csv = WEB_CSV.split('\n').slice(0, 3).join('\n');
  const s = B.summarisePeriod(B.parseCsv(csv));
  assert.strictEqual(s.workOrders, 2, 'the header count must win over the one data row');
  assert.ok(/group header/.test(s.countedBy), s.countedBy);
});

t('a work order with several billable lines counts once', () => {
  const s = B.summarisePeriod(B.parseCsv(EXCEL_CSV));
  // 23092-1, 23093-1 and 23100-1 across 3 rows; add a second line for one.
  const more = EXCEL_CSV + '\n23092-1,8-116,Metric,Inventory,10/2/26,A part,0,12.50,0.00,Completed';
  assert.strictEqual(B.summarisePeriod(B.parseCsv(more)).workOrders, s.workOrders);
});

// ---- the declared period, and staleness -------------------------------------
const META = slot => [
  [slot + ' - Work Order Billable Detail'],
  ['Exported On: 10/06/2026 1:40 PM'],
  ['Status Date: Work Done On 09/27/2026 - 10/03/2026'],
  ['Property Groups: All Active, Item Created Date Range: 01/01/0001 to 12/30/9999 (All Time)'],
  ['headerSize=5&filters%5Bstatus_date_range_relative_to%5D=2026-10-06'],
  ['count(Work Order Number)', 'Unit'],
];

t('the period is read from the Status Date line only', () => {
  assert.deepStrictEqual(B.sheetPeriod(META('MWeekly')),
    { first: '2026-09-27', last: '2026-10-03' });
});

t('"Exported On" and the relative_to in the filter URL are not the period', () => {
  const p = B.sheetPeriod(META('MWeekly'));
  assert.notStrictEqual(p.last, '2026-10-06',
    'sweeping the whole metadata block made every sheet end today and never read stale');
});

t('the all-time sentinel dates are not a period', () => {
  const p = B.sheetPeriod([[''], [''], ['Date Range: 01/01/0001 to 12/30/9999'], [''], [''], ['h']]);
  assert.deepStrictEqual(p, { first: null, last: null });
});

t('a sheet with no declared period reports nulls rather than guessing', () => {
  assert.deepStrictEqual(B.sheetPeriod([['x'], ['y'], ['z'], [''], [''], ['h']]),
    { first: null, last: null });
  assert.strictEqual(B.periodStaleDays({ first: null, last: null }, '2026-10-06', 'weekly'), null);
});

t('last week is NOT stale on a Tuesday — the week always ends Saturday', () => {
  const week = { first: '2026-09-27', last: '2026-10-03' };
  assert.strictEqual(B.periodStaleDays(week, '2026-10-06', 'weekly'), 3);
  assert.strictEqual(B.periodIsStale(week, '2026-10-06', 'weekly'), false);
});

t('a weekly file two weeks old still trips the warning', () => {
  const old = { first: '2026-09-20', last: '2026-09-26' };
  assert.strictEqual(B.periodIsStale(old, '2026-10-06', 'weekly'), true);
});

t('a period containing today is current, which is what carries the month', () => {
  const month = { first: '2026-10-01', last: '2026-10-31' };
  assert.strictEqual(B.periodStaleDays(month, '2026-10-06', 'monthly'), 0);
  assert.strictEqual(B.periodIsStale(month, '2026-10-06', 'monthly'), false);
  // And September's file, read in November, is not.
  assert.strictEqual(B.periodIsStale({ first: '2026-09-01', last: '2026-09-30' }, '2026-11-08', 'monthly'), true);
});

t('yesterday\'s daily is fine, last week\'s is not', () => {
  assert.strictEqual(B.periodIsStale({ first: '2026-10-05', last: '2026-10-05' }, '2026-10-06', 'daily'), false);
  assert.strictEqual(B.periodIsStale({ first: '2026-09-29', last: '2026-09-29' }, '2026-10-06', 'daily'), true);
});

t('each slot has its own allowance, and weekly is more than daily', () => {
  assert.ok(B.SHEET_STALE_DAYS.weekly > B.SHEET_STALE_DAYS.daily);
  ['daily', 'weekly', 'monthly', 'labor'].forEach(k =>
    assert.ok(typeof B.SHEET_STALE_DAYS[k] === 'number', k + ' needs an allowance'));
});

t('the period is captured at upload, before the metadata rows are dropped', () => {
  const route = server.slice(server.indexOf("app.post('/api/billable/upload-workbook'"));
  const body = route.slice(0, route.indexOf("app.post('/api/billable/generate'"));
  assert.ok(body.indexOf('sheetPeriod(aoa)') < body.indexOf('sheetToCsv(aoa)'),
    'sheetToCsv throws the metadata rows away, so the period must be read first');
  assert.ok(/period: out\.period \|\| null/.test(body), 'and kept in the manifest');
});

t('status prefers the declared period and falls back for a hand-uploaded CSV', () => {
  const st = server.slice(server.indexOf("app.get('/api/billable/status'"));
  const body = st.slice(0, st.indexOf("app.post('/api/billable/upload/:slot'"));
  assert.ok(/periodStaleDays\(period, ctDateStr\(0\), slot\)/.test(body));
  assert.ok(/periodIsStale\(period, ctDateStr\(0\), slot\)/.test(body));
  assert.ok(/staleDays !== null && staleDays > 2/.test(body),
    'a CSV slot has no metadata left, so it keeps the row-date rule');
});

t('the slot card shows the declared period, and labels the fallback', () => {
  const fn = appjs.slice(appjs.indexOf('async function blLoadStatus'));
  const body = fn.slice(0, fn.indexOf('async function blUpload('));
  assert.ok(/s\.period && s\.period\.last/.test(body));
  assert.ok(/\(row dates\)/.test(body), 'the weaker answer must say that it is one');
});

// ---- the real workbook, when it is on this machine --------------------------
// Skipped in CI and on Render: this is Erick's actual export, and it is the
// only thing that proves the parser against the file that was failing.
const REAL = 'C:/Users/artur/Downloads/Billable Labor Report.xlsx';
if (fs.existsSync(REAL)) {
  t('Erick\'s real workbook: all four sheets resolve a property', () => {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(REAL);
    const { sheets, missing } = B.matchSheets(wb.SheetNames);
    assert.deepStrictEqual(missing, []);
    for (const [slot, name] of Object.entries(sheets)) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      const p = B.parseCsv(B.sheetToCsv(aoa));
      assert.ok(p.rows.length > 0, slot + ' should have rows');
      assert.ok(B.resolveColumns(p.headers).property, slot + ' should resolve a property column');
    }
  });
} else {
  console.log('  --  skipped: Erick\'s workbook is not on this machine');
}

console.log(`\n${pass} passing`);
