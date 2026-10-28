#!/usr/bin/env node
//
// Can a move-out with NO deposit be found from the move-out list?
//
// READ ONLY. Paged GETs against the dashboard's own report store and one
// paged select from deposit_held. NO AppFolio REQUEST IS MADE — both sides
// are already synced, so this asks nothing of the Reports API and spends none
// of its 7-per-15s budget. The pacing below applies to our own store.
//
//   node scripts/probe-moveout-deposit-join.js
//
// THE QUESTION. deposit_held lists deposits HELD, so a move-out with no
// deposit at all has no row in it and the FAS section cannot see the case
// Kara asked about on 2026-10-28. unit_turn_detail is the move-out list the
// KPI report and Kara's own move-outs section already read, so it is the
// candidate source — but only if a turn can be matched to a tenancy.
//
// AND THAT IS THE RISK, NOT THE PLUMBING. unit_turn_detail appears to carry
// property, unit, move_out_date and a turn id, and NOT occupancy_id — which
// is what deposit_held is keyed on. Property+unit alone is not a tenancy:
// Sunset Palms 111 had three this year. So the join would fall back to
// property+unit+date, and a date that differs by one day between two reports
// produces a confident false "no deposit on file" about a real resident.
//
// This counts, for every past move-out:
//   A  matched a deposit row on property+unit+date
//   B  matched on property+unit, but the dates disagree   <- the dangerous one
//   C  matched nothing                                    <- the candidate case
//
// It also reports whether any occupancy or lease id exists under ANY spelling,
// because an id join would make B and most of C go away.
//
// COUNTS AND COLUMN NAMES ONLY. No resident name, no unit, no amount.
'use strict';

require('dotenv').config({ override: true });

const { createClient } = require('@supabase/supabase-js');
const EXCLUDED = require('../lib/excluded-properties.js');
const WEEK = require('../lib/week.js');
const F = require('../lib/fas-deposits.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = String(arg('base', process.env.PROBE_BASE_URL
  || 'https://ai-admin-dashboard-jkde.onrender.com')).replace(/\/+$/, '');
const KEY = process.env.METRIC_API_KEY || '';
const TODAY = arg('today', WEEK.todayYMD());
const SPACING_MS = 2300;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v == null ? '' : v).trim();
const ymd = v => clean(v).slice(0, 10);
const pad = (s, w) => String(s).padEnd(w);
const key = (p, u) => clean(p).toLowerCase() + '|' + clean(u).toLowerCase();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

async function storeRows(id) {
  const out = [];
  for (let offset = 0, guard = 0; guard < 50; guard++) {
    const res = await fetch(BASE + '/api/appfolio/reports/' + id + '/data?limit=1000&offset=' + offset,
      { headers: KEY ? { 'x-metric-key': KEY } : {} });
    if (!res.ok) throw new Error(id + ': HTTP ' + res.status);
    const j = await res.json();
    const rows = j.rows || [];
    out.push(...rows);
    if (out.length >= (j.total || 0) || !rows.length) {
      return { rows: out, syncedAt: j.syncedAt || j.synced_at || null };
    }
    offset += rows.length;
    await sleep(SPACING_MS);
  }
  return { rows: out, syncedAt: null };
}

// Every spelling an id could arrive under. The lesson from the tenant
// directory: the reader must not insist on a name the writer never used —
// asking for `phone` when the report says "Phone Numbers" found nothing and
// looked exactly like a report nobody synced.
const ID_PATTERNS = [/occupanc/i, /\blease\b/i, /tenanc/i, /resident[_\s]*id/i];

(async () => {
  console.log('MOVE-OUTS WITHOUT A DEPOSIT — is unit_turn_detail joinable?');
  console.log('READ ONLY. No AppFolio request; both sides are already synced.\n');

  const turns = await storeRows('unit_turn_detail');
  console.log('unit_turn_detail : ' + turns.rows.length + ' rows'
    + (turns.syncedAt ? '   synced ' + turns.syncedAt : ''));
  if (!turns.rows.length) {
    console.log('\nThe store is empty here. This report lives on Render; run it there,');
    console.log('or point --base at the deployed dashboard (the default).');
    return;
  }

  const cols = Object.keys(turns.rows[0]);
  console.log('   columns: ' + cols.join(', '));

  // 1. AN ID, UNDER ANY SPELLING.
  console.log('\n1. IS THERE AN OCCUPANCY OR LEASE ID?');
  const idCols = cols.filter(c => ID_PATTERNS.some(re => re.test(c)));
  if (!idCols.length) {
    console.log('   none. The join can only be property + unit + date.');
  } else {
    idCols.forEach(c => {
      const filled = turns.rows.filter(r => clean(r[c])).length;
      console.log('   ' + pad(c, 28) + filled + ' of ' + turns.rows.length + ' rows carry a value');
    });
  }

  // 2. THE MOVE-OUTS THIS WOULD BE ABOUT.
  const deadline = F.DEFAULT_DEADLINE;
  const past = turns.rows.filter(t => {
    const m = ymd(t.move_out_date);
    if (!m || m > TODAY) return false;
    if (EXCLUDED.propertyIsExcluded(t.property_name || t.property)) return false;
    const age = F.daysBetween(m, TODAY, deadline.basis);
    return age !== null && age > deadline.days;
  });
  console.log('\n2. PAST MOVE-OUTS, more than ' + deadline.days + ' '
    + deadline.basis + ' days ago, on properties we manage');
  console.log('   ' + past.length + ' of ' + turns.rows.length + ' turns');

  // 3. THE DEPOSIT SIDE.
  const deposits = [];
  for (let from = 0; ; from += 1000) {
    const r = await db.from('deposit_held')
      .select('occupancy_id,unit,property,move_out').order('occupancy_id')
      .range(from, from + 999);
    if (r.error) throw new Error(r.error.message);
    deposits.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
  }
  const byUnitDate = new Set();
  const byUnit = new Map();
  deposits.forEach(d => {
    const k = key(d.property, d.unit);
    byUnitDate.add(k + '|' + ymd(d.move_out));
    byUnit.set(k, (byUnit.get(k) || 0) + 1);
  });
  console.log('   deposit_held: ' + deposits.length + ' rows, '
    + byUnit.size + ' distinct property+unit');

  // 4. THE JOIN.
  console.log('\n3. HOW EACH PAST MOVE-OUT MATCHES');
  const buckets = { A: 0, B: 0, C: 0 };
  const cByProperty = new Map();
  const bByProperty = new Map();
  past.forEach(t => {
    const prop = clean(t.property_name || t.property);
    const k = key(prop, t.unit || t.unit_name);
    if (byUnitDate.has(k + '|' + ymd(t.move_out_date))) { buckets.A++; return; }
    if (byUnit.has(k)) {
      buckets.B++;
      bByProperty.set(prop, (bByProperty.get(prop) || 0) + 1);
      return;
    }
    buckets.C++;
    cByProperty.set(prop, (cByProperty.get(prop) || 0) + 1);
  });
  console.log('   A  property+unit+date matched a deposit : ' + buckets.A);
  console.log('   B  property+unit matched, DATES DIFFER  : ' + buckets.B
    + '   <- would read as "no deposit" on a date mismatch');
  console.log('   C  nothing matched                      : ' + buckets.C
    + '   <- the candidate "no deposit on file" case');
  if (bByProperty.size) {
    console.log('\n   B by property');
    [...bByProperty].sort().forEach(([p, n]) => console.log('      ' + pad(p, 30) + n));
  }
  if (cByProperty.size) {
    console.log('\n   C by property');
    [...cByProperty].sort().forEach(([p, n]) => console.log('      ' + pad(p, 30) + n));
  }

  console.log('\nWHAT THE ANSWER MEANS');
  console.log('  AN ID COLUMN EXISTS          -> join on it; B collapses and C becomes');
  console.log('     trustworthy. Build it.');
  console.log('  NO ID AND B IS LARGE         -> the date is not a reliable key, and');
  console.log('     "no deposit on file" would be wrong about real residents.');
  console.log('  NO ID AND B IS ZERO          -> property+unit+date holds today, but it');
  console.log('     is still a key nothing enforces; the unmatched count has to stay on');
  console.log('     the page.');
  console.log('\nNothing was written. No resident name, unit or amount was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
