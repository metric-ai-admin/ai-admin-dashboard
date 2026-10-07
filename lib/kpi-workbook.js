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
  if (headerIdx === -1) return out;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length || blank(r[propIdx])) continue;
    const prop = canonicalProperty(r[propIdx]);
    if (!prop) continue;
    const goal = num(r[goalIdx]);
    // A goal of 0 is not a goal. Her parser drops them too, and a 0 here would
    // make "units needed" come out negative.
    if (goal > 0) out[prop] = goal;
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

function matchSheets(names) {
  const sheets = {}, missing = [];
  SHEET_PATTERNS.forEach(([key, pats]) => {
    const hit = (names || []).find(n => pats.some(p => normalise(n).includes(normalise(p))));
    if (hit) sheets[key] = hit; else missing.push(key);
  });
  return { sheets, missing };
}

const LABELS = {
  mtd_cash: 'MTD Cash',
  mtd_accrual: 'MTD Accrual',
  occupancy_goals: 'Occupancy Goals',
};

module.exports = {
  normalise, blank, num, canonicalProperty,
  findAccountNameHeader, propertyColumns,
  parseMtdCash, parseMtdAccrual, parseOccupancyGoals,
  EXPENSE_CATEGORIES, EXPENSE_ALIASES, SHEET_PATTERNS, LABELS, matchSheets,
};
