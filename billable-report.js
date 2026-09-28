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
  return dropSubtotalRows(expandGroups({ headers, rows: out }));
}

// AppFolio's trailing subtotal rows.
//
// Besides the "-> Property" group headers, the export carries unlabelled
// subtotal rows: no work order, no status, no vendor, but the Amount and Hours
// columns filled with the totals of the rows above. Kept as data they inflate
// every money and hours figure by roughly double, and they are invisible in the
// output because they land under whichever property they trail.
//
// Every "has nothing" condition is required, not any one of them, and the
// identifying fields are in that list for a reason. A genuine line can lack a
// vendor, and in a status-grouped file it can lack a per-row status too —
// inheriting it from the section it sits under. Dropping on the absence of a
// work order, a status and a vendor alone would have deleted exactly those
// rows. A real subtotal has no unit, no description and no date either: it
// identifies nothing, it only totals.
function dropSubtotalRows(parsed) {
  const cols = resolveColumns(parsed.headers);
  // The status a row carries ITSELF. __groupStatus is inherited from the
  // section heading and would make a blank subtotal row look like it had one.
  const ownStatus = cols.status === '__groupStatus' ? null : cols.status;

  const rows = [];
  const subtotalRows = [];
  for (const r of parsed.rows) {
    const has = field => !!String(get(r, cols, field) == null ? '' : get(r, cols, field)).trim();
    const hasStatus = ownStatus ? !!String(r[ownStatus] == null ? '' : r[ownStatus]).trim() : false;
    const hasMoney = num(get(r, cols, 'amount')) !== 0
      || num(get(r, cols, 'billedAmount')) !== 0
      || num(get(r, cols, 'unbilledAmount')) !== 0
      || num(get(r, cols, 'billableHours')) !== 0
      || num(get(r, cols, 'workedHours')) !== 0;

    const identifiesNothing = !has('workOrder') && !hasStatus && !has('tech')
      && !has('unit') && !has('description') && !has('date');
    if (identifiesNothing && hasMoney) {
      subtotalRows.push(r);
      continue;
    }
    rows.push(r);
  }
  return { ...parsed, rows, subtotalRows };
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
  const groupRows = [];     // kept, not discarded — see the debug route
  const groupCounts = {};
  // A group whose NAME is a status is not a property.
  //
  // This report can be grouped by status as well as by property, and the two
  // nest. When it is, "-> Work Done" is a group header carrying a work-order
  // count, and a work order with nothing billed yet has NO data rows beneath
  // it — the header is the only trace of it in the file. Treating that header
  // as a property put "Work Done" in the property column and lost the status
  // entirely, which is how Work Done and Ready to Bill read 0 beside a file
  // that plainly contained them.
  const statusGroupCounts = {};
  const statusGroupHasRows = {};
  const byPropStatus = {};
  const statusGroupHasRowsByProp = {};
  let currentProperty = '';
  let currentStatus = '';
  for (const r of parsed.rows) {
    const cell = String(r[groupKey] || '').trim();
    // "->" is what AppFolio writes; en/em dashes appear when the file has been
    // opened and re-saved in Excel.
    const header = cell.match(/^(?:->|[-–—]>|→)\s*(.+)$/);
    if (header) {
      const name = header[1].trim();
      const n = countKey ? parseInt(String(r[countKey] || '').replace(/[^0-9]/g, ''), 10) : NaN;
      const asStatus = statusGroup(name);
      if (asStatus) {
        currentStatus = name;
        const pk = currentProperty + ' ' + name;
        if (isFinite(n)) {
          statusGroupCounts[name] = (statusGroupCounts[name] || 0) + n;
          // Keyed by property too, so the per-property table can show a status
          // whose only trace is a header under that property.
          byPropStatus[pk] = { property: currentProperty, status: name, count: (byPropStatus[pk] ? byPropStatus[pk].count : 0) + n };
        }
        if (statusGroupHasRows[name] === undefined) statusGroupHasRows[name] = false;
        if (statusGroupHasRowsByProp[pk] === undefined) statusGroupHasRowsByProp[pk] = false;
      } else {
        currentProperty = name;
        // A new property starts a new status section; carrying the previous
        // one across would label the next property's rows with it.
        currentStatus = '';
        if (isFinite(n)) groupCounts[name] = (groupCounts[name] || 0) + n;
      }
      groupRows.push({ ...r, __group: name, __isStatusGroup: !!asStatus });
      continue;                      // subtotal row: never data
    }
    // A row before any header has no property; keep it so it is visible as
    // "(no property)" rather than silently vanishing.
    if (currentStatus) {
      statusGroupHasRows[currentStatus] = true;
      statusGroupHasRowsByProp[currentProperty + ' ' + currentStatus] = true;
    }
    rows.push({ ...r, __property: currentProperty, __groupStatus: currentStatus });
  }
  return {
    headers: [...parsed.headers, '__property', '__groupStatus'],
    rows, groupRows, grouped: true, groupCounts,
    statusGroupCounts,
    // Status groups whose work orders produced no billable line at all. Their
    // header count is the only evidence they exist.
    emptyStatusGroups: Object.keys(statusGroupCounts).filter(k => !statusGroupHasRows[k]),
    // [{ property, status, count }] for status groups that produced no rows.
    emptyStatusGroupsByProperty: Object.entries(byPropStatus)
      .filter(([k]) => !statusGroupHasRowsByProp[k])
      .map(([, v]) => v),
  };
}

// ---- Erick's workbook -------------------------------------------------------
//
// AppFolio's Excel plugin refreshes ONE .xlsx holding all four reports as
// sheets, which is a great deal less work than exporting four CSVs. Same data,
// so it joins the existing pipeline rather than getting its own: each sheet is
// turned into the CSV text the four slots already hold, and everything
// downstream — grouping, subtotal removal, column resolution, the report — is
// untouched and stays covered by the tests it already has.
//
// Each sheet carries five rows of report metadata (title, company, date range,
// a blank, a generated-on stamp) before the header on row 6.
const SHEET_HEADER_ROW = 5;          // zero-based: row 6 in Excel's numbering

// Matched on a substring because the tab names are truncated by Excel's 31
// character limit and carry stray spaces: "Maintenance - Work Order Labor ",
// "MWeekly - Work Order Billable D". Order matters — 'labor' is tested first so
// the labour sheet cannot be claimed by another pattern.
const SHEET_PATTERNS = [
  ['labor', /labor|labour/i],
  ['daily', /daily/i],
  ['weekly', /weekly/i],
  ['monthly', /monthly/i],
];

/**
 * Which sheet is which. Returns { daily, weekly, monthly, labor } of sheet
 * names, plus what could not be matched — a workbook missing a sheet is a
 * thing to say out loud, not to quietly report zeros for.
 */
function matchSheets(sheetNames) {
  const out = {};
  const taken = new Set();
  for (const [slot, re] of SHEET_PATTERNS) {
    const hit = (sheetNames || []).find(n => !taken.has(n) && re.test(String(n)));
    if (hit) { out[slot] = hit; taken.add(hit); }
  }
  const missing = SHEET_PATTERNS.map(([slot]) => slot).filter(slot => !out[slot]);
  const unused = (sheetNames || []).filter(n => !taken.has(n));
  return { sheets: out, missing, unused };
}

/**
 * A sheet's rows (array of arrays, as sheet_to_json({header:1}) gives them)
 * into the CSV text the rest of this module already reads.
 *
 * `skip` drops the report metadata above the header. It is a parameter rather
 * than a constant because a workbook whose layout shifts by a row should be a
 * one-line fix, not a re-read of this file.
 */
function sheetToCsv(rows, { skip = SHEET_HEADER_ROW } = {}) {
  const body = (rows || []).slice(skip);
  // Trailing all-empty columns are an artifact of Excel padding every row to
  // the widest one; carrying them makes every row end in a run of commas.
  let width = 0;
  body.forEach(r => {
    for (let i = (r || []).length - 1; i >= 0; i--) {
      if (String(r[i] == null ? '' : r[i]).trim() !== '') { width = Math.max(width, i + 1); break; }
    }
  });
  // Quoting only — NO formula-injection escaping here.
  //
  // This CSV is an internal intermediate that parseCsv reads back at once; it
  // is never handed to a person or opened in Excel. Applying the = + - @ guard
  // to it CORRUPTED the data: AppFolio's group markers start with '-', so
  // "-> Hyde Park Square" became "'-> Hyde Park Square", no group header was
  // recognised, every property read as "(no property)", and the subtotal rows
  // were counted as data. The guard belongs on toCsv(), which produces files
  // people download, and it is still there.
  const esc = v => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };

  return body
    .map(r => Array.from({ length: width }, (_, i) => esc((r || [])[i])).join(','))
    .filter((line, i) => i === 0 || line.replace(/,/g, '').trim() !== '')
    .join('\n');
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
  // __groupStatus is the status GROUP a row sits under, used only when the row
  // carries no status of its own. Listed second so a real per-row status wins.
  status: ['work_order_status', 'status', 'wo_status', '__groupStatus'],
  // "count(Work Order Number)" is last, and it is not the aggregate its name
  // promises. On a GROUP row it holds a count; on a DATA row it holds the work
  // order number itself ("22884-1"). Same column, two meanings, decided by
  // which kind of row you are on — and group rows never reach the data, so
  // reading it as the identifier here is safe. Listed after the honest names so
  // a file that has a real Work Order Number column uses that instead.
  workOrder: ['work_order_number', 'work_order', 'wo_number', 'wo', 'work_order_id',
    'service_request_number', 'count_work_order_number'],
  workedHours: ['worked_hours', 'hours_worked', 'actual_hours'],
  billableHours: ['billable_hours', 'hours', 'billed_hours'],
  billedAmount: ['billed_amount', 'billed', 'amount_billed', 'last_billed_amount'],
  unbilledAmount: ['unbilled_amount', 'unbilled', 'amount_unbilled'],
  amount: ['amount', 'total_amount', 'vendor_bill_amount'],
  billableType: ['billable_type', 'billable', 'bill_to'],
  description: ['description', 'job_description', 'work_order_issue'],
  unit: ['unit', 'unit_name', 'unit_address'],
  date: ['work_completed_on', 'completed_on', 'date', 'work_done_on', 'labor_date', 'created_date'],
};

// Builds { logicalName -> actual header } once per file.
// An aggregate column belongs to the GROUP row, not to the data rows.
// "count(Work Order Number)" contains "work_order_number", so the loose pass
// below happily matched it as the work-order column — empty on every data row,
// and countedBy then claimed the counts came from work-order numbers when they
// came from the fallback identity. A wrong label on a right number is still a
// thing someone acts on.
const AGGREGATE_HEADER = /^(count|sum|avg|average|min|max|total)_/;

// Every name any field claims exactly. The loose pass must not steal a header
// that another field owns outright: "work_order_status" CONTAINS "work_order",
// so the work-order column resolved to the STATUS column, every row's identity
// became its own status, and three separate jobs with the same status counted
// as one. The counts were wrong in the direction that looks plausible.
const CLAIMED_HEADERS = new Set(Object.values(FIELDS).flat());

function resolveColumns(headers) {
  const byNorm = {};
  headers.forEach(h => { byNorm[norm(h)] = h; });
  const map = {};
  for (const [field, candidates] of Object.entries(FIELDS)) {
    const hit = candidates.find(c => byNorm[c]);
    // Fall back to a header that CONTAINS the candidate, so "Total Billed
    // Amount" still resolves — but only when nothing matched exactly, or
    // "hours" would swallow "worked_hours". Aggregates are excluded from this
    // pass only; an exact match on one would still be honoured.
    map[field] = hit ? byNorm[hit]
      : (candidates.map(c => Object.keys(byNorm).find(k =>
        k.includes(c)
        && !AGGREGATE_HEADER.test(k)
        && !(CLAIMED_HEADERS.has(k) && !candidates.includes(k))))
        .filter(Boolean).map(k => byNorm[k])[0] || null);
  }
  return map;
}

const get = (row, cols, field) => (cols[field] ? row[cols[field]] : undefined);

// What makes two rows the same work order.
//
// The grouped export has no work-order number on its data rows — only
// count(Work Order Number) on the group header — so counting distinct work
// orders per status needs a stand-in. Unit, description and date together are
// what separate one job from another on those rows. It can undercount if the
// same unit has two identical descriptions on one day; that is a closer answer
// than counting billable LINES, where a single job with four parts reads as
// four work orders.
function woIdentity(row, cols) {
  const wo = get(row, cols, 'workOrder');
  if (wo) return 'wo:' + String(wo).trim();
  return 'k:' + [
    get(row, cols, 'property'), get(row, cols, 'unit'),
    get(row, cols, 'date'), String(get(row, cols, 'description') || '').slice(0, 60),
  ].map(x => String(x == null ? '' : x).trim().toLowerCase()).join('|');
}

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
// Patterns rather than a fixed list. An exact-match list is brittle against a
// report that writes "Work Done - Billable", "Ready To Bill (Owner)" or a
// trailing space, and the failure is silent: the status lands in "other" and
// the card reads 0 while the file plainly contains those rows.
const STATUS_GROUPS = {
  // norm() joins words with underscores, and \b does not fire between a letter
  // and an underscore — so /^completed\b/ never matched
  // "completed_no_need_to_bill". The separator has to be spelled out.
  workDone: /^work_?done(?:_|$)/,
  readyToBill: /^ready_?to_?bill(?:_|$)/,
  completed: /^completed(?:_|$)/,
};

function statusGroup(raw) {
  const n = norm(raw);
  if (!n) return null;
  for (const [group, re] of Object.entries(STATUS_GROUPS)) {
    if (re.test(n)) return group;
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

  // Whether any data row actually carried a work-order number, as opposed to
  // the column merely existing.
  let woNumbered = false;
  const s = {
    rows: rows.length,
    rowsExcluded: parsed.rows.length - rows.length,
    statusKeys: { workDone: new Set(), readyToBill: new Set(), completed: new Set() },
    otherKeys: new Set(),
    billableHours: 0, workedHours: 0,
    billed: 0, unbilled: 0,
    // Counted as DISTINCT work orders, not rows: the billable detail is one row
    // per labor entry, so a work order with four entries would otherwise count
    // four times.
    workOrders: new Set(),
    statusesSeen: {},
  };

  rows.forEach(r => {
    const raw = get(r, cols, 'status') || r.__groupStatus;
    const g = statusGroup(raw);
    if (raw) s.statusesSeen[raw] = (s.statusesSeen[raw] || 0) + 1;
    // Counted as DISTINCT work orders per status, not rows: one work order can
    // carry several billable lines and would otherwise be counted once per
    // line. Where the grouped export gives no work-order number, the identity
    // falls back to unit + description + date, which is what distinguishes one
    // job from another on those rows. Stated in `countedBy` so the number is
    // never silently a row count pretending to be a work-order count.
    if (g) s.statusKeys[g].add(woIdentity(r, cols));
    else if (raw) s.otherKeys.add(woIdentity(r, cols));
    s.billableHours += num(get(r, cols, 'billableHours'));
    s.workedHours += num(get(r, cols, 'workedHours'));
    s.billed += num(get(r, cols, 'billedAmount'));
    s.unbilled += num(get(r, cols, 'unbilledAmount'));
    const wo = get(r, cols, 'workOrder');
    if (wo) { s.workOrders.add(String(wo)); woNumbered = true; }
  });

  // In the grouped export the data rows carry no work-order number — the count
  // lives on the "-> Property" header. Sum those, skipping excluded properties.
  let workOrders = s.workOrders.size;
  if (parsed.groupCounts) {
    workOrders = Object.entries(parsed.groupCounts)
      .filter(([p]) => !isExcludedProperty(p))
      .reduce((a, [, n]) => a + n, 0);
  }

  // A status group that produced no data rows exists only as its header count.
  // Added here, and ONLY when it produced none, so a group with rows is not
  // counted twice.
  Object.entries(parsed.statusGroupCounts || {}).forEach(([name, n]) => {
    if (!(parsed.emptyStatusGroups || []).includes(name)) return;
    const g = statusGroup(name);
    if (!g) return;
    for (let i = 0; i < n; i++) s.statusKeys[g].add('group:' + name + ':' + i);
    s.statusesSeen[name] = (s.statusesSeen[name] || 0) + n;
  });

  // Statuses sitting on the GROUP rows rather than the data rows. If a status
  // only ever appears here, the report groups by something that carries it and
  // no data row will ever show it — which is invisible from the data rows alone.
  const groupStatuses = {};
  (parsed.groupRows || []).forEach(r => {
    const v = String(get(r, cols, 'status') || '').trim();
    if (v) groupStatuses[v] = (groupStatuses[v] || 0) + 1;
    const g = String(r.__group || '').trim();
    if (g && statusGroup(g)) groupStatuses['(group name) ' + g] = (groupStatuses['(group name) ' + g] || 0) + 1;
  });

  const dates = exportDate(rows, cols);
  return {
    ...s,
    groupStatuses,
    groupNames: [...new Set((parsed.groupRows || []).map(r => String(r.__group || '').trim()).filter(Boolean))],
    statusKeys: undefined,
    otherKeys: undefined,
    workDone: s.statusKeys.workDone.size,
    readyToBill: s.statusKeys.readyToBill.size,
    completed: s.statusKeys.completed.size,
    otherStatus: s.otherKeys.size,
    // Whether those three are true work-order counts or a best-effort identity.
    // What the count was ACTUALLY reached by. A resolved column is not the same
    // as a populated one: "count(Work Order Number)" resolves on every grouped
    // export, but if it is blank on the data rows the identity silently falls
    // back, and printing the column name then would be a wrong label on a right
    // number — which is still something someone acts on.
    countedBy: (cols.workOrder && woNumbered)
      ? `"${cols.workOrder}"`
      : `unit + description + date${cols.workOrder ? ` ("${cols.workOrder}" is empty on every row)` : ''}`,
    statusColumn: cols.status,
    workOrders,
    grouped: !!parsed.grouped,
    subtotalRowsDropped: (parsed.subtotalRows || []).length,
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
        property,
        statusKeys: { workDone: new Set(), readyToBill: new Set(), completed: new Set() },
        otherKeys: new Set(),
        billableHours: 0, workedHours: 0, billed: 0, unbilled: 0, workOrders: new Set(),
      });
    }
    const p = map.get(property);
    const raw = get(r, cols, 'status') || r.__groupStatus;
    const g = statusGroup(raw);
    if (g) p.statusKeys[g].add(woIdentity(r, cols));
    else if (raw) p.otherKeys.add(woIdentity(r, cols));
    p.billableHours += num(get(r, cols, 'billableHours'));
    p.workedHours += num(get(r, cols, 'workedHours'));
    p.billed += num(get(r, cols, 'billedAmount'));
    p.unbilled += num(get(r, cols, 'unbilledAmount'));
    const wo = get(r, cols, 'workOrder');
    if (wo) p.workOrders.add(String(wo));
  });

  // Status groups under a property that produced no billable line at all: the
  // header count is the only record that those work orders exist.
  (parsed.emptyStatusGroupsByProperty || []).forEach(({ property, status, count }) => {
    if (!property || isExcludedProperty(property)) return;
    const g = statusGroup(status);
    if (!g) return;
    if (!map.has(property)) {
      map.set(property, {
        property,
        statusKeys: { workDone: new Set(), readyToBill: new Set(), completed: new Set() },
        otherKeys: new Set(),
        billableHours: 0, workedHours: 0, billed: 0, unbilled: 0, workOrders: new Set(),
      });
    }
    const p = map.get(property);
    for (let i = 0; i < count; i++) p.statusKeys[g].add('group:' + status + ':' + i);
  });

  return [...map.values()]
    .map(p => ({
      ...p,
      statusKeys: undefined,
      otherKeys: undefined,
      workDone: p.statusKeys.workDone.size,
      readyToBill: p.statusKeys.readyToBill.size,
      completed: p.statusKeys.completed.size,
      other: p.otherKeys.size,
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
  matchSheets, sheetToCsv, SHEET_HEADER_ROW,
  parseCsv, resolveColumns, buildReport, summarisePeriod,
  byProperty, byPropertyAndTech, byTech, toCsv,
  isExcludedProperty, cleanTech, num, statusGroup, exportDate,
  EXCLUDED_FRAGMENTS,
};
