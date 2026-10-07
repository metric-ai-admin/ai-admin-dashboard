// Exporting the Code Violations tracker.
//
// Katie asks Erick for updates and there was no way to hand her anything, so
// this rebuilds the workbook the section was BUILT from —
// Code_Violations_Tracker.xlsx — out of live data, plus a PDF to print and a
// flat CSV.
//
// THE SHAPE IS NOT NEGOTIABLE. People already read that workbook: 20 columns
// in a fixed order on a tab per property, and a Summary counting the seven
// statuses. Changing the order or the names would make the export something
// they have to learn instead of something they recognise.
//
// WHAT COMES FROM DATA AND WHAT DOES NOT, decided with Arturo 2026-10-07:
//
//   Summary        counts only. The original's six narrative notes were
//                  hand-written analysis and are deliberately left out rather
//                  than carried forward stale.
//   Closed Cases   derived from status, because closed_by and closed_at are
//                  empty on all 67 rows. "Date last updated" stands in for the
//                  closing date and the sheet says so on its face.
//   Watchlist      from code_violation_watchlist. The original's third row
//                  (The Sidney) is not in that table and is not invented.
//   Legend/Read Me copied from the 2026-09-24 workbook and LABELLED as a copy
//                  with that date, because nothing in the dashboard maintains
//                  them and a reader must not take them for current.
//   The Sidney     excluded: the property is in cession and is being hidden in
//                  AppFolio.
//   Due Date       blank where it was never captured — 13 rows of 67 have one.
//                  An inferred deadline on a code violation is a liability.
//
// Month, Week Number and Year are CALCULATED from the Deficiency Date, exactly
// as the workbook's own formulas do.

// Column order is the contract. Index matters; do not sort this.
const COLUMNS = [
  ['Property Name', 'property_name', 'text'],
  ['Case Number', 'case_number', 'text'],
  ['Work Order', 'work_order', 'text'],
  ['Address/Unit', 'address_unit', 'text'],
  ['Deficiency Date', 'deficiency_date', 'date'],
  ['Deficiency Description', 'deficiency_description', 'text'],
  ['Status', 'status', 'text'],
  ['Date last updated', 'updated_at', 'date'],
  ['Pending Items', 'pending_items', 'text'],
  ['Completed Items', 'completed_items', 'text'],
  ['Maintenance Remarks', 'maintenance_remarks', 'text'],
  ['Client/Vendor Remarks', 'client_vendor_remarks', 'text'],
  ['Category', 'category', 'text'],
  ['Month', '_month', 'text'],
  ['Week Number', '_week', 'text'],
  ['Year', '_year', 'text'],
  ['Progress Notes', 'progress_notes', 'text'],
  ['Last Updated', 'updated_at', 'date'],
  ['Notice Date', 'notice_date', 'date'],
  ['Due Date', 'due_date', 'date'],
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A date-only string, or null. Never a Date: a Date is a moment in a timezone,
// and "2026-06-08" read as UTC midnight renders as the 7th in Central.
function ymd(v) {
  if (!v) return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[0] : null;
}

// The workbook's N/O/P formulas, in JavaScript.
//
// Week Number is Excel's WEEKNUM default: week 1 contains January 1 and weeks
// start on Sunday, which is NOT ISO-8601. Matching the original matters more
// than being right about ISO here — a different number in the same column
// would read as a data change.
function derived(dateStr) {
  const d = ymd(dateStr);
  if (!d) return { _month: '', _week: '', _year: '' };
  const [y, m, day] = d.split('-').map(Number);
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const here = new Date(Date.UTC(y, m - 1, day));
  const week = Math.floor((Math.floor((here - jan1) / 86400000) + jan1.getUTCDay()) / 7) + 1;
  return { _month: MONTHS[m - 1], _week: 'Week ' + week, _year: String(y) };
}

const isClosed = status => /^(Completed|Closed)/.test(String(status || '').trim());

// One row, in column order, with the derived fields filled in.
function rowFor(v) {
  const d = derived(v.deficiency_date);
  const src = { ...v, ...d };
  return COLUMNS.map(([, key, kind]) => {
    const raw = src[key];
    if (kind === 'date') return ymd(raw);
    return raw == null ? '' : String(raw);
  });
}

// Grouped by property, in the fixed portfolio order, so a property with no
// cases still gets its tab. A property missing from the list looks like an
// oversight; an empty tab is a statement.
function byProperty(violations, properties) {
  const out = new Map();
  (properties || []).forEach(p => out.set(p, []));
  (violations || []).forEach(v => {
    const p = v.property_name || '(no property)';
    if (!out.has(p)) out.set(p, []);     // never drop a row for being unexpected
    out.get(p).push(v);
  });
  // Oldest deficiency first, which is how the original reads.
  for (const list of out.values()) {
    list.sort((a, b) => String(a.deficiency_date || '').localeCompare(String(b.deficiency_date || ''))
      || String(a.case_number || '').localeCompare(String(b.case_number || '')));
  }
  return out;
}

// The Summary matrix: one row per property, one column per status, then TOTAL.
function summary(violations, properties, statuses) {
  const groups = byProperty(violations, properties);
  const rows = [];
  const totals = {};
  statuses.forEach(s => { totals[s] = 0; });
  let grand = 0;
  for (const [property, list] of groups) {
    const counts = {};
    statuses.forEach(s => { counts[s] = 0; });
    let other = 0;
    list.forEach(v => {
      const s = String(v.status || '').trim();
      // A status outside the seven is counted somewhere rather than vanishing:
      // the original turns the TOTAL cell red for exactly this case, and a row
      // that disappears from a count is how a violation gets forgotten.
      if (counts[s] === undefined) other++; else counts[s]++;
    });
    statuses.forEach(s => { totals[s] += counts[s]; });
    grand += list.length;
    rows.push({ property, counts, other, total: list.length });
  }
  return { rows, totals, grand, unknown: rows.reduce((a, r) => a + r.other, 0) };
}

// Closed Cases, derived.
//
// closed_by and closed_at are empty on every row, so the honest substitute is
// the status plus the day the row last moved. Returned with a flag so the
// sheet can say that on its face rather than presenting a guess as a record.
function closedCases(violations) {
  return (violations || [])
    .filter(v => isClosed(v.status))
    .map(v => ({
      property: v.property_name || '',
      case_number: v.case_number || '',
      work_order: v.work_order || '',
      description: v.deficiency_description || '',
      status: v.status || '',
      resolution: v.completed_items || '',
      closed: ymd(v.updated_at),
      closed_by: v.updated_by || '',
    }))
    .sort((a, b) => String(b.closed || '').localeCompare(String(a.closed || '')));
}

// Every row flat, for the CSV, with Property Name first.
function flatRows(violations, properties) {
  const out = [];
  for (const [, list] of byProperty(violations, properties)) {
    list.forEach(v => out.push(rowFor(v)));
  }
  return out;
}

// RFC-4180 with the formula guard, because this one IS opened in Excel.
function toCsv(header, rows) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    // = + - @ start a formula in Excel and Sheets. A description beginning
    // with "-" is ordinary here, so the guard is a prefixed apostrophe rather
    // than a refusal.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
}

const fileStamp = today => 'Code_Violations_Tracker_' + String(today).slice(0, 10);

// Carried from the 2026-09-24 workbook. Nothing in the dashboard maintains
// either of these, so both are written into the export under a line saying so
// — a reader must not take a contact list of unknown age for current.
const REFERENCE_AS_OF = '09/24/2026';
const REFERENCE_NOTE =
  'Reference as of ' + REFERENCE_AS_OF + ' — copied from Code_Violations_Tracker.xlsx. '
  + 'The dashboard does not maintain this sheet; confirm before relying on it.';

const LEGEND = [
  ['Property', 'Code Enforcement Officer / Contact', 'Vendor(s) Involved'],
  ['Ascent at Northgate', 'Crystal Mendez - City of Austin Code Compliance', 'Lopez LLC (Helder, helder-lopez@hotmail.com, 346-500-4544)'],
  ['Sunset Palms', 'Crystal Mendez - City of Austin Code Compliance, 512-423-8709, crystal.mendez@austintexas.gov', 'Lopez LLC / Metric Property Management of Texas LLC - Raul Martinez, Emerson Garcia (internal); electrician TBD'],
  ['Windy Hill Apartment', 'No active cases', '-'],
  ['iConic Round Rock', 'Round Rock Fire Department - Inspector Wagner', 'Carlos Portilla (internal) / Josue Garcia (gate repair, WO 19105-1)'],
  ['iConic Downtown', 'No active cases', '-'],
  ['The Chateau', 'City of Austin Code Officer', 'Angel Martinez (internal) - case CV-2026-068055'],
  ['The Highlander', 'No active cases', '-'],
  ['Hyde Park Square', 'Jerome Howard', 'Carlos Portilla (internal) - case CV-2026-083912'],
];

const READ_ME = [
  ['What one row means', 'One row per cited deficiency, NOT per work order. A single AppFolio work order often lists several code sections - WO 18547-1 carries six. They share a Case Number and Work Order.'],
  ['Status - seven values only', 'Pending | Assigned - No Activity | Assigned - In Progress | Assigned - Reassignment Needed | Completed - No Need to Bill | Completed by Maintenance | Closed by Code Compliance.'],
  ['Dates', 'Real Excel dates, formatted mm/dd/yyyy. Month, Week Number and Year are calculated from the Deficiency Date.'],
  ['Due Date', 'Only a deadline the city actually issued. Blank where none was recorded — never inferred from the citation date.'],
  ['Closed Cases', 'Derived from each case’s status. The dashboard does not record who closed a case or when, so the closing date shown is the day the row last changed.'],
  ['Escalation', 'Workflow and approvals: Jay Manuel. Legal or fair housing: Lyndsay Hanes - never resolve those here. AppFolio report tagging: Arturo Mendoza.'],
];

module.exports = {
  COLUMNS, MONTHS, REFERENCE_AS_OF, REFERENCE_NOTE, LEGEND, READ_ME,
  ymd, derived, isClosed, rowFor, byProperty, summary, closedCases,
  flatRows, toCsv, fileStamp,
};
