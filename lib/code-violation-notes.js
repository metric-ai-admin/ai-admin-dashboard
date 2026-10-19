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

// ---- the Closed Cases sheet -------------------------------------------------
//
// Six real rows, each a case somebody closed. The sheet also carries a TOTAL
// row and a footnote, which are not cases and must not become rows: a total
// imported as a case would claim ten deficiencies were closed twice.
//
// A City case number is a strict token — four digits, a dash, six digits, then
// CV. Lifting one out of the Status/Resolution text is not the same as reading
// an AUTHOR out of prose, which this module refuses to do: a case number has
// one possible reading, a name in a sentence is an attribution with several.
const CASE_NUMBER_RE = /\b(\d{4}-\d{6})\s*CV\b/i;

function closedCaseFromRow(row, ctx) {
  const c = ctx || {};
  const property = clean(row.Property);
  if (!property) return null;

  // A total row has a number and nothing else; a footnote has prose in the
  // property cell and nothing else. Both are recognised by the ABSENCE of the
  // things a case must have, rather than by matching the word "Total", which
  // would miss "TOTAL", "Grand Total" and whatever the next editor types.
  const hasCaseFields = clean(row.Status) || clean(row.Resolution)
    || clean(row.Closed) || clean(row['Closed by']);
  if (!hasCaseFields) return null;

  const text = [clean(row.Status), clean(row.Resolution)].join(' ');
  const m = text.match(CASE_NUMBER_RE);
  const items = clean(row.Items);

  return {
    // NULL when the sheet does not state one, which is most of them.
    case_number: m ? m[1] + ' CV' : null,
    property,
    // NULL, not 0: "not stated" and "none" are different.
    items: /^\d+$/.test(items) ? Number(items) : null,
    status: clean(row.Status) || null,
    resolution: clean(row.Resolution) || null,
    closed_at: (excelDate(row.Closed) || '').slice(0, 10) || null,
    closed_by: clean(row['Closed by']) || null,
    source: 'excel',
    source_row: [c.sheet || 'Closed Cases', c.rowNumber].join('|'),
  };
}

// How a closed case reads on the case view: "Closed 2026-07-16 by Erick Frey".
function closedLabel(c) {
  if (!c) return null;
  const when = c.closed_at ? String(c.closed_at).slice(0, 10) : null;
  const who = clean(c.closed_by) || null;
  if (!when && !who) return 'Closed — date and closer not recorded';
  if (!when) return 'Closed by ' + who + ' — date not recorded';
  if (!who) return 'Closed ' + when + ' — closer not recorded';
  return 'Closed ' + when + ' by ' + who;
}

// ---- the Watchlist sheet ----------------------------------------------------
//
// Items that are NOT in the AppFolio feed — the reason the sheet exists. Its
// first column mixes a property and a work order in one cell ("Ascent 14196-1",
// "iConic RR — WO 19105-1"), so the work order is lifted by its own shape and
// whatever is left is the property.
const WORK_ORDER_RE = /\b(\d{4,6}-\d{1,2})\b/;

function watchlistFromRow(row, ctx) {
  const c = ctx || {};
  const combined = clean(row['Property / Work Order']);
  if (!combined) return null;
  const item = clean(row.Item);
  if (!item) return null;

  const wo = combined.match(WORK_ORDER_RE);
  // Separators are trimmed from BOTH ends after the work order comes out.
  // Taking "WO 23142-1 - Ascent at Northgate" apart left "- Ascent at
  // Northgate", which is the property name with a dash welded to it and
  // matches nothing downstream.
  const property = clean(combined
    .replace(WORK_ORDER_RE, ' ')
    .replace(/\bWO\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–:-]+/, '')
    .replace(/[\s—–:-]+$/, ''));

  return {
    property_name: property || combined,
    work_order: wo ? wo[1] : null,
    title: item,
    detail: clean(row['Why it is not in the AppFolio feed']) || null,
    authority: clean(row.Owner) || null,
    status: 'Open',
    source_row: [c.sheet || 'Watchlist', c.rowNumber].join('|'),
  };
}

/**
 * Is this watchlist row already stored?
 *
 * MATCHED ON THE TITLE, not on the combined cell. The two rows already in
 * code_violation_watchlist were typed by hand and their property spelling may
 * not match the sheet's; the item text is what a person would recognise as
 * "the same thing". A near-match is reported for a person to decide rather
 * than merged automatically.
 */
function watchlistDuplicate(candidate, existing) {
  const norm = s => clean(s).toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  const title = norm(candidate.title);

  // THE WORK ORDER MAY BE IN THE PROSE. The sheet's first column does not
  // always carry it — "Pool gate repair - Round Rock Fire Department" has
  // 19105-1 inside the item text instead — and the stored row has it as a
  // field. Looking only at the parsed column missed that pair and wrote a
  // second row for a watchlist item somebody had already typed.
  const woIn = s => { const m = clean(s).match(WORK_ORDER_RE); return m ? m[1] : null; };
  const candidateWo = candidate.work_order
    || woIn(candidate.title) || woIn(candidate.detail);

  return (existing || []).find(e => {
    const et = norm(e.title);
    if (et === title) return true;
    // ONE TITLE INSIDE THE OTHER. A hand-typed "Pool gate" and an imported
    // "Pool gate repair - Round Rock Fire Department, inspected 09/24" are the
    // same item written at two lengths. Guarded by a minimum length so a
    // three-letter title does not swallow everything.
    if (et.length >= 6 && title.length >= 6 && (et.includes(title) || title.includes(et))) return true;
    const ewo = clean(e.work_order) || woIn(e.title) || woIn(e.detail);
    if (candidateWo && ewo && ewo === candidateWo) return true;
    return false;
  }) || null;
}

/**
 * Hang the closed-case rows onto the cases they belong to.
 *
 * MATCHED ON THE CASE NUMBER WHEN THERE IS ONE, and on nothing else when
 * there is not. Six of the six closed rows carry no case number — the sheet
 * has no such column — so most of them attach to nothing and are returned
 * separately rather than guessed onto a case by property name. Two cases at
 * the same property closed a month apart would otherwise swap labels, and a
 * wrong "Closed by" is worse than no label: it tells somebody the work is
 * done.
 */
function attachClosed(cases, closedRows) {
  const byNumber = new Map();
  (closedRows || []).forEach(c => {
    const n = clean(c.case_number);
    if (n) byNumber.set(n.toLowerCase(), c);
  });
  return (cases || []).map(c => {
    const hit = c.caseNumber ? byNumber.get(clean(c.caseNumber).toLowerCase()) : null;
    if (!hit) return c;
    return {
      ...c,
      closed: {
        label: closedLabel(hit),
        resolution: clean(hit.resolution) || null,
        items: hit.items === null || hit.items === undefined ? null : Number(hit.items),
      },
    };
  });
}

// ---- the case number -------------------------------------------------------
//
// The City writes it however it likes and whoever keeps the tracker copies it
// as written: "2025-104408 CV", "CV-2026-128356", "2026-072494 CV", and some
// cells that are a sentence rather than a number.
//
// Jay, 2026-10-19: the case number is the stable key. A deficiency can move to
// a different work order without changing case, and one case carries many
// cited deficiencies.
//
// SO THE KEY IS YEAR + NUMBER AND NOTHING ELSE. The "CV" and its position are
// formatting, and two cells that differ only in where the letters sit are the
// same case — which is the whole reason this exists.
//
// THE ORIGINAL TEXT IS NEVER REPLACED. It is what the City sent, it is what
// somebody will search for, and the normalised form is an index, not a
// correction.
const CASE_KEY_RE = /\b(19|20)(\d{2})\s*[-–]\s*(\d{4,8})\b/;

/**
 * @returns {{key: string|null, display: string, pending: boolean}}
 *   `key` is "2025-104408" or null. `pending` is true when the cell carries no
 *   usable number — "case number pending", never a number we made up.
 */
// Something that looks like an identifier but is not the year-number scheme.
// "CE20260917-3645" is one of these — a City numbering we have not been told
// the shape of. It is NOT folded into the scheme above: reading "2026" and
// "0917" out of it would produce a key that looks right and points nowhere.
const LOOKS_LIKE_AN_ID = /[A-Z]{1,3}[-\s]?\d{6,}|\d{6,}[-]\d{3,}/i;

function caseKey(raw) {
  const text = clean(raw);
  if (!text) return { key: null, display: '', pending: true, reason: 'blank' };
  const m = text.match(CASE_KEY_RE);
  if (m) return { key: m[1] + m[2] + '-' + m[3], display: text, pending: false, reason: null };
  // Both are pending — neither gets an invented key — but they are not the
  // same problem, and a count that merges them hides the one somebody can
  // actually answer.
  return {
    key: null,
    display: text,
    pending: true,
    reason: LOOKS_LIKE_AN_ID.test(text) ? 'unrecognised format' : 'no number',
  };
}

/**
 * Group deficiencies by the normalised case, counting what the normalising
 * actually merged.
 *
 * `merged` is the number of cases that existed only because the same case was
 * written two ways. It is reported rather than assumed: if it is zero, the
 * normalising bought nothing and somebody should know that too.
 */
function groupByCaseKey(rows, caseOf) {
  const get = caseOf || (r => r && r.case_number);
  const byKey = new Map();
  const byRaw = new Set();
  const pending = [];
  (rows || []).forEach(r => {
    const c = caseKey(get(r));
    if (clean(get(r))) byRaw.add(clean(get(r)).toLowerCase());
    if (c.pending) { pending.push(r); return; }
    if (!byKey.has(c.key)) byKey.set(c.key, { key: c.key, displays: new Set(), rows: [] });
    const g = byKey.get(c.key);
    g.displays.add(c.display);
    g.rows.push(r);
  });
  const groups = [...byKey.values()].map(g => ({
    key: g.key,
    // Every spelling the City used for this case, kept so a search for any of
    // them finds it.
    displays: [...g.displays],
    rows: g.rows,
  }));
  return {
    groups,
    pending,
    distinctRawCaseTexts: byRaw.size,
    // Split, because "we were not given one" and "we do not recognise this"
    // are different problems and only one of them is ours.
    pendingNoNumber: pending.filter(r => caseKey(get(r)).reason === "no number").length,
    pendingUnrecognised: pending.filter(r => caseKey(get(r)).reason === "unrecognised format").length,
    // How many distinct spellings collapsed into one key.
    merged: groups.reduce((a, g) => a + (g.displays.length - 1), 0),
  };
}

// ---- deficiency -> work orders ----------------------------------------------
//
// The tracker keeps them in one cell: "23240-1", or "23240-1 (was 22882-1)".
// Jay's report uses that cell as a literal lookup key, so every replacement
// lands in his "not found in AppFolio" bucket when AppFolio has both numbers.
//
// THE FIRST NUMBER IS THE CURRENT ONE and anything after a replacement word is
// a previous one. Order, not cleverness: the cell is written front-to-back by
// a person, and a rule that tried to work out which number is "newer" from the
// digits would be inventing a fact the cell does not state.
const WO_IN_TEXT = /\b(\d{4,6}-\d{1,2})\b/g;
const REPLACEMENT_WORD = /\b(was|replaces?|replaced|formerly|previously|supersedes?)\b/i;

function workOrdersFromCell(raw, deficiencyKey) {
  const text = clean(raw);
  if (!text) return [];
  const found = [...text.matchAll(WO_IN_TEXT)].map(m => ({ number: m[1], at: m.index }));
  if (!found.length) return [];

  // Where the cell stops talking about the current work order. Everything at
  // or after a replacement word is history.
  const mark = text.search(REPLACEMENT_WORD);
  const seen = new Set();
  const out = [];
  found.forEach((f, i) => {
    const role = (mark >= 0 && f.at > mark) ? 'replaced' : 'current';
    const key = f.number + '|' + role;
    if (seen.has(key)) return;          // the same number twice in one cell is one fact
    seen.add(key);
    out.push({
      deficiency_key: deficiencyKey || null,
      work_order_number: f.number,
      role,
      replaced_by: null,
      raw_text: text,
      position: i,
    });
  });

  // A replaced row points at whatever is current, when there is one.
  const current = out.find(r => r.role === 'current');
  if (current) out.forEach(r => { if (r.role === 'replaced') r.replaced_by = current.work_order_number; });
  return out;
}

/**
 * The deficiency's own state beside the state of its work orders.
 *
 * THEY ARE NEVER MERGED INTO ONE VERDICT. Erick's rule is about the
 * DEFICIENCY — only the City closes it — and a work order can be closed while
 * the citation stays open. WOs 22882 and 22870 were completed and billed and
 * the City did not clear them on 10/07. A single combined status would have to
 * pick one of those two truths and would be wrong about the other.
 *
 * @param {object} deficiency  a code_violations row
 * @param {object[]} links     code_violation_work_orders rows for it
 * @param {object} woStatusBy  { '23240-1': 'Completed', ... } from AppFolio
 * @param {object} labelledBy  { '23240-1': true } — description starts with
 *                             CODE VIOLATION. A CROSS-CHECK, not a count.
 */
function caseWorkOrderView(deficiency, links, woStatusBy, labelledBy) {
  const city = clean(deficiency && deficiency.status);
  const cityClosed = /^closed by code compliance/i.test(city);
  const rows = (links || []).map(l => {
    const status = clean((woStatusBy || {})[l.work_order_number]) || null;
    return {
      workOrder: l.work_order_number,
      role: l.role,
      replacedBy: l.replaced_by || null,
      // null is "AppFolio does not have this number", which is a different
      // thing from "we have not looked".
      appfolioStatus: status,
      known: status !== null,
      labelled: !!(labelledBy || {})[l.work_order_number],
    };
  });
  const current = rows.filter(r => r.role === 'current');
  const allCurrentClosed = current.length > 0
    && current.every(r => r.known && /^(complet|cancel|closed|ready to bill)/i.test(r.appfolioStatus));
  return {
    city: { status: city || null, closed: cityClosed },
    workOrders: rows,
    // THE SENTENCE THAT MATTERS, and it is only printed when both are true.
    // "The work order is finished and the citation is not" is the normal state
    // of a case waiting on the City, not an error — so it is stated, not
    // flagged as a problem.
    note: (allCurrentClosed && !cityClosed)
      ? 'work order closed; the City has not cleared the deficiency'
      : null,
    crossCheck: {
      labelled: rows.filter(r => r.labelled).length,
      total: rows.length,
      unknown: rows.filter(r => !r.known).length,
    },
  };
}

module.exports = {
  attachClosed, workOrdersFromCell, caseWorkOrderView,
  caseKey, groupByCaseKey, CASE_KEY_RE,
  WO_IN_TEXT, REPLACEMENT_WORD,
  CASE_NUMBER_RE, WORK_ORDER_RE,
  closedCaseFromRow, closedLabel, watchlistFromRow, watchlistDuplicate,
  NO_AUTHOR, NO_DATE, EXCEL_NOTE_COLUMNS, EMPTY_NOTE,
  isEmptyNote, notesFromExcelRow, excelDate, dashboardNote, describe, byCase, clean,
  propertyOptions, membersOf, filterByProperty,
};
