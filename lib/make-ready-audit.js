// Every open unit turn, unit by unit, with what the rent roll says about the
// unit today and the make-ready work order behind it.
//
// WHY THIS EXISTS. The brief reported Ascent with 40 turns open and the oldest
// at 490 days, and the first rule we wrote filed anything past 90 days as
// paperwork. Bekah checked them on 2026-10-13: "they aren't done" — all but
// the iConic Round Rock one are real make-readies on units that have been
// empty for a very long time. A count cannot be argued with in a meeting; a
// list of units can be worked.
//
// NO PERSONAL DATA. Unit numbers, dates and work-order statuses only. The turn
// and rent-roll rows carry resident names and phone numbers and none of those
// columns are read — a vacant unit has no resident to name, and for an
// occupied one the name is somebody's address.
//
// WHAT EACH COLUMN IS FOR, since the point is to settle a disagreement:
//
//   Unit status today  from the rent roll. This is what decides whether a turn
//                      is work or a record, so it is on the face of the sheet
//                      rather than behind the classification.
//   Make-ready WO      the work order, if one exists. "none" is a finding: a
//                      turn with no work order is not being worked by anybody,
//                      whatever the turn record says.
//   Days open          from move_out_date to today, Central.

'use strict';

const AFP = require('./appfolio-properties.js');

const clean = s => String(s == null ? '' : s).trim();
const ymd = v => clean(v).slice(0, 10);
const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(ymd(v));

function daysSince(v, todayCT) {
  if (!isYmd(v)) return null;
  return Math.round((Date.parse(todayCT + 'T00:00:00Z') - Date.parse(ymd(v) + 'T00:00:00Z')) / 86400000);
}

// First present value among several column spellings. The reports do not agree
// with each other on names and an absent column must not read as an empty one.
function pick(row, names) {
  for (const n of names) {
    if (row && row[n] !== undefined && row[n] !== null && clean(row[n]) !== '') return clean(row[n]);
  }
  return '';
}

const UNIT_FIELDS = ['unit', 'unit_name', 'unit_number'];
const PROP_FIELDS = ['property_name', 'property'];

// The rent roll's verdict on each unit, keyed "Property|Unit".
//
// The raw status is kept, not just a vacant/occupied boolean: "Notice-Rented"
// and "Vacant-Rented" are different answers from "Vacant-Unrented" and the
// difference is the whole conversation.
function unitStatusIndex(rentRoll) {
  const out = new Map();
  (rentRoll || []).forEach(r => {
    const name = AFP.resolveProperty(pick(r, PROP_FIELDS));
    const unit = pick(r, UNIT_FIELDS);
    if (!name || !unit) return;
    const status = clean(r.status) || clean(r.unit_status);
    const k = name + '|' + unit;
    // A unit can have two rows (an outgoing and an incoming lease). A vacancy
    // is the one worth surfacing, so it wins over a "Current" row rather than
    // being overwritten by whichever came last in the file.
    if (!out.has(k) || /vacant|notice/i.test(status)) out.set(k, status);
  });
  return out;
}

// Make-ready work orders by "Property|Unit". Only unit-turn work, and only the
// ones that are not finished — a completed WO on an open turn says the turn
// record is stale, which is itself worth seeing, so it is kept and labelled.
const TURN_TYPE = /unit[\s_-]*turn|make[\s_-]*ready|turnover/i;

function workOrderIndex(workOrders) {
  const out = new Map();
  (workOrders || []).forEach(w => {
    const name = AFP.resolveProperty(pick(w, PROP_FIELDS));
    const unit = pick(w, UNIT_FIELDS);
    if (!name || !unit) return;
    const type = pick(w, ['work_order_type', 'type', 'job_type']);
    const desc = pick(w, ['description', 'work_order_description', 'title']);
    if (!TURN_TYPE.test(type) && !TURN_TYPE.test(desc)) return;
    const k = name + '|' + unit;
    const row = {
      number: pick(w, ['work_order_number', 'work_order_id', 'number', 'id']),
      status: pick(w, ['status', 'work_order_status']),
      created: ymd(pick(w, ['created_at', 'created_on', 'work_order_created', 'date_created'])),
    };
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  });
  // Newest first, so the row that gets shown is the current attempt.
  out.forEach(list => list.sort((a, b) => String(b.created).localeCompare(String(a.created))));
  return out;
}

/**
 * One row per OPEN unit turn.
 *
 * @param {object} src   { turns, rentRoll, workOrders }
 * @param {string} todayCT  YYYY-MM-DD, Central
 */
function turnRows(src, todayCT) {
  const s = src || {};
  const status = unitStatusIndex(s.rentRoll);
  const wos = workOrderIndex(s.workOrders);
  const rows = [];

  (s.turns || []).forEach(t => {
    const property = AFP.resolveProperty(pick(t, PROP_FIELDS));
    if (!property) return;
    if (clean(t.turn_end_date)) return;             // finished
    const unit = pick(t, UNIT_FIELDS);
    const started = ymd(t.move_out_date);
    const days = daysSince(started, todayCT);
    if (days === null || days < 0) return;

    const k = property + '|' + unit;
    const st = unit ? (status.get(k) || '') : '';
    const wo = (wos.get(k) || [])[0] || null;

    rows.push({
      property,
      unit: unit || '(no unit on the turn record)',
      started,
      days,
      // Said in words, because "Current" means occupied and a reader should
      // not have to know that. The raw status travels beside it.
      unitToday: describeStatus(st, !!unit),
      unitStatusRaw: st,
      workOrder: wo ? wo.number : '',
      workOrderStatus: wo ? wo.status : (unit ? 'none found' : ''),
      // The classification the brief now applies, on the sheet, so the meeting
      // can argue with the rule rather than with the number.
      verdict: verdictFor(st, days, unit),
    });
  });

  rows.sort((a, b) => b.days - a.days || a.property.localeCompare(b.property)
    || String(a.unit).localeCompare(String(b.unit)));
  return rows;
}

function describeStatus(raw, hasUnit) {
  if (!hasUnit) return 'cannot be checked — no unit number';
  if (!raw) return 'not in the rent roll';
  if (/vacant/i.test(raw)) return 'vacant';
  if (/notice/i.test(raw)) return 'occupied, on notice';
  return 'occupied';
}

// The same rule lib/kara-brief-gather.js applies, in words.
function verdictFor(raw, days, unit) {
  if (!unit) return 'cannot be checked';
  if (!raw) return 'not in the rent roll';
  if (!/vacant/i.test(raw)) return 'record to clean up — somebody lives there';
  return days > 90 ? 'LONG-OPEN MAKE-READY (90+ days)' : 'make-ready in progress';
}

// Applications still pending, for one property. Unit, received, days — no
// applicant name, no contact details.
function applicationRows(apps, property, todayCT) {
  return (apps || [])
    .filter(a => AFP.resolveProperty(a.property_name) === property)
    .filter(a => {
      const st = clean(a.status);
      const det = clean(a.detailed_status);
      if (/^cancel/i.test(st) || /denied|declined/i.test(st)) return false;
      return det !== 'Converted' && det !== 'Converting';
    })
    .map(a => ({
      property,
      unit: pick(a, UNIT_FIELDS) || '(no unit)',
      received: ymd(a.application_date),
      days: daysSince(a.application_date, todayCT),
      status: clean(a.status) || '—',
      detailedStatus: clean(a.detailed_status) || '—',
    }))
    .sort((a, b) => (b.days || 0) - (a.days || 0));
}

// Per-property totals for the Summary sheet.
function summarise(rows) {
  const by = new Map();
  rows.forEach(r => {
    if (!by.has(r.property)) {
      by.set(r.property, {
        property: r.property, open: 0, longOpen: 0, records: 0,
        oldest: 0, noWorkOrder: 0,
      });
    }
    const b = by.get(r.property);
    if (/record to clean up/.test(r.verdict)) b.records++;
    else {
      b.open++;
      if (/LONG-OPEN/.test(r.verdict)) b.longOpen++;
      if (r.days > b.oldest) b.oldest = r.days;
      if (r.workOrderStatus === 'none found') b.noWorkOrder++;
    }
  });
  return [...by.values()].sort((a, b) => b.longOpen - a.longOpen || b.open - a.open);
}

module.exports = {
  clean, ymd, isYmd, daysSince, pick, unitStatusIndex, workOrderIndex,
  turnRows, applicationRows, summarise, describeStatus, verdictFor, TURN_TYPE,
};
