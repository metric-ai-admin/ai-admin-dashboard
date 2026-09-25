// billable-report.js
//
// The Billable Labor Report, built from four CSVs Lyndsay exports from
// AppFolio: Work Order Billable Detail for a daily, weekly and monthly window,
// plus the Work Order Labor Summary.
//
// WHY UPLOADS RATHER THAN THE API
//
// work_order_billable_detail is reachable through the Reports API and carries
// every column this report needs — but it only ever returns Completed work
// orders. "Work Done" and "Ready to Bill", the two statuses that represent
// money not yet billed, are absent from it, and AppFolio ignores the status
// filter on that report (documented in appfolio-reports.js since 2026-09-17).
// The web UI can filter on what the API cannot, so the CSV Lyndsay exports by
// hand carries statuses no automated pull can reach.
//
// Everything here is pure: CSVs in, numbers out. No I/O, no database, no dates
// of its own — the caller passes `today` so a report is reproducible and a test
// does not drift when the clock does.

// ---- Exclusions -------------------------------------------------------------
// The shared list every other module uses (server.js's
// METRIC_EXCLUDED_PROPERTY_FRAGMENTS), plus the corporate entity, which is a
// billing entity rather than a property Metric manages. Fragment matching, not
// equality: AppFolio renders the same property under several spellings.
const EXCLUDED_FRAGMENTS = [
  'lily pad', 'wolf ridge', 'sidney', 'brazos', 'live with metric',
  'metric property management of texas',
];

function isExcludedProperty(name) {
  const n = String(name || '').toLowerCase();
  return EXCLUDED_FRAGMENTS.some(f => n.includes(f));
}

// ---- CSV --------------------------------------------------------------------
//
// A hand-rolled parser rather than a dependency, because the shape is known and
// small — but it must handle quoted fields containing commas and newlines.
// Property names and job descriptions contain both, and a split(',') parser
// silently shifts every column after the first comma inside a quote, which
// produces a report that is wrong rather than one that fails.
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');   // Excel writes a BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }      // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // AppFolio exports sometimes carry a title line above the header. The header
  // is the first row with more than one non-empty cell.
  const headerIdx = rows.findIndex(r => r.filter(c => String(c).trim()).length > 1);
  if (headerIdx < 0) return { headers: [], rows: [] };

  const headers = rows[headerIdx].map(h => String(h).trim());
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some(c => String(c).trim())) continue;        // blank line
    // A trailing "Total" line would otherwise be counted as a work order.
    if (/^\s*(total|grand total|sum)\s*$/i.test(String(r[0] || ''))) continue;
    const o = {};
    headers.forEach((h, j) => { o[h] = r[j] === undefined ? '' : String(r[j]).trim(); });
    out.push(o);
  }
  return expandGroups({ headers, rows: out });
}

// ---- The grouped export -----------------------------------------------------
//
// AppFolio's Work Order Billable Detail exports GROUPED, not flat. There is no
// property column: the first column is "Group", and a property appears as its
// own row reading "-> Hyde Park Square", with that property's work orders on
// the rows beneath it until the next "->" header.
//
//   Group,count(Work Order Number),Unit,Vendor,...
//   -> Hyde Park Square,28,,,...          <- header AND subtotal
//   ,,5-224,Acme Plumbing,...             <- a work order under it
//   ,,3-101,Acme Plumbing,...
//   -> Ascent at Northgate,12,,,...
//
// Two things follow, and the second is easy to miss:
//
//   1. The property has to be forward-filled onto the rows below it.
//   2. The header row is a SUBTOTAL, not a work order. Counting it as data
//      would add a phantom row per property and double the money, since its
//      amount columns repeat the group's totals.
//
// And there is no Work Order Number column on the data rows at all — only
// count(Work Order Number) on the header. So the distinct-work-order count for
// a property can only come from that header value, which is why groupCounts is
// carried out of here rather than recomputed downstream.
function expandGroups(parsed) {
  const groupKey = parsed.headers.find(h => norm(h) === 'group');
  if (!groupKey) return { ...parsed, grouped: false, groupCounts: null };

  const countKey = parsed.headers.find(h => /count.*work_order_number|work_order_count/.test(norm(h)))
    || parsed.headers.find(h => norm(h).startsWith('count'));

  const rows = [];
  const groupCounts = {};
  let current = '';
  for (const r of parsed.rows) {
    const cell = String(r[groupKey] || '').trim();
    // "->" is what AppFolio writes; en/em dashes appear when the file has been
    // opened and re-saved in Excel.
    const header = cell.match(/^(?:->|[-–—]>|→)\s*(.+)$/);
    if (header) {
      current = header[1].trim();
      const n = countKey ? parseInt(String(r[countKey] || '').replace(/[^0-9]/g, ''), 10) : NaN;
      if (isFinite(n)) groupCounts[current] = (groupCounts[current] || 0) + n;
      continue;                      // subtotal row: never data
    }
    // A row before any header has no property; keep it so it is visible as
    // "(no property)" rather than silently vanishing.
    rows.push({ ...r, __property: current });
  }
  return { headers: [...parsed.headers, '__property'], rows, grouped: true, groupCounts };
}

// ---- Column resolution ------------------------------------------------------
//
// The CSV comes from the WEB UI, which writes human labels ("Work Order
// Status"), while the API writes snake_case ("work_order_status"). Both spellings
// reach this module — the same report can arrive either way — so every field is
// looked up through a candidate list on a normalised key.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const FIELDS = {
  // __property is synthesised by expandGroups() for the grouped export, which
  // has no property column at all — the name lives in "-> Name" header rows.
  // First in the list so it wins when present.
  property: ['__property', 'property_name', 'property', 'property_address'],
  tech: ['maintenance_tech', 'technician', 'tech', 'assigned_user', 'assigned_to', 'vendor'],
  status: ['work_order_status', 'status', 'wo_status'],
  workOrder: ['work_order_number', 'work_order', 'wo_number', 'wo', 'work_order_id', 'service_request_number'],
  workedHours: ['worked_hours', 'hours_worked', 'actual_hours'],
  billableHours: ['billable_hours', 'hours', 'billed_hours'],
  billedAmount: ['billed_amount', 'billed', 'amount_billed', 'last_billed_amount'],
  unbilledAmount: ['unbilled_amount', 'unbilled', 'amount_unbilled'],
  amount: ['amount', 'total_amount', 'vendor_bill_amount'],
  billableType: ['billable_type', 'billable', 'bill_to'],
  date: ['work_completed_on', 'completed_on', 'date', 'work_done_on', 'labor_date', 'created_date'],
};

// Builds { logicalName -> actual header } once per file.
function resolveColumns(headers) {
  const byNorm = {};
  headers.forEach(h => { byNorm[norm(h)] = h; });
  const map = {};
  for (const [field, candidates] of Object.entries(FIELDS)) {
    const hit = candidates.find(c => byNorm[c]);
    // Fall back to a header that CONTAINS the candidate, so "Total Billed
    // Amount" still resolves — but only when nothing matched exactly, or
    // "hours" would swallow "worked_hours".
    map[field] = hit ? byNorm[hit]
      : (candidates.map(c => Object.keys(byNorm).find(k => k.includes(c)))
        .filter(Boolean).map(k => byNorm[k])[0] || null);
  }
  return map;
}

const get = (row, cols, field) => (cols[field] ? row[cols[field]] : undefined);

// Money and hours arrive as "$1,234.50", "(45.00)" for negatives, or "".
function num(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

// ---- Status buckets ---------------------------------------------------------
// The report cares about three groups. Matched on normalised text so "Ready To
// Bill" and "ready_to_bill" land together.
const STATUS_GROUPS = {
  workDone: ['work_done'],
  readyToBill: ['ready_to_bill'],
  completed: ['completed', 'completed_no_need_to_bill'],
};

function statusGroup(raw) {
  const n = norm(raw);
  for (const [group, values] of Object.entries(STATUS_GROUPS)) {
    if (values.includes(n)) return group;
  }
  return null;
}

// ---- The export date, read out of the file ----------------------------------
//
// The failure mode for an upload-driven report is a stale file silently
// becoming this week's numbers, and nothing else catches it. So the newest date
// found in the rows is reported per file, and the caller compares it to today.
function exportDate(rows, cols) {
  const dates = rows
    .map(r => String(get(r, cols, 'date') || '').trim())
    .map(d => {
      if (!d) return null;
      // ISO first; then US M/D/YYYY, which is what the UI exports.
      const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (us) return `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
      return null;
    })
    .filter(Boolean)
    .sort();
  return dates.length ? { first: dates[0], last: dates[dates.length - 1] } : { first: null, last: null };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// ---- Aggregation ------------------------------------------------------------

// One period (daily / weekly / monthly) from one Billable Detail CSV.
function summarisePeriod(parsed) {
  const cols = resolveColumns(parsed.headers);
  const rows = parsed.rows.filter(r => !isExcludedProperty(get(r, cols, 'property')));

  const s = {
    rows: rows.length,
    rowsExcluded: parsed.rows.length - rows.length,
    workDone: 0, readyToBill: 0, completed: 0, otherStatus: 0,
    billableHours: 0, workedHours: 0,
    billed: 0, unbilled: 0,
    // Counted as DISTINCT work orders, not rows: the billable detail is one row
    // per labor entry, so a work order with four entries would otherwise count
    // four times.
    workOrders: new Set(),
    statusesSeen: {},
  };

  rows.forEach(r => {
    const raw = get(r, cols, 'status');
    const g = statusGroup(raw);
    if (raw) s.statusesSeen[raw] = (s.statusesSeen[raw] || 0) + 1;
    if (g) s[g]++; else s.otherStatus++;
    s.billableHours += num(get(r, cols, 'billableHours'));
    s.workedHours += num(get(r, cols, 'workedHours'));
    s.billed += num(get(r, cols, 'billedAmount'));
    s.unbilled += num(get(r, cols, 'unbilledAmount'));
    const wo = get(r, cols, 'workOrder');
    if (wo) s.workOrders.add(String(wo));
  });

  // In the grouped export the data rows carry no work-order number — the count
  // lives on the "-> Property" header. Sum those, skipping excluded properties.
  let workOrders = s.workOrders.size;
  if (parsed.groupCounts) {
    workOrders = Object.entries(parsed.groupCounts)
      .filter(([p]) => !isExcludedProperty(p))
      .reduce((a, [, n]) => a + n, 0);
  }

  const dates = exportDate(rows, cols);
  return {
    ...s,
    workOrders,
    grouped: !!parsed.grouped,
    billableHours: round1(s.billableHours),
    workedHours: round1(s.workedHours),
    billed: round2(s.billed),
    unbilled: round2(s.unbilled),
    dateRange: dates,
    columnsResolved: cols,
    // Named so the UI can say which columns it could NOT find, rather than
    // silently reporting zeros for a column that was spelled differently.
    columnsMissing: Object.entries(cols).filter(([, v]) => !v).map(([k]) => k),
  };
}

// Status × property, for one period.
function byProperty(parsed, { woAlertThreshold = 10 } = {}) {
  const cols = resolveColumns(parsed.headers);
  const map = new Map();
  parsed.rows.forEach(r => {
    const property = String(get(r, cols, 'property') || '').trim() || '(no property)';
    if (isExcludedProperty(property)) return;
    if (!map.has(property)) {
      map.set(property, {
        property, workDone: 0, readyToBill: 0, completed: 0, other: 0,
        billableHours: 0, workedHours: 0, billed: 0, unbilled: 0, workOrders: new Set(),
      });
    }
    const p = map.get(property);
    const g = statusGroup(get(r, cols, 'status'));
    if (g) p[g]++; else p.other++;
    p.billableHours += num(get(r, cols, 'billableHours'));
    p.workedHours += num(get(r, cols, 'workedHours'));
    p.billed += num(get(r, cols, 'billedAmount'));
    p.unbilled += num(get(r, cols, 'unbilledAmount'));
    const wo = get(r, cols, 'workOrder');
    if (wo) p.workOrders.add(String(wo));
  });

  return [...map.values()]
    .map(p => ({
      ...p,
      // The grouped export's header count is authoritative: its data rows have
      // no work-order number, so the Set would be empty and every property
      // would read zero.
      workOrders: (parsed.groupCounts && parsed.groupCounts[p.property] !== undefined)
        ? parsed.groupCounts[p.property]
        : p.workOrders.size,
      billableHours: round1(p.billableHours),
      workedHours: round1(p.workedHours),
      billed: round2(p.billed),
      unbilled: round2(p.unbilled),
    }))
    // The red-highlight rule is applied AFTER the count is settled, so it reads
    // the group header's number rather than an empty Set.
    .map(p => ({ ...p, alert: p.workOrders > woAlertThreshold }))
    .sort((a, b) => b.workOrders - a.workOrders || a.property.localeCompare(b.property));
}

// Property × technician, from the Labor Summary.
function byPropertyAndTech(parsed, { woAlertThreshold = 10 } = {}) {
  const cols = resolveColumns(parsed.headers);
  const map = new Map();
  parsed.rows.forEach(r => {
    const property = String(get(r, cols, 'property') || '').trim() || '(no property)';
    if (isExcludedProperty(property)) return;
    const tech = cleanTech(get(r, cols, 'tech'));
    const key = property + '\u0000' + tech;
    if (!map.has(key)) map.set(key, { property, tech, hours: 0, workedHours: 0, workOrders: new Set() });
    const e = map.get(key);
    e.hours += num(get(r, cols, 'billableHours'));
    e.workedHours += num(get(r, cols, 'workedHours'));
    const wo = get(r, cols, 'workOrder');
    if (wo) e.workOrders.add(String(wo));
  });
  return [...map.values()]
    .map(e => ({
      ...e,
      hours: round1(e.hours),
      workedHours: round1(e.workedHours),
      workOrders: e.workOrders.size,
      alert: e.workOrders.size > woAlertThreshold,
    }))
    .sort((a, b) => a.property.localeCompare(b.property) || b.hours - a.hours);
}

// Technician totals across everything.
function byTech(parsed, { woAlertThreshold = 10 } = {}) {
  const cols = resolveColumns(parsed.headers);
  const map = new Map();
  parsed.rows.forEach(r => {
    const property = get(r, cols, 'property');
    if (isExcludedProperty(property)) return;
    const tech = cleanTech(get(r, cols, 'tech'));
    if (!map.has(tech)) map.set(tech, { tech, hours: 0, workedHours: 0, workOrders: new Set(), properties: new Set() });
    const e = map.get(tech);
    e.hours += num(get(r, cols, 'billableHours'));
    e.workedHours += num(get(r, cols, 'workedHours'));
    const wo = get(r, cols, 'workOrder');
    if (wo) e.workOrders.add(String(wo));
    if (property) e.properties.add(String(property).trim());
  });
  return [...map.values()]
    .map(e => ({
      tech: e.tech,
      hours: round1(e.hours),
      workedHours: round1(e.workedHours),
      // The gap between what was worked and what is billable is the number
      // this table exists to show.
      unbillableHours: round1(e.workedHours - e.hours),
      workOrders: e.workOrders.size,
      properties: e.properties.size,
      alert: e.workOrders.size > woAlertThreshold,
    }))
    .sort((a, b) => b.hours - a.hours);
}

// AppFolio suffixes tech names: "Alex Worley (Hidden)", "Emerson Garcia -".
// Left visible in raw data, tidied for display — one person must be one row.
function cleanTech(raw) {
  const s = String(raw || '').replace(/\s*\(hidden\)\s*/i, '').replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
  return s || '(unassigned)';
}

const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;

// ---- The whole report -------------------------------------------------------
//
// `files` is { daily, weekly, monthly, labor }, each the raw CSV text.
// `today` is passed in rather than read from the clock so the staleness warning
// is testable and a report is reproducible.
function buildReport(files, { today, woAlertThreshold = 10, staleDays = 2 } = {}) {
  const parsed = {};
  for (const key of ['daily', 'weekly', 'monthly', 'labor']) {
    parsed[key] = files[key] ? parseCsv(files[key]) : { headers: [], rows: [] };
  }

  const periods = {};
  for (const key of ['daily', 'weekly', 'monthly']) {
    periods[key] = summarisePeriod(parsed[key]);
    const last = periods[key].dateRange.last;
    const age = daysBetween(last, today);
    periods[key].staleDays = age;
    // A file whose newest row predates the report is the failure this guards.
    // Reported, never blocking: a Monday report legitimately has no weekend
    // work in it, and refusing to build would be worse than saying so.
    periods[key].stale = age !== null && age > staleDays;
  }

  const labor = parsed.labor;
  const laborCols = resolveColumns(labor.headers);
  const laborDates = exportDate(labor.rows, laborCols);

  return {
    generatedAt: null,      // stamped by the caller, which owns the clock
    today,
    summary: {
      daily: periods.daily,
      weekly: periods.weekly,
      monthly: periods.monthly,
    },
    byProperty: {
      daily: byProperty(parsed.daily, { woAlertThreshold }),
      weekly: byProperty(parsed.weekly, { woAlertThreshold }),
      monthly: byProperty(parsed.monthly, { woAlertThreshold }),
    },
    byPropertyAndTech: byPropertyAndTech(labor, { woAlertThreshold }),
    byTech: byTech(labor, { woAlertThreshold }),
    labor: {
      rows: labor.rows.length,
      dateRange: laborDates,
      staleDays: daysBetween(laborDates.last, today),
      columnsMissing: Object.entries(laborCols).filter(([, v]) => !v).map(([k]) => k),
    },
    woAlertThreshold,
    excludedFragments: EXCLUDED_FRAGMENTS,
  };
}

// ---- CSV out ----------------------------------------------------------------
// Per-section export. Formula injection is guarded the same way
// call-grades-workbook.js does it: a cell beginning = + - @ is executable when
// the file is opened in Excel, and vendor and property names are free text.
function toCsv(rows, columns) {
  const esc = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

module.exports = {
  parseCsv, resolveColumns, buildReport, summarisePeriod,
  byProperty, byPropertyAndTech, byTech, toCsv,
  isExcludedProperty, cleanTech, num, statusGroup, exportDate,
  EXCLUDED_FRAGMENTS,
};
