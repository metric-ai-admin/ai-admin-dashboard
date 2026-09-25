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
  // 1, not 2: the two Completed rows are both work order 21818-1. Status counts
  // are DISTINCT WORK ORDERS, not billable lines — a job with four parts is one
  // completed work order, not four.
  assert.strictEqual(s.completed, 1);
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

console.log('\nstatus counting — distinct work orders, tolerant matching');
t('a status with a suffix still lands in its group', () => {
  // The silent failure this replaces: an exact-match list put "Work Done -
  // Billable" in "other", and the card read 0 while the file plainly had
  // Work Done rows in it.
  assert.strictEqual(B.statusGroup('Work Done - Billable'), 'workDone');
  assert.strictEqual(B.statusGroup('Ready to Bill (Owner)'), 'readyToBill');
  assert.strictEqual(B.statusGroup('Completed No Need To Bill'), 'completed');
});
t('underscores do not defeat the match', () => {
  // norm() joins words with underscores and \b does not fire between a letter
  // and an underscore, which is how /^completed\b/ missed the whole group.
  ['completed_no_need_to_bill', 'work_done', 'ready_to_bill'].forEach(v =>
    assert.ok(B.statusGroup(v), v));
});
t('unrelated statuses are still not swallowed', () => {
  ['Assigned', 'Canceled', 'Scheduled', 'New', 'Waiting'].forEach(v =>
    assert.strictEqual(B.statusGroup(v), null, v));
});

const MULTILINE = [
  'Group,count(Work Order Number),Unit,Vendor,Created Date,Description,Amount,Worked Hours,Billable Hours,Work Order Status,Billed Amount,Unbilled Amount',
  '-> Hyde Park Square,3,,,,,,,,,,',
  // One job, THREE billable lines. Counting rows would say 3 Ready to Bill.
  ',,5-224,Acme,09/22/2026,Leak under sink,$100.00,1,1,Ready to Bill,$0.00,$100.00',
  ',,5-224,Acme,09/22/2026,Leak under sink,$100.00,1,1,Ready to Bill,$0.00,$100.00',
  ',,5-224,Acme,09/22/2026,Leak under sink,$100.00,1,1,Ready to Bill,$0.00,$100.00',
  // A genuinely different job, same day, same property.
  ',,3-101,Acme,09/22/2026,Door lock,$50.00,1,1,Ready to Bill,$0.00,$50.00',
  ',,A-1,Bright,09/22/2026,Breaker,$75.00,1,1,Work Done,$0.00,$75.00',
].join('\n');

t('one job with several billable lines counts ONCE per status', () => {
  const sum = B.summarisePeriod(B.parseCsv(MULTILINE));
  assert.strictEqual(sum.readyToBill, 2, 'three lines of one job + one other job = 2');
  assert.strictEqual(sum.workDone, 1);
});
t('money still sums every LINE, not the distinct jobs', () => {
  // The counts deduplicate; the money must not.
  const sum = B.summarisePeriod(B.parseCsv(MULTILINE));
  assert.strictEqual(sum.unbilled, 425);   // 100+100+100+50+75
});
t('how the count was reached is reported, never implied', () => {
  // MULTILINE has the count(Work Order Number) column but leaves it blank on
  // the data rows, so the identity really is the fallback — and the label says
  // so, including WHY, rather than naming a column it did not use.
  const grouped = B.summarisePeriod(B.parseCsv(MULTILINE));
  assert.ok(grouped.countedBy.startsWith('unit + description + date'), grouped.countedBy);
  assert.ok(/is empty on every row/.test(grouped.countedBy), grouped.countedBy);
  const flat = B.summarisePeriod(parseUI());
  assert.strictEqual(flat.countedBy, '"Work Order Number"');
});
t('a real work-order number is preferred over the fallback identity', () => {
  const s2 = B.summarisePeriod(parseUI());
  assert.strictEqual(s2.completed, 1);     // both rows are 21818-1
});
t('the status column actually used is named', () => {
  assert.strictEqual(B.summarisePeriod(B.parseCsv(MULTILINE)).statusColumn, 'Work Order Status');
});
t('every status value found in the file is reported', () => {
  const seen = B.summarisePeriod(B.parseCsv(MULTILINE)).statusesSeen;
  assert.deepStrictEqual(Object.keys(seen).sort(), ['Ready to Bill', 'Work Done']);
  assert.strictEqual(seen['Ready to Bill'], 4);   // rows, so a mismatch is visible
});
t('per-property status counts are distinct too', () => {
  const p = B.byProperty(B.parseCsv(MULTILINE))[0];
  assert.strictEqual(p.readyToBill, 2);
  assert.strictEqual(p.workDone, 1);
});
t('a file whose statuses are ALL unrecognised reports them rather than zeros', () => {
  const odd = 'Group,count(Work Order Number),Unit,Created Date,Description,Work Order Status,Billable Hours\n'
    + '-> A,1,,,,,\n,,U1,09/22/2026,Job,Pending Approval,1\n';
  const sum = B.summarisePeriod(B.parseCsv(odd));
  assert.strictEqual(sum.workDone + sum.readyToBill + sum.completed, 0);
  assert.strictEqual(sum.otherStatus, 1);
  assert.deepStrictEqual(Object.keys(sum.statusesSeen), ['Pending Approval']);
});

const REAL_HEADERS = ['Group', 'count(Work Order Number)', 'Unit', 'Vendor', 'Billable Type',
  'Created Date', 'Description', 'GL Account', 'Quantity', 'Rate', 'Amount', 'Worked Hours',
  'Billable Hours', 'Work Order Status', 'Billed Amount', 'Unbilled Amount', '__property'];

console.log('\ncolumn resolution must not steal a column another field owns');
t('workOrder does not resolve to "Work Order Status"', () => {
  // "work_order_status" CONTAINS "work_order". The loose pass took it, so every
  // row's work-order identity became its own status and three separate jobs
  // sharing a status counted as one. Wrong in the direction that looks right.
  const cols = B.resolveColumns(REAL_HEADERS);
  assert.strictEqual(cols.status, 'Work Order Status');
  assert.notStrictEqual(cols.workOrder, 'Work Order Status');
});
t('workOrder DOES resolve to count(Work Order Number)', () => {
  // This assertion used to say the opposite. The column was excluded as an
  // aggregate on the strength of its name; a real export on 2026-09-25 showed
  // it carries the work order itself ("22884-1") on data rows, and only a
  // count on group rows — which are dropped before any of this runs.
  assert.strictEqual(B.resolveColumns(REAL_HEADERS).workOrder, 'count(Work Order Number)');
});
t('other aggregates are still kept out of the loose pass', () => {
  // The exclusion still stands for names nothing claims exactly.
  assert.strictEqual(B.resolveColumns(['Group', 'sum(Billed Amount)']).billedAmount, null);
});
t('every other column on the real export resolves', () => {
  const cols = B.resolveColumns(REAL_HEADERS);
  assert.deepStrictEqual({
    property: cols.property, tech: cols.tech, status: cols.status,
    workedHours: cols.workedHours, billableHours: cols.billableHours,
    billedAmount: cols.billedAmount, unbilledAmount: cols.unbilledAmount,
    amount: cols.amount, billableType: cols.billableType,
    unit: cols.unit, description: cols.description, date: cols.date,
  }, {
    property: '__property', tech: 'Vendor', status: 'Work Order Status',
    workedHours: 'Worked Hours', billableHours: 'Billable Hours',
    billedAmount: 'Billed Amount', unbilledAmount: 'Unbilled Amount',
    amount: 'Amount', billableType: 'Billable Type',
    unit: 'Unit', description: 'Description', date: 'Created Date',
  });
});
t('an exact match still beats the restriction', () => {
  // The rule only governs the LOOSE pass — a field may still claim a header
  // it names exactly.
  assert.strictEqual(B.resolveColumns(['work_order_number']).workOrder, 'work_order_number');
});

console.log('\nnested groups: property then status');

// The report can group by STATUS as well as by property, and the two nest.
// When it does, "-> Work Done" is a group header carrying a work-order count —
// and a work order with nothing billed yet has NO rows beneath it. The header
// is its only trace in the file. Treating that header as a property put "Work
// Done" in the property column and lost the status, which is how Work Done and
// Ready to Bill read 0 beside a file that plainly contained them.
const NESTED = [
  'Group,count(Work Order Number),Unit,Vendor,Billable Type,Created Date,Description,GL Account,Quantity,Rate,Amount,Worked Hours,Billable Hours,Work Order Status,Billed Amount,Unbilled Amount',
  '-> Hyde Park Square,12,,,,,,,,,,,,,,',
  '-> Work Done,1,,,,,,,,,,,,,,',
  '-> Completed,11,,,,,,,,,,,,,,',
  ',,5-224,Acme,Tenant,09/22/2026,Leak,6595,1,300,$300.00,1.2,1.0,Completed,$300.00,$0.00',
  ',,3-101,Acme,Owner,09/22/2026,Lock,6595,1,200,$200.00,1.0,1.0,Completed,$200.00,$0.00',
  '-> Ascent at Northgate,3,,,,,,,,,,,,,,',
  '-> Ready to Bill,3,,,,,,,,,,,,,,',
  ',,A-12,Bright,Owner,09/21/2026,Breaker,6595,1,500,$500.00,2.0,2.0,Ready to Bill,$0.00,$500.00',
].join('\n');

t('a status-named group is not treated as a property', () => {
  const p = B.parseCsv(NESTED);
  assert.deepStrictEqual(Object.keys(p.groupCounts), ['Hyde Park Square', 'Ascent at Northgate']);
  assert.deepStrictEqual([...new Set(p.rows.map(r => r.__property))],
    ['Hyde Park Square', 'Ascent at Northgate']);
});
t('status-group counts are kept separately', () => {
  const p = B.parseCsv(NESTED);
  assert.strictEqual(p.statusGroupCounts['Work Done'], 1);
  assert.strictEqual(p.statusGroupCounts['Completed'], 11);
});
t('a status group with NO rows beneath it is still counted', () => {
  // The whole bug: Work Done has a header and no data rows.
  const sum = B.summarisePeriod(B.parseCsv(NESTED));
  assert.strictEqual(sum.workDone, 1);
  assert.deepStrictEqual(B.parseCsv(NESTED).emptyStatusGroups, ['Work Done']);
});
t('a status group WITH rows is not double-counted', () => {
  // Completed has a header saying 11 and two data rows. The rows win; adding
  // the header count as well would report 13.
  const sum = B.summarisePeriod(B.parseCsv(NESTED));
  assert.strictEqual(sum.completed, 2);
});
t('a row inherits the status group it sits under when it has no status', () => {
  const noStatus = [
    'Group,count(Work Order Number),Unit,Created Date,Description,Billable Hours,Work Order Status,Unbilled Amount',
    '-> Hyde Park Square,2,,,,,,',
    '-> Ready to Bill,2,,,,,,',
    ',,5-224,09/22/2026,Leak,1.0,,$100.00',
    ',,3-101,09/22/2026,Lock,1.0,,$50.00',
  ].join('\n');
  assert.strictEqual(B.summarisePeriod(B.parseCsv(noStatus)).readyToBill, 2);
});
t('a real per-row status beats the group it sits under', () => {
  const conflict = [
    'Group,count(Work Order Number),Unit,Created Date,Description,Billable Hours,Work Order Status,Unbilled Amount',
    '-> Hyde Park Square,1,,,,,,',
    '-> Ready to Bill,1,,,,,,',
    ',,5-224,09/22/2026,Leak,1.0,Completed,$0.00',
  ].join('\n');
  const sum = B.summarisePeriod(B.parseCsv(conflict));
  assert.strictEqual(sum.completed, 1);
  assert.strictEqual(sum.readyToBill, 0);
});
t('the per-property table shows a header-only status too', () => {
  const rows = B.byProperty(B.parseCsv(NESTED));
  const hyde = rows.find(r => r.property === 'Hyde Park Square');
  assert.strictEqual(hyde.workDone, 1);
  assert.strictEqual(hyde.completed, 2);
  const ascent = rows.find(r => r.property === 'Ascent at Northgate');
  assert.strictEqual(ascent.readyToBill, 1);
});
t('a status group does not leak across into the next property', () => {
  // Ascent's rows must not inherit Hyde Park's last status section.
  const p = B.parseCsv(NESTED);
  const ascentRows = p.rows.filter(r => r.__property === 'Ascent at Northgate');
  assert.deepStrictEqual([...new Set(ascentRows.map(r => r.__groupStatus))], ['Ready to Bill']);
});
t('money is unaffected by the header-only counts', () => {
  const sum = B.summarisePeriod(B.parseCsv(NESTED));
  assert.strictEqual(sum.unbilled, 500);
  assert.strictEqual(sum.billed, 500);
});
t('a flat property-only grouping still behaves as before', () => {
  const p = B.parseCsv(GROUPED);
  assert.deepStrictEqual(p.emptyStatusGroups, []);
  assert.strictEqual(B.summarisePeriod(p).completed, 1);
});

console.log('\ncount(Work Order Number) is the WO number on data rows');

// Confirmed from a real export on 2026-09-25: on a GROUP row that column holds
// a count, on a DATA row it holds the work order itself ("22884-1"). Same
// column, two meanings, decided by which kind of row you are on. It had been
// excluded as an aggregate, so deduplication fell back to unit + description +
// date — close, but it merges two same-day jobs on one unit with the same
// description, and splits one job whose description was edited mid-week.
const WITH_WO = [
  'Group,count(Work Order Number),Unit,Vendor,Billable Type,Created Date,Description,GL Account,Quantity,Rate,Amount,Worked Hours,Billable Hours,Work Order Status,Billed Amount,Unbilled Amount',
  '-> Hyde Park Square,12,,,,,,,,,"$3,600.00",14.4,12.0,,"$3,600.00",$0.00',
  ',22884-1,5-224,Acme,Tenant,09/22/2026,Leak,6595,1,300,$300.00,1.2,1.0,Completed,$300.00,$0.00',
  ',22884-1,5-224,Acme,Tenant,09/22/2026,Leak part two,6595,1,150,$150.00,0.6,0.5,Completed,$150.00,$0.00',
  ',22879-1,3-101,Acme,Owner,09/22/2026,Lock,6595,1,200,$200.00,1.0,1.0,Completed,$200.00,$0.00',
].join(String.fromCharCode(10));

t('it resolves as the work-order column', () => {
  assert.strictEqual(B.resolveColumns(B.parseCsv(WITH_WO).headers).workOrder, 'count(Work Order Number)');
});
t('the group row still yields a COUNT from the same column', () => {
  assert.strictEqual(B.parseCsv(WITH_WO).groupCounts['Hyde Park Square'], 12);
});
t('two lines of one work order count once, even with different descriptions', () => {
  // The fallback identity would have said 3 here: the two 22884-1 lines carry
  // different descriptions, so unit+description+date splits one job in two.
  assert.strictEqual(B.summarisePeriod(B.parseCsv(WITH_WO)).completed, 2);
});
t('money still sums every line', () => {
  assert.strictEqual(B.summarisePeriod(B.parseCsv(WITH_WO)).billed, 650);
});
t('the card names the actual column it counted by', () => {
  assert.strictEqual(B.summarisePeriod(B.parseCsv(WITH_WO)).countedBy, '"count(Work Order Number)"');
});
t('a real Work Order Number column is still preferred over it', () => {
  const both = 'Group,count(Work Order Number),Work Order Number,Unit,Created Date,Description,Billable Hours,Work Order Status'
    + String.fromCharCode(10) + '-> P,2,,,,,,'
    + String.fromCharCode(10) + ',9,WO-1,U1,09/22/2026,A,1,Completed';
  assert.strictEqual(B.resolveColumns(B.parseCsv(both).headers).workOrder, 'Work Order Number');
});
t('per-property counts still come from the group header, not the rows', () => {
  const hyde = B.byProperty(B.parseCsv(WITH_WO))[0];
  assert.strictEqual(hyde.workOrders, 12);
  assert.strictEqual(hyde.completed, 2);
});

console.log(`\n${pass} passing`);
