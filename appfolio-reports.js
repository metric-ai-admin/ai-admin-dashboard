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
    id: 'work_order_labor_summary',
    resource: 'work_order_labor_summary',
    label: 'Work Order — Labor Summary',
    group: 'Billable Labor',
    priority: 1,
    feeds: 'AppFolio Analyzer → Billable Labor + Technician Activity Today',
    params: {},
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

/** Billable Labor Report — feeds the AppFolio Analyzer view. */
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

    const t = techs[name] || (techs[name] = {
      name, hours: 0, billableHours: 0, wos: [], _seen: new Set(),
    });
    t.hours += hours;

    const key = `${wo}|${property}|${unit}`;
    if (!t._seen.has(key)) {
      t._seen.add(key);
      t.wos.push({ wo, property, unit, hours });
    } else {
      const existing = t.wos.find(w => `${w.wo}|${w.property}|${w.unit}` === key);
      if (existing) existing.hours += hours;
    }

    // Track which techs touched each unit, for the overlap flag.
    const uKey = `${property}${unit ? ' · ' + unit : ''}`;
    (unitTouch[uKey] || (unitTouch[uKey] = new Set())).add(name);
  }

  const list = Object.values(techs).map(t => {
    delete t._seen;
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
  toCSV,
  collectHeaders,
  ACTIVE_TECHNICIANS,
  byId,
  API_DIR,
};
