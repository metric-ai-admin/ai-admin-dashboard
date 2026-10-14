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
// THE LINK IS STRUCTURAL NOW. The probe of 2026-10-14 settled it: there is no
// type column, but there IS `unit_turn_id` on 202 of 635 rows — the unit turn
// the inspection belongs to. An inspection carrying the turn id of this
// move-out IS the walk for it: nothing to read, nothing to misspell. The name
// is the FALLBACK, used only when an inspection has no turn id at all.
//
// That inverts the fragility. The 388 unnamed rows stop mattering wherever the
// turn id is present, and where it is absent the alert still says "recorded",
// still lists what it could not classify, and is still honest about not
// knowing.

// ---- dates -----------------------------------------------------------------
//
// `inspection_date` IS NOT A COLUMN inspection_detail returns — the sync asked
// for a name AppFolio never sends, so it has been null on every row since the
// sync was written. The real one is `inspected_on`, present on all 635.
// marked_done_on (447) is the fallback for a row synced before migration 095.

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

const DONE = /^done$/i;

const turnIdOf = row => clean(row && (row.unit_turn_id || row.turn_id));

// Does this inspection belong to this turn?
//
// Compared as TRIMMED STRINGS: one side arrives from Supabase as text and the
// other from the report as a number, and 202 == '202' is false.
function belongsToTurn(row, turnId) {
  const a = turnIdOf(row);
  const b = clean(turnId);
  return !!a && !!b && a === b;
}

function isWalk(row, opts) {
  const o = opts || {};
  // A turn id is an answer on its own — that is the point of migration 095.
  if (o.turnId && belongsToTurn(row, o.turnId)) return true;
  // An inspection linked to a DIFFERENT turn is not this move-out's walk,
  // whatever it is called.
  if (o.turnId && turnIdOf(row)) return false;
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

// The date an inspection happened: inspected_on, then marked_done_on for rows
// synced before 095. created_on is NOT used — when it was created says nothing
// about when somebody walked the unit.
function inspectedOn(row) {
  const d = ymd(row && row.inspected_on);
  if (isYmd(d)) return d;
  const m = ymd(row && row.marked_done_on);
  return isYmd(m) ? m : null;
}

const unitKey = (property, unit) =>
  clean(property).toLowerCase() + '|' + clean(unit).toLowerCase();

/**
 * Inspections indexed BOTH ways: by "property|unit" and by unit_turn_id.
 *
 * The turn index is the one that matters. The unit index is how an inspection
 * with no turn id is still found, and how the unrecognised ones get listed
 * beside the alert.
 */
function indexInspections(rows) {
  const byUnit = new Map();
  const byTurn = new Map();
  (rows || []).forEach(r => {
    const k = unitKey(r.property_name, r.unit);
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(r);
    const t = turnIdOf(r);
    if (t) {
      if (!byTurn.has(t)) byTurn.set(t, []);
      byTurn.get(t).push(r);
    }
  });
  return { byUnit, byTurn };
}

// A turn's own id, under whichever name the report uses.
const turnOf = t => clean(t && (t.unit_turn_id || t.turn_id || t.id));

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
  const { byUnit, byTurn } = indexInspections((src || {}).inspections);
  const out = [];

  (((src || {}).turns) || []).forEach(t => {
    const moveOut = ymd(t.move_out_date);
    if (!isYmd(moveOut) || moveOut > todayCT) return;
    const property = clean(t.property_name || t.property);
    const unit = clean(t.unit || t.unit_name);
    if (!property) return;

    const due = WEEK.addBusinessDays(moveOut, days);
    if (!due || todayCT <= due) return;              // not overdue yet

    const m = matchWalk({ turn: t, byTurn, byUnit, property, unit, moveOut });
    // Only 'none' and 'open' are worth an alert, and they are DIFFERENT alerts.
    if (m.state === 'done') return;

    out.push({
      property, unit, moveOut, due, turnId: m.turnId || null,
      businessDaysOverdue: WEEK.businessDaysBetween(due, todayCT),
      state: m.state,
      openWalk: m.open ? clean(m.open.status) : null,
      openName: m.open ? (clean(m.open.inspection_name) || '(no name)') : null,
      basis: m.basis,
      tooEarly: (m.tooEarly || []).map(r => ({
        name: clean(r.inspection_name) || '(no name)',
        inspectedOn: inspectedOn(r),
      })),
      unnamedInspections: (m.unnamed || []).map(r => ({
        name: clean(r.inspection_name) || '(no name)',
        status: clean(r.status),
        inspectedOn: inspectedOn(r),
        createdOn: ymd(r.created_on) || null,
      })),
    });
  });

  out.sort((a, b) => (b.businessDaysOverdue || 0) - (a.businessDaysOverdue || 0)
    || a.property.localeCompare(b.property));
  return out;
}

/**
 * Find this move-out's walk, and say how.
 *
 * TWO PASSES, AND THE SECOND ALWAYS RUNS. The first version let the turn id
 * veto in both directions: an inspection carrying any other turn id was "not
 * this walk", so when the two id namespaces did not line up at all, every
 * inspection was rejected and the name fallback never got a chance. 39 of 39
 * move-outs came back "none" with 202 linked inspections sitting right there.
 *
 * A turn id is only ever a POSITIVE signal now. If the turn pass finds nothing
 * — no link, or links that do not match — the name pass runs over every
 * inspection on the unit, whatever turn id it carries, and the result is
 * reported as 'name' so nobody mistakes it for a structural match.
 *
 * Exported so the measurement and the tests see exactly what the alert sees.
 */
function matchWalk({ turn, byTurn, byUnit, property, unit, moveOut }) {
  const turnId = turnOf(turn);
  const linked = turnId ? (byTurn.get(turnId) || []) : [];
  const onUnit = byUnit.get(unitKey(property, unit)) || [];

  const done = r => DONE.test(clean(r.status));
  const onOrAfter = r => inspectedOn(r) && inspectedOn(r) >= moveOut;

  // ---- pass 1: the turn's own inspections, DATE IRRELEVANT -----------------
  //
  // Arturo, 2026-10-14. If AppFolio linked an inspection to THIS unit turn then
  // it is this move-out's inspection, whenever it is dated. The date rule
  // exists to stop a walk from the PREVIOUS tenancy being counted, and a turn
  // id already rules that out — it is a stronger statement than any date
  // comparison. Six of the thirty-nine were being thrown away on a date test
  // the link had already answered.
  const linkedDone = linked.find(done);
  if (linkedDone) {
    return state('done', { walk: linkedDone, basis: 'turn', turnId });
  }
  if (linked.length) {
    // THE MIDDLE STATE. An inspection exists for this turn and nobody marked it
    // done. That is a different job from doing the walk — somebody has to close
    // it in AppFolio — and calling it "no inspection" sends a technician back
    // to a unit that has already been walked.
    return state('open', { basis: 'turn', turnId, open: linked[0] });
  }

  // ---- pass 2: by name, over every inspection on the unit ------------------
  //
  // Here the date DOES matter: without a turn id there is nothing else to tell
  // this move-out's walk from the last one's.
  const named = onUnit.filter(r => WALK_NAME.test(clean(r.inspection_name)));
  const namedDone = named.filter(done);
  const namedWalk = namedDone.find(onOrAfter);
  if (namedWalk) return state('done', { walk: namedWalk, basis: 'name', turnId });

  const openNamed = named.find(r => !done(r));
  if (openNamed) return state('open', { basis: 'name', turnId, open: openNamed });

  return state('none', {
    basis: linked.length ? 'turn' : 'name',
    turnId,
    // Done, named, and older than the move-out: about the previous tenancy.
    // Reported rather than folded into the silence.
    tooEarly: namedDone.filter(r => !onOrAfter(r)),
    unnamed: onUnit.filter(r => isUnrecognised(r)),
  });
}

// THREE STATES, NOT TWO (Arturo, 2026-10-14):
//
//   done   somebody walked it and marked it done.
//   open   an inspection exists and is not marked done. The walk may well have
//          happened; what is missing is the click in AppFolio.
//   none   nothing at all. This is the only one that means "go and inspect".
//
// 33 of 39 move-outs had an inspection named like a walk and only 6 were DONE.
// Reporting all 33 as "no inspection" would send people to re-walk units that
// had already been walked, which is how an alert gets switched off.
const STATES = ['done', 'open', 'none'];

function state(which, extra) {
  return Object.assign({
    state: which,
    walk: null, basis: 'name', turnId: null, open: null, tooEarly: [], unnamed: [],
  }, extra || {}, { state: which });
}

// One sentence, in the brief and on the screen, so the wording cannot drift.
//
// "No move-out inspection RECORDED" — not "nobody did the walk". The data
// cannot tell those apart and the alert must not pretend it can.
function line(a) {
  // THE FIRST CLAUSE IS THE WHOLE ALERT. "Not marked done" and "nothing
  // recorded" are different jobs for different people, and the old wording
  // said the second for both.
  const head = a.state === 'open'
    ? 'Inspection exists but is NOT marked done in AppFolio for ' + a.property + ' '
      + (a.unit || '(no unit)') + ' — ' + (a.openName || 'an inspection')
      + ' is ' + (a.openWalk || 'open')
    : 'No move-out inspection recorded for ' + a.property + ' ' + (a.unit || '(no unit)');

  const bits = [head + ' — moved out ' + a.moveOut + ', due ' + a.due];
  if (a.businessDaysOverdue) {
    bits.push(a.businessDaysOverdue + ' business day'
      + (a.businessDaysOverdue === 1 ? '' : 's') + ' late');
  }
  if (a.state === 'open') bits.push('somebody has to close it, not re-walk the unit');
  // Only worth saying when we are reading free text. A turn-linked verdict
  // needs no apology.
  if (a.state === 'none' && a.basis === 'name') {
    bits.push(a.turnId
      ? 'the turn id on this move-out matched no inspection, so it was decided by inspection NAME'
      : 'no turn id on this move-out, so it was decided by inspection NAME');
  }
  if ((a.tooEarly || []).length) {
    bits.push((a.tooEarly.length === 1 ? 'an inspection was' : a.tooEarly.length + ' inspections were')
      + ' done BEFORE the move-out (' + a.tooEarly.map(x => x.inspectedOn).filter(Boolean).join(', ')
      + '), so they are about the previous tenancy');
  }
  if ((a.unnamedInspections || []).length) {
    bits.push(a.unnamedInspections.length + ' inspection'
      + (a.unnamedInspections.length === 1 ? '' : 's') + ' on this unit with an unrecognised name '
      + '— one of them may be the walk');
  }
  return bits.join('. ') + '.';
}

module.exports = {
  WALK_NAME, FAS_NAME, DONE,
  isWalk, isFas, isUnrecognised, unitKey, indexInspections, turnIdOf, turnOf, matchWalk,
  STATES,
  belongsToTurn, inspectedOn,
  moveOutsOn, walkOverdue, line, clean, ymd, isYmd,
};
