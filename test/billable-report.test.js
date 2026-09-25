// The Billable Labor Report.
//
// Built from CSVs a person exports by hand, which is the whole reason these
// tests are detailed: the file can arrive with the web UI's human column
// labels or the API's snake_case, with money as "$1,234.50" or "(45.00)", with
// a title line above the header, and with a Total row at the bottom. Every one
// of those silently produces a wrong number rather than an error.
const assert = require('assert');
const B = require('../billable-report.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// ---- fixtures ---------------------------------------------------------------
// Web-UI spelling: human labels, US dates, money with symbols.
const UI_CSV = [
  'Work Order Billable Detail',                       // a title line above the header
  'Property Name,Work Order Number,Work Order Status,Maintenance Tech,Billable Hours,Worked Hours,Billed Amount,Unbilled Amount,Work Completed On',
  'Ascent at Northgate,21818-1,Completed,Alex Worley (Hidden),2.5,3.0,"$1,250.00",$0.00,09/22/2026',
  'Ascent at Northgate,21818-1,Completed,Alex Worley (Hidden),1.0,1.0,$500.00,$0.00,09/22/2026',
  'Ascent at Northgate,21900-1,Ready to Bill,Fredy Ramirez,4.0,4.5,$0.00,"$2,000.00",09/22/2026',
  'The Chateau,22001-1,Work Done,Jose Hernandez,1.5,2.0,$0.00,$750.00,09/21/2026',
  'The Chateau,22002-1,Assigned,Jose Hernandez,0,0,$0.00,$0.00,09/21/2026',
  '513 Wolf Ridge,22100-1,Completed,Alex Worley,9.0,9.0,"$9,999.00",$0.00,09/22/2026',
  'Metric Property Management of Texas LLC,22101-1,Completed,Arturo Mendoza,1.0,1.0,$100.00,$0.00,09/22/2026',
  'Total,,,,19.5,20.5,,,',                            // a total row at the bottom
].join('\n');

// API spelling: snake_case, ISO dates, bare numbers.
const API_CSV = [
  'property_name,work_order_number,work_order_status,maintenance_tech,hours,worked_hours,date',
  'Hyde Park Square,23172-1,Completed,Carlos Portilla,0.25,0.20,2026-09-22',
  'Hyde Park Square,23173-1,Ready to Bill,Carlos Portilla,1.00,1.50,2026-09-22',
  'Sunset Palms,23174-1,Work Done,Emerson  Garcia -,2.00,2.00,2026-09-20',
  'Lily Pad Lane,23175-1,Completed,Carlos Portilla,5.00,5.00,2026-09-22',
].join('\n');

const parseUI = () => B.parseCsv(UI_CSV);
const parseAPI = () => B.parseCsv(API_CSV);

console.log('CSV parsing');
t('skips a title line and finds the real header', () => {
  const p = parseUI();
  assert.ok(p.headers.includes('Work Order Status'), p.headers.join('|'));
  assert.strictEqual(p.headers[0], 'Property Name');
});
t('drops the Total row rather than counting it as a work order', () => {
  assert.strictEqual(parseUI().rows.length, 7);
});
t('a quoted field containing a comma does not shift the columns', () => {
  const r = parseUI().rows[0];
  assert.strictEqual(r['Billed Amount'], '$1,250.00');
  assert.strictEqual(r['Work Completed On'], '09/22/2026');
});
t('an escaped quote inside a field survives', () => {
  const p = B.parseCsv('a,b\n"he said ""hi""",2');
  assert.strictEqual(p.rows[0].a, 'he said "hi"');
});
t('a newline inside a quoted field does not split the row', () => {
  const p = B.parseCsv('a,b\n"line one\nline two",2');
  assert.strictEqual(p.rows.length, 1);
  assert.strictEqual(p.rows[0].b, '2');
});
t('a BOM does not corrupt the first header', () => {
  const p = B.parseCsv('﻿property_name,hours\nX,1');
  assert.ok(p.headers.includes('property_name'), p.headers.join('|'));
});
t('blank lines are ignored', () => {
  assert.strictEqual(B.parseCsv('a,b\n1,2\n\n\n3,4').rows.length, 2);
});

console.log('\nmoney and hours');
t('currency symbols and thousands separators parse', () => {
  assert.strictEqual(B.num('$1,250.00'), 1250);
  assert.strictEqual(B.num('1,234.56'), 1234.56);
});
t('accounting negatives parse as negative', () => {
  assert.strictEqual(B.num('(45.00)'), -45);
  assert.strictEqual(B.num('($1,000.00)'), -1000);
});
t('empty and junk are zero, not NaN', () => {
  [' ', '', null, undefined, 'n/a', '-'].forEach(v => assert.strictEqual(B.num(v), 0, JSON.stringify(v)));
});

console.log('\ncolumn resolution across both spellings');
t('web-UI labels resolve', () => {
  const c = B.resolveColumns(parseUI().headers);
  assert.strictEqual(c.status, 'Work Order Status');
  assert.strictEqual(c.billableHours, 'Billable Hours');
  assert.strictEqual(c.workedHours, 'Worked Hours');
  assert.strictEqual(c.billedAmount, 'Billed Amount');
});
t('API snake_case resolves', () => {
  const c = B.resolveColumns(parseAPI().headers);
  assert.strictEqual(c.status, 'work_order_status');
  assert.strictEqual(c.property, 'property_name');
});
t('"hours" does not swallow "worked_hours"', () => {
  // Both exist in the API export; an over-eager contains() match would map
  // billableHours and workedHours to the same column and double-count.
  const c = B.resolveColumns(parseAPI().headers);
  assert.strictEqual(c.billableHours, 'hours');
  assert.strictEqual(c.workedHours, 'worked_hours');
  assert.notStrictEqual(c.billableHours, c.workedHours);
});
t('a missing column is null rather than silently zero', () => {
  const c = B.resolveColumns(['property_name']);
  assert.strictEqual(c.billedAmount, null);
});

console.log('\nexclusions');
t('the shared fragments are excluded', () => {
  ['513 Wolf Ridge', 'Lily Pad Lane', 'The Sidney', 'Brazos Lofts', 'Live With Metric']
    .forEach(p => assert.ok(B.isExcludedProperty(p), p));
});
t('the corporate entity is excluded', () => {
  assert.ok(B.isExcludedProperty('Metric Property Management of Texas LLC'));
});
t('managed properties are NOT excluded', () => {
  ['Ascent at Northgate', 'The Chateau', 'Hyde Park Square', 'iConic Round Rock', 'Windy Hill Apartment']
    .forEach(p => assert.ok(!B.isExcludedProperty(p), p));
});
t('excluded rows are counted, not just dropped', () => {
  const s = B.summarisePeriod(parseUI());
  assert.strictEqual(s.rowsExcluded, 2);   // Wolf Ridge + the LLC
  assert.strictEqual(s.rows, 5);
});

console.log('\nstatus grouping');
t('the three groups match on either spelling', () => {
  assert.strictEqual(B.statusGroup('Work Done'), 'workDone');
  assert.strictEqual(B.statusGroup('ready_to_bill'), 'readyToBill');
  assert.strictEqual(B.statusGroup('Ready To Bill'), 'readyToBill');
  assert.strictEqual(B.statusGroup('Completed'), 'completed');
  assert.strictEqual(B.statusGroup('Completed No Need To Bill'), 'completed');
});
t('an unknown status is not silently bucketed', () => {
  assert.strictEqual(B.statusGroup('Assigned'), null);
});

console.log('\nperiod summary');
t('counts, hours and money add up with exclusions applied', () => {
  const s = B.summarisePeriod(parseUI());
  assert.strictEqual(s.completed, 2);      // two Ascent rows
  assert.strictEqual(s.readyToBill, 1);
  assert.strictEqual(s.workDone, 1);
  assert.strictEqual(s.otherStatus, 1);    // Assigned
  assert.strictEqual(s.billableHours, 9);  // 2.5+1+4+1.5+0
  assert.strictEqual(s.billed, 1750);      // 1250+500, Wolf Ridge's 9999 excluded
  assert.strictEqual(s.unbilled, 2750);    // 2000+750
});
t('work orders are counted DISTINCT, not per row', () => {
  // 21818-1 appears twice; counting rows would say 5 work orders.
  assert.strictEqual(B.summarisePeriod(parseUI()).workOrders, 4);
});
t('the date range is read out of the rows', () => {
  const s = B.summarisePeriod(parseUI());
  assert.strictEqual(s.dateRange.first, '2026-09-21');
  assert.strictEqual(s.dateRange.last, '2026-09-22');
});
t('missing columns are named', () => {
  const s = B.summarisePeriod(B.parseCsv('property_name,hours\nX,1'));
  assert.ok(s.columnsMissing.includes('billedAmount'), s.columnsMissing.join(','));
});

console.log('\nby property');
t('one row per property, excluded ones absent', () => {
  const rows = B.byProperty(parseUI());
  assert.deepStrictEqual(rows.map(r => r.property).sort(), ['Ascent at Northgate', 'The Chateau']);
});
t('the >10 work-order alert fires only above the threshold', () => {
  const header = 'property_name,work_order_number,work_order_status,hours\n';
  const many = header + Array.from({ length: 11 }, (_, i) => `Busy,WO-${i},Completed,1`).join('\n');
  const few = header + Array.from({ length: 10 }, (_, i) => `Calm,WO-${i},Completed,1`).join('\n');
  assert.strictEqual(B.byProperty(B.parseCsv(many))[0].alert, true, '11 should alert');
  assert.strictEqual(B.byProperty(B.parseCsv(few))[0].alert, false, '10 should not');
});
t('the threshold is configurable', () => {
  const csv = 'property_name,work_order_number,work_order_status,hours\n'
    + Array.from({ length: 6 }, (_, i) => `P,WO-${i},Completed,1`).join('\n');
  assert.strictEqual(B.byProperty(B.parseCsv(csv), { woAlertThreshold: 5 })[0].alert, true);
});

console.log('\nby technician');
t('AppFolio name suffixes are tidied so one person is one row', () => {
  assert.strictEqual(B.cleanTech('Alex Worley (Hidden)'), 'Alex Worley');
  assert.strictEqual(B.cleanTech('Emerson  Garcia -'), 'Emerson Garcia');
  assert.strictEqual(B.cleanTech(''), '(unassigned)');
});
t('a tech under two spellings collapses into one row', () => {
  const csv = 'property_name,work_order_number,maintenance_tech,hours,worked_hours\n'
    + 'A,1,Alex Worley (Hidden),2,3\n'
    + 'B,2,Alex Worley,1,1\n';
  const rows = B.byTech(B.parseCsv(csv));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].hours, 3);
  assert.strictEqual(rows[0].properties, 2);
});
t('the worked-versus-billable gap is reported', () => {
  const csv = 'property_name,work_order_number,maintenance_tech,hours,worked_hours\nA,1,Tech,2,5\n';
  assert.strictEqual(B.byTech(B.parseCsv(csv))[0].unbillableHours, 3);
});
t('excluded properties do not reach the tech tables', () => {
  const csv = 'property_name,work_order_number,maintenance_tech,hours,worked_hours\n'
    + '513 Wolf Ridge,1,Ghost,9,9\n';
  assert.strictEqual(B.byTech(B.parseCsv(csv)).length, 0);
  assert.strictEqual(B.byPropertyAndTech(B.parseCsv(csv)).length, 0);
});

console.log('\nthe whole report');
const report = () => B.buildReport(
  { daily: UI_CSV, weekly: UI_CSV, monthly: UI_CSV, labor: API_CSV },
  { today: '2026-09-23' });

t('all three periods and both tech tables are present', () => {
  const r = report();
  ['daily', 'weekly', 'monthly'].forEach(k => assert.ok(r.summary[k], k));
  assert.ok(r.byTech.length > 0);
  assert.ok(r.byPropertyAndTech.length > 0);
});
t('staleness is measured against the passed-in today, not the clock', () => {
  const fresh = B.buildReport({ daily: UI_CSV, weekly: UI_CSV, monthly: UI_CSV, labor: API_CSV }, { today: '2026-09-23' });
  assert.strictEqual(fresh.summary.daily.staleDays, 1);
  assert.strictEqual(fresh.summary.daily.stale, false);
  const old = B.buildReport({ daily: UI_CSV, weekly: UI_CSV, monthly: UI_CSV, labor: API_CSV }, { today: '2026-10-30' });
  assert.strictEqual(old.summary.daily.stale, true);
});
t('a missing file yields an empty period rather than throwing', () => {
  const r = B.buildReport({ daily: UI_CSV }, { today: '2026-09-23' });
  assert.strictEqual(r.summary.weekly.rows, 0);
  assert.strictEqual(r.byTech.length, 0);
});
t('the excluded fragments are reported so the UI can show them', () => {
  assert.ok(report().excludedFragments.includes('metric property management of texas'));
});

console.log('\nCSV export');
t('a formula-leading cell is neutralised', () => {
  const csv = B.toCsv([{ p: '=cmd|calc' }], [{ key: 'p', label: 'Property' }]);
  assert.ok(csv.includes("'=cmd|calc"), csv);
});
t('commas and quotes are escaped', () => {
  const csv = B.toCsv([{ p: 'A, B "C"' }], [{ key: 'p', label: 'Property' }]);
  assert.ok(csv.includes('"A, B ""C"""'), csv);
});
t('the header uses the labels', () => {
  assert.ok(B.toCsv([], [{ key: 'p', label: 'Property' }]).startsWith('Property\n'));
});

console.log('\nthe REAL AppFolio format — grouped, no property column');
// The export has no property column at all. The first column is "Group", the
// property is a row reading "-> Hyde Park Square", and its work orders are the
// rows beneath it. That header row is also a SUBTOTAL, and the data rows carry
// no work-order number — only count(Work Order Number) on the header.
const GROUPED = [
  'Group,count(Work Order Number),Unit,Vendor,Billable Type,Created Date,Description,GL Account,Quantity,Rate,Amount,Worked Hours,Billable Hours,Work Order Status,Billed Amount,Unbilled Amount',
  '-> Hyde Park Square,12,,,,,,,,,"$3,600.00",14.4,12.0,,"$3,600.00",$0.00',
  ',,5-224,Acme Plumbing,Tenant,09/22/2026,Leak under sink,6595,1,300,$300.00,1.2,1.0,Completed,$300.00,$0.00',
  ',,3-101,Acme Plumbing,Owner,09/22/2026,Door lock,6595,1,300,$300.00,1.2,1.0,Ready to Bill,$0.00,$300.00',
  '-> Ascent at Northgate,2,,,,,,,,,"$1,250.00",3.0,2.5,,"$1,250.00",$0.00',
  ',,A-12,Bright Electric,Owner,09/21/2026,Breaker,6595,1,1250,"$1,250.00",3.0,2.5,Work Done,$0.00,"$1,250.00"',
  '-> 513 Wolf Ridge,9,,,,,,,,,"$9,999.00",9.0,9.0,,"$9,999.00",$0.00',
  ',,W-1,Ghost Vendor,Owner,09/22/2026,Excluded,6595,1,9999,"$9,999.00",9.0,9.0,Completed,"$9,999.00",$0.00',
].join('\n');

t('the Group column is detected and the format flagged', () => {
  const p = B.parseCsv(GROUPED);
  assert.strictEqual(p.grouped, true);
  assert.ok(p.groupCounts);
});
t('"-> Name" rows set the property for the rows beneath them', () => {
  const p = B.parseCsv(GROUPED);
  assert.deepStrictEqual(p.rows.map(r => r.__property),
    ['Hyde Park Square', 'Hyde Park Square', 'Ascent at Northgate', '513 Wolf Ridge']);
});
t('the group header is a SUBTOTAL and is not kept as data', () => {
  // 8 lines in, 1 header + 3 group rows removed = 4 data rows. Keeping the
  // group rows would add a phantom work order per property AND double the
  // money, since their amount columns repeat the group totals.
  assert.strictEqual(B.parseCsv(GROUPED).rows.length, 4);
});
t('count(Work Order Number) is read off the header', () => {
  const p = B.parseCsv(GROUPED);
  assert.strictEqual(p.groupCounts['Hyde Park Square'], 12);
  assert.strictEqual(p.groupCounts['Ascent at Northgate'], 2);
});
t('the property resolves through the synthesised column', () => {
  const p = B.parseCsv(GROUPED);
  assert.strictEqual(B.resolveColumns(p.headers).property, '__property');
});
t('en-dash and arrow variants from an Excel round-trip still parse', () => {
  ['-> A,1', '–> A,1', '→ A,1'].forEach(line => {
    const p = B.parseCsv('Group,count(Work Order Number)\n' + line + '\n,\n');
    assert.ok(p.groupCounts.A !== undefined, line);
  });
});

t('work orders come from the header counts, not the rows', () => {
  // The data rows have no work-order number: counting them would say 2.
  const sum = B.summarisePeriod(B.parseCsv(GROUPED));
  assert.strictEqual(sum.workOrders, 14);      // 12 + 2, Wolf Ridge's 9 excluded
});
t('money and hours come from the DATA rows, not the subtotals', () => {
  const sum = B.summarisePeriod(B.parseCsv(GROUPED));
  assert.strictEqual(sum.billed, 300);         // one $300 Completed row
  assert.strictEqual(sum.unbilled, 1550);      // 300 + 1250
  assert.strictEqual(sum.billableHours, 4.5);  // 1 + 1 + 2.5
});
t('statuses are read from the data rows', () => {
  const sum = B.summarisePeriod(B.parseCsv(GROUPED));
  assert.strictEqual(sum.completed, 1);
  assert.strictEqual(sum.readyToBill, 1);
  assert.strictEqual(sum.workDone, 1);
});
t('an excluded property is dropped, header count and all', () => {
  const rows = B.byProperty(B.parseCsv(GROUPED));
  assert.deepStrictEqual(rows.map(r => r.property).sort(), ['Ascent at Northgate', 'Hyde Park Square']);
  assert.strictEqual(B.summarisePeriod(B.parseCsv(GROUPED)).workOrders, 14);
});
t('per-property work orders use the header count', () => {
  const rows = B.byProperty(B.parseCsv(GROUPED));
  const hyde = rows.find(r => r.property === 'Hyde Park Square');
  assert.strictEqual(hyde.workOrders, 12);
  assert.strictEqual(hyde.unbilled, 300);
});
t('the >10 alert fires on the header count, not the row count', () => {
  // Hyde Park has 12 work orders but only 2 rows in this file. Reading the
  // rows would say 2 and the alert would never fire.
  const hyde = B.byProperty(B.parseCsv(GROUPED)).find(r => r.property === 'Hyde Park Square');
  assert.strictEqual(hyde.alert, true);
  const ascent = B.byProperty(B.parseCsv(GROUPED)).find(r => r.property === 'Ascent at Northgate');
  assert.strictEqual(ascent.alert, false);
});
t('Vendor stands in for the technician when there is no tech column', () => {
  const rows = B.byTech(B.parseCsv(GROUPED));
  assert.ok(rows.find(r => r.tech === 'Acme Plumbing'), rows.map(r => r.tech).join(','));
  assert.ok(!rows.find(r => r.tech === 'Ghost Vendor'), 'excluded property leaked into the tech table');
});
t('Created Date is used as the date when Work Completed On is absent', () => {
  const sum = B.summarisePeriod(B.parseCsv(GROUPED));
  assert.strictEqual(sum.dateRange.first, '2026-09-21');
  assert.strictEqual(sum.dateRange.last, '2026-09-22');
});
t('a flat CSV with a real property column still works', () => {
  // The grouped path must not break the format the Labor Summary arrives in.
  const p = parseAPI();
  assert.strictEqual(p.grouped, false);
  assert.strictEqual(p.groupCounts, null);
  assert.strictEqual(B.resolveColumns(p.headers).property, 'property_name');
});
t('rows appearing before any group header are not silently dropped', () => {
  const p = B.parseCsv('Group,count(Work Order Number),Amount\n,,$5.00\n-> A,1,\n,,$10.00');
  assert.strictEqual(p.rows.length, 2);
  assert.strictEqual(p.rows[0].__property, '');
});

console.log(`\n${pass} passing`);
