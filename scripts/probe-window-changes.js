#!/usr/bin/env node
//
// WHICH move-outs does the wider date window change, and to what?
// READ ONLY — reads Supabase and the cached unit_turn_detail file. No AppFolio
// request, no write anywhere.
//
//   node scripts/probe-window-changes.js            # [-30, +90]
//   node scripts/probe-window-changes.js --back 30 --fwd 90 --days 90
//
// WHY THIS EXISTS. The earlier probe reported that the [-30, +90] window moves
// 4 of 58 rows and said so in counts, which is the right output for a privacy
// question and the wrong one for a decision. Jay has to open those units and
// say whether they are move-out walks or Make Ready records from the previous
// tenancy — and for that he needs the property, the unit and a link.
//
// THE RISK THIS IS CHECKING. Of the four pre-move-out inspections Erick opened
// on 2026-10-16, THREE were Make Ready and only one was a real walk. They are
// excluded today because isUnrecognised() reads "make ready" in the NAME, and
// inspection_detail has no template column — so a make-ready inspection named
// after a technician is indistinguishable from a walk. Widening the window to
// -30 days lets that whole class back in. These rows are where it would land.
//
// IT MUST NOT MEASURE ITSELF. The candidate below is a copy of matchWalk and
// collectionsView with ONE expression changed: the date test. A copy can drift
// from the original and then the diff describes the copy. So before printing
// anything, the copy is run with the CURRENT rule (back=0, forward=unbounded)
// and required to reproduce the real collectionsView state for every row. If it
// does not, this exits without a comparison rather than offering one that is
// about the wrong code.
//
// NOTHING PERSONAL IS PRINTED. Property, unit, move-out date, inspection id,
// status and the inspection's own name — which is a technician's name or
// "Untitled", never a resident's. No resident, no amount, no occupancy id.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const WEEK = require('../lib/week.js');
const MO = require('../lib/moveout-alerts.js');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};
const TODAY = arg('today', WEEK.todayYMD());
const DAYS = Number(arg('days', 90));
const BACK = Number(arg('back', 30));
const FWD = Number(arg('fwd', 90));

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// PostgREST caps a plain select at 1000 rows whatever limit is asked for, and a
// capped read is a plausible short answer rather than an error.
async function selectAll(build, label) {
  const page = 1000;
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await build().range(from, from + page - 1);
    if (r.error) throw new Error(label + ': ' + r.error.message);
    out.push(...(r.data || []));
    if ((r.data || []).length < page) break;
  }
  return out;
}

const { clean, ymd, isYmd, DONE, isUnrecognised, indexInspections,
  unitKey, turnOf, inspectedOn, describeInspection, WALK_NAME } = MO;
const pad = (s, w) => String(s).padEnd(w);
const bar = n => '='.repeat(n);
// week.js has addDaysYMD and businessDaysBetween but no plain calendar gap.
const daysApart = (a, b) =>
  Math.round((WEEK.ymdToUTC(b) - WEEK.ymdToUTC(a)) / 86400000);

// ---- the candidate ---------------------------------------------------------
//
// matchWalk + collectionsView, with the date test lifted out as `inWin`. Every
// other branch and its ORDER is copied as-is: the order is what decides the
// state when more than one branch could fire, so a reordering here would show
// up as a window effect that is really a copying error.
function candidateState({ turn, byTurn, byUnit, property, unit, moveOut, inWin }) {
  const turnId = turnOf(turn);
  const linked = turnId ? (byTurn.get(turnId) || []) : [];
  const onUnit = byUnit.get(unitKey(property, unit)) || [];
  const done = r => DONE.test(clean(r.status));

  // pass 1 — the turn's own inspections, date irrelevant.
  const linkedDone = linked.find(done);
  let state, walk, open = null;
  if (linkedDone) { state = 'done'; walk = linkedDone; }
  else if (linked.length) { state = 'open'; open = linked[0]; }
  else {
    // pass 2 — by name, where the date is all there is.
    const named = onUnit.filter(r => WALK_NAME.test(clean(r.inspection_name)));
    const namedDone = named.filter(done);
    const namedWalk = namedDone.find(r => inWin(r, moveOut));
    if (namedWalk) { state = 'done'; walk = namedWalk; }
    else {
      const openNamed = named.find(r => !done(r));
      if (openNamed) { state = 'open'; open = openNamed; }
      else { state = 'none'; }
    }
  }
  const unnamed = onUnit.filter(r => isUnrecognised(r));

  // ---- collectionsView's own branch, same order ----------------------------
  const elsewhere = unnamed.filter(r => DONE.test(clean(r.status)) && inWin(r, moveOut));
  let status, chosen;
  if (state === 'done') { status = 'complete'; chosen = walk; }
  else if (elsewhere.length) { status = 'done_elsewhere'; chosen = elsewhere[0]; }
  else if (state === 'open') { status = 'empty'; chosen = open; }
  else { status = 'none'; chosen = null; }

  // Nothing to search by: whatever the lookup returned came from matching an
  // empty unit against other empty units.
  if (!unit && !turnOf(turn)) { status = 'none'; chosen = null; }
  return { status, chosen };
}

function candidateRows(turns, byTurn, byUnit, inWin) {
  const from = WEEK.addDaysYMD(TODAY, -DAYS);
  const rows = [];
  turns.forEach(t => {
    const moveOut = ymd(t.move_out_date);
    if (!isYmd(moveOut) || moveOut > TODAY || moveOut < from) return;
    const property = clean(t.property_name || t.property);
    const unit = clean(t.unit || t.unit_name);
    if (!property) return;
    const r = candidateState({ turn: t, byTurn, byUnit, property, unit, moveOut, inWin });
    rows.push({ property, unit, moveOut, status: r.status, chosen: r.chosen });
  });
  return rows;
}

const keyOf = r => r.property + '|' + r.unit + '|' + r.moveOut;

(async () => {
  const af = require('../appfolio-reports.js');
  const turns = ((await af.readReportData('unit_turn_detail')) || {}).rows || [];
  const inspections = await selectAll(() => db.from('maintenance_inspections')
    .select('inspection_id,inspection_name,property_name,unit,status,marked_done_on,'
      + 'marked_done_by,created_on,inspected_on,unit_turn_id'), 'inspections');

  if (!turns.length || !inspections.length) {
    console.log('turns: ' + turns.length + '   inspections: ' + inspections.length);
    console.log('One source is empty. NOTHING can be concluded — an empty source');
    console.log('produces exactly the same output as "no rows changed".');
    console.log('(unit_turn_detail is synced to DATA_DIR; run this on Render.)');
    process.exitCode = 1;
    return;
  }

  const { byUnit, byTurn } = indexInspections(inspections);

  // The real thing.
  const real = MO.collectionsView({ turns, inspections }, TODAY, { days: DAYS });
  const realBy = new Map(real.rows.map(r => [keyOf(r), r]));

  // ---- the self-check ------------------------------------------------------
  const CURRENT = (r, moveOut) => { const d = inspectedOn(r); return !!d && d >= moveOut; };
  const mirror = candidateRows(turns, byTurn, byUnit, CURRENT);
  const drift = mirror.filter(m => {
    const r = realBy.get(keyOf(m));
    return !r || r.status !== m.status;
  });
  if (mirror.length !== real.rows.length || drift.length) {
    console.log(bar(70));
    console.log('ABORTED — the copy no longer reproduces collectionsView.');
    console.log(bar(70));
    console.log('rows: real ' + real.rows.length + ', copy ' + mirror.length
      + '; disagreements: ' + drift.length);
    drift.slice(0, 10).forEach(m => {
      const r = realBy.get(keyOf(m));
      console.log('  ' + pad(m.property + ' ' + m.unit, 34)
        + 'real ' + pad(r ? r.status : '(absent)', 16) + 'copy ' + m.status);
    });
    console.log('\nThe candidate below differs from the live rule in more than the');
    console.log('date test, so any diff it produced would be about this file and');
    console.log('not about the window. Fix the copy before trusting a comparison.');
    process.exitCode = 1;
    return;
  }

  // ---- the comparison ------------------------------------------------------
  const WIDE = (r, moveOut) => {
    const d = inspectedOn(r);
    if (!d) return false;
    return d >= WEEK.addDaysYMD(moveOut, -BACK) && d <= WEEK.addDaysYMD(moveOut, FWD);
  };
  const wide = candidateRows(turns, byTurn, byUnit, WIDE);

  console.log(bar(70));
  console.log('WINDOW [-' + BACK + ', +' + FWD + '] — which rows change, and to what');
  console.log(bar(70));
  console.log('as of ' + TODAY + ', move-outs in the last ' + DAYS + ' days');
  console.log('rows compared: ' + wide.length + '   (copy verified against collectionsView)\n');

  const changed = wide.map(w => ({ w, r: realBy.get(keyOf(w)) }))
    .filter(({ w, r }) => r && r.status !== w.status);

  if (!changed.length) {
    console.log('No row changes state. The window buys nothing on this data.');
    return;
  }

  const moves = {};
  changed.forEach(({ w, r }) => {
    const k = r.status + ' -> ' + w.status;
    moves[k] = (moves[k] || 0) + 1;
  });
  console.log(changed.length + ' of ' + wide.length + ' rows change:');
  Object.keys(moves).sort().forEach(k => console.log('   ' + pad(k, 34) + moves[k]));

  console.log('\n' + bar(70));
  console.log('THE ROWS — for Jay: is this a move-out walk, or a Make Ready?');
  console.log(bar(70));
  changed.forEach(({ w, r }, i) => {
    const d = describeInspection(w.chosen, MO.APPFOLIO_HOST);
    console.log('\n' + (i + 1) + '. ' + w.property + '  unit ' + (w.unit || '(none)'));
    console.log('   move-out      ' + w.moveOut);
    console.log('   today         ' + r.status + '  ->  would become  ' + w.status);
    if (!d) { console.log('   inspection    (none)'); return; }
    console.log('   inspection    ' + d.name + '   [' + (d.status || '?') + ']');
    console.log('   inspected on  ' + (d.date || '(no date)')
      + (d.date && d.date < w.moveOut
        ? '   <-- ' + daysApart(d.date, w.moveOut) + ' days BEFORE the move-out'
        : ''));
    if (d.markedDoneBy) console.log('   marked done   ' + d.markedDoneBy);
    console.log('   open          ' + (d.url || '(no link — odd inspection id)'));
  });

  console.log('\n' + bar(70));
  console.log('WHAT JAY IS DECIDING');
  console.log(bar(70));
  console.log('  A MOVE-OUT WALK  -> the window is right and the row should change.');
  console.log('  A MAKE READY     -> it belongs to the PREVIOUS tenancy, and -' + BACK);
  console.log('     days readmits exactly the class the 2026-10-16 note excluded.');
  console.log('     One of these is enough to say the window is the wrong fix.');
  console.log('\nNothing was written. No resident name, amount or occupancy id printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
