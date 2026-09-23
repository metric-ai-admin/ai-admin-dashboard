// =====================================================================
// Call grades → Excel workbook.
//
// The CSV export in call-grades-export.js stays as it is; it feeds the
// per-agent summary and the scripts. This is the reviewer's version: everything
// the model actually said about a call, in a shape Lyndsay can read and sort.
//
// ONE ROW PER CRITERION, not per call. That is the whole point — a call graded
// F is not actionable, "Stated 'Metric Property Management' on outbound call: 0"
// is. The per-call fields repeat down the criterion rows so any column can be
// filtered or pivoted without a lookup, which one-sheet-per-call would make
// impossible (681 sheets, no sorting, no totals).
//
// Three sheets:
//   Criteria   one row per criterion, the working sheet
//   Calls      one row per call, for totals and a quick scan
//   Flagged    only the calls flagged for policy review, with the note
//
// Pure functions, no I/O. The caller passes rows in and writes the file.
// =====================================================================

const XLSX = require('xlsx');

const clean = s => String(s == null ? '' : s).trim();

// Excel turns a leading =, +, - or @ into a formula. Agent notes are free text
// written by a model, so a note beginning with "-" is entirely possible and
// would arrive as #NAME? or worse. Prefixing with an apostrophe is the standard
// defence and is invisible in the cell.
const cell = v => {
  const s = clean(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const mmss = secs => {
  // null and '' both coerce to 0, which would print a real-looking 0:00 for a
  // call whose duration was never recorded. Missing stays blank.
  if (secs === null || secs === undefined || secs === '') return '';
  const n = Number(secs);
  if (!Number.isFinite(n) || n < 0) return '';
  return `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
};

// A grade row carries N/S as not_scoreable rather than as a grade value.
const gradeOf = g => (g.not_scoreable ? 'N/S' : clean(g.overall_grade) || '');

// categories is [{ name, items: [{ label, score, note }] }]. Defensive because
// it is model output: a malformed entry should cost one row, not the workbook.
function criteriaOf(grade) {
  const out = [];
  const cats = Array.isArray(grade.categories) ? grade.categories : [];
  cats.forEach(c => {
    const items = Array.isArray(c && c.items) ? c.items : [];
    if (!items.length) {
      out.push({ category: clean(c && c.name), label: '', score: null, note: '' });
      return;
    }
    items.forEach(i => out.push({
      category: clean(c.name),
      label: clean(i && i.label),
      score: i && Number.isFinite(Number(i.score)) ? Number(i.score) : null,
      note: clean(i && i.note),
    }));
  });
  return out;
}

// coaching is [{ category, strength, improve }]. Flattened into one block per
// call so the summary reads as prose rather than as JSON.
function coachingText(grade) {
  const c = Array.isArray(grade.coaching) ? grade.coaching : [];
  return c.map(x => {
    const head = clean(x && x.category);
    const bits = [];
    if (clean(x && x.strength)) bits.push(`Strength: ${clean(x.strength)}`);
    if (clean(x && x.improve)) bits.push(`Improve: ${clean(x.improve)}`);
    return (head ? `${head} — ` : '') + bits.join(' | ');
  }).filter(Boolean).join('\n');
}

const listText = v => (Array.isArray(v) ? v.map(clean).filter(Boolean).join('\n') : clean(v));

/**
 * @param {object[]} grades  call_grades rows
 * @param {object} opts
 *   phoneByRecording  Map/object recording_id -> phone number dialled
 *   flagsByRecording  Map/object recording_id -> { flagged_by, flagged_at, flag_note, resolved }
 */
function buildWorkbook(grades = [], opts = {}) {
  const phone = k => {
    const m = opts.phoneByRecording;
    if (!m) return '';
    return clean(m instanceof Map ? m.get(k) : m[k]);
  };
  const flag = k => {
    const m = opts.flagsByRecording;
    if (!m) return null;
    return (m instanceof Map ? m.get(k) : m[k]) || null;
  };

  const criteria = [];
  const calls = [];
  const flagged = [];

  grades.forEach(g => {
    const f = flag(g.recording_id);
    const base = {
      'Agent': cell(g.agent_name),
      'Date': cell(g.call_date),
      'Direction': cell(g.call_direction),
      'Duration': mmss(g.duration_seconds),
      'Property': cell(g.property_name),
      'Phone': cell(phone(g.recording_id)),
      'Grade': gradeOf(g),
      'Score': Number.isFinite(Number(g.overall_score)) ? Number(g.overall_score) : null,
    };

    const rows = criteriaOf(g);
    if (!rows.length) {
      // An N/S call has no criteria. It still gets a row, because a reviewer
      // filtering by agent should see that the call existed and why it was not
      // scored — a silently absent call looks like a missing recording.
      criteria.push({
        ...base,
        'Category': '',
        'Criterion': g.not_scoreable ? '(not scoreable)' : '(no criteria returned)',
        'Criterion score': null,
        'Coaching note': cell(g.not_scoreable_reason),
        'Flagged': f ? 'YES' : '',
        'Recording ID': cell(g.recording_id),
      });
    } else {
      rows.forEach(r => criteria.push({
        ...base,
        'Category': cell(r.category),
        'Criterion': cell(r.label),
        'Criterion score': r.score,
        'Coaching note': cell(r.note),
        'Flagged': f ? 'YES' : '',
        'Recording ID': cell(g.recording_id),
      }));
    }

    const callRow = {
      ...base,
      'Criteria': rows.length,
      'Legal violation': g.legal_violation ? 'YES' : '',
      'Fair housing flag': g.fair_housing_flag ? 'YES' : '',
      'Liability flag': g.liability_flag ? 'YES' : '',
      'Summary': cell(g.summary),
      'Outcome': cell(g.outcome),
      'Coaching': cell(coachingText(g)),
      'Flags raised': cell(listText(g.flags)),
      'Key moments': cell(listText(g.key_moments)),
      'Not scoreable reason': cell(g.not_scoreable_reason),
      'Flagged for policy review': f ? 'YES' : '',
      'Policy review note': cell(f && f.flag_note),
      'Flagged by': cell(f && f.flagged_by),
      'Recording ID': cell(g.recording_id),
    };
    calls.push(callRow);

    if (f) {
      flagged.push({
        'Agent': base.Agent, 'Date': base.Date, 'Direction': base.Direction,
        'Property': base.Property, 'Phone': base.Phone,
        'Grade': base.Grade, 'Score': base.Score,
        'What needs review': cell(f.flag_note),
        'Flagged by': cell(f.flagged_by),
        'Flagged at': cell(f.flagged_at),
        'Resolved': f.resolved ? 'YES' : '',
        'Summary': cell(g.summary),
        'Coaching': cell(coachingText(g)),
        'Recording ID': cell(g.recording_id),
      });
    }
  });

  const wb = XLSX.utils.book_new();
  const sheet = (rows, name, widths) => {
    // An empty sheet still needs its headers, otherwise the workbook opens on a
    // blank grid and looks broken rather than empty.
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.aoa_to_sheet([widths.map(w => w.h)]);
    ws['!cols'] = widths.map(w => ({ wch: w.w }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  sheet(criteria, 'Criteria', [
    { h: 'Agent', w: 14 }, { h: 'Date', w: 11 }, { h: 'Direction', w: 10 },
    { h: 'Duration', w: 9 }, { h: 'Property', w: 22 }, { h: 'Phone', w: 15 },
    { h: 'Grade', w: 7 }, { h: 'Score', w: 7 }, { h: 'Category', w: 26 },
    { h: 'Criterion', w: 42 }, { h: 'Criterion score', w: 13 },
    { h: 'Coaching note', w: 70 }, { h: 'Flagged', w: 9 }, { h: 'Recording ID', w: 34 },
  ]);
  sheet(calls, 'Calls', [
    { h: 'Agent', w: 14 }, { h: 'Date', w: 11 }, { h: 'Direction', w: 10 },
    { h: 'Duration', w: 9 }, { h: 'Property', w: 22 }, { h: 'Phone', w: 15 },
    { h: 'Grade', w: 7 }, { h: 'Score', w: 7 }, { h: 'Criteria', w: 8 },
    { h: 'Legal violation', w: 13 }, { h: 'Fair housing flag', w: 15 },
    { h: 'Liability flag', w: 13 }, { h: 'Summary', w: 80 }, { h: 'Outcome', w: 60 },
    { h: 'Coaching', w: 90 }, { h: 'Flags raised', w: 60 }, { h: 'Key moments', w: 60 },
    { h: 'Not scoreable reason', w: 40 }, { h: 'Flagged for policy review', w: 16 },
    { h: 'Policy review note', w: 50 }, { h: 'Flagged by', w: 16 }, { h: 'Recording ID', w: 34 },
  ]);
  sheet(flagged, 'Flagged', [
    { h: 'Agent', w: 14 }, { h: 'Date', w: 11 }, { h: 'Direction', w: 10 },
    { h: 'Property', w: 22 }, { h: 'Phone', w: 15 }, { h: 'Grade', w: 7 },
    { h: 'Score', w: 7 }, { h: 'What needs review', w: 60 }, { h: 'Flagged by', w: 16 },
    { h: 'Flagged at', w: 22 }, { h: 'Resolved', w: 9 }, { h: 'Summary', w: 80 },
    { h: 'Coaching', w: 90 }, { h: 'Recording ID', w: 34 },
  ]);

  return { wb, counts: { calls: calls.length, criteria: criteria.length, flagged: flagged.length } };
}

const toBuffer = wb => XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

module.exports = { buildWorkbook, toBuffer, criteriaOf, coachingText, cell, mmss, gradeOf };
