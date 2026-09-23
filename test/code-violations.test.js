// Code Violations Tracker — the rules that decide what a row is and whether it
// needs a human. Fixtures mirror the 09/17/2026 workbook.
const assert = require('assert');
const cv = require('../code-violations.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const TODAY = '2026-09-23';

console.log('vocabulary');
t('exactly seven statuses', () => assert.strictEqual(cv.STATUSES.length, 7));
t('exactly nine properties', () => assert.strictEqual(cv.PROPERTIES.length, 9));
t('open excludes everything completed or closed', () => {
  assert.deepStrictEqual(cv.OPEN_STATUSES,
    ['Pending', 'Assigned - No Activity', 'Assigned - In Progress', 'Assigned - Reassignment Needed']);
});

console.log('dates');
t('the workbook\'s MM/DD/YYYY is understood', () => assert.strictEqual(cv.isoDate('04/28/2026'), '2026-04-28'));
t('single-digit months and days are padded', () => assert.strictEqual(cv.isoDate('6/8/2026'), '2026-06-08'));
t('ISO passes through', () => assert.strictEqual(cv.isoDate('2026-04-28'), '2026-04-28'));
t('a blank due date is null, never today', () => assert.strictEqual(cv.isoDate(''), null));
t('unparseable text is null rather than an Invalid Date', () => assert.strictEqual(cv.isoDate('TBD'), null));

console.log('code section');
t('parsed out of the citation text', () => {
  assert.strictEqual(cv.codeSection('Installation (Sec. 605.1) - Three electrical disconnect boxes'), '605.1');
});
t('"Section" spelled out works too', () => assert.strictEqual(cv.codeSection('Egress (Section 1003.2) - blocked'), '1003.2'));
t('no section cited yields empty, not null-ish text', () => assert.strictEqual(cv.codeSection('Permitting - stairwell'), ''));

console.log('deficiency key');
const base = {
  property_name: 'Ascent at Northgate', case_number: '2026-072495 CV', work_order: '22872-1',
  address_unit: '1830 W Rundberg Ln, Austin, TX 78758 - BLDG 03',
  deficiency_description: 'Window, Skylight and Door Frames (Sec. 304.13) - Deteriorated roof hatch wood frame at building 3.',
};
t('the same row twice gives the same key', () => {
  assert.strictEqual(cv.deficiencyKey(base), cv.deficiencyKey({ ...base }));
});
t('case and spacing do not fork a row', () => {
  assert.strictEqual(cv.deficiencyKey(base),
    cv.deficiencyKey({ ...base, address_unit: '1830 W  Rundberg Ln, Austin, TX 78758 - bldg 03' }));
});
// The pair that collides under the four fields Jay named.
t('two citations sharing case, WO, building AND section stay two rows', () => {
  const other = { ...base, deficiency_description: 'Window, Skylight and Door Frames (Sec. 304.13) - Multiple window frames at building 3 are deteriorated on the front side of building.' };
  assert.notStrictEqual(cv.deficiencyKey(base), cv.deficiencyKey(other));
});
t('a different work order is a different row', () => {
  assert.notStrictEqual(cv.deficiencyKey(base), cv.deficiencyKey({ ...base, work_order: '22873-1' }));
});
t('a different building is a different row', () => {
  assert.notStrictEqual(cv.deficiencyKey(base), cv.deficiencyKey({ ...base, address_unit: 'BLDG 09' }));
});
t('the key names its property, so a cross-property collision is visible', () => {
  assert.ok(cv.deficiencyKey(base).startsWith('ascent at northgate:'));
});
t('"No CV number issued" does not merge unrelated rows', () => {
  const a = { ...base, case_number: 'No CV number issued', work_order: '14196-1', address_unit: 'Bldg 5 - stairwell' };
  const b = { ...base, case_number: 'No CV number issued', work_order: '18518-1', address_unit: 'Bldg 09 - stairwell' };
  assert.notStrictEqual(cv.deficiencyKey(a), cv.deficiencyKey(b));
});

console.log('status mapping');
const m = (s, o) => cv.mapAppfolioStatus(s, o);
t('Estimate Requested and New are Pending', () => {
  assert.strictEqual(m('Estimate Requested'), 'Pending');
  assert.strictEqual(m('New'), 'Pending');
});
t('Assigned with no activity', () => assert.strictEqual(m('Assigned'), 'Assigned - No Activity'));
t('Assigned with activity', () => assert.strictEqual(m('Assigned', { hasActivity: true }), 'Assigned - In Progress'));
t('Scheduled and Waiting are In Progress regardless of activity', () => {
  assert.strictEqual(m('Scheduled'), 'Assigned - In Progress');
  assert.strictEqual(m('Waiting on Parts'), 'Assigned - In Progress');
});
t('Work Done and Completed map to Completed by Maintenance', () => {
  assert.strictEqual(m('Work Done'), 'Completed by Maintenance');
  assert.strictEqual(m('Completed'), 'Completed by Maintenance');
});
t('"Completed No Need To Bill" is its own status, not Completed by Maintenance', () => {
  assert.strictEqual(m('Completed No Need To Bill'), 'Completed - No Need to Bill');
});
t('Closed by Code Compliance is NEVER auto-mapped', () => {
  assert.strictEqual(m('Closed by Code Compliance'), null);
});
t('an unrecognised status maps to null so a human value is not overwritten', () => {
  assert.strictEqual(m('Sent to Legal'), null);
  assert.strictEqual(m(''), null);
});
t('every mapped value is one of the seven', () => {
  ['Estimate Requested', 'New', 'Assigned', 'Scheduled', 'Waiting', 'Work Done', 'Completed', 'Completed No Need To Bill']
    .forEach(s => assert.ok(cv.STATUSES.includes(m(s)) || m(s) === null, s));
});

console.log('unverified closure');
const done = { status: 'Completed by Maintenance', completed_items: 'Replaced the frame. Photos on file.', progress_notes: 'Verified on site 09/18.' };
t('an open row is never flagged', () => {
  assert.strictEqual(cv.unverifiedClosure({ status: 'Pending', completed_items: '' }).flagged, false);
});
t('a completed row with a field record is not flagged', () => {
  assert.strictEqual(cv.unverifiedClosure(done).flagged, false);
});
t('completed with nothing recorded is flagged', () => {
  const r = cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: '', progress_notes: '' });
  assert.strictEqual(r.flagged, true);
  assert.match(r.reason, /no field record/);
});
t('"None yet." counts as nothing recorded', () => {
  assert.strictEqual(cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: 'None yet.' }).flagged, true);
});
t('billed within a minute of completion is flagged', () => {
  const r = cv.unverifiedClosure(done,
    { completedAt: '2026-09-18T14:02:00Z', billedAt: '2026-09-18T14:02:30Z' });
  assert.strictEqual(r.flagged, true);
  assert.match(r.reason, /within a minute/);
});
t('billed an hour later is ordinary', () => {
  assert.strictEqual(cv.unverifiedClosure(done,
    { completedAt: '2026-09-18T14:02:00Z', billedAt: '2026-09-18T15:02:00Z' }).flagged, false);
});
t('notes claiming completion with nothing completed is flagged', () => {
  const r = cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: '', progress_notes: 'Work completed by vendor.' });
  assert.strictEqual(r.flagged, true);
});
t('a note saying NOT completed does not read as a completion claim', () => {
  const r = cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: 'Frame replaced.', progress_notes: 'Second frame not completed yet.' });
  assert.strictEqual(r.flagged, false);
});
t('Completed - No Need to Bill is checked too', () => {
  assert.strictEqual(cv.unverifiedClosure({ status: 'Completed - No Need to Bill', completed_items: '' }).flagged, true);
});
t('independent reasons stack, so the review note says everything that is wrong', () => {
  const r = cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: '', maintenance_remarks: '', progress_notes: '' },
    { completedAt: '2026-09-18T14:02:00Z', billedAt: '2026-09-18T14:02:10Z' });
  assert.strictEqual(r.flagged, true);
  assert.match(r.reason, /within a minute/);
  assert.match(r.reason, /no field record/);
});
t('a note is a field record, so it answers that reason on its own', () => {
  // "Closed." with nothing in completed_items is still flagged, by the
  // contradiction check rather than the empty-record one.
  const r = cv.unverifiedClosure({ status: 'Completed by Maintenance', completed_items: '', progress_notes: 'Closed.' });
  assert.strictEqual(r.flagged, true);
  assert.doesNotMatch(r.reason, /no field record/);
  assert.match(r.reason, /claim completion/);
});

console.log('past deadline');
const openRow = { status: 'Assigned - No Activity', due_date: '2026-09-01' };
t('an open row past its city deadline', () => assert.strictEqual(cv.pastDeadline(openRow, TODAY), true));
t('a due date in the future is not past', () => {
  assert.strictEqual(cv.pastDeadline({ ...openRow, due_date: '2026-12-01' }, TODAY), false);
});
t('NO DUE DATE IS NEVER PAST DEADLINE — it is never derived', () => {
  assert.strictEqual(cv.pastDeadline({ status: 'Assigned - No Activity', due_date: null }, TODAY), false);
  assert.strictEqual(cv.pastDeadline({ status: 'Pending', deficiency_date: '2024-01-01' }, TODAY), false);
});
t('a completed row is not late', () => {
  assert.strictEqual(cv.pastDeadline({ ...openRow, status: 'Completed by Maintenance' }, TODAY), false);
});
t('a row closed by code compliance is not late', () => {
  assert.strictEqual(cv.pastDeadline({ ...openRow, status: 'Closed by Code Compliance' }, TODAY), false);
});
t('due today is not yet past', () => {
  assert.strictEqual(cv.pastDeadline({ ...openRow, due_date: TODAY }, TODAY), false);
});

console.log('import');
const raw = {
  property_name: 'Ascent at Northgate', case_number: '2026-052660 CV', work_order: '22882-1',
  address_unit: 'SITE-WIDE (front fence)', deficiency_date: '04/28/2026',
  deficiency_description: 'Installation (Sec. 605.1) - Three electrical disconnect boxes with exposed ACTIVE wires.',
  status: 'Assigned - No Activity', category: 'Electrical', due_date: '', completed_items: 'None yet.',
};
t('a good row normalises', () => {
  const r = cv.normaliseImportRow(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.row.code_section, '605.1');
  assert.strictEqual(r.row.deficiency_date, '2026-04-28');
  assert.strictEqual(r.row.due_date, null);
  assert.ok(r.row.deficiency_key);
});
t('an eighth status is REJECTED, not coerced', () => {
  const r = cv.normaliseImportRow({ ...raw, status: 'In Review' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Unknown status/);
});
t('a blank status is rejected', () => {
  assert.strictEqual(cv.normaliseImportRow({ ...raw, status: '' }).ok, false);
});
t('a row with no property is rejected', () => {
  assert.strictEqual(cv.normaliseImportRow({ ...raw, property_name: '' }).ok, false);
});
t('an open row is not flagged on import', () => {
  assert.strictEqual(cv.normaliseImportRow(raw).row.unverified_closure, false);
});
t('a completed row with no record is flagged on import', () => {
  const r = cv.normaliseImportRow({ ...raw, status: 'Completed by Maintenance', completed_items: 'None yet.' });
  assert.strictEqual(r.row.unverified_closure, true);
  assert.ok(r.row.unverified_reason);
});

console.log('tracker');
const ROWS = [
  { property_name: 'Sunset Palms', status: 'Assigned - No Activity', due_date: '2026-09-01', deficiency_date: '2026-06-08', category: 'Electrical' },
  { property_name: 'Sunset Palms', status: 'Pending', due_date: null, deficiency_date: '2025-09-12', category: 'Permitting' },
  { property_name: 'Ascent at Northgate', status: 'Completed by Maintenance', due_date: '2026-09-01', deficiency_date: '2026-06-08', category: 'Electrical', unverified_closure: true },
  { property_name: 'iConic Round Rock', status: 'Assigned - In Progress', due_date: '2026-12-01', deficiency_date: '2026-04-28', category: 'Plumbing' },
];
const tr = (filters) => cv.buildTracker(ROWS, { today: TODAY, filters });
t('all nine properties appear, including the empty ones', () => {
  assert.strictEqual(tr().byProperty.length, 9);
  assert.strictEqual(tr().byProperty.find(p => p.property === 'The Highlander').total, 0);
});
t('all seven statuses appear in the summary, including the zeros', () => {
  assert.deepStrictEqual(Object.keys(tr().summary.byStatus), cv.STATUSES);
  assert.strictEqual(tr().summary.byStatus['Closed by Code Compliance'], 0);
});
t('counts add up to the total', () => {
  const s = tr().summary;
  assert.strictEqual(Object.values(s.byStatus).reduce((a, b) => a + b, 0), s.total);
});
t('past deadline counts only open rows', () => {
  assert.strictEqual(tr().summary.pastDeadline, 1);   // the completed one does not count
});
t('unverified closures are counted', () => assert.strictEqual(tr().summary.unverified, 1));
t('filter by property', () => assert.strictEqual(tr({ property: 'Sunset Palms' }).summary.total, 2));
t('filter by status', () => assert.strictEqual(tr({ status: 'Pending' }).summary.total, 1));
t('filter by category', () => assert.strictEqual(tr({ category: 'Electrical' }).summary.total, 2));
t('filter by month and year, derived from the deficiency date', () => {
  assert.strictEqual(tr({ month: 6, year: 2026 }).summary.total, 2);
  assert.strictEqual(tr({ year: 2025 }).summary.total, 1);
});
t('filters combine', () => {
  assert.strictEqual(tr({ property: 'Sunset Palms', status: 'Pending' }).summary.total, 1);
});
t('a property off the list of nine is surfaced, not dropped', () => {
  const out = cv.buildTracker(ROWS.concat([{ property_name: 'Brazos Lofts', status: 'Pending' }]), { today: TODAY });
  assert.deepStrictEqual(out.unknownProperties, ['Brazos Lofts']);
  assert.strictEqual(out.summary.total, 5);
});
t('facets come from the data', () => {
  assert.deepStrictEqual(tr().facets.categories, ['Electrical', 'Permitting', 'Plumbing']);
  assert.deepStrictEqual(tr().facets.years, [2026, 2025]);
});
t('an empty tracker is a valid tracker', () => {
  const out = cv.buildTracker([], { today: TODAY });
  assert.strictEqual(out.summary.total, 0);
  assert.strictEqual(out.byProperty.length, 9);
});

console.log(`\n${pass} passing`);
