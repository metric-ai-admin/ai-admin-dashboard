// Work orders that were created AND closed between two syncs.
//
// /api/maintenance/sync asks AppFolio for OPEN status codes and drops anything
// closed before it writes; the reconciliation only ever UPDATES rows that
// already exist. So a work order opened on Monday and completed on Wednesday,
// with no sync in between catching it open, never enters
// maintenance_work_orders at all. On 2026-09-27..10-03 that is 19 completions
// Katie's report has and we do not — not a wrong status or a wrong date, no
// row.
//
// This adds them from the wo_completed and wo_canceled stores. It ONLY ADDS:
// an existing row is never touched, so a row a person or the reconciliation
// has already settled cannot be overwritten by a feed.

const WOS = require('./work-order-status.js');

const pick = (r, keys) => {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') return r[k];
  }
  return null;
};

function day(v) {
  if (!v) return null;
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
}

function rowFrom(r, now) {
  const number = pick(r, ['work_order_number']);
  if (!number) return null;
  const id = pick(r, ['work_order_id']);
  const sr = pick(r, ['service_request_id']);
  const pid = pick(r, ['property_id']);
  return {
    work_order_number: String(number).trim(),
    property: pick(r, ['property']),
    property_name: pick(r, ['property_name', 'property']),
    property_id: pid === null ? null : String(pid),
    unit: pick(r, ['unit_name', 'unit']),
    issue: pick(r, ['work_order_issue', 'job_description']),
    description: pick(r, ['job_description']),
    status: pick(r, ['status']),
    priority: pick(r, ['priority']),
    work_order_type: pick(r, ['work_order_type']),
    assigned_user: pick(r, ['assigned_user']),
    vendor: pick(r, ['vendor']),
    primary_resident: pick(r, ['primary_tenant']),
    created_at_appfolio: pick(r, ['created_at']),
    work_order_id: id === null ? null : String(id),
    service_request_id: sr === null ? null : String(sr),
    // Whichever name the feed uses for the day it closed. A cancelled row
    // carries canceled_on and nothing else.
    completed_on: day(pick(r, ['completed_on', 'work_completed_on', 'canceled_on'])),
    // DELIBERATELY NULL. last_seen_in_feed means "the OPEN feed still carries
    // this". Stamping it here would tell the next reconciliation these rows
    // are open and it would start marking them Unknown when they stopped
    // appearing — which they never will, because they are closed.
    last_seen_in_feed: null,
    synced_at: now,
    updated_at: now,
    // No updated_by: maintenance_work_orders has no such column. The first
    // write failed on it at row 0 — which is the reason this uses insert and
    // checks the error rather than firing and hoping.
  };
}

// Returns { rows, summary } — the rows that are missing, and what they are.
// `existing` is a Set of work_order_number already in the table.
function plan(completed, canceled, existing, now) {
  const seen = new Set();
  const rows = [];
  const consider = list => (list || []).forEach(r => {
    const rec = rowFrom(r, now || new Date().toISOString());
    if (!rec) return;
    if (existing.has(rec.work_order_number) || seen.has(rec.work_order_number)) return;
    // Only a CLOSED row. Anything open belongs to the normal sync, which knows
    // how to keep it up to date; inserting it here would create a row nothing
    // afterwards would maintain.
    if (!WOS.isClosed(rec.status)) return;
    seen.add(rec.work_order_number);
    rows.push(rec);
  });
  // completed first, so a work order in both stores is kept as completed.
  consider(completed);
  consider(canceled);

  const byStatus = {}, byMonth = {}, byProperty = {};
  rows.forEach(r => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const m = String(r.completed_on || '').slice(0, 7) || '(no date)';
    byMonth[m] = (byMonth[m] || 0) + 1;
    const p = r.property_name || '(none)';
    byProperty[p] = (byProperty[p] || 0) + 1;
  });
  return {
    rows,
    summary: {
      toInsert: rows.length,
      byStatus, byMonth, byProperty,
      allClosed: rows.every(r => WOS.isClosed(r.status)),
      noneMarkedInFeed: rows.every(r => r.last_seen_in_feed === null),
    },
  };
}

module.exports = { plan, rowFrom, day };
