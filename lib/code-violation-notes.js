// Notes on a code violation, and the case-level view they hang off.
//
// WHY ONE ROW PER NOTE. The deficiency carried three free-text blocks and a
// single updated_by, so two people writing on the same item overwrote each
// other or ran together with nothing saying who wrote which half. Rocío and
// Bekah have been keeping the real thread in a SharePoint workbook for exactly
// that reason.
//
// THE AUTHOR IS NULL ON ANYTHING IMPORTED. The workbook has no author column —
// twenty columns, two of them dates, none a person. Names appear only inside
// sentences ("cancelled 10/07/2026 3:17 PM by Erick Frey"), and pulling one
// out with a pattern would put a name against words somebody else may have
// written. Absent is a value here.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// What the screen shows when there is no author. Said once, here, so the two
// renderers cannot disagree about it.
const NO_AUTHOR = 'author not recorded';
const NO_DATE = 'date not recorded';

// The workbook columns that are notes, and what each is called on screen. The
// order is the order they are shown in.
const EXCEL_NOTE_COLUMNS = [
  ['Maintenance Remarks', 'Maintenance'],
  ['Client/Vendor Remarks', 'Client / vendor'],
  ['Progress Notes', 'Progress'],
  ['Pending Items', 'Pending items'],
  ['Completed Items', 'Completed items'],
];

// Placeholders the workbook uses for "nothing here". Importing these as notes
// would fill the thread with rows that say nothing — and "None yet." appearing
// under a timestamp reads as somebody having checked, which nobody did.
const EMPTY_NOTE = /^(none|none yet\.?|n\/?a|-|–|—|tbd|no notes?\.?)$/i;

const isEmptyNote = body => !clean(body) || EMPTY_NOTE.test(clean(body));

/**
 * One workbook row -> the notes it contains.
 *
 * @param {object} row      the sheet row, keyed by its header
 * @param {object} ctx      { sheet, rowNumber, deficiencyKey }
 */
function notesFromExcelRow(row, ctx) {
  const c = ctx || {};
  const out = [];
  EXCEL_NOTE_COLUMNS.forEach(([column, label]) => {
    const body = clean(row[column]);
    if (isEmptyNote(body)) return;
    out.push({
      deficiency_key: c.deficiencyKey || null,
      case_number: clean(row['Case Number']) || null,
      // The label is kept so the thread still says which block it came from.
      // Without it five imported notes on one deficiency are five paragraphs
      // in an order nobody chose.
      body: label + ': ' + body,
      // NOT PARSED FROM THE TEXT. See the note at the top.
      author: null,
      authored_at: excelDate(row['Last Updated']) || excelDate(row['Date last updated']),
      source: 'excel',
      source_row: [c.sheet, c.rowNumber, column].join('|'),
    });
  });
  return out;
}

/**
 * A workbook date cell as an ISO timestamp, or null.
 *
 * NULL RATHER THAN TODAY. An unparseable date must not become the import time:
 * that would date every note to the day we loaded it and make the thread look
 * like it was all written at once.
 */
function excelDate(v) {
  const s = clean(v);
  if (!s) return null;
  // MM/DD/YYYY, which is how the workbook writes them.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    const iso = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    return Number.isNaN(Date.parse(iso)) ? null : iso + 'T00:00:00.000Z';
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return Number.isNaN(Date.parse(s)) ? null : new Date(s).toISOString();
  }
  return null;
}

/**
 * A note written in the dashboard.
 *
 * The author is required here and refused if absent — the whole point of the
 * new path is that it knows who is typing. A dashboard note with no author
 * would be indistinguishable from an imported one.
 */
function dashboardNote({ body, author, deficiencyKey, caseNumber, now }) {
  const b = clean(body);
  if (!b) throw new Error('a note needs a body');
  const a = clean(author);
  if (!a) throw new Error('a note written here needs an author');
  if (!clean(deficiencyKey) && !clean(caseNumber)) {
    throw new Error('a note needs a deficiency or a case to belong to');
  }
  return {
    deficiency_key: clean(deficiencyKey) || null,
    case_number: clean(caseNumber) || null,
    body: b,
    author: a,
    authored_at: now || new Date().toISOString(),
    source: 'dashboard',
    source_row: null,
  };
}

// How one note reads. Newest-looking fields first, and both unknowns stated.
function describe(n) {
  return {
    ...n,
    authorLabel: clean(n.author) || NO_AUTHOR,
    dateLabel: n.authored_at ? String(n.authored_at).slice(0, 10) : NO_DATE,
  };
}

/**
 * Deficiencies grouped into the cases the City actually issues.
 *
 * THE CASE IS THE UNIT THE CITY WORKS IN. Nine deficiencies on one case number
 * is one conversation with one inspector, and a flat list of 78 rows hides
 * which of them are the same case. Counts are per case so "3 of 9 done" is
 * answerable without adding up a screen.
 *
 * A deficiency with NO case number is not dropped — it goes under its own
 * heading. The workbook has rows like that, and a row that vanishes because a
 * field is blank is the failure this codebase keeps running into.
 */
const DONE_RE = /^(completed|closed|done)/i;

function byCase(deficiencies, notes) {
  const notesFor = {};
  (notes || []).forEach(n => {
    const k = clean(n.deficiency_key);
    if (k) (notesFor[k] = notesFor[k] || []).push(n);
  });
  const caseNotes = {};
  (notes || []).forEach(n => {
    if (clean(n.deficiency_key)) return;      // already attached above
    const c = clean(n.case_number);
    if (c) (caseNotes[c] = caseNotes[c] || []).push(n);
  });

  const cases = new Map();
  (deficiencies || []).forEach(d => {
    const key = clean(d.case_number) || '(no case number)';
    if (!cases.has(key)) {
      cases.set(key, {
        caseNumber: clean(d.case_number) || null,
        unnumbered: !clean(d.case_number),
        property: clean(d.property_name) || null,
        deficiencies: [],
        notes: caseNotes[key] || [],
      });
    }
    const c = cases.get(key);
    if (!c.property) c.property = clean(d.property_name) || null;
    c.deficiencies.push({
      ...d,
      done: DONE_RE.test(clean(d.status)),
      notes: (notesFor[clean(d.deficiency_key)] || []).map(describe),
    });
  });

  return [...cases.values()].map(c => {
    const done = c.deficiencies.filter(d => d.done).length;
    return {
      ...c,
      notes: c.notes.map(describe),
      total: c.deficiencies.length,
      done,
      open: c.deficiencies.length - done,
      // "3 of 9" is the sentence somebody reads out in a meeting.
      progress: c.deficiencies.length ? done + ' of ' + c.deficiencies.length : '0 of 0',
      complete: c.deficiencies.length > 0 && done === c.deficiencies.length,
    };
  }).sort((a, b) =>
    // Open work first, then the biggest cases, then by number so the order is
    // stable between loads.
    (b.open - a.open) || (b.total - a.total)
    || String(a.caseNumber || '').localeCompare(String(b.caseNumber || '')));
}

/**
 * The property filter Jay's Maintenance tab has and ours does not.
 *
 * A SELECTION IS A PROPERTY OR A PORTFOLIO, and the portfolio members come
 * from lib/kpi-report.js — the same place brief_portfolios is filled from, and
 * the same four properties Jay's cv-live.js lists for Greystone independently.
 * Restating the membership here would make a third copy of a list that two
 * systems already agree on.
 *
 * AN UNKNOWN SELECTION RETURNS NOTHING AND SAYS SO, rather than falling back
 * to everything: a filter that silently stops filtering shows the whole
 * portfolio under one property's name, which reads as that property having
 * every violation in the company.
 */
function propertyOptions(kpi) {
  const groups = Object.keys((kpi && kpi.VIRTUAL_GROUPS) || {});
  const rr = kpi && kpi.ROUND_ROCK && kpi.ROUND_ROCK.name ? [kpi.ROUND_ROCK.name] : [];
  return { groups: groups.concat(rr) };
}

function membersOf(selection, kpi) {
  const s = clean(selection);
  if (!s || s.toLowerCase() === 'all') return null;          // null = no filter
  const vg = (kpi && kpi.VIRTUAL_GROUPS) || {};
  const hit = Object.keys(vg).find(g => g.toLowerCase() === s.toLowerCase());
  if (hit) return vg[hit].slice();
  const rr = kpi && kpi.ROUND_ROCK;
  if (rr && clean(rr.name).toLowerCase() === s.toLowerCase()) return (rr.members || []).slice();
  return [s];                                                 // a single property
}

/**
 * @returns {{rows: object[], selection: string|null, members: string[]|null,
 *            matched: boolean}} `matched` is false when the selection named
 *            nothing present — the caller says so instead of showing zero rows
 *            as though the property were clean.
 */
function filterByProperty(rows, selection, kpi, field) {
  const f = field || 'property_name';
  const members = membersOf(selection, kpi);
  if (!members) return { rows: rows || [], selection: null, members: null, matched: true };
  const want = new Set(members.map(m => clean(m).toLowerCase()));
  const out = (rows || []).filter(r => want.has(clean(r[f]).toLowerCase()));
  const anyKnown = (rows || []).some(r => want.has(clean(r[f]).toLowerCase()));
  return {
    rows: out,
    selection: clean(selection),
    members,
    // A real property with no violations is matched and empty — a good result.
    // A selection nobody recognises is NOT, and the difference matters.
    matched: anyKnown || members.length > 0,
  };
}

module.exports = {
  NO_AUTHOR, NO_DATE, EXCEL_NOTE_COLUMNS, EMPTY_NOTE,
  isEmptyNote, notesFromExcelRow, excelDate, dashboardNote, describe, byCase, clean,
  propertyOptions, membersOf, filterByProperty,
};
