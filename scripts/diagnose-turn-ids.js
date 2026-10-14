#!/usr/bin/env node
//
// Do the inspection's unit_turn_id and the unit turn's own id refer to the
// same thing? READ ONLY, COUNTS ONLY — no units, no resident names.
//
//   node scripts/diagnose-turn-ids.js
//   node scripts/diagnose-turn-ids.js --days 60
//
// WHY. The measurement came back 39 move-outs, 0 matched by turn id, 0 by
// name, 39 none — with 202 linked inspections sitting in the table. Either the
// ids are two different namespaces, or the turn's id is under a column nobody
// guessed. This answers that without printing a single value: it reports which
// CANDIDATE COLUMN on unit_turn_detail overlaps the inspections' turn ids, and
// by how much.
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

const pad = (s, w) => String(s).padEnd(w);
const norm = v => String(v == null ? '' : v).trim();

(async () => {
  const af = require('../appfolio-reports.js');
  const turnsAll = (((await af.readReportData('unit_turn_detail')) || {}).rows) || [];
  const insp = await selectAll(() => db.from('maintenance_inspections')
    .select('inspection_id,inspection_name,property_name,unit,status,inspected_on,unit_turn_id'),
  { label: 'inspections', order: 'inspection_id' });

  const inspTurnIds = new Set(insp.map(r => norm(r.unit_turn_id)).filter(Boolean));
  console.log('inspections: ' + insp.length
    + '   with a turn id: ' + insp.filter(r => norm(r.unit_turn_id)).length
    + '   distinct turn ids: ' + inspTurnIds.size);

  if (!turnsAll.length) {
    console.log('\nunit_turn_detail is EMPTY on this machine. Run this on Render.');
    return;
  }

  // EVERY COLUMN, not a guessed shortlist. The point is to find the one that
  // overlaps, and a list of names I thought of is how we got here.
  const cols = new Set();
  turnsAll.forEach(t => Object.keys(t || {}).forEach(k => cols.add(k)));

  console.log('\nunit_turn_detail: ' + turnsAll.length + ' rows, ' + cols.size + ' columns');
  console.log('\nWHICH COLUMN OVERLAPS THE INSPECTIONS\' TURN IDS');
  const scored = [...cols].map(c => {
    const vals = turnsAll.map(t => norm(t[c])).filter(Boolean);
    const hit = vals.filter(v => inspTurnIds.has(v)).length;
    return { c, filled: vals.length, hit, distinct: new Set(vals).size };
  }).sort((a, b) => b.hit - a.hit || b.filled - a.filled);

  scored.slice(0, 12).forEach(x => console.log('   ' + pad(x.c, 28)
    + 'filled ' + String(x.filled).padStart(4)
    + '   distinct ' + String(x.distinct).padStart(4)
    + '   IN INSPECTIONS: ' + String(x.hit).padStart(4)
    + (x.hit ? '   <-- this is the join' : '')));

  const best = scored[0];
  if (!best || !best.hit) {
    console.log('\n   NOTHING OVERLAPS. The two ids are different namespaces, so the turn');
    console.log('   link cannot work for these rows and the NAME pass is the only route.');
    console.log('   That is now what the alert falls back to — it used to give up here.');
  } else if (best.c !== 'unit_turn_id') {
    console.log('\n   The join column is "' + best.c + '", not unit_turn_id.');
    console.log('   Add it to turnOf() in lib/moveout-alerts.js.');
  }

  // ---- the recent move-outs, step by step ----------------------------------
  const from = WEEK.addDaysYMD(TODAY, -DAYS);
  const turns = turnsAll.filter(t => M.isYmd(t.move_out_date)
    && M.ymd(t.move_out_date) >= from && M.ymd(t.move_out_date) <= TODAY);
  const { byUnit, byTurn } = M.indexInspections(insp);

  const tally = { total: turns.length, withTurnId: 0, turnIdFound: 0, anyLinked: 0,
    unitMatched: 0, namedOnUnit: 0, doneNamed: 0, byDateOnly: 0, matched: 0 };

  turns.forEach(t => {
    const turnId = M.turnOf(t);
    if (turnId) tally.withTurnId++;
    if (turnId && inspTurnIds.has(turnId)) tally.turnIdFound++;
    const linked = turnId ? (byTurn.get(turnId) || []) : [];
    if (linked.length) tally.anyLinked++;

    const property = M.clean(t.property_name || t.property);
    const unit = M.clean(t.unit || t.unit_name);
    const onUnit = byUnit.get(M.unitKey(property, unit)) || [];
    if (onUnit.length) tally.unitMatched++;
    const named = onUnit.filter(r => M.WALK_NAME.test(M.clean(r.inspection_name)));
    if (named.length) tally.namedOnUnit++;
    const done = named.filter(r => M.DONE.test(M.clean(r.status)));
    if (done.length) tally.doneNamed++;

    const m = M.matchWalk({ turn: t, byTurn, byUnit, property, unit,
      moveOut: M.ymd(t.move_out_date) });
    if (m.walk) tally.matched++;
    // Rejected ONLY by the date rule: a done, named inspection exists but it
    // predates the move-out.
    else if (done.length && m.tooEarly.length) tally.byDateOnly++;
  });

  console.log('\nTHE ' + tally.total + ' MOVE-OUTS IN THE LAST ' + DAYS + ' DAYS, STEP BY STEP');
  const step = (label, n) => console.log('   ' + pad(label, 44) + String(n).padStart(4));
  step('have a turn id of their own', tally.withTurnId);
  step('...and that id appears on some inspection', tally.turnIdFound);
  step('...and that inspection is indexed to this turn', tally.anyLinked);
  step('have ANY inspection on the same property+unit', tally.unitMatched);
  step('...of which one is NAMED like a move-out walk', tally.namedOnUnit);
  step('...and that one is DONE', tally.doneNamed);
  step('rejected ONLY because it predates the move-out', tally.byDateOnly);
  step('MATCHED by the alert (turn or name)', tally.matched);

  console.log('\nNothing was written, and no unit or resident name was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
