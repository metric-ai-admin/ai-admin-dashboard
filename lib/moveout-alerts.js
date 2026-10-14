// Move-outs today, and the ones with no inspection behind them.
//
// Kara's Phase C, item 1 (form of 2026-10-09). Two of the three alerts are
// built; the FAS one is waiting on her answer to what "FAS done" means, and
// the reason is worth writing down because it is not a scheduling detail:
//
//   THE FAS IS NOT A DOCUMENT IN OUR DATA. It is an INSPECTION named after
//   one. "Move Out - FAS Inspection" (33 rows) and "Final Account Statement
//   Inspection" (8) are the only trace of it, so the strongest thing we could
//   say is "somebody completed an inspection with FAS in its name" — which is
//   not the same as the statement having reached the resident, and an alert
//   that implies the second while checking the first is worse than no alert.
//   52 rows against ~195 move-out walks also means it would open shouting
//   about nearly every move-out.
//
// ---- how a walk is recognised, and why that is fragile ---------------------
//
// `maintenance_inspections.inspection_name` is FREE TEXT and people type into
// it. Of 635 rows on 2026-10-14: 160 "Move Out Damage and Occupancy
// Inspection", and then 34 "Untitled", 31 "Andres luevano", 9 "Mike redy", 6
// "Jose reyes", 5 "Acen", 4 "110". 388 of the 635 match neither pattern.
//
// So an alert keyed on the name WILL say "no inspection" about units where
// somebody did the walk and named the record after themselves. That is why the
// alert says "no move-out inspection RECORDED" rather than "nobody did the
// walk", and why every unrecognised inspection on that unit is listed beside
// it: the reader can see in one line when the problem is the name.
//
// IF THE REPORT HAS A STRUCTURED TYPE, IT WINS. `typeField` is read first and
// the name is the fallback, so confirming a real type column is a config
// change rather than a rewrite. The sync keeps eleven columns of
// inspection_detail and drops the rest, so such a field may exist and have
// never reached the database — scripts/probe-report-columns.js inspection_detail
// answers that, on Render.
//
// ---- dates -----------------------------------------------------------------
//
// `inspection_date` is EMPTY ON ALL 635 ROWS — synced and never populated. The
// usable dates are created_on (100%) and marked_done_on (100% of DONE). So
// "the walk happened" means a DONE inspection, dated by marked_done_on.

'use strict';

const WEEK = require('./week.js');

const clean = s => String(s == null ? '' : s).trim();
const ymd = v => clean(v).slice(0, 10);
const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(ymd(v));

// Names that mean "this is the move-out walk". Read off the live data, the way
// lib/property-aliases.js is: a list of what people have actually produced, not
// a pattern that might catch next week's invention.
const WALK_NAME = /move[\s-]*out.*(damage|occupancy|inspection)|occupancy.*move[\s-]*out/i;

// Named here so the FAS alert, when Kara defines it, reads the same column.
const FAS_NAME = /\bfas\b|final\s+account/i;

// Structured type values, if the report turns out to have the field. Checked
// before the name; unknown values fall through to the name rather than being
// treated as "not a walk".
const WALK_TYPES = ['move_out', 'moveout', 'move out', 'move-out'];

const DONE = /^done$/i;

function isWalk(row, opts) {
  const o = opts || {};
  const typeField = o.typeField || 'inspection_type';
  const type = clean(row && row[typeField]).toLowerCase();
  if (type) {
    if (WALK_TYPES.includes(type)) return true;
    // A structured type that is present and says something else is an answer:
    // this inspection is not a move-out walk, whatever it is called.
    if (!WALK_NAME.test(clean(row.inspection_name))) return false;
  }
  return WALK_NAME.test(clean(row && row.inspection_name));
}

function isFas(row) {
  return FAS_NAME.test(clean(row && row.inspection_name));
}

// An inspection whose name tells us nothing. These are the reason the alert is
// worded the way it is, so they are carried, not filtered away.
function isUnrecognised(row, opts) {
  return !isWalk(row, opts) && !isFas(row)
    && !/make[\s-]*ready|monthly|management|annual|renewal/i.test(clean(row && row.inspection_name));
}

const unitKey = (property, unit) =>
  clean(property).toLowerCase() + '|' + clean(unit).toLowerCase();

/**
 * Inspections indexed by "property|unit".
 */
function indexInspections(rows, opts) {
  const by = new Map();
  (rows || []).forEach(r => {
    const k = unitKey(r.property_name, r.unit);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  });
  return by;
}

// The move-outs with a date of exactly `today`, from unit_turn_detail — the
// same source the KPI report and Kara's brief use for move-outs, so the three
// cannot disagree about who moved out.
function moveOutsOn(turns, todayCT) {
  return (turns || [])
    .filter(t => isYmd(t.move_out_date) && ymd(t.move_out_date) === todayCT)
    .map(t => ({
      property: clean(t.property_name || t.property),
      unit: clean(t.unit || t.unit_name),
      moveOut: ymd(t.move_out_date),
      // A turn that is already finished is still a move-out that happened
      // today; the walk question is separate from the turn being closed.
      turnClosed: !!clean(t.turn_end_date),
    }))
    .filter(m => m.property)
    .sort((a, b) => a.property.localeCompare(b.property) || String(a.unit).localeCompare(String(b.unit)));
}

/**
 * Move-outs whose walk is overdue.
 *
 * @param {object} src   { turns, inspections }
 * @param {string} todayCT
 * @param {object} opts  { businessDays = 2, typeField }
 */
function walkOverdue(src, todayCT, opts) {
  const o = opts || {};
  const days = o.businessDays == null ? 2 : o.businessDays;
  const byUnit = indexInspections((src || {}).inspections, o);
  const out = [];

  (((src || {}).turns) || []).forEach(t => {
    const moveOut = ymd(t.move_out_date);
    if (!isYmd(moveOut) || moveOut > todayCT) return;
    const property = clean(t.property_name || t.property);
    const unit = clean(t.unit || t.unit_name);
    if (!property) return;

    const due = WEEK.addBusinessDays(moveOut, days);
    if (!due || todayCT <= due) return;              // not overdue yet

    const mine = byUnit.get(unitKey(property, unit)) || [];
    // A walk counts when it is DONE and was marked done on or after the
    // move-out. An inspection completed BEFORE somebody moved out is a
    // different inspection — that one was about the resident still living
    // there.
    const walks = mine.filter(r => isWalk(r, o) && DONE.test(clean(r.status))
      && isYmd(r.marked_done_on) && ymd(r.marked_done_on) >= moveOut);
    if (walks.length) return;

    // An open one is not a pass, but it IS a different conversation from
    // nothing at all.
    const open = mine.filter(r => isWalk(r, o) && !DONE.test(clean(r.status)));
    out.push({
      property, unit, moveOut, due,
      businessDaysOverdue: WEEK.businessDaysBetween(due, todayCT),
      openWalk: open.length ? clean(open[0].status) : null,
      // THE POINT OF THE WHOLE DESIGN. 388 of 635 inspections carry a name
      // nobody can read. If one of these is the walk, the reader sees it here
      // instead of chasing a unit that was already inspected.
      unnamedInspections: mine.filter(r => isUnrecognised(r, o)).map(r => ({
        name: clean(r.inspection_name) || '(no name)',
        status: clean(r.status),
        doneOn: ymd(r.marked_done_on) || null,
        createdOn: ymd(r.created_on) || null,
      })),
    });
  });

  out.sort((a, b) => (b.businessDaysOverdue || 0) - (a.businessDaysOverdue || 0)
    || a.property.localeCompare(b.property));
  return out;
}

// One sentence, in the brief and on the screen, so the wording cannot drift.
//
// "No move-out inspection RECORDED" — not "nobody did the walk". The data
// cannot tell those apart and the alert must not pretend it can.
function line(a) {
  const bits = ['No move-out inspection recorded for ' + a.property + ' ' + (a.unit || '(no unit)')
    + ' — moved out ' + a.moveOut + ', due ' + a.due];
  if (a.businessDaysOverdue) bits.push(a.businessDaysOverdue + ' business day'
    + (a.businessDaysOverdue === 1 ? '' : 's') + ' late');
  if (a.openWalk) bits.push('an inspection is open (' + a.openWalk + ')');
  if (a.unnamedInspections.length) {
    bits.push(a.unnamedInspections.length + ' inspection'
      + (a.unnamedInspections.length === 1 ? '' : 's') + ' on this unit with an unrecognised name '
      + '— one of them may be the walk');
  }
  return bits.join('. ') + '.';
}

module.exports = {
  WALK_NAME, FAS_NAME, WALK_TYPES, DONE,
  isWalk, isFas, isUnrecognised, unitKey, indexInspections,
  moveOutsOn, walkOverdue, line, clean, ymd, isYmd,
};
