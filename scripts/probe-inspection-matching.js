#!/usr/bin/env node
//
// Would the three proposed rules change anything, and by how much?
//
//   node scripts/probe-inspection-matching.js
//   node scripts/probe-inspection-matching.js --days 90 --back 30 --fwd 90
//
// READ ONLY. One cached AppFolio report read and one Supabase select. Nothing
// is written to either. Run it after 6 PM CT with the other two probes.
//
// WHY. Arturo checked the live Collections view against AppFolio on
// 2026-10-22 and found three things:
//
//   1. inspected_on is not reliable (inspection 1394, Highlander 116).
//   2. One inspection is claimed by two move-outs (1368, Hyde Park 117).
//   3. "Done under another name" can be a make-ready checklist, not a damage
//      walk (1445, Hyde Park 112).
//
// The proposal is: prefer created_on for the date, accept a name-matched
// inspection only inside [move-out - BACK, move-out + FWD], and give each
// inspection to the closest move-out only. ALL THREE ARE UNBUILT. This probe
// measures what they would do before any of them is written into lib/, because
// "it fixed the row I looked at" and "it is right" are different claims and
// only the second one is worth shipping.
//
// WHAT IT PRINTS. Counts, transitions between states, and column names.
// NOTHING ELSE. These rows carry residents, units and free-text notes; a probe
// that prints "a couple of examples so we can see" is how a resident's name
// reaches a terminal and then a chat window.
//
// THE CANDIDATE RULES ARE COPIED HERE, NOT IMPORTED. lib/moveout-alerts.js is
// deliberately unchanged — fix #3 waits for this output. The copy below is a
// measuring instrument with a short life. If a rule ships it ships in the lib,
// with its own tests, and this file stops mattering.
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

// PostgREST caps a plain select at 1000 rows whatever limit is asked for, and
// a capped read is a plausible short answer rather than an error.
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

const clean = MO.clean;
const ymd = MO.ymd;
const isYmd = MO.isYmd;
const pad = (s, w) => String(s).padEnd(w);
const bar = n => '='.repeat(n);

// ---- the candidate date rule --------------------------------------------------
//
// Today: inspected_on, then marked_done_on. created_on is explicitly NOT used,
// on the reasoning that when a record was created says nothing about when
// somebody walked the unit. 1394 is the counter-example: the walk is real and
// inspected_on is not where it says it is.
function dateNow(r) { return MO.inspectedOn(r); }
function dateCandidate(r) {
  const c = ymd(r && r.created_on);
  if (isYmd(c)) return c;
  return MO.inspectedOn(r);
}

(async () => {
  const af = require('../appfolio-reports.js');
  const turnsAll = ((await af.readReportData('unit_turn_detail')) || {}).rows || [];
  const inspections = await selectAll(() => db.from('maintenance_inspections')
    .select('inspection_id,inspection_name,property_name,unit,status,marked_done_on,'
      + 'marked_done_by,created_on,inspected_on,unit_turn_id'), 'inspections');

  if (!turnsAll.length || !inspections.length) {
    console.log('turns: ' + turnsAll.length + '   inspections: ' + inspections.length);
    console.log('One of the two sources is empty. NOTHING can be concluded from this run —');
    console.log('an empty source produces exactly the same output as "no problems found".');
    process.exitCode = 1;
    return;
  }

  const from = WEEK.addDaysYMD(TODAY, -DAYS);
  const inWindow = t => {
    const d = ymd(t.move_out_date);
    return isYmd(d) && d <= TODAY && d >= from;
  };
  const turns = turnsAll.filter(inWindow);

  console.log(bar(70));
  console.log('move-out inspection matching — ' + TODAY + ', last ' + DAYS + ' days');
  console.log(bar(70));
  console.log('move-outs in window : ' + turns.length);
  console.log('inspections in table: ' + inspections.length);
  console.log('');

  // ---- 1. the date column ------------------------------------------------------
  console.log(bar(70));
  console.log('1. THE DATE COLUMN — how often do the two rules disagree?');
  console.log(bar(70));
  const dateStats = {
    'has inspected_on': 0,
    'has marked_done_on': 0,
    'has created_on': 0,
    'no date of any kind': 0,
    'created_on only (inspected_on empty)': 0,
    'the two rules give the SAME day': 0,
    'they differ by 1-7 days': 0,
    'they differ by 8-30 days': 0,
    'they differ by more than 30 days': 0,
  };
  const dayGap = (a, b) => Math.abs(
    (Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
  inspections.forEach(r => {
    const i = ymd(r.inspected_on), m = ymd(r.marked_done_on), c = ymd(r.created_on);
    if (isYmd(i)) dateStats['has inspected_on']++;
    if (isYmd(m)) dateStats['has marked_done_on']++;
    if (isYmd(c)) dateStats['has created_on']++;
    if (!isYmd(i) && !isYmd(m) && !isYmd(c)) dateStats['no date of any kind']++;
    if (isYmd(c) && !isYmd(i)) dateStats['created_on only (inspected_on empty)']++;
    const a = dateNow(r), b = dateCandidate(r);
    if (!a || !b) return;
    const g = dayGap(a, b);
    if (g === 0) dateStats['the two rules give the SAME day']++;
    else if (g <= 7) dateStats['they differ by 1-7 days']++;
    else if (g <= 30) dateStats['they differ by 8-30 days']++;
    else dateStats['they differ by more than 30 days']++;
  });
  Object.keys(dateStats).forEach(k =>
    console.log('  ' + pad(k, 42) + dateStats[k] + '/' + inspections.length));
  console.log('');
  console.log('  A large "SAME day" count does NOT mean the change is safe — it means');
  console.log('  the change is mostly invisible, which is a different thing. The rows');
  console.log('  that matter are the ones that differ, and section 2 prices them.');
  console.log('');

  // ---- 2. what actually changes on screen ---------------------------------------
  console.log(bar(70));
  console.log('2. THE SCREEN — how many rows change state under each rule?');
  console.log(bar(70));

  const baseline = MO.collectionsView({ turns: turnsAll, inspections }, TODAY, { days: DAYS });
  const keyOf = r => r.property.toLowerCase() + '|' + r.unit.toLowerCase() + '|' + r.moveOut;
  const baseBy = new Map(baseline.rows.map(r => [keyOf(r), r]));

  console.log('  baseline (what the live screen shows today):');
  MO.COLLECTIONS_STATES.forEach(s =>
    console.log('    ' + pad(s, 16) + baseline.counts[s]));
  console.log('    ' + pad('unmatchable', 16) + baseline.unmatchable);
  console.log('');

  // The candidate run, with the date rule swapped and a window on the name pass.
  // Built by re-deriving the state from the lib's own index so the only things
  // that differ are the two rules under test.
  function candidateView(opts) {
    const useCreated = !!opts.created;
    const windowed = !!opts.windowed;
    const dateOf = useCreated ? dateCandidate : dateNow;
    const { byUnit, byTurn } = MO.indexInspections(inspections);
    const rows = [];
    turns.forEach(t => {
      const moveOut = ymd(t.move_out_date);
      const property = clean(t.property_name || t.property);
      const unit = clean(t.unit || t.unit_name);
      if (!property) return;
      const turnId = MO.turnOf(t);
      const linked = turnId ? (byTurn.get(turnId) || []) : [];
      const onUnit = byUnit.get(MO.unitKey(property, unit)) || [];
      const done = r => MO.DONE.test(clean(r.status));

      // The window replaces the bare "on or after the move-out" test. A walk
      // dated four months after the move-out is not this move-out's walk, and
      // today nothing says so.
      const lo = WEEK.addDaysYMD(moveOut, -BACK);
      const hi = WEEK.addDaysYMD(moveOut, FWD);
      const inRange = r => {
        const d = dateOf(r);
        if (!d) return false;
        return windowed ? (d >= lo && d <= hi) : d >= moveOut;
      };

      // THE BRANCH ORDER IS THE BASELINE'S, EXACTLY. collectionsView tests
      // done_elsewhere BEFORE the linked-but-open case, so a unit with an open
      // official inspection and a real walk recorded elsewhere reads
      // done_elsewhere. An earlier version of this probe tested linked-open
      // first and reported the resulting differences as an effect of the date
      // rule — the probe would have been measuring itself.
      const named = onUnit.filter(r => MO.WALK_NAME.test(clean(r.inspection_name)));
      const elsewhere = onUnit.filter(r => MO.isUnrecognised(r) && done(r) && inRange(r));
      const openNamed = named.find(r => !done(r));
      const namedWalk = named.filter(done).find(inRange);

      let status = 'none', chosen = null;
      if (linked.find(done)) { status = 'complete'; chosen = linked.find(done); }
      else if (namedWalk && !linked.length) { status = 'complete'; chosen = namedWalk; }
      else if (elsewhere.length) { status = 'done_elsewhere'; chosen = elsewhere[0]; }
      else if (linked.length) { status = 'empty'; chosen = linked[0]; }
      else if (openNamed) { status = 'empty'; chosen = openNamed; }
      if (!unit && !turnId) { status = 'none'; chosen = null; }
      rows.push({ property, unit, moveOut, status, chosen });
    });
    return rows;
  }

  const VARIANTS = [
    { label: 'created_on for the date, window unchanged', created: true, windowed: false },
    { label: 'window [-' + BACK + ', +' + FWD + '], date unchanged', created: false, windowed: true },
    { label: 'both together (the proposal)', created: true, windowed: true },
  ];

  VARIANTS.forEach(v => {
    const rows = candidateView(v);
    const moves = new Map();
    let changed = 0;
    rows.forEach(r => {
      const b = baseBy.get(keyOf(r));
      if (!b) return;
      if (b.status !== r.status) {
        changed++;
        const k = b.status + ' -> ' + r.status;
        moves.set(k, (moves.get(k) || 0) + 1);
      }
    });
    console.log('  ' + v.label);
    console.log('    rows that change state: ' + changed + ' of ' + rows.length);
    if (!moves.size) console.log('      (none)');
    [...moves.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log('      ' + pad(k, 34) + n));
    console.log('');
  });
  console.log('  THE WINDOW CUTS BOTH WAYS. [-' + BACK + ', +' + FWD + '] reaches BACK before the');
  console.log('  move-out, so it can hand a second move-out on the same unit a walk that');
  console.log('  belongs to the first — the window rule can CREATE double claims as well');
  console.log('  as remove them. Read section 3 against the "-> complete" counts here.');
  console.log('');
  console.log('  A transition INTO complete is a row that was wrongly shouting.');
  console.log('  A transition OUT of complete is a row that was wrongly quiet, which is');
  console.log('  the worse of the two and the number to read first.');
  console.log('');

  // ---- 3. one inspection, two move-outs ------------------------------------------
  console.log(bar(70));
  console.log('3. DOUBLE CLAIMS — one inspection shown against more than one move-out');
  console.log(bar(70));
  const claims = new Map();
  baseline.rows.forEach(r => {
    const id = r.inspection && r.inspection.id;
    if (!id) return;
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push(r.moveOut);
  });
  const doubled = [...claims.entries()].filter(([, v]) => v.length > 1);
  console.log('  inspections shown on the screen : ' + claims.size);
  console.log('  claimed by 2 or more move-outs  : ' + doubled.length);
  const spread = {};
  doubled.forEach(([, dates]) => {
    const sorted = [...dates].sort();
    const g = dayGap(sorted[0], sorted[sorted.length - 1]);
    const b = g <= 7 ? '<= 7 days apart' : g <= 60 ? '8-60 days apart' : '> 60 days apart';
    spread[b] = (spread[b] || 0) + 1;
  });
  Object.keys(spread).forEach(k => console.log('    ' + pad(k, 22) + spread[k]));
  console.log('');
  console.log('  "Closest move-out wins" only helps where the move-outs are far apart.');
  console.log('  Two move-outs a week apart on one unit are a re-let, and the closest');
  console.log('  one is a coin toss — those need the turn id, not a date comparison.');
  console.log('');

  // ---- 4. units with more than one turn -------------------------------------------
  console.log(bar(70));
  console.log('4. RE-LETS — units with more than one turn in the window');
  console.log(bar(70));
  const byUnitTurns = new Map();
  turns.forEach(t => {
    const k = MO.unitKey(clean(t.property_name || t.property), clean(t.unit || t.unit_name));
    if (!byUnitTurns.has(k)) byUnitTurns.set(k, []);
    byUnitTurns.get(k).push(ymd(t.move_out_date));
  });
  const multi = [...byUnitTurns.values()].filter(v => v.length > 1);
  console.log('  distinct units with a move-out : ' + byUnitTurns.size);
  console.log('  units with more than one turn  : ' + multi.length);
  const withTurnId = turns.filter(t => MO.turnOf(t)).length;
  console.log('  move-outs carrying a turn id   : ' + withTurnId + '/' + turns.length);
  console.log('');
  console.log('  The second number is the ceiling on what any date rule can fix. Where');
  console.log('  a unit turned twice and neither turn carries an id, nothing in the');
  console.log('  data distinguishes the two walks and the honest answer is to say so');
  console.log('  on the row rather than to pick one.');
  console.log('');

  // ---- 5. is there a template column at all? ---------------------------------------
  console.log(bar(70));
  console.log('5. TYPE / TEMPLATE — can a make-ready be told from a damage walk?');
  console.log(bar(70));
  const cols = Object.keys(inspections[0] || {});
  console.log('  columns the table has: ' + cols.join(', '));
  console.log('  (what inspection_detail RETURNS is the other probe — a column the');
  console.log('   sync never kept is invisible here and present there.)');
  console.log('');
  // Names grouped BY PATTERN, never printed. A free-text field holds people's
  // names; "Andres luevano" is 31 rows of somebody's name, not a category.
  const patterns = {
    'move-out damage / occupancy': /move[\s-]*out.*(damage|occupancy)/i,
    'make ready / turn / punch': /make[\s-]*ready|turn[\s-]*over|punch/i,
    'FAS / final account': /fas|final account/i,
    'move-in': /move[\s-]*in/i,
    'untitled / blank': /^\s*$|untitled/i,
  };
  const seen = new Array(inspections.length).fill(false);
  Object.keys(patterns).forEach(label => {
    let n = 0;
    inspections.forEach((r, i) => {
      if (seen[i]) return;
      if (patterns[label].test(clean(r.inspection_name))) { seen[i] = true; n++; }
    });
    console.log('  ' + pad(label, 30) + n);
  });
  console.log('  ' + pad('matches none of the above', 30) + seen.filter(x => !x).length);
  console.log('');
  console.log('  If "make ready" is a real bucket here, the make-ready/damage confusion');
  console.log('  is separable from the NAME and needs no new column. If it is near zero,');
  console.log('  the name does not carry it and the row has to say "type not recorded".');
  console.log('');

  console.log(bar(70));
  console.log('Nothing was written. No name, unit, address or free-text value was printed.');
  console.log(bar(70));
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
