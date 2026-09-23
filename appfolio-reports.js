// =====================================================================
// AppFolio Reports — registry, sync orchestration, and derived feeds.
//
// Everything here is READ-ONLY. Nothing in this file writes back to
// AppFolio; assigning techs, adding notes, changing status and creating
// work orders all still happen manually in Chrome. See README.md.
// =====================================================================

const path = require('path');
const fsp = require('fs/promises');
const { fetchReport, isConfigured, AppFolioError } = require('./appfolio-client');

// Must honour DATA_DIR like server.js and metric-routes.js do: render.yaml
// mounts a persistent disk at /var/data. Writing to ./data instead puts the
// synced report JSON on Render's ephemeral filesystem, so every deploy would
// throw it away and force a full re-sync against the 7-req/15s rate limit.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_DIR = path.join(DATA_DIR, 'appfolio_api');
const STATUS_FILE = path.join(API_DIR, '_status.json');

// ---- Date helpers (used by dated report variants) ----------------------------

function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---- Registry ---------------------------------------------------------------
// `id`       — unique key: the filename under data/appfolio_api/ and the API path.
// `resource` — the actual AppFolio report endpoint ({resource}.json). Several
//              entries share a resource with different filters, which is how the
//              Maintenance Efficiency metrics are built from just two reports.
// `params`   — POST body sent to the Reports API. May be a function so date
//              windows (last 90 days, older than 30 days) resolve at sync time.
// Priority order matches the rollout plan in README.md.

const REPORTS = [
  {
    id: 'work_order_billable_detail',
    resource: 'work_order_billable_detail',
    label: 'Work Order — Billable Detail',
    group: 'Billable Labor',
    priority: 1,
    feeds: 'AppFolio Analyzer → Billable Labor Report',
    params: {},
  },
  {
    // labor_performed_from / labor_performed_to are REQUIRED by this report, and
    // without them AppFolio returns only its own short default window — 17 days
    // when this was measured. A ROLLING 90 days as a function, not fixed dates:
    // resolveParams() calls it at sync time, so the window follows the calendar
    // instead of freezing on the day it was written.
    //
    // Widening this changes existing consumers, which is intended but worth
    // knowing: billableSummary() sums every labor row, so its hours/byTech grow
    // from ~17 days to 90; efficiencyMetrics()'s distinct-WO-by-status counts
    // rise for the same reason (they were undercounting before, so this is more
    // accurate, not less). techActivityToday() filters to a single day and is
    // unaffected.
    id: 'work_order_labor_summary',
    resource: 'work_order_labor_summary',
    label: 'Work Order — Labor Summary (90 days)',
    group: 'Billable Labor',
    priority: 1,
    feeds: 'AppFolio Analyzer → Billable Labor + Technician Activity Today',
    params: () => ({ labor_performed_from: isoDay(-90), labor_performed_to: isoDay(0) }),
  },
  {
    id: 'upcoming_activities',
    resource: 'upcoming_activities',
    label: 'Upcoming Activities',
    group: 'Activities',
    priority: 2,
    feeds: 'Daily Work Report / End of Day',
    // Available filters: property_visibility, unit_ids, property, parties_ids
    // (occupancies_ids / owners_ids / rental_applications_ids), activity_status,
    // assigned_user, due_at_from, due_at_to.
    params: {},
  },
  {
    id: 'work_order',
    resource: 'work_order',
    label: 'Work Orders — Urgent & Open',
    group: 'Work Orders',
    priority: 3,
    feeds: 'Command Center (urgent review) + Coverage Map (per-property counts)',
    params: { priority: 'Urgent', status: 'Open' },
  },

  // ---- Maintenance Efficiency source ----
  // Only ONE extra work_order pull is registered, not one per metric.
  // Probed against the live API on 2026-08-04: work_order.json honours
  // `priority` but SILENTLY IGNORES `status` / `work_order_status`, and it
  // only ever returns open work orders. Registering a variant per status
  // would fire extra requests that return byte-identical data, so the
  // per-status metrics are counted locally instead. See efficiencyMetrics().
  {
    id: 'wo_all',
    resource: 'work_order',
    label: 'WO — All open (unfiltered pull)',
    group: 'Maintenance Efficiency',
    priority: 5,
    feeds: 'Efficiency rows 45 & 49 — counted locally',
    params: {},
  },

  // ---- WO Scheduling Tool pilot (iConic Round Rock + iConic Downtown) ----
  // work_order_labor_detail was registered here and removed: AppFolio answers
  // 400 "Id is not a valid report" — the resource does not exist. Don't re-add
  // it without a name confirmed against a live request; a permanently-400
  // report sits in syncAll() burning a slot against the 7-req/15s limit and
  // leaves an error in the Reports Sync view that nobody can clear.
  {
    // `status: 'Completed'` (a string) was silently IGNORED — the pull came back
    // with 148 open work orders, a strict subset of wo_all, zero Completed. The
    // filter the API actually reads is `work_order_statuses`, an array of
    // NUMERIC status codes: 4 = Completed, 5 = Canceled, 7 = Completed No Need
    // To Bill. We take 4 + 7, the two "finished" states; 5 (Canceled) is
    // deliberately excluded — a canceled WO has no completion to measure and
    // would distort cycle time.
    //
    // params go out as a JSON POST body, so the array serializes as-is.
    id: 'wo_completed',
    resource: 'work_order',
    label: 'WO — Completed',
    group: 'Work Orders',
    priority: 6,
    feeds: 'WO Scheduling Tool pilot — completion/cycle time',
    params: { work_order_statuses: ['4', '7'] },
  },

  {
    // The UI's "Move Out Directory" (buffered_reports/689) is a configured
    // view of AppFolio's standard Tenant Tickler report. Saved-report UUIDs
    // are unreachable from the public API (see README), but the BASE report
    // name works — so we pull tenant_tickler directly.
    id: 'tenant_tickler',
    resource: 'tenant_tickler',
    label: 'Move Out Directory (Tenant Tickler)',
    group: 'Leasing / Move Outs',
    priority: 7,
    feeds: 'Reports Sync — sync + CSV/PDF export (no dedicated view yet)',
    params: {},
  },
  {
    id: 'inventory_status',
    resource: 'inventory_status',
    label: 'Inventory Status',
    group: 'Inventory',
    priority: 4,
    feeds: 'Weekly inventory audit',
    params: {},
  },
  {
    id: 'inventory_usage',
    resource: 'inventory_usage',
    label: 'Inventory Usage',
    group: 'Inventory',
    priority: 4,
    feeds: 'Weekly inventory audit',
    params: {},
  },
  {
    // Phase 0 spike for the Unit Vacancy Automation module (Lyndsay, 2026-09-21).
    // Registered on its own to answer one question before anything is built on
    // it: does Reports API v2 expose this report at all, and under what column
    // names? Lyndsay's link is to /buffered_reports/unit_vacancy, which is the
    // UI surface — a different thing from the API, and we have already had one
    // plausible-looking resource (work_order_labor_detail) 400 because it simply
    // does not exist in the API. No consumer reads this yet.
    // Registered 2026-09-22 to answer one question for Bekah's Decision Queue:
    // which columns does delinquency_as_of ACTUALLY return? The hand-written
    // APPFOLIO_DELINQUENCY_MAP in server.js says Eviction Status, Last Payment
    // and the court dates come back blank, and lists no days-delinquent field —
    // which would make three of the five escalation triggers uncomputable. That
    // map is a comment, not evidence. This makes it checkable.
    // Same filter the Eviction Tracker and Collections both use.
    id: 'delinquency_as_of',
    resource: 'delinquency_as_of',
    label: 'Delinquency (As Of)',
    group: 'Collections',
    priority: 9,
    feeds: 'Column reference for the Collections Decision Queue',
    params: { tenant_statuses: ['0', '4'], property_visibility: 'active' },
  },
  {
    id: 'unit_vacancy',
    resource: 'unit_vacancy',
    label: 'Unit Vacancy Detail',
    group: 'Leasing / Vacancy',
    priority: 8,
    feeds: 'Phase 0 spike — Vacancy Posting module (not built yet)',
    params: {},
  },

  // ---- Lease expirations, for the Monday Morning Brief -------------------
  // Probed live 2026-09-23. Bekah named "Lease Expiration or Rent Roll"; both
  // exist in Reports API v2, and they answer DIFFERENT questions, so the brief
  // uses both rather than picking one:
  //
  //   rent_roll (438 rows)   every unit, one row per lease, with lease_to.
  //                          This is the complete set — 11 leases expire in
  //                          the next 30 days. It is the source of record.
  //
  //   lease_expiration_detail (97 rows)   the renewal pipeline, carrying the
  //                          renewal status rent_roll has no column for
  //                          (Eligible / Pending / Renewed / Not Eligible).
  //                          It lists 8 of those 11: it drops units already on
  //                          notice, which are not renewal conversations. So
  //                          it is joined for status, never used to filter.
  //
  // tenant_directory was probed too and is deliberately NOT registered. It is
  // per-tenant rather than per-lease (15 rows for the same 11 leases, the
  // extra 4 being roommates and occupants) and it carries resident birthdates,
  // which is PII this dashboard has no reason to hold on disk.
  {
    id: 'rent_roll',
    resource: 'rent_roll',
    label: 'Rent Roll',
    group: 'Leasing / Leases',
    priority: 9,
    feeds: 'Lease expirations — Monday Morning Brief',
    params: {},
  },
  {
    id: 'lease_expiration_detail',
    resource: 'lease_expiration_detail',
    label: 'Lease Expiration Detail',
    group: 'Leasing / Leases',
    priority: 9,
    feeds: 'Renewal status — Monday Morning Brief',
    params: {},
  },
];

const byId = id => REPORTS.find(r => r.id === id);

// params may be a function (dynamic date windows) — resolve it at call time.
const resolveParams = def => (typeof def.params === 'function' ? def.params() : (def.params || {}));

// ---- Storage ----------------------------------------------------------------

async function ensureDir() {
  await fsp.mkdir(API_DIR, { recursive: true });
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJSON(file, data) {
  // Temp-file + rename, same as server.js — OneDrive locks files mid-write.
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

const dataFile = id => path.join(API_DIR, `${id}.json`);

async function readReportData(id) {
  return readJSON(dataFile(id), null);
}

async function readStatus() {
  return readJSON(STATUS_FILE, {});
}

async function writeStatusEntry(id, entry) {
  await ensureDir();
  const all = await readStatus();
  all[id] = { ...(all[id] || {}), ...entry };
  await writeJSON(STATUS_FILE, all);
  return all[id];
}

// ---- Sync -------------------------------------------------------------------

const _running = new Set();

/**
 * Pull one report and persist it. Never throws — the failure is recorded in
 * the status file so the Reports Sync view can show it.
 */
async function syncReport(id) {
  const def = byId(id);
  if (!def) return { ok: false, id, error: `Unknown report "${id}"` };
  if (_running.has(id)) return { ok: false, id, error: 'Sync already in progress for this report' };

  _running.add(id);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    const params = resolveParams(def);
    const { rows, pages, truncated } = await fetchReport(def.resource, params);

    await ensureDir();
    await writeJSON(dataFile(id), {
      report: id,
      resource: def.resource,
      fetchedAt: new Date().toISOString(),
      params,
      pages,
      truncated,
      rowCount: rows.length,
      rows,
    });

    const status = await writeStatusEntry(id, {
      lastSuccessAt: new Date().toISOString(),
      lastAttemptAt: startedAt,
      rowCount: rows.length,
      pages,
      truncated,
      durationMs: Date.now() - t0,
      lastError: null,
      lastErrorAt: null,
      lastErrorStatus: null,
    });

    return { ok: true, id, rowCount: rows.length, pages, truncated, status };
  } catch (err) {
    const status = await writeStatusEntry(id, {
      lastAttemptAt: startedAt,
      lastError: err.message,
      lastErrorAt: new Date().toISOString(),
      lastErrorStatus: err instanceof AppFolioError ? err.status : null,
      durationMs: Date.now() - t0,
    });
    return { ok: false, id, error: err.message, httpStatus: err.status ?? null, status };
  } finally {
    _running.delete(id);
  }
}

/**
 * Sync every report, in priority order. Sequential on purpose — the shared
 * rate limiter would serialize them anyway, and this keeps errors readable.
 */
async function syncAll() {
  const ordered = [...REPORTS].sort((a, b) => a.priority - b.priority);
  const results = [];
  for (const def of ordered) {
    results.push(await syncReport(def.id));
  }
  return results;
}

/** Registry + per-report status, for the Reports Sync view. */
async function overview() {
  const status = await readStatus();
  return {
    configured: isConfigured(),
    rateLimit: '7 requests / 15 seconds',
    reports: REPORTS.map(r => ({
      id: r.id,
      resource: r.resource,
      label: r.label,
      group: r.group,
      priority: r.priority,
      feeds: r.feeds,
      params: resolveParams(r),
      syncing: _running.has(r.id),
      ...(status[r.id] || {
        lastSuccessAt: null, lastAttemptAt: null, rowCount: null,
        lastError: null, lastErrorAt: null, lastErrorStatus: null,
      }),
    })),
  };
}

// ---- Field access helpers ---------------------------------------------------
// AppFolio column names vary between accounts and report versions, so every
// read goes through a tolerant lookup rather than a hard-coded key.

function normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(row, candidates, fallback = null) {
  if (!row) return fallback;
  const map = {};
  for (const k of Object.keys(row)) map[normKey(k)] = row[k];
  for (const c of candidates) {
    const v = map[normKey(c)];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---- Derived feeds ----------------------------------------------------------

/**
 * Billable Labor Report — feeds the AppFolio Analyzer view.
 *
 * ── Why the numbers jumped on 2026-09-17 ──────────────────────────────────
 * If you remember these totals being much smaller, nothing broke and nothing
 * was double-counted. The window changed, not the work.
 *
 * work_order_labor_summary requires labor_performed_from / labor_performed_to.
 * We were not sending them, so AppFolio applied its own short default — about
 * 17 days. The report now asks for a rolling 90 days (see its registry entry
 * above), which took it from 388 rows to ~2230.
 *
 * This function sums EVERY labor row it is given, so laborHours and byTech
 * grew roughly 5x on that date. For the iConic pilot properties the same
 * change moved 94.9h over 17 days to 480.8h over 90 days — the daily rate is
 * effectively unchanged.
 *
 * So: compare these figures to other 90-day figures, not to anything captured
 * before 2026-09-17. Week-over-week history spanning that date has a step in
 * it. efficiencyMetrics()'s distinct-WO-by-status counts moved for the same
 * reason and are now closer to the truth, since they were counting against a
 * 17-day window while being labelled as longer. techActivityToday() filters to
 * a single day and did not change at all.
 * ──────────────────────────────────────────────────────────────────────────
 */
async function billableSummary() {
  const detail = await readReportData('work_order_billable_detail');
  const labor  = await readReportData('work_order_labor_summary');
  if (!detail && !labor) return null;

  const detailRows = detail?.rows || [];
  const laborRows  = labor?.rows  || [];

  let billableTotal = 0;
  const byProperty = {};
  for (const r of detailRows) {
    const amount = num(pick(r, ['billable_amount', 'amount', 'total', 'billable_total', 'charge_amount']));
    const prop = pick(r, ['property_name', 'property', 'propertyname', 'building'], 'Unknown');
    billableTotal += amount;
    byProperty[prop] = (byProperty[prop] || 0) + amount;
  }

  let laborHours = 0;
  const byTech = {};
  for (const r of laborRows) {
    const hours = num(pick(r, ['hours', 'worked_hours', 'labor_hours', 'total_hours', 'duration_hours']));
    const tech  = pick(r, TECH_KEYS, 'Unassigned');
    laborHours += hours;
    byTech[tech] = (byTech[tech] || 0) + hours;
  }

  return {
    fetchedAt: detail?.fetchedAt || labor?.fetchedAt || null,
    detailRows: detailRows.length,
    laborRows: laborRows.length,
    billableTotal: Math.round(billableTotal * 100) / 100,
    laborHours: Math.round(laborHours * 10) / 10,
    topProperties: Object.entries(byProperty)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 })),
    byTech: Object.entries(byTech)
      .sort((a, b) => b[1] - a[1])
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 })),
  };
}

/** Urgent + open work orders — feeds Command Center. */
async function urgentWorkOrders() {
  const wo = await readReportData('work_order');
  if (!wo) return null;

  const items = (wo.rows || []).map(r => ({
    number:   pick(r, ['work_order_number', 'wo_number', 'number', 'id', 'work_order_id']),
    property: pick(r, ['property_name', 'property', 'building'], 'Unknown'),
    unit:     pick(r, ['unit_name', 'unit', 'unit_number'], ''),
    priority: pick(r, ['priority'], ''),
    status:   pick(r, ['status', 'work_order_status'], ''),
    assigned: pick(r, ['assigned_user', 'maintenance_tech', 'vendor', 'assigned_to', 'technician'], ''),
    created:  pick(r, ['created_at', 'created', 'date_created', 'submitted_date'], ''),
    summary:  pick(r, ['description', 'summary', 'job_description', 'notes'], ''),
  }));

  return { fetchedAt: wo.fetchedAt, count: items.length, items };
}

/**
 * Every open work order with a deep link into AppFolio — feeds the table
 * under the Coverage Map so a red pin badge can be clicked through to the
 * actual work orders instead of hunting for them by hand.
 */
async function openWorkOrders() {
  const wo = await readReportData('wo_all');
  if (!wo) return null;

  const sub = process.env.APPFOLIO_SUBDOMAIN;
  const items = (wo.rows || []).map(r => {
    const woId = pick(r, ['work_order_id']);
    const srId = pick(r, ['service_request_id']);
    return {
      property: pick(r, ['property_name', 'property'], 'Unknown'),
      number:   pick(r, ['work_order_number', 'wo_number'], '—'),
      unit:     pick(r, ['unit_name', 'unit', 'unit_number'], ''),
      status:   pick(r, STATUS_KEYS, ''),
      priority: pick(r, ['priority'], ''),
      assigned: pick(r, ['assigned_user', 'vendor'], ''),
      created:  rowDay(r, ['created_at']),
      description: pick(r, ['job_description', 'service_request_description', 'description'], ''),
      // Null when we can't build a valid link, so the UI shows plain text
      // rather than a URL that 404s.
      url: (sub && woId && srId)
        ? `https://${sub}.appfolio.com/maintenance/service_requests/${srId}/work_orders/${woId}`
        : null,
    };
  });

  const byProperty = {};
  for (const i of items) (byProperty[i.property] || (byProperty[i.property] = [])).push(i);

  return {
    fetchedAt: wo.fetchedAt,
    count: items.length,
    properties: Object.keys(byProperty).sort(),
    items,
  };
}

/**
 * Open-WO count per property — feeds the red badges on the Coverage Map pins.
 * Reads `wo_all` so the badge number matches the Open Work Orders table below
 * the map exactly. Falls back to the Urgent-only pull if wo_all isn't synced,
 * and says which one it used so the UI can label the badges honestly.
 */
async function woCountsByProperty() {
  const wo = await readReportData('wo_all') || await readReportData('work_order');
  if (!wo) return null;
  const counts = {};
  for (const r of wo.rows || []) {
    const prop = pick(r, ['property_name', 'property', 'building'], 'Unknown');
    counts[prop] = (counts[prop] || 0) + 1;
  }
  return { fetchedAt: wo.fetchedAt, counts, source: wo.report || 'work_order' };
}

/** Upcoming Activities — feeds Daily Work Report / End of Day. */
async function activitiesSummary() {
  const act = await readReportData('upcoming_activities');
  if (!act) return null;
  const rows = act.rows || [];
  const byType = {};
  for (const r of rows) {
    const type = pick(r, ['activity_type', 'type', 'category', 'activity'], 'Other');
    byType[type] = (byType[type] || 0) + 1;
  }
  return {
    fetchedAt: act.fetchedAt,
    total: rows.length,
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
  };
}

/** Inventory status + usage — feeds the weekly audit. */
async function inventorySnapshot() {
  const status = await readReportData('inventory_status');
  const usage  = await readReportData('inventory_usage');
  if (!status && !usage) return null;

  const statusRows = status?.rows || [];
  const lowStock = statusRows.map(r => ({
    item:     pick(r, ['name', 'item_name', 'item', 'description'], 'Unknown'),
    onHand:   num(pick(r, ['quantity', 'quantity_on_hand', 'on_hand', 'qty'])),
    reorder:  num(pick(r, ['reorder', 'reorder_point', 'reorder_level', 'minimum', 'min_quantity'])),
    location: pick(r, ['location', 'property_name', 'warehouse'], ''),
  })).filter(i => i.reorder > 0 && i.onHand <= i.reorder)
     .sort((a, b) => (a.onHand - a.reorder) - (b.onHand - b.reorder));

  return {
    fetchedAt: status?.fetchedAt || usage?.fetchedAt || null,
    statusRows: statusRows.length,
    usageRows: usage?.rows?.length || 0,
    lowStockCount: lowStock.length,
    lowStock: lowStock.slice(0, 25),
  };
}

// =====================================================================
// MAINTENANCE EFFICIENCY — the 9 numbers that go into the Excel tracker
//
// Each metric names the Excel row it fills, so whoever holds the
// coordinator role can copy them straight into the day's column.
// =====================================================================

const STATUS_KEYS = ['status', 'work_order_status', 'wo_status'];

// AppFolio's technician column across reports (verified against live data).
const TECH_KEYS = ['maintenance_tech', 'assigned_user', 'user_name',
                   'technician', 'tech', 'assigned_to', 'employee', 'vendor'];


function sumAmount(rows) {
  return Math.round(rows.reduce((t, r) => t + num(pick(r,
    ['billable_amount', 'amount', 'total', 'billable_total', 'charge_amount'])), 0) * 100) / 100;
}

/** Distinct work-order numbers in `rows` whose status matches. */
function distinctWOsByStatus(rows, matcher) {
  const set = new Set();
  for (const r of rows) {
    const s = String(pick(r, STATUS_KEYS, '')).trim().toLowerCase();
    if (!matcher(s)) continue;
    const wo = pick(r, ['work_order_number', 'wo_number', 'work_order_id'], null);
    if (wo !== null) set.add(String(wo));
  }
  return set.size;
}

/**
 * Rows 62 & 65 — billable totals for a status the API refuses to filter on.
 *
 * We filter LOCALLY on work_order_status instead. Probed 2026-08-04: the
 * report only ever returns "Work Done" and "Ready to Bill", so Canceled and
 * Waiting genuinely aren't in the payload — reporting $0.00 would be a wrong
 * number dressed up as a real one. So: if the status is absent from the whole
 * dataset we return `unavailable`; the moment AppFolio starts including it,
 * this computes a real figure with no code change.
 *
 * @returns [value, confidence, source, note] — spread into M().
 */
function bdStatusMetric(bd, bdRows, matcher, sinceDay, statusLabel) {
  const src = 'work_order_billable_detail';
  if (!bd) return [null, 'unavailable', src, 'Report not synced yet.'];

  const present = bdRows.some(r =>
    matcher(String(pick(r, STATUS_KEYS, '')).trim().toLowerCase()));

  if (!present) {
    const seen = [...new Set(bdRows.map(r => pick(r, STATUS_KEYS, '')).filter(Boolean))];
    return [null, 'unavailable', src,
      `No "${statusLabel}" rows exist in this report — it only returns ${seen.join(' / ') || 'other statuses'}, ` +
      `and AppFolio ignores the status filter. Getting this number requires AppFolio to enable the ` +
      `server-side status filter on work_order_billable_detail; it cannot be solved on our side. ` +
      `Run this row manually in AppFolio for now.`];
  }

  const value = sumAmount(bdRows.filter(r => {
    if (!matcher(String(pick(r, STATUS_KEYS, '')).trim().toLowerCase())) return false;
    if (!sinceDay) return true;
    const d = rowDay(r, ['labor_date', 'created_date']);
    return d && d >= sinceDay;
  }));

  return [value, 'approx', src,
    `Filtered locally on work_order_status = "${statusLabel}"` +
    (sinceDay ? ` with labor_date on or after ${sinceDay}` : '') +
    `. Limited to the window AppFolio returns for this report.`];
}

// NOTE: the distinct-WO-by-status counts below moved up on 2026-09-17 when
// work_order_labor_summary gained a rolling 90-day window (it had been running
// against AppFolio's ~17-day default). They count work orders that have logged
// labour, so a longer window finds more of them. The rise is recovered
// undercount, not new work — see the note on billableSummary() above.
async function efficiencyMetrics() {
  const [woAll, bd, labor] = await Promise.all([
    readReportData('wo_all'),
    readReportData('work_order_billable_detail'),
    readReportData('work_order_labor_summary'),
  ]);

  const woRows = woAll?.rows || [];
  const bdRows = bd?.rows || [];
  const laborRows = labor?.rows || [];
  const cutoff30 = isoDay(-30);
  const cutoff90 = isoDay(-90);

  // Actual date span the billable report came back with — used to warn that
  // "all time" (row 63) is really just whatever window AppFolio allows.
  const bdDates = bdRows.map(r => rowDay(r, ['labor_date', 'created_date'])).filter(Boolean).sort();
  const bdSpan = bdDates.length ? { from: bdDates[0], to: bdDates[bdDates.length - 1] } : null;

  // confidence:
  //  'exact'       — computed from a report that genuinely contains the data
  //  'approx'      — derived from labor/billable rows, so it only counts work
  //                  orders that have logged labor (undercounts)
  //  'unavailable' — the status/date filter needed is ignored by the API and
  //                  the value is not present in any report we can pull
  const M = (row, label, unit, value, confidence, source, note) =>
    ({ row, label, unit, value, confidence, source, note: note || null,
       missing: value === null });

  const metrics = [
    M(45, 'Open Work Orders', 'count',
      woAll ? woRows.length : null, 'exact', 'wo_all',
      'work_order.json returns exactly the open statuses (New, Assigned, Assigned by AppFolio, Scheduled).'),

    M(46, 'Work Done', 'count',
      labor ? distinctWOsByStatus(laborRows, s => s === 'work done') : null, 'approx',
      'work_order_labor_summary',
      'Counts distinct WOs with logged labor. work_order.json cannot return this status.'),

    M(47, 'Ready to Bill', 'count',
      labor ? distinctWOsByStatus(laborRows, s => s.includes('ready') && s.includes('bill')) : null,
      'approx', 'work_order_labor_summary',
      'Counts distinct WOs with logged labor. work_order.json cannot return this status.'),

    M(48, 'Waiting Work Order Total', 'count',
      labor ? distinctWOsByStatus(laborRows, s => s === 'waiting') : null, 'approx',
      'work_order_labor_summary',
      'Counts distinct WOs with logged labor. The status filter is ignored by work_order.json.'),

    M(49, 'Work Orders older than 1 month', 'count',
      woAll ? woRows.filter(r => {
        const c = rowDay(r, ['created_at']);
        return c && c <= cutoff30;
      }).length : null, 'exact', 'wo_all',
      `Open WOs created on or before ${cutoff30}.`),

    M(62, 'Billable — Canceled (last 90 days)', 'currency',
      ...bdStatusMetric(bd, bdRows, s => s === 'canceled', cutoff90, 'Canceled')),

    M(63, 'Billable — All time', 'currency',
      bd ? sumAmount(bdRows) : null, 'approx', 'work_order_billable_detail',
      `Sum of every row the report returns. AppFolio caps this report to a recent window` +
      (bdSpan ? ` — the current pull only spans ${bdSpan.from} → ${bdSpan.to}` : '') +
      `, so this is NOT true all-time.`),

    // Only "exact" when the report actually returned data covering the whole
    // 90-day window. AppFolio serves this report as a short rolling window
    // (observed as little as a single day), and a confident "$0.00 for the
    // last 90 days" in Lyndsay's tracker would be worse than an honest flag.
    M(64, 'Billable — Last 90 days', 'currency',
      bd ? sumAmount(bdRows.filter(r => {
        const d = rowDay(r, ['labor_date', 'created_date']);
        return d && d >= cutoff90;
      })) : null,
      (bd && bdSpan && bdSpan.from <= cutoff90) ? 'exact' : 'approx',
      'work_order_billable_detail',
      (bd && bdSpan && bdSpan.from <= cutoff90)
        ? `Rows with labor_date on or after ${cutoff90}, filtered locally.`
        : `NOT a full 90-day total — the report only returned ${bdSpan ? bdSpan.from + ' → ' + bdSpan.to : 'no dated rows'}, ` +
          `so this covers ${bdSpan ? 'that span only' : 'nothing'}. AppFolio serves this report as a short rolling window.`),

    M(65, 'Billable — Waiting (all time)', 'currency',
      ...bdStatusMetric(bd, bdRows, s => s === 'waiting', null, 'Waiting')),
  ];

  const stamps = [woAll?.fetchedAt, bd?.fetchedAt, labor?.fetchedAt].filter(Boolean).sort();

  return {
    date: new Date().toISOString().slice(0, 10),
    metrics,
    missingCount: metrics.filter(m => m.missing).length,
    approxCount: metrics.filter(m => m.confidence === 'approx').length,
    unavailableCount: metrics.filter(m => m.confidence === 'unavailable').length,
    oldestFetchedAt: stamps[0] || null,
    newestFetchedAt: stamps[stamps.length - 1] || null,
  };
}

// =====================================================================
// TECHNICIAN ACTIVITY TODAY — from work_order_labor_summary
// =====================================================================

// Technicians expected to log hours on a normal working day. Kept here so
// the zero-hours alert Lyndsay asked for can fire on absence of data — a
// tech with no rows would otherwise be invisible.
const ACTIVE_TECHNICIANS = [
  'Angel Martinez',
  'Raul Martinez',
  'Emerson Garcia',
  'Carlos Portilla',
  'Jose Renteria',
  'Fredy Ramirez',
];

// AppFolio stores techs with trailing initials and stray spacing —
// "Angel Martinez C", "Emerson  Garcia -", "Jose Renteria E". Comparing the
// stripped forms by prefix matches those against the clean roster names.
const normName = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function sameTech(rosterName, appfolioName) {
  const a = normName(rosterName);
  const b = normName(appfolioName);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

function rowDay(r, keys) {
  const raw = pick(r, keys || ['date', 'labor_date', 'work_date', 'service_date',
                               'entry_date', 'posted_date', 'created_at'], '');
  if (!raw) return '';
  // Handles both "2026-08-04" and "2026-08-04T13:22:00Z" and "08/04/2026".
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Per-technician view of today's logged labor, plus the two flags Lyndsay
 * asked for: zero-hours techs, and the same unit touched by two techs.
 * @param {string} day — YYYY-MM-DD, defaults to today.
 * @param {Array<{name: string, aliases: string[]}>} [roster] — who is expected
 *   to log hours, from the Supabase `technicians` table. Explicit aliases beat
 *   the fuzzy prefix match, since AppFolio spellings are inconsistent. Falls
 *   back to ACTIVE_TECHNICIANS when omitted, so this module still works
 *   standalone (and in the original metric-dashboard) with no database.
 */
// pick() normalises keys, so "Start Time", "start_time" and "StartTime" all
// resolve to the same candidate. Listed rather than hardcoded to one spelling
// because the synced JSON is not in the repo — data/ is gitignored and the file
// lives on Render's disk — so the exact header could not be read from here, and
// a wrong guess would render nothing while looking exactly like "no tech marked
// a start", which is a state the card is meant to show.
const START_TIME_KEYS = ['start_time', 'timer_start', 'started_at', 'time_started',
                         'labor_start', 'clock_in', 'start'];
const END_TIME_KEYS = ['end_time', 'timer_end', 'ended_at', 'time_ended',
                       'labor_end', 'clock_out', 'end', 'finish_time', 'finished_at'];

// Minutes since midnight, for comparing two starts. Handles "8:32 AM", "08:32"
// and a full "…T08:32:00Z"; anything else returns null and simply loses the
// comparison rather than throwing.
function clockMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (/p/i.test(m[3])) h += 12;
    return h * 60 + parseInt(m[2], 10);
  }
  m = s.match(/T(\d{2}):(\d{2})/) || s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    return (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) ? h * 60 + mi : null;
  }
  return null;
}

// Minutes between the start and the end of a work order, or null.
//
// Only for work orders with a single timer session. With two, the span from the
// earliest start to the latest end is elapsed time, not worked time — 8-9am plus
// 2-3pm is a seven-hour span for two hours of work, and the two hours are
// already on the same row. Printing seven beside them would invite exactly the
// wrong reading, so multi-session work orders show their times and no duration.
//
// Safe to compute here despite the server running UTC: both values come from the
// same column in the same shape, so whatever offset they carry cancels in the
// subtraction. An end before the start is read as crossing midnight, which
// after-hours work really does; anything past sixteen hours is treated as a
// mismatched pair rather than a very long night.
function woDuration(w) {
  if (!w || w._sessions !== 1) return null;
  const a = clockMinutes(w.startTime), b = clockMinutes(w.endTime);
  if (a == null || b == null) return null;
  let mins = b - a;
  if (mins < 0) mins += 1440;
  if (mins <= 0 || mins > 16 * 60) return null;
  return mins;
}

async function techActivityToday(day, roster) {
  const labor = await readReportData('work_order_labor_summary');
  if (!labor) return null;

  const target = day || new Date().toISOString().slice(0, 10);
  const todays = (labor.rows || []).filter(r => rowDay(r, ['date']) === target);

  // Labor Summary has no billable column — billable hours live in the
  // Billable Detail report, keyed by labor_date + maintenance_tech.
  const billableByTech = {};
  const bd = await readReportData('work_order_billable_detail');
  for (const r of (bd?.rows || [])) {
    if (rowDay(r, ['labor_date']) !== target) continue;
    const n = normName(pick(r, TECH_KEYS, ''));
    if (!n) continue;
    billableByTech[n] = (billableByTech[n] || 0) + num(pick(r, ['billable_hours', 'worked_hours']));
  }

  const techs = {};
  const unitTouch = {};

  for (const r of todays) {
    const name = pick(r, TECH_KEYS, 'Unassigned');
    const hours = num(pick(r, ['hours', 'worked_hours', 'labor_hours', 'total_hours']));
    const wo = pick(r, ['work_order_number', 'wo_number', 'number', 'work_order_id'], '—');
    const property = pick(r, ['property_name', 'property', 'building'], 'Unknown');
    const unit = pick(r, ['unit_name', 'unit', 'unit_number'], '');
    // Raw, not formatted: the value may be a full timestamp, and turning it into
    // a clock reading here would use the server's zone — UTC on Render — and
    // print an hour that is five off. The card formats it in the browser.
    const startTime = pick(r, START_TIME_KEYS, '') || null;
    const endTime = pick(r, END_TIME_KEYS, '') || null;

    const t = techs[name] || (techs[name] = {
      name, hours: 0, billableHours: 0, wos: [], _seen: new Set(),
    });
    t.hours += hours;

    const key = `${wo}|${property}|${unit}`;
    if (!t._seen.has(key)) {
      t._seen.add(key);
      t.wos.push({ wo, property, unit, hours, startTime, endTime, _sessions: 1 });
    } else {
      const existing = t.wos.find(w => `${w.wo}|${w.property}|${w.unit}` === key);
      if (existing) {
        existing.hours += hours;
        existing._sessions++;
        // Labor Summary holds one row per timer session, so a work order picked
        // up twice in a day arrives as two rows. "Started" means when the tech
        // first got to it, so the earliest wins — and a row with no start does
        // not overwrite one that has it. "Finished" is the mirror: the latest.
        const cs = clockMinutes(existing.startTime), ns = clockMinutes(startTime);
        if (ns != null && (cs == null || ns < cs)) existing.startTime = startTime;
        const ce = clockMinutes(existing.endTime), ne = clockMinutes(endTime);
        if (ne != null && (ce == null || ne > ce)) existing.endTime = endTime;
      }
    }

    // Track which techs touched each unit, for the overlap flag.
    const uKey = `${property}${unit ? ' · ' + unit : ''}`;
    (unitTouch[uKey] || (unitTouch[uKey] = new Set())).add(name);
  }

  const list = Object.values(techs).map(t => {
    delete t._seen;
    for (const w of t.wos) {
      w.durationMin = woDuration(w);
      delete w._sessions;
    }
    t.hours = Math.round(t.hours * 100) / 100;
    t.billableHours = Math.round((billableByTech[normName(t.name)] || 0) * 100) / 100;
    return t;
  }).sort((a, b) => b.hours - a.hours);

  // Zero-hours alert: roster techs with no logged time today.
  const logged = list.filter(t => t.hours > 0).map(t => t.name);
  const rosterList = (Array.isArray(roster) && roster.length)
    ? roster
    : ACTIVE_TECHNICIANS.map(name => ({ name, aliases: [] }));

  const matchesRoster = (entry, appfolioName) =>
    (entry.aliases || []).some(a => normName(a) === normName(appfolioName)) ||
    sameTech(entry.name, appfolioName);

  const zeroHours = rosterList
    .filter(entry => !logged.some(appfolio => matchesRoster(entry, appfolio)))
    .map(entry => entry.name);

  // Overlap: same unit worked by 2+ different techs today.
  const overlaps = Object.entries(unitTouch)
    .filter(([, set]) => set.size > 1)
    .map(([unit, set]) => ({ unit, techs: [...set] }));

  return {
    date: target,
    fetchedAt: labor.fetchedAt,
    rowsToday: todays.length,
    totalHours: Math.round(list.reduce((s, t) => s + t.hours, 0) * 100) / 100,
    totalBillableHours: Math.round(list.reduce((s, t) => s + t.billableHours, 0) * 100) / 100,
    technicians: list,
    zeroHours,
    overlaps,
    activeRoster: rosterList.map(entry => entry.name),
  };
}

// =====================================================================
// EXPORTS — CSV / PDF generated locally from already-synced rows.
// The Reports API only returns JSON; these files are built by us.
// =====================================================================

/** Union of every key across rows, preserving first-seen order. */
function collectHeaders(rows) {
  const seen = [];
  const set = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r || {})) {
      if (!set.has(k)) { set.add(k); seen.push(k); }
    }
  }
  return seen;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Build a CSV string from a synced report's rows, using the real column names. */
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const headers = collectHeaders(rows);
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map(h => csvCell(r[h])).join(','));
  // BOM so Excel opens UTF-8 accents correctly.
  return '﻿' + lines.join('\r\n');
}


// ---- WO Scheduling Tool (iConic pilot) --------------------------------------

/**
 * Everything the WO Scheduling tab needs, in one compact payload.
 *
 * Reads the three synced reports straight off disk and aggregates here rather
 * than letting the browser pull the raw CSVs: those are 246 KB + 988 KB +
 * 1752 KB, roughly 3 MB per tab open, and the largest of them exists only to
 * produce two summary numbers. The filtering is the same either way.
 *
 * `match` is a property-name substring ("iConic" for the pilot) so the same
 * feed serves other properties when the pilot graduates.
 */
const WO_SCHED_DEFAULT_MATCH = 'iConic';

// Whole days between two dates, or null when either is unparseable.
function daysBetween(fromRaw, toRaw) {
  const a = Date.parse(fromRaw), b = Date.parse(toRaw);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function woSchedulingFeed(match = WO_SCHED_DEFAULT_MATCH) {
  const [openRaw, laborRaw, doneRaw] = await Promise.all([
    readReportData('wo_all'),
    readReportData('work_order_labor_summary'),
    readReportData('wo_completed'),
  ]);
  // wo_all is the only hard requirement — the table cannot render without it.
  if (!openRaw) return null;

  const needle = String(match || '').toLowerCase();
  const hit = r => String(pick(r, ['property_name', 'property', 'building'], ''))
    .toLowerCase().includes(needle);

  const openRows  = (openRaw.rows  || []).filter(hit);
  const laborRows = (laborRaw?.rows || []).filter(hit);
  const doneRows  = (doneRaw?.rows  || []).filter(hit);

  const today = new Date().toISOString().slice(0, 10);

  const openWos = openRows.map(r => {
    const created = pick(r, ['created_at', 'created', 'date_created'], '');
    return {
      wo:        pick(r, ['work_order_number', 'wo_number', 'number'], '—'),
      property:  pick(r, ['property_name', 'property'], 'Unknown'),
      unit:      pick(r, ['unit_name', 'unit'], ''),
      issue:     pick(r, ['work_order_issue', 'job_description', 'description'], ''),
      type:      pick(r, ['work_order_type', 'vendor_trade'], ''),
      created,
      ageDays:   daysBetween(created, today),
      priority:  pick(r, ['priority'], ''),
      // assigned_user and vendor are NOT interchangeable. assigned_user is the
      // internal tech; vendor is the company the WO sits with and is populated
      // on every row (often "Metric Property Management" itself). Falling back
      // to vendor made the unassigned count read 0 when 5 WOs genuinely have no
      // tech — the exact number the pilot exists to surface. Keep them apart and
      // let the UI show the vendor only when there is no tech.
      tech:      pick(r, ['assigned_user'], ''),
      vendor:    pick(r, ['vendor'], ''),
      // Populated on ~4% of rows. Surfaced anyway so the gap is visible in the
      // UI rather than implied by a blank column.
      scheduledStart: pick(r, ['scheduled_start'], ''),
      status:    pick(r, ['status', 'work_order_status'], ''),
    };
  }).sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));   // oldest first

  // Cycle time, from the only pull that carries completion dates.
  const totals = [], workSpans = [], adminSpans = [];
  for (const r of doneRows) {
    const created   = pick(r, ['created_at'], '');
    const workDone  = pick(r, ['work_completed_on'], '');
    const completed = pick(r, ['completed_on', 'work_completed_on'], '');
    const t = daysBetween(created, completed);
    if (t !== null) totals.push(t);
    // created -> work done is the field response; work done -> completed is the
    // billing/closeout tail. Splitting them says which half a scheduling tool
    // can actually move.
    const w = daysBetween(created, workDone);
    const a = daysBetween(workDone, completed);
    if (w !== null) workSpans.push(w);
    if (a !== null) adminSpans.push(a);
  }
  const sortNum = arr => arr.slice().sort((x, y) => x - y);

  // Top issue over the labor window (90 days), which describes what the techs
  // actually spend time on — the open queue is too small to rank meaningfully.
  const issueCounts = {};
  for (const r of laborRows) {
    const k = String(pick(r, ['work_order_issue', 'description'], '')).toLowerCase().trim().slice(0, 60);
    if (k) issueCounts[k] = (issueCounts[k] || 0) + 1;
  }
  const topIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([issue, count]) => ({ issue, count }));

  const laborDates = laborRows.map(r => rowDay(r, ['date'])).filter(Boolean).sort();

  // ---- Tech workload ----
  // Hours over 7/30/90 days, plus the open WOs each tech is carrying.
  //
  // The 90-day figure is bounded by the labor report's own window, which is a
  // rolling 90 days — so "90d" is the full window, not a slice of something
  // longer. avgWeekly is derived from it rather than from the 7-day count: a
  // single week swings wildly with one big job, and capacity has to be judged
  // against a normal week.
  const cut7  = isoDay(-7);
  const cut30 = isoDay(-30);
  const techMap = {};
  const techOf = r => String(pick(r, ['maintenance_tech', 'technician', 'tech'], '')).trim();
  for (const r of laborRows) {
    const name = techOf(r);
    if (!name) continue;
    const day = rowDay(r, ['date']);
    const h = num(pick(r, ['worked_hours', 'hours', 'labor_hours']));
    const t = techMap[name] || (techMap[name] = { tech: name, hours7: 0, hours30: 0, hours90: 0, openWos: 0, byProperty: {} });
    t.hours90 += h;
    if (day && day >= cut30) t.hours30 += h;
    if (day && day >= cut7)  t.hours7  += h;
    const prop = String(pick(r, ['property_name', 'property'], 'Unknown')).trim();
    t.byProperty[prop] = (t.byProperty[prop] || 0) + h;
  }
  // Open WOs per tech. assigned_user can carry SEVERAL names on one WO
  // ("Carlos Portilla, Josue Garcia C") — each is credited, so the per-tech
  // counts can sum to more than the number of open work orders. That is the
  // honest reading: both techs are carrying it.
  for (const w of openWos) {
    for (const nameRaw of String(w.tech || '').split(',')) {
      const name = nameRaw.trim();
      if (!name) continue;
      const t = techMap[name] || (techMap[name] = { tech: name, hours7: 0, hours30: 0, hours90: 0, openWos: 0, byProperty: {} });
      t.openWos++;
    }
  }
  const round1 = n => Math.round(n * 10) / 10;
  const techs = Object.values(techMap)
    .map(t => ({
      tech: t.tech,
      hours7:  round1(t.hours7),
      hours30: round1(t.hours30),
      hours90: round1(t.hours90),
      openWos: t.openWos,
      avgWeekly: round1(t.hours90 / (90 / 7)),
      topProperty: Object.entries(t.byProperty).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    }))
    .sort((a, b) => b.hours90 - a.hours90);

  return {
    match,
    generatedAt: new Date().toISOString(),
    techs,
    syncedAt: {
      open: openRaw.fetchedAt || null,
      labor: laborRaw?.fetchedAt || null,
      completed: doneRaw?.fetchedAt || null,
    },
    openWos,
    insights: {
      openCount:      openWos.length,
      over30:         openWos.filter(w => (w.ageDays ?? 0) > 30).length,
      between15and30: openWos.filter(w => (w.ageDays ?? 0) >= 15 && (w.ageDays ?? 0) <= 30).length,
      under15:        openWos.filter(w => (w.ageDays ?? 0) < 15).length,
      unassigned:     openWos.filter(w => !String(w.tech || '').trim()).length,
      scheduled:      openWos.filter(w => String(w.scheduledStart || '').trim()).length,
      oldestDays:     openWos.length ? (openWos[0].ageDays ?? null) : null,
      topIssues,
      cycle: {
        n:            totals.length,
        medianDays:   median(sortNum(totals)),
        medianWork:   median(sortNum(workSpans)),
        medianAdmin:  median(sortNum(adminSpans)),
      },
      laborRows: laborRows.length,
      laborFrom: laborDates[0] || null,
      laborTo:   laborDates[laborDates.length - 1] || null,
      // So the UI can say WHY a panel is empty instead of rendering zeros.
      missing: [
        laborRaw ? null : 'work_order_labor_summary',
        doneRaw  ? null : 'wo_completed',
      ].filter(Boolean),
    },
  };
}

module.exports = {
  REPORTS,
  syncReport,
  syncAll,
  overview,
  readReportData,
  billableSummary,
  urgentWorkOrders,
  woCountsByProperty,
  openWorkOrders,
  activitiesSummary,
  inventorySnapshot,
  efficiencyMetrics,
  techActivityToday,
  woSchedulingFeed,
  toCSV,
  collectHeaders,
  ACTIVE_TECHNICIANS,
  byId,
  API_DIR,
};
