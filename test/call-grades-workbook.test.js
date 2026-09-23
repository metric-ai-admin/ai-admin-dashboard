// Call grades → Excel workbook. Shapes mirror live call_grades rows.
const assert = require('assert');
const XLSX = require('xlsx');
const wb = require('../call-grades-workbook.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const GRADE = {
  recording_id: '202609-abc', agent_name: 'Oscar', call_date: '2026-09-09',
  call_direction: 'outbound', duration_seconds: 105, property_name: 'Unidentified',
  overall_score: 28, overall_grade: 'F',
  legal_violation: false, fair_housing_flag: false, liability_flag: true,
  summary: 'Outbound call about a key handoff.', outcome: 'Callback arranged.',
  flags: ['No company identification', 'Casual tone'],
  key_moments: ['0:00 — no greeting'],
  categories: [{
    name: 'Outbound Identification & Greeting',
    items: [
      { label: "Stated 'Metric Property Management'", score: 0, note: 'Never mentioned.' },
      { label: 'Identified self by name', score: 5, note: 'Partially.' },
    ],
  }, {
    name: 'Professionalism',
    items: [{ label: 'Professional tone', score: 8, note: 'Friendly but casual.' }],
  }],
  coaching: [{ category: 'Greeting', strength: 'Called back promptly.', improve: 'Always state the company.' }],
};
const NS = { recording_id: '202609-ns', agent_name: 'Dana', call_date: '2026-09-10',
  not_scoreable: true, not_scoreable_reason: 'Vendor call, no resident interaction.',
  categories: [], coaching: [] };

// json_to_sheet writes an empty string; sheet_to_json may report it as '' or
// drop the key. Both mean 'blank cell', and neither must ever be the text
// 'undefined' or 'null' showing up in Lyndsay's spreadsheet.
const blank = v => v === undefined || v === '';

const sheets = (grades, opts) => {
  const { wb: book, counts } = wb.buildWorkbook(grades, opts);
  return {
    counts,
    criteria: XLSX.utils.sheet_to_json(book.Sheets.Criteria),
    calls: XLSX.utils.sheet_to_json(book.Sheets.Calls),
    flagged: XLSX.utils.sheet_to_json(book.Sheets.Flagged),
    book,
  };
};

console.log('structure');
t('three sheets, named for what is in them', () => {
  assert.deepStrictEqual(wb.buildWorkbook([]).wb.SheetNames, ['Criteria', 'Calls', 'Flagged']);
});
t('an empty export still has headers, so it opens as empty rather than broken', () => {
  const b = wb.buildWorkbook([]).wb;
  const head = XLSX.utils.sheet_to_json(b.Sheets.Criteria, { header: 1 })[0];
  assert.ok(head.includes('Criterion'));
  assert.ok(head.includes('Coaching note'));
});
t('ONE ROW PER CRITERION, not per call', () => {
  const s = sheets([GRADE]);
  assert.strictEqual(s.counts.calls, 1);
  assert.strictEqual(s.criteria.length, 3);   // 2 + 1 across two categories
});

console.log('criteria sheet');
t('every field the brief asked for is present', () => {
  const r = sheets([GRADE]).criteria[0];
  ['Agent', 'Date', 'Direction', 'Duration', 'Property', 'Phone', 'Grade', 'Score',
    'Category', 'Criterion', 'Criterion score', 'Coaching note'].forEach(k =>
    assert.ok(k in r, 'missing ' + k));
});
t('per-call fields repeat down the criterion rows so any column can be filtered', () => {
  const c = sheets([GRADE]).criteria;
  assert.ok(c.every(r => r.Agent === 'Oscar' && r.Grade === 'F' && r.Score === 28));
});
t('criterion score and note come from the item, not the call', () => {
  const c = sheets([GRADE]).criteria;
  assert.strictEqual(c[0]['Criterion score'], 0);
  assert.strictEqual(c[0]['Coaching note'], 'Never mentioned.');
  assert.strictEqual(c[2]['Criterion score'], 8);
});
t('duration renders as m:ss, not raw seconds', () => {
  assert.strictEqual(sheets([GRADE]).criteria[0].Duration, '1:45');
  assert.strictEqual(wb.mmss(0), '0:00');
  assert.strictEqual(wb.mmss(null), '');
});
t('the phone dialled is joined in by recording id', () => {
  const s = sheets([GRADE], { phoneByRecording: { '202609-abc': '(512) 555-1234' } });
  assert.strictEqual(s.criteria[0].Phone, '(512) 555-1234');
});
t('a call with no phone on file leaves the cell empty, never the text "undefined"', () => {
  assert.ok(blank(sheets([GRADE]).criteria[0].Phone));
});

console.log('not scoreable');
t('an N/S call still gets a row — a silently absent call looks like a lost recording', () => {
  const s = sheets([NS]);
  assert.strictEqual(s.criteria.length, 1);
  assert.strictEqual(s.criteria[0].Criterion, '(not scoreable)');
  assert.strictEqual(s.criteria[0]['Coaching note'], 'Vendor call, no resident interaction.');
});
t('N/S shows as a grade rather than blank', () => {
  assert.strictEqual(sheets([NS]).criteria[0].Grade, 'N/S');
  assert.strictEqual(wb.gradeOf({ not_scoreable: true, overall_grade: 'F' }), 'N/S');
});

console.log('calls sheet');
t('the full coaching summary is flattened into prose, not JSON', () => {
  const c = sheets([GRADE]).calls[0];
  assert.match(c.Coaching, /Greeting — Strength: Called back promptly\. \| Improve: Always state the company\./);
});
t('model flags and key moments carry over', () => {
  const c = sheets([GRADE]).calls[0];
  assert.match(c['Flags raised'], /No company identification/);
  assert.match(c['Key moments'], /no greeting/);
  assert.strictEqual(c['Liability flag'], 'YES');
  assert.ok(blank(c['Legal violation']), 'false should render blank, got ' + JSON.stringify(c['Legal violation']));
});

console.log('policy review flags');
const FLAG = { '202609-abc': { flagged_by: 'Lyndsay Hanes', flagged_at: '2026-09-23T18:00:00Z',
  flag_note: 'Greeting scored 0 but the company name was said at 0:12.', resolved: false } };
t('a flagged call appears on its own sheet with the note', () => {
  const s = sheets([GRADE, NS], { flagsByRecording: FLAG });
  assert.strictEqual(s.flagged.length, 1);
  assert.strictEqual(s.flagged[0]['What needs review'], FLAG['202609-abc'].flag_note);
  assert.strictEqual(s.flagged[0]['Flagged by'], 'Lyndsay Hanes');
});
t('the flag is also marked on the criteria and calls sheets', () => {
  const s = sheets([GRADE], { flagsByRecording: FLAG });
  assert.ok(s.criteria.every(r => r.Flagged === 'YES'));
  assert.strictEqual(s.calls[0]['Flagged for policy review'], 'YES');
  assert.strictEqual(s.calls[0]['Policy review note'], FLAG['202609-abc'].flag_note);
});
t('an unflagged call is absent from the Flagged sheet', () => {
  assert.strictEqual(sheets([GRADE, NS], { flagsByRecording: FLAG }).flagged.length, 1);
  assert.strictEqual(sheets([GRADE]).flagged.length, 0);
});

console.log('safety');
t('a note starting with = is not handed to Excel as a formula', () => {
  assert.strictEqual(wb.cell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.strictEqual(wb.cell('-1 for tone'), "'-1 for tone");
  assert.strictEqual(wb.cell('+ve'), "'+ve");
  assert.strictEqual(wb.cell('@agent'), "'@agent");
});
t('ordinary text is untouched', () => {
  assert.strictEqual(wb.cell('Never mentioned.'), 'Never mentioned.');
});
t('malformed model output costs one row, not the workbook', () => {
  const bad = { recording_id: 'x', agent_name: 'A', categories: [{ name: 'C' }, { name: 'D', items: 'nope' }], coaching: 'nope' };
  const s = sheets([bad]);
  assert.strictEqual(s.criteria.length, 2);
  assert.ok(blank(s.calls[0].Coaching));
});
t('categories missing entirely does not throw', () => {
  assert.strictEqual(sheets([{ recording_id: 'y', agent_name: 'B' }]).criteria.length, 1);
});

console.log('round trip');
t('the workbook writes and reopens with its rows intact', () => {
  const { wb: book } = wb.buildWorkbook([GRADE], { flagsByRecording: FLAG });
  const buf = wb.toBuffer(book);
  const back = XLSX.read(buf, { type: 'buffer' });
  assert.deepStrictEqual(back.SheetNames, ['Criteria', 'Calls', 'Flagged']);
  assert.strictEqual(XLSX.utils.sheet_to_json(back.Sheets.Criteria).length, 3);
  assert.strictEqual(XLSX.utils.sheet_to_json(back.Sheets.Flagged).length, 1);
});

console.log(`\n${pass} passing`);
