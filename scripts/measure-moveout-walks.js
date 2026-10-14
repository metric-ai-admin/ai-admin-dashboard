#!/usr/bin/env node
//
// Of the move-outs in the last N days, how many have an inspection — and HOW
// do we know? READ ONLY. Counts only; no resident names, no unit lists.
//
//   node scripts/measure-moveout-walks.js
//   node scripts/measure-moveout-walks.js --days 60
//
// WHY THE BREAKDOWN MATTERS MORE THAN THE TOTAL. Before 2026-10-14 the only
// way to recognise a move-out walk was its name, and 388 of 635 inspections
// carry a name nobody can classify. unit_turn_id links 202 of them to a turn
// structurally. "Found by turn" is a number we can trust; "found by name only"
// is a number that is right about as often as people type carefully; "none" is
// the real backlog plus whatever the other two missed.
//
// unit_turn_detail lives on the Render disk, so this runs there.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const M = require('../lib/moveout-alerts.js');
const WEEK = require('../lib/week.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', 60));
const TODAY = arg('today', WEEK.todayYMD());

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
const pad = (s, w) => String(s).padEnd(w);

(async () => {
  const af = require('../appfolio-reports.js');
  const turnsAll = (((await af.readReportData('unit_turn_detail')) || {}).rows) || [];
  // Migration 095 adds inspected_on and unit_turn_id. Before it is run the
  // select fails on the whole query, so the old shape is read instead and the
  // difference is STATED — a measurement that silently reports the old numbers
  // under the new headings is worse than one that refuses.
  const NEW_COLS = 'inspection_id,inspection_name,property_name,unit,status,'
    + 'inspected_on,marked_done_on,created_on,unit_turn_id';
  const OLD_COLS = 'inspection_id,inspection_name,property_name,unit,status,'
    + 'marked_done_on,created_on';
  let insp;
  let migrated = true;
  try {
    insp = await selectAll(() => db.from('maintenance_inspections').select(NEW_COLS),
      { label: 'inspections', order: 'inspection_id' });
  } catch (e) {
    if (!/inspected_on|unit_turn_id/.test(e.message || '')) throw e;
    migrated = false;
    insp = await selectAll(() => db.from('maintenance_inspections').select(OLD_COLS),
      { label: 'inspections', order: 'inspection_id' });
  }
  if (!migrated) {
    console.log('MIGRATION 095 HAS NOT BEEN RUN. inspected_on and unit_turn_id do not');
    console.log('exist yet, so every move-out below can only be matched by NAME and the');
    console.log('"by unit_turn_id" row will read zero. Run 095, then the inspections');
    console.log('sync, then this again.\n');
  }

  console.log('inspections: ' + insp.length
    + '   with unit_turn_id: ' + insp.filter(r => M.turnIdOf(r)).length
    + '   with inspected_on: ' + insp.filter(r => M.ymd(r.inspected_on)).length);
  if (!insp.some(r => M.turnIdOf(r)) || !insp.some(r => M.ymd(r.inspected_on))) {
    console.log('\n   Those are zero because the sync has not run since migration 095.');
    console.log('   Run the inspections sync first or this measures the old shape.');
  }

  const from = WEEK.addDaysYMD(TODAY, -DAYS);
  const turns = turnsAll.filter(t => M.isYmd(t.move_out_date)
    && M.ymd(t.move_out_date) >= from && M.ymd(t.move_out_date) <= TODAY);
  console.log('\nmove-outs ' + from + ' .. ' + TODAY + ': ' + turns.length
    + '   with a turn id: ' + turns.filter(t => M.turnOf(t)).length);

  const { byUnit, byTurn } = M.indexInspections(insp);
  const tally = { turn: 0, nameOnly: 0, none: 0, noTurnId: 0, dateOnly: 0 };
  const byProperty = {};

  turns.forEach(t => {
    const moveOut = M.ymd(t.move_out_date);
    const property = M.clean(t.property_name || t.property) || '(no property)';
    const unit = M.clean(t.unit || t.unit_name);
    const turnId = M.turnOf(t);
    if (!turnId) tally.noTurnId++;

    // THE SAME FUNCTION THE ALERT USES. The measurement had its own copy of
    // the matching rule and reported 0/0/39 while the alert would have said
    // something else — two implementations of one rule is one of them being
    // wrong without anybody noticing.
    const m = M.matchWalk({ turn: t, byTurn, byUnit, property, unit, moveOut });
    const verdict = m.walk ? m.basis : 'none';
    tally[verdict === 'turn' ? 'turn' : (verdict === 'name' ? 'nameOnly' : 'none')]++;
    if (!m.walk && m.tooEarly.length) tally.dateOnly++;
    const key = verdict === 'turn' ? 'turn' : (verdict === 'name' ? 'nameOnly' : 'none');
    byProperty[property] = byProperty[property] || { turn: 0, nameOnly: 0, none: 0 };
    byProperty[property][key]++;
  });

  const n = turns.length;
  console.log('\nHOW THE INSPECTION WAS FOUND');
  console.log('   ' + pad('by unit_turn_id', 22) + pad(tally.turn, 6) + pct(tally.turn, n)
    + '   structural — no name read');
  console.log('   ' + pad('by name only', 22) + pad(tally.nameOnly, 6) + pct(tally.nameOnly, n)
    + '   right about as often as people type carefully');
  console.log('   ' + pad('none found', 22) + pad(tally.none, 6) + pct(tally.none, n)
    + '   the backlog, plus whatever the other two missed');
  console.log('\n   move-outs with no turn id at all: ' + tally.noTurnId
    + '  (those can only ever be matched by name)');

  console.log('\nBY PROPERTY            turn  name  none');
  Object.entries(byProperty).sort((a, b) => b[1].none - a[1].none).forEach(([p, c]) =>
    console.log('   ' + pad(p, 22) + String(c.turn).padStart(4)
      + String(c.nameOnly).padStart(6) + String(c.none).padStart(6)));

  console.log('\nNothing was written, and no resident name or unit was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
