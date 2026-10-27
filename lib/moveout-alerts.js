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

// Lifted OUT of isUnrecognised, where these two lived as one inline pattern.
// Split because the type label needs to say "Make-ready" and "Other" apart,
// and because one rule in two places is how they drift. isUnrecognised still
// tests both, so this is a rename, not a behaviour change — asserted in
// test/inspection-type.test.js rather than trusted.
const MAKE_READY_NAME = /make[\s-]*ready/i;
const ROUTINE_NAME = /monthly|management|annual|renewal/i;

// THE ONE NEW RULE, AND IT IS NEW. Jay asked for a Move-in category and there
// was no existing regex to derive it from: not WALK_NAME, not FAS_NAME, not
// the make-ready pattern, and the name buckets probed 2026-10-26 (make-ready
// 77, damage/occupancy 163, FAS 56, untitled 42, other 301) had no move-in
// bucket either. So this is the only pattern here not read off the live data.
// It is tested AFTER the walk check, so a name containing "move out" can
// never reach it. If it earns nothing on real rows, delete it and the
// category with it rather than leaving a label nothing can be.
const MOVE_IN_NAME = /move[\s-]*in/i;

// DISPLAY ONLY. Six labels for a human reading a row, derived from the NAME
// and nothing else — no opts, no turn id, no status — so it cannot see what
// matching sees and cannot be mistaken for evidence. isWalk() takes a turn id
// and this deliberately does not: a turn-linked inspection named "Untitled"
// IS the walk for matching and still reads "Untitled" here, which is the
// honest thing for the screen to say.
//
// ORDER IS THE RULE. A name like "FAS move out occupancy" satisfies two
// patterns; the sequence below decides, and the test asserts the sequence
// rather than one example of it.
const INSPECTION_TYPES = ['Move-out walk', 'Make-ready', 'FAS', 'Move-in', 'Untitled', 'Other'];

function inspectionType(row) {
  const name = clean(row && row.inspection_name);
  // Blank AND the literal "Untitled" AppFolio writes on 34 rows. Both mean
  // the same thing to a reader: nobody named it.
  if (!name || /^untitled$/i.test(name)) return 'Untitled';
  if (WALK_NAME.test(name)) return 'Move-out walk';
  if (FAS_NAME.test(name)) return 'FAS';
  if (MAKE_READY_NAME.test(name)) return 'Make-ready';
  if (MOVE_IN_NAME.test(name)) return 'Move-in';
  return 'Other';
}

// ---- DECISIONS TAKEN, FOR WHEN THE FOURTH STATE IS BUILT -------------------
//
// NOT BUILT. Jay and Bekah have not decided how inspections will be recorded,
// and a fourth state ("probably done under another name") is a patch over that
// decision. These are written down because they were paid for in Erick's time
// and would otherwise be re-litigated.
//
// Erick opened the four inspections dated BEFORE their move-out, 2026-10-16:
//
//   Highlander 114 (05/12), Highlander 106 (07/27), Chateau 113 (06/17)
//     NOT move-out walks. They use the Make Ready template — "General Make
//     Ready Items", Kitchen, Appliances, Resurfacing — and belong to the
//     PREVIOUS make ready. The date rule was right to exclude them.
//
//   HPS 114 (07/22, named "unidad 114", 72 photos)
//     IS the move-out walk. The unit was handed back early: rent ready on
//     08/20, six days after the official move-out of 08/14.
//
// So: keep the date rule, and treat HPS 114 as a manual exception. Do NOT widen
// the window for one case — three of the four say the rule is working, and a
// window stretched to catch the fourth would readmit the three.
//
// AND EXCLUDE MAKE-READY INSPECTIONS AS WALKS. isUnrecognised() already drops
// anything whose NAME says make ready, so those three were never offered as a
// maybe-walk. THE LIMIT IS THAT IT READS THE NAME: inspection_detail returns no
// template column (14 columns, probed 2026-10-14), so a make-ready inspection
// named "Andres luevano" is indistinguishable from a walk named the same. That
// is the gap the fourth state would inherit, and the reason the right fix is
// upstream in how AppFolio records these.
//
// Footnote worth keeping: HPS 114 has 72 photos and the API cannot see one of
// them. "Inspection done" still says nothing about whether a charge is
// evidenced.

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
  const name = clean(row && row.inspection_name);
  return !isWalk(row, opts) && !isFas(row)
    && !MAKE_READY_NAME.test(name) && !ROUTINE_NAME.test(name);
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
    // THE MIDDLE STATE. An inspection exists for this turn and nobody marked
    // it done, which is a different job from doing the walk.
    //
    // WHAT IT IS NOT IS "ALREADY WALKED, JUST CLOSE IT". Erick opened all the
    // open move-out inspections on 2026-10-14 and every one was EMPTY — no
    // areas, no photos. In twenty of those units the real walk was recorded in
    // a DIFFERENT inspection, under a technician's name or "Untitled". So the
    // unrecognised inspections on the unit are attached here, exactly as they
    // are on 'none': they are the evidence of the walk that did happen, and
    // leaving them out hides it precisely where somebody is deciding whether
    // to close an empty record.
    return state('open', {
      basis: 'turn', turnId, open: linked[0],
      unnamed: onUnit.filter(r => isUnrecognised(r)),
    });
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
  if (openNamed) {
    return state('open', {
      basis: 'name', turnId, open: openNamed,
      unnamed: onUnit.filter(r => isUnrecognised(r)),
    });
  }

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

/**
 * EVERY move-out in a window with its state — not only the overdue ones.
 *
 * Maintenance needs the whole picture: Erick is the person who closes an
 * inspection or sends somebody back to a unit, and a list of only the failures
 * cannot be checked against the ones that went fine. walkOverdue() answers
 * "what needs chasing today"; this answers "where does every move-out stand".
 *
 * NO BALANCE, NO DELINQUENCY, NOT EVER. This is built for the Maintenance tab,
 * which Erick holds and Collections is not. The fields are the ones a
 * maintenance conversation needs and nothing else — adding a balance here
 * because it was convenient is how a tab's audience stops meaning anything.
 */
function register(src, todayCT, opts) {
  const o = opts || {};
  const days = o.days == null ? 60 : o.days;
  const from = WEEK.addDaysYMD(todayCT, -days);
  const dueDays = o.businessDays == null ? 2 : o.businessDays;
  const { byUnit, byTurn } = indexInspections((src || {}).inspections);
  const out = [];

  (((src || {}).turns) || []).forEach(t => {
    const moveOut = ymd(t.move_out_date);
    if (!isYmd(moveOut) || moveOut > todayCT || moveOut < from) return;
    const property = clean(t.property_name || t.property);
    const unit = clean(t.unit || t.unit_name);
    if (!property) return;

    const m = matchWalk({ turn: t, byTurn, byUnit, property, unit, moveOut });
    const found = m.walk || m.open || null;
    out.push({
      property, unit, moveOut,
      businessDaysSince: WEEK.businessDaysBetween(moveOut, todayCT),
      due: WEEK.addBusinessDays(moveOut, dueDays),
      state: m.state,
      // The inspection we found, whichever state it is in. Naming it is what
      // lets somebody open it in AppFolio instead of searching for it.
      inspectionName: found ? (clean(found.inspection_name) || '(no name)') : null,
      inspectionDate: found ? inspectedOn(found) : null,
      inspectionStatus: found ? clean(found.status) : null,
      basis: m.basis,
      turnId: m.turnId || null,
      unnamedCount: (m.unnamed || []).length,
      tooEarlyCount: (m.tooEarly || []).length,
    });
  });

  out.sort((a, b) => String(b.moveOut).localeCompare(String(a.moveOut))
    || a.property.localeCompare(b.property));
  return out;
}

// What the register says, in words, for a reader who wants the sentence.
const STATE_LABEL = {
  done: 'Inspection done',
  open: 'Inspection exists, not marked done',
  none: 'No inspection recorded',
};

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
  // NOT "just close it". Every open move-out inspection Erick checked on
  // 2026-10-14 was empty, so closing one records a walk that never happened in
  // that record — and it is the record a charge to a resident rests on.
  if (a.state === 'open') {
    bits.push('Erick checked the open ones on 2026-10-14 and all were empty — '
      + 'check it before closing it');
  }
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


// ---------------------------------------------------------------------------
// KARLA'S VIEW. Four states, and a link that opens the right inspection.
//
// She opens the official move-out inspection, finds nothing, and cannot find
// the photos she needs to charge a deposit. The Inspections tab in AppFolio
// does not open on a unit, so today that is a manual search.
//
// THE FOURTH STATE IS THE POINT. matchWalk already collects the unrecognised
// inspections on the unit — a technician's name, "Untitled" — because they
// are the evidence of the walk that did happen. Until now they were an
// attachment on a failure; here one of them that is DONE and dated on or
// after the move-out becomes a state of its own, with its name, because that
// is the record Karla actually wants to open.
//
// ORDER: done_elsewhere beats empty. If the official inspection is empty AND
// somebody really walked it under another name, the walk is the answer —
// `officialEmpty` still says the official one needs closing.
// How many other inspections on the unit a row offers before it stops being
// a shortlist. Five is what fits beside a row without pushing the next one
// off the screen.
const ALSO_ON_UNIT_MAX = 5;

const COLLECTIONS_STATES = ['complete', 'done_elsewhere', 'empty', 'none'];

const COLLECTIONS_LABEL = {
  complete: 'Complete',
  done_elsewhere: 'Done under another name',
  empty: 'Empty (not completed)',
  none: 'No inspection',
};

// VERIFIED, NOT GUESSED. Arturo opened inspection 1393 and the address is
// https://metricpropertymanagement.appfolio.com/inspections/1393 — so the key
// is inspection_id. That row also carries unit_id 1898 and property_id 26,
// and neither appears in the URL: picking either would have produced a link
// that opens somebody else's inspection rather than a 404, which is worse.
const APPFOLIO_HOST = 'metricpropertymanagement';

function inspectionUrl(row, host) {
  const id = clean(row && (row.inspection_id || row.id));
  // Digits only: the id goes into a path, and a row with a missing or odd id
  // gets no link rather than a link to nothing.
  if (!/^[0-9]+$/.test(id)) return null;
  return 'https://' + (host || APPFOLIO_HOST) + '.appfolio.com/inspections/' + id;
}

function describeInspection(row, host) {
  if (!row) return null;
  return {
    id: clean(row.inspection_id) || null,
    name: clean(row.inspection_name) || '(no name)',
    date: inspectedOn(row),
    status: clean(row.status) || null,
    markedDoneBy: clean(row.marked_done_by) || null,
    // Who created it, which is a different person from who closed it often
    // enough to matter: a "Done under another name" row exists precisely
    // because the walk is filed under somebody's name, and until now the row
    // did not say whose. Null where the column is absent — a row synced before
    // migration 115 says nothing rather than implying nobody created it.
    createdBy: clean(row.created_by) || null,
    // What KIND of inspection this is, from its name. Display only — it rides
    // on the description so every inspection the screen shows carries it, and
    // it is computed here rather than in the client so there is one set of
    // rules rather than two. Nothing in matching reads it.
    type: inspectionType(row),
    url: inspectionUrl(row, host),
  };
}

/**
 * Every move-out in the window, with the inspection state Collections needs.
 *
 * @param {object} src   { turns, inspections }
 * @param {string} todayCT
 * @param {object} opts  { days = 90, host }
 */
function collectionsView(src, todayCT, opts) {
  const o = opts || {};
  const days = o.days == null ? 90 : o.days;
  const host = o.host || APPFOLIO_HOST;
  const from = WEEK.addDaysYMD(todayCT, -days);
  const { byUnit, byTurn } = indexInspections((src || {}).inspections);

  const rows = [];
  const counts = { complete: 0, done_elsewhere: 0, empty: 0, none: 0 };
  // A MOVE-OUT WE COULD NOT LOOK UP IS NOT A MOVE-OUT WITH NO INSPECTION.
  // 83 of 110 recent inspections carry no unit_turn_id and 10 carry no unit
  // at all, so some of these will read "No inspection" when a walk exists and
  // nothing could tie it here. Counted and shown, never folded into `none`.
  let unmatchable = 0;

  (((src || {}).turns) || []).forEach(t => {
    const moveOut = ymd(t.move_out_date);
    if (!isYmd(moveOut) || moveOut > todayCT || moveOut < from) return;
    const property = clean(t.property_name || t.property);
    const unit = clean(t.unit || t.unit_name);
    if (!property) return;

    const m = matchWalk({ turn: t, byTurn, byUnit, property, unit, moveOut });
    const onOrAfter = r => inspectedOn(r) && inspectedOn(r) >= moveOut;
    const elsewhere = (m.unnamed || []).filter(r => DONE.test(clean(r.status)) && onOrAfter(r));

    let status;
    let open;
    if (m.state === 'done') { status = 'complete'; open = m.walk; }
    else if (elsewhere.length) { status = 'done_elsewhere'; open = elsewhere[0]; }
    else if (m.state === 'open') { status = 'empty'; open = m.open; }
    else { status = 'none'; open = null; }

    // Nothing to search by: no unit and no turn id means the lookup could not
    // be made, whatever it returned.
    const noKeys = !unit && !turnOf(t);
    if (noKeys) unmatchable++;
    // And whatever it DID return came from matching an empty unit against
    // other empty units, so it is not evidence about this move-out.
    if (noKeys) { status = 'none'; open = null; }

    counts[status]++;
    rows.push({
      property, unit, moveOut,
      status,
      label: COLLECTIONS_LABEL[status],
      // The one to open. For done_elsewhere this is the walk somebody really
      // did, which is the whole reason the state exists.
      inspection: describeInspection(open, host),
      // The official move-out inspection, when there is one, so a row can say
      // "the walk is here AND the official one still needs closing".
      officialEmpty: m.state === 'open' ? describeInspection(m.open, host) : null,
      // Other candidates, for a row where the first guess is not the right one.
      //
      // NOT WHEN THERE IS NOTHING TO TIE THEM TO. A turn with no unit matches
      // every unit-less inspection at that property — on real data one such
      // row offered twenty-nine candidates going back to 2025, which is not a
      // shortlist, it is the manual search this screen exists to replace.
      //
      // CAPPED, AND THE REMAINDER COUNTED. A long list buries the one that
      // matters, and silently truncating it would hide that there are more.
      alsoOnUnit: noKeys ? [] : (m.unnamed || []).filter(r => r !== open)
        .slice(0, ALSO_ON_UNIT_MAX).map(r => describeInspection(r, host)),
      alsoOnUnitMore: noKeys ? 0
        : Math.max(0, (m.unnamed || []).filter(r => r !== open).length - ALSO_ON_UNIT_MAX),
      basis: m.basis,
      turnId: m.turnId || null,
      // Said per row as well as counted, so a "No inspection" that nobody
      // could have matched is not read as a unit nobody walked.
      unmatchable: noKeys,
    });
  });

  rows.sort((a, b) => String(b.moveOut).localeCompare(String(a.moveOut)));

  // HOW MANY OF THE INSPECTIONS ON THIS SCREEN NOBODY NAMED USEFULLY.
  //
  // Counted over the inspections these rows actually SHOW, not over all 643
  // in the table — the screen can only honestly report the denominator it is
  // displaying, and the full-table buckets are a probe's job. Deduped by
  // inspection id, because one inspection can appear as another row's
  // `alsoOnUnit`; an inspection with no usable id is counted once on its own
  // rather than dropped, since dropping it would quietly shrink the total.
  const typeCounts = {};
  INSPECTION_TYPES.forEach(k => { typeCounts[k] = 0; });
  const seen = new Set();
  let anon = 0;
  rows.forEach(r => {
    [r.inspection, r.officialEmpty].concat(r.alsoOnUnit || []).forEach(d => {
      if (!d) return;
      const key = d.id ? 'id:' + d.id : 'anon:' + (anon++);
      if (seen.has(key)) return;
      seen.add(key);
      if (typeCounts[d.type] == null) typeCounts[d.type] = 0;
      typeCounts[d.type]++;
    });
  });

  return { rows, counts, unmatchable, days, from, to: todayCT, typeCounts, typeTotal: seen.size };
}
module.exports = {
  WALK_NAME, FAS_NAME, MAKE_READY_NAME, ROUTINE_NAME, MOVE_IN_NAME, DONE,
  INSPECTION_TYPES, inspectionType,
  isWalk, isFas, isUnrecognised, unitKey, indexInspections, turnIdOf, turnOf, matchWalk,
  register, STATE_LABEL,
  STATES,
  belongsToTurn, inspectedOn,
  moveOutsOn, walkOverdue, line, clean, ymd, isYmd,
  collectionsView, COLLECTIONS_STATES, COLLECTIONS_LABEL, inspectionUrl,
  describeInspection, APPFOLIO_HOST,
};
