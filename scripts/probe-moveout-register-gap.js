#!/usr/bin/env node
//
// Why is a move-out in the FAS backlog missing from Collections → Move-outs?
//
//   node scripts/probe-moveout-register-gap.js
//   node scripts/probe-moveout-register-gap.js --unit 10-221 --property Ascent
//
// READ ONLY. Paged GETs against the dashboard's own report store and one paged
// select from deposit_held. NO AppFolio REQUEST — both sides are already
// synced. Nothing is written anywhere.
//
// THE QUESTION. Karla's walkthrough on 2026-10-29: Ascent 10-221 is not in the
// move-out inspections view (last 90 days), but the FAS backlog lists it with a
// move-out about 39 days ago. One of those two is wrong about a unit somebody
// is trying to charge a deposit against.
//
// THE TWO VIEWS DO NOT READ THE SAME TABLE, which is the whole reason this can
// happen:
//
//   Collections → Move-outs   MOVEOUT.register(), over unit_turn_detail ONLY.
//                             A move-out with no turn row cannot appear — the
//                             loop is `turns.forEach`, so there is nothing to
//                             match an inspection to.
//   FAS backlog               deposit_held, which is keyed on occupancy_id and
//                             carries its own move_out.
//
// So "unit format mismatch" is only one candidate and not the first one to
// test. The order here is: is there a turn row at all, is it inside the
// window, does the property or unit spelling differ, and only then matching.
//
// COUNTS, UNITS AND IDS ONLY. No resident names.
'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const MOVEOUT = require('../lib/moveout-alerts.js');
const WEEK = require('../lib/week.js');
const { propertyIsExcluded } = require('../lib/excluded-properties.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = String(arg('base', process.env.PROBE_BASE_URL
  || 'https://ai-admin-dashboard-jkde.onrender.com')).replace(/\/+$/, '');
const KEY = process.env.METRIC_API_KEY || '';
const TODAY = arg('today', WEEK.todayYMD());
const DAYS = Number(arg('days', '90'));
const ONE_UNIT = arg('unit', '10-221');
const ONE_PROP = arg('property', 'Ascent');

const clean = v => String(v == null ? '' : v).trim();
const ymd = v => clean(v).slice(0, 10);
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

// The community name without the address AppFolio appends.
const canonProp = raw => {
  const s = clean(raw);
  const i = s.indexOf(' - ');
  return i > 0 ? s.slice(0, i).trim() : s;
};
// Every spelling of a unit that might be "the same unit". 10-221 and 10221 are
// the pair Karla asked about; the others cost nothing to test at the same time.
const unitKeys = u => {
  const s = clean(u).toLowerCase();
  return [...new Set([s, s.replace(/[^a-z0-9]/g, ''), s.replace(/^0+/, '')])].filter(Boolean);
};

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

async function store(id) {
  const rows = [];
  let meta = {};
  for (let offset = 0, guard = 0; guard < 60; guard++) {
    const res = await fetch(BASE + '/api/appfolio/reports/' + id + '/data?limit=1000&offset=' + offset,
      { headers: KEY ? { 'x-metric-key': KEY } : {} });
    if (!res.ok) throw new Error(id + ': HTTP ' + res.status);
    const j = await res.json();
    meta = { fetchedAt: j.fetchedAt || j.syncedAt || null, total: j.total };
    const got = j.rows || [];
    rows.push(...got);
    if (!got.length || rows.length >= (j.total || 0)) break;
    offset += got.length;
  }
  return { rows, ...meta };
}

async function allRows(table, cols, order) {
  const out = [];
  for (let from = 0; from < 60000; from += 1000) {
    const r = await db.from(table).select(cols).order(order).range(from, from + 999);
    if (r.error) throw new Error(table + ': ' + r.error.message);
    out.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
  }
  return out;
}

(async () => {
  console.log('MOVE-OUT REGISTER GAP — ' + TODAY + ', last ' + DAYS + ' days');
  console.log('READ ONLY. No AppFolio request, no writes, no resident names.\n');

  const from = WEEK.addDaysYMD(TODAY, -DAYS);
  const turns = await store('unit_turn_detail');
  const deposits = await allRows('deposit_held',
    'occupancy_id,unit,property,move_out,amount,first_seen_on,in_feed', 'occupancy_id');
  const inspections = await allRows('maintenance_inspections',
    'inspection_id,inspection_name,property_name,unit,status,inspected_on,marked_done_on,created_on,unit_turn_id',
    'inspection_id');

  console.log('unit_turn_detail      : ' + turns.rows.length + ' rows   (fetched ' + (turns.fetchedAt || '?') + ')');
  console.log('deposit_held          : ' + deposits.length + ' rows');
  console.log('maintenance_inspections: ' + inspections.length + ' rows');
  console.log('window                : ' + from + ' .. ' + TODAY + '\n');

  // ── 1. THE UNIT KARLA ASKED ABOUT ──────────────────────────────────────
  console.log('1. ' + ONE_PROP + ' ' + ONE_UNIT);
  const wantUnit = new Set(unitKeys(ONE_UNIT));
  const propMatches = p => canonProp(p).toLowerCase().includes(ONE_PROP.toLowerCase());

  const turnHits = turns.rows.filter(t =>
    propMatches(t.property_name || t.property)
    && unitKeys(t.unit || t.unit_name).some(k => wantUnit.has(k)));
  console.log('   unit_turn_detail rows for this unit: ' + turnHits.length);
  turnHits.forEach(t => console.log('      turn ' + pad(t.unit_turn_id, 10)
    + ' unit ' + pad(clean(t.unit || t.unit_name), 10)
    + ' move_out ' + (ymd(t.move_out_date) || '(none)')
    + '   in window: ' + (ymd(t.move_out_date) >= from && ymd(t.move_out_date) <= TODAY)));

  const depHits = deposits.filter(d =>
    propMatches(d.property) && unitKeys(d.unit).some(k => wantUnit.has(k)));
  console.log('   deposit_held rows for this unit    : ' + depHits.length);
  depHits.forEach(d => console.log('      occ ' + pad(d.occupancy_id, 8)
    + ' unit ' + pad(clean(d.unit), 10)
    + ' move_out ' + (ymd(d.move_out) || '(none)')
    + '   in_feed ' + d.in_feed + '   first_seen ' + ymd(d.first_seen_on)));

  // Every spelling of this unit anywhere in the turn list, so a format
  // mismatch shows up as a row under a different key rather than as nothing.
  const looksLike = turns.rows.filter(t => {
    const u = clean(t.unit || t.unit_name).toLowerCase().replace(/[^a-z0-9]/g, '');
    return propMatches(t.property_name || t.property)
      && u === clean(ONE_UNIT).toLowerCase().replace(/[^a-z0-9]/g, '');
  });
  console.log('   turn rows whose unit matches ignoring punctuation: ' + looksLike.length);

  // ── 2. WHAT THE REGISTER ACTUALLY RETURNS ──────────────────────────────
  const reg = MOVEOUT.register({ turns: turns.rows, inspections }, TODAY, { days: DAYS });
  console.log('\n2. THE VIEW');
  console.log('   register rows in the window: ' + reg.length);
  const inReg = reg.filter(r => propMatches(r.property)
    && unitKeys(r.unit).some(k => wantUnit.has(k)));
  console.log('   rows for ' + ONE_UNIT + ': ' + inReg.length
    + (inReg.length ? '' : '   <- this is what Karla saw'));
  inReg.forEach(r => console.log('      ' + r.moveOut + '  ' + r.state + '  ' + (r.inspectionName || '')));

  // ── 3. HOW MANY OTHERS GO THE SAME WAY ─────────────────────────────────
  //
  // Every deposit move-out in the window, on a property we manage, that the
  // register does not carry. Keyed on property+unit ignoring punctuation, so
  // a format difference counts as PRESENT here — otherwise this count would
  // measure the spelling and not the gap.
  console.log('\n3. DEPOSIT MOVE-OUTS IN THE WINDOW WITH NO ROW IN THE VIEW');
  const regKey = new Set();
  reg.forEach(r => unitKeys(r.unit).forEach(k =>
    regKey.add(canonProp(r.property).toLowerCase() + '|' + k)));

  const missing = [];
  let considered = 0, excluded = 0;
  deposits.forEach(d => {
    const mo = ymd(d.move_out);
    if (!mo || mo > TODAY || mo < from) return;
    const prop = canonProp(d.property);
    if (!prop) return;
    if (propertyIsExcluded(prop)) { excluded++; return; }
    considered++;
    const hit = unitKeys(d.unit).some(k => regKey.has(prop.toLowerCase() + '|' + k));
    if (!hit) missing.push({ prop, unit: clean(d.unit), mo, occ: d.occupancy_id });
  });
  console.log('   deposit move-outs in the window (managed properties): ' + considered);
  console.log('   of those, NOT in the view                           : ' + missing.length
    + (considered ? '   (' + Math.round(missing.length / considered * 100) + '%)' : ''));
  if (excluded) console.log('   (' + excluded + ' on properties we do not manage, not counted)');

  if (missing.length) {
    const byProp = new Map();
    missing.forEach(m => byProp.set(m.prop, (byProp.get(m.prop) || 0) + 1));
    console.log('\n   by property');
    [...byProp].sort((a, b) => b[1] - a[1]).forEach(([p, n]) =>
      console.log('      ' + pad(p, 26) + lpad(n, 4)));
    console.log('\n   units (no names)');
    missing.sort((a, b) => b.mo.localeCompare(a.mo)).slice(0, 40).forEach(m =>
      console.log('      ' + pad(m.prop, 24) + pad(m.unit, 10) + m.mo + '   occ ' + m.occ));
    if (missing.length > 40) console.log('      … and ' + (missing.length - 40) + ' more');
  }

  // ── 4. IS IT THE SPELLING, OR IS THE ROW ABSENT? ───────────────────────
  //
  // The question the fix depends on. For each missing one: does the turn list
  // hold that property+unit AT ALL, under any spelling and any date?
  console.log('\n4. FOR EACH MISSING ONE, IS THERE A TURN ROW AT ALL?');
  const turnByUnit = new Map();
  turns.rows.forEach(t => {
    const p = canonProp(t.property_name || t.property).toLowerCase();
    unitKeys(t.unit || t.unit_name).forEach(k => {
      const key = p + '|' + k;
      if (!turnByUnit.has(key)) turnByUnit.set(key, []);
      turnByUnit.get(key).push(t);
    });
  });
  let noTurnAtAll = 0, turnOutOfWindow = 0, turnNoDate = 0, turnInWindow = 0;
  missing.forEach(m => {
    const hits = unitKeys(m.unit)
      .flatMap(k => turnByUnit.get(m.prop.toLowerCase() + '|' + k) || []);
    if (!hits.length) { noTurnAtAll++; return; }
    const dates = hits.map(t => ymd(t.move_out_date)).filter(Boolean);
    if (!dates.length) { turnNoDate++; return; }
    if (dates.some(d => d >= from && d <= TODAY)) turnInWindow++;
    else turnOutOfWindow++;
  });
  console.log('   no turn row for that unit at all        : ' + noTurnAtAll);
  console.log('   turn row exists, move_out_date is EMPTY : ' + turnNoDate);
  console.log('   turn row exists, move_out OUTSIDE window: ' + turnOutOfWindow);
  console.log('   turn row IN the window (so: a spelling  ');
  console.log('     or property mismatch, not a missing row): ' + turnInWindow);

  // THE DETAIL, because the three buckets above hide the interesting case: a
  // unit can have one turn row dated a year earlier AND another with no date
  // at all, which is a turn AppFolio opened and never stamped. That is not
  // the same problem as a unit with no turn row, and the fixes differ.
  if (missing.length) {
    console.log('\n   per unit');
    missing.forEach(m => {
      const hits = unitKeys(m.unit)
        .flatMap(k => turnByUnit.get(m.prop.toLowerCase() + '|' + k) || []);
      const seen = new Set();
      const detail = hits.filter(h => {
        const id = String(h.unit_turn_id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map(h => 'turn ' + h.unit_turn_id + ' move_out ' + (ymd(h.move_out_date) || 'EMPTY'));
      console.log('      ' + pad(m.prop, 22) + pad(m.unit, 8) + 'deposit move_out ' + m.mo
        + '   ' + (detail.length ? detail.join(' · ') : 'NO TURN ROW'));
    });
  }

  console.log('\nNothing was written. No AppFolio request was made. No resident names printed.');
})().catch(e => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; });
