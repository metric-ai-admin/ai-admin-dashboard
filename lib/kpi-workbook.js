// The three sheets that still have to come from Katie's workbook.
//
// Everything else in the KPI report is computed from synced data. These are not:
//
//   MTD Cash        income_statement returns 309 rows whatever you ask it,
//   MTD Accrual     ignores its filters and answers PORTFOLIO totals only
//                   (probed live 2026-10-02). Her sheets are per property, so a
//                   portfolio total cannot stand in for them.
//   Occupancy Goals never came from AppFolio at all — a hand-maintained tab.
//
// The parsers are ports of parseMTDCash / parseMTDAccrual / parseOccupancyGoals
// from kpi_dashboard_17.html, read on 2026-10-07. Deliberately ports and not
// improvements: on 2026-10-12 these numbers get held up against the ones her
// page produces, and a better parser that disagreed would make the comparison
// about the parser instead of about the report.
//
// Her sheets are PIVOTS — one row per GL account line, one column per property
// — which is why these read a header row and then walk columns, rather than
// reading records.

// The same alias table every other KPI screen uses, so a goal written as
// "Windy Hill" lands on the column called "Windy Hill Apartment".
const PA = require('./property-aliases.js');

const normalise = s => String(s === null || s === undefined ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const blank = v => v === null || v === undefined || String(v).trim() === '';

// "$1,234.50" and "(45.00)" both appear in these sheets.
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}

// A RATIO, however Excel chose to render it.
//
// The route reads every sheet with raw:false, so a cell FORMATTED as a
// percentage arrives as the string "90%" — and num() strips $ and commas but
// not %, so Number("90%") is NaN, which became 0, which was dropped as "not a
// goal", which emptied the sheet and rejected the whole tab. The workbook was
// fine; the reader could not see it. (lib/kpi-compare.js strips % and has all
// along — two parsers for the same workbook disagreeing on what a number is.)
//
// The % is what says which scale this is, so it is read and not merely
// deleted: "90%" is 0.9 and "0.9" is 0.9. A bare number above 1 is NOT quietly
// divided — 90 might be a percentage typed without its sign or a goal somebody
// fat-fingered, and the row is reported rather than guessed at.
function ratio(v) {
  if (v === null || v === undefined || String(v).trim() === '') {
    return { ok: false, value: null, reason: 'the cell is empty' };
  }
  const raw = String(v).trim();
  const isPct = raw.indexOf('%') !== -1;
  const n = num(raw.replace(/%/g, ''));
  if (!isFinite(n) || (n === 0 && !/^[-+]?0*\.?0*$/.test(raw.replace(/%/g, '')))) {
    return { ok: false, value: null, reason: 'could not read "' + raw + '" as a number' };
  }
  // Rounded: 57.6 / 100 is 0.5760000000000001 in binary floating point, and
  // that is what would be stored and shown.
  const value = isPct ? Math.round((n / 100) * 1e6) / 1e6 : n;
  if (value <= 0) return { ok: false, value: null, reason: 'the goal is 0' };
  if (value > 1) {
    return {
      ok: false,
      value: null,
      reason: 'reads as ' + value + ', which is more than 100% — write it as 90% or 0.9',
    };
  }
  return { ok: true, value, reason: null };
}

// Her canonicalProperty: everything before " - " is the property.
function canonicalProperty(raw) {
  if (raw === null || raw === undefined) return null;
  let name = String(raw).trim();
  if (!name || normalise(name) === 'total') return null;
  const i = name.indexOf(' - ');
  if (i !== -1) name = name.slice(0, i).trim();
  return name || null;
}

// The pivot's header row: the one whose first cell says "Account Name".
function findAccountNameHeader(rows, maxScan) {
  const max = Math.min(maxScan || 15, (rows || []).length);
  for (let i = 0; i < max; i++) {
    const row = rows[i];
    if (row && row[0] && normalise(row[0]) === normalise('Account Name')) return { rowIndex: i, row };
  }
  return null;
}

// colIndex -> property, skipping the trailing Total column.
function propertyColumns(headerRow) {
  const map = {};
  for (let j = 1; j < (headerRow || []).length; j++) {
    const v = headerRow[j];
    if (blank(v)) continue;
    if (normalise(v) === normalise('Total')) continue;
    const prop = canonicalProperty(String(v).trim());
    if (prop) map[j] = prop;
  }
  return map;
}

// MTD Cash -> the single row labelled "Total Operating Income".
function parseMtdCash(rows) {
  const out = {};
  const header = findAccountNameHeader(rows);
  if (!header) return out;
  const cols = propertyColumns(header.row);
  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length || blank(r[0])) continue;
    if (normalise(r[0]) !== normalise('Total Operating Income')) continue;
    Object.keys(cols).forEach(j => { out[cols[j]] = (out[cols[j]] || 0) + num(r[j]); });
    break;                                // only one such row is expected
  }
  return out;
}

// Her seven expense categories, and the aliases for the two whose names in the
// report differ from the labels she asked for. Everything else in the P&L is
// deliberately excluded — this is a summary, not the statement.
const EXPENSE_CATEGORIES = ['General & Administrative', 'Marketing & Leasing',
  'Salaries & Payroll', 'Monthly Contract Expenses', 'Make Ready & Turn',
  'Repairs & Maintenance', 'Utilities'];

const EXPENSE_ALIASES = {
  'general administrative': 'General & Administrative',
  'marketing leasing': 'Marketing & Leasing',
  'salaries payroll': 'Salaries & Payroll',
  'monthly contract services': 'Monthly Contract Expenses',
  'monthly contract expenses': 'Monthly Contract Expenses',
  'make ready turn costs': 'Make Ready & Turn',
  'make ready turn': 'Make Ready & Turn',
  'repairs maintenance': 'Repairs & Maintenance',
  utilities: 'Utilities',
};

// MTD Accrual -> the seven "Total <category>" subtotal rows, per property,
// plus the sum as MTD Expenses.
function parseMtdAccrual(rows) {
  const byProp = {};
  const header = findAccountNameHeader(rows);
  if (!header) return { total: {}, categories: {} };
  const cols = propertyColumns(header.row);
  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length || blank(r[0])) continue;
    const label = normalise(r[0]);
    if (!/^total /.test(label)) continue;
    const cat = EXPENSE_ALIASES[label.replace(/^total /, '')];
    if (!cat) continue;                   // not one of the seven
    Object.keys(cols).forEach(j => {
      const p = cols[j];
      if (!byProp[p]) byProp[p] = {};
      byProp[p][cat] = (byProp[p][cat] || 0) + num(r[j]);
    });
  }
  const total = {};
  Object.keys(byProp).forEach(p => {
    total[p] = EXPENSE_CATEGORIES.reduce((a, c) => a + (byProp[p][c] || 0), 0);
  });
  return { total, categories: byProp };
}

// Occupancy Goals -> a hand-maintained tab: Property, Goal %.
function parseOccupancyGoals(rows) {
  const out = {};
  let headerIdx = -1, propIdx = -1, goalIdx = -1;
  for (let i = 0; i < Math.min(15, (rows || []).length); i++) {
    const r = rows[i] || [];
    const p = r.findIndex(c => normalise(c) === 'property');
    const g = r.findIndex(c => /goal/.test(normalise(c)));
    if (p !== -1 && g !== -1) { headerIdx = i; propIdx = p; goalIdx = g; break; }
  }
  // WHAT COULD NOT BE READ, ROW BY ROW. Reported on the object rather than
  // returned beside it, so every existing caller keeps working with a plain
  // {property: goal} map. Non-enumerable, so Object.keys() still counts goals
  // and only goals — the route decides "nothing could be read" from that count.
  const skipped = [];
  Object.defineProperty(out, '__skipped', { value: skipped, enumerable: false });

  if (headerIdx === -1) return out;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length || blank(r[propIdx])) continue;
    const named = canonicalProperty(r[propIdx]);
    if (!named) continue;
    // THE SAME NAMES THE REST OF THE KPI USES. Her sheet says "iConic at Round
    // Rock" and "Windy Hill"; the report's columns are "iConic Round Rock" and
    // "Windy Hill Apartment". Stored as written, those two goals attach to no
    // column at all and vanish without a word.
    const prop = PA.canonical(named) || named;
    const goal = ratio(r[goalIdx]);
    if (!goal.ok) {
      // A ROW IS NOT THE SHEET. A property with no goal — Ascent has none — is
      // a blank cell for that property, not grounds for rejecting the other
      // six. The row number is the sheet's own, 1-based, so it can be opened.
      skipped.push({ row: i + 1, property: prop, raw: String(r[goalIdx] === undefined ? '' : r[goalIdx]), reason: goal.reason });
      continue;
    }
    out[prop] = goal.value;
  }
  return out;
}

// Which tab is which. Matched on a substring, case-insensitively, the way her
// findSheetName does — tabs get renamed and the names carry stray spaces.
const SHEET_PATTERNS = [
  ['mtd_cash', ['mtd cash', 'month to date cash']],
  ['mtd_accrual', ['mtd accrual', 'month to date accrual']],
  ['occupancy_goals', ['occupancy goals', 'occupancy goal']],
];

// OPTIONAL, and separate from the three above on purpose.
//
// Those three are required: without them the Income Snapshot and the goals
// have no source at all and an upload that half-worked is worse than one that
// refused. Follow-ups are new, so a workbook that predates them — or one
// exported without the tab — still uploads, and the metric reports that it has
// no source rather than taking the whole file down with it.
const OPTIONAL_SHEET_PATTERNS = [
  ['guest_card_inquiries', ['guest card inquiries', 'guest card inquiry']],
];

function matchSheets(names) {
  const sheets = {}, missing = [], optionalMissing = [];
  SHEET_PATTERNS.forEach(([key, pats]) => {
    const hit = (names || []).find(n => pats.some(p => normalise(n).includes(normalise(p))));
    if (hit) sheets[key] = hit; else missing.push(key);
  });
  OPTIONAL_SHEET_PATTERNS.forEach(([key, pats]) => {
    const hit = (names || []).find(n => pats.some(p => normalise(n).includes(normalise(p))));
    if (hit) sheets[key] = hit; else optionalMissing.push(key);
  });
  return { sheets, missing, optionalMissing };
}

const LABELS = {
  mtd_cash: 'MTD Cash',
  mtd_accrual: 'MTD Accrual',
  occupancy_goals: 'Occupancy Goals',
  guest_card_inquiries: 'Guest Card Inquiries',
};

/**
 * Follow-ups per property, from `guest card inquiries`.
 *
 * BY COLUMN NAME, NOT POSITION. The sheet is sixty-odd columns wide — "Follow
 * Ups" sits at BG in this week's export — and a report that wide gets columns
 * added and reordered. Reading BG by number works until the week it does not,
 * and then it reports somebody else's column as follow-ups.
 *
 * The header is not row 1: hers sits on row 6 under the report preamble, so
 * the header is found by looking for the labels rather than assumed.
 *
 * Rows with no property (23 of them this week) contribute nothing — they are
 * skipped, and counted, because "23 rows had no property" is a fact about the
 * export and silence is not.
 *
 * @returns {{}} {property: {followUps, overdue}}, with __skipped on it
 */
function parseGuestCardInquiries(rows) {
  const out = {};
  const stats = { noProperty: 0, rows: 0, columns: {} };
  Object.defineProperty(out, '__stats', { value: stats, enumerable: false });

  let headerIdx = -1, map = null;
  for (let i = 0; i < Math.min(30, (rows || []).length); i++) {
    const r = rows[i] || [];
    const m = {};
    r.forEach((c, j) => { if (String(c).trim()) m[normalise(c)] = j; });
    // Her findHeaderRow for this sheet asks for Property AND Touch Points, so
    // a stray row that happens to say "Property" cannot be taken for it.
    if (m[normalise('Property')] !== undefined && m[normalise('Touch Points')] !== undefined) {
      headerIdx = i; map = m; break;
    }
  }
  if (headerIdx === -1) return out;

  const iProp = map[normalise('Property')];
  const iFu = map[normalise('Follow Ups')];
  const iOd = map[normalise('Overdue Follow Ups')];
  stats.headerRow = headerIdx + 1;
  stats.columns = { followUps: iFu, overdue: iOd };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    stats.rows++;
    // The property arrives with its address — "Ascent at Northgate - 9315
    // Northgate Blvd…" — so it is cut at " - " and then put through the same
    // alias table the rest of the KPI uses.
    const named = canonicalProperty(r[iProp]);
    if (!named) { stats.noProperty++; continue; }
    const prop = PA.canonical(named) || named;
    if (!out[prop]) out[prop] = { followUps: 0, overdue: 0 };
    if (iFu !== undefined) out[prop].followUps += num(r[iFu]);
    if (iOd !== undefined) out[prop].overdue += num(r[iOd]);
  }
  return out;
}

module.exports = {
  normalise, blank, num, canonicalProperty,
  findAccountNameHeader, propertyColumns,
  parseMtdCash, parseMtdAccrual, parseOccupancyGoals, parseGuestCardInquiries,
  EXPENSE_CATEGORIES, EXPENSE_ALIASES, SHEET_PATTERNS, OPTIONAL_SHEET_PATTERNS, LABELS, matchSheets,
};
