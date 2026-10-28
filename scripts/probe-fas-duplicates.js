#!/usr/bin/env node
//
// Are the repeated units in the FAS section two occupancies or one row twice?
//
// READ ONLY. One paged select from deposit_held. Nothing is written.
//
//   node scripts/probe-fas-duplicates.js
//
// THE QUESTION. The 2026-10-28 preview showed the same unit twice in two
// properties — Ascent 3-116 at 91 and 63 days, Sunset Palms 111 at 84 and 29 —
// and a third, Ascent 3-216, is a unit with an eviction in process right now.
// Two tenancies in one unit is ordinary and both statements are genuinely
// owed. The same occupancy counted twice is a number Kara would act on that
// is not real. They look identical in the rendered section.
//
// IDS ONLY. occupancy_id, unit, property, dates and buckets. No resident name
// and no amount — the question is about identity, not money.
'use strict';

require('dotenv').config({ override: true });

const { createClient } = require('@supabase/supabase-js');
const F = require('../lib/fas-deposits.js');
const EXCLUDED = require('../lib/excluded-properties.js');
const WEEK = require('../lib/week.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const TODAY = arg('today', WEEK.todayYMD());

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const clean = v => String(v == null ? '' : v).trim();
const pad = (s, w) => String(s).padEnd(w);

(async () => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    // Ordered on occupancy_id: deposit_held has no `id` column, and an
    // unordered page past the first is not trustworthy.
    const r = await db.from('deposit_held')
      // `amount` IS SELECTED AND NEVER PRINTED, and the difference matters.
      // The first run of this probe left it out for privacy and every row
      // classified as `noDeposit` — classify() reads the amount, and
      // Number(undefined) is NaN, which is indistinguishable from a deposit
      // of zero. The section it was checking says OVERDUE for those same
      // rows, so the probe quietly contradicted the thing it was auditing.
      // Dropping a column the reader needs does not protect anybody; it just
      // moves the lie into the answer.
      .select('occupancy_id,unit,property,property_source,tenant_status,move_in,move_out,'
        + 'amount,first_seen_on,last_seen_on,in_feed,gone_first_seen_on')
      .order('occupancy_id').range(from, from + 999);
    if (r.error) throw new Error(r.error.message);
    rows.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
  }
  console.log('READ ONLY — ' + rows.length + ' rows from deposit_held, nothing written.\n');

  // 1. IS ANY OCCUPANCY STORED TWICE? The table is keyed on occupancy_id, so
  //    this should be impossible — but "should be" is the assumption that
  //    produced the question, and the primary key is worth reading rather
  //    than trusting.
  const byOcc = new Map();
  rows.forEach(r => {
    const k = clean(r.occupancy_id) || '(blank)';
    byOcc.set(k, (byOcc.get(k) || 0) + 1);
  });
  const repeatedOcc = [...byOcc].filter(([, n]) => n > 1);
  console.log('1. THE SAME OCCUPANCY STORED TWICE');
  console.log('   distinct occupancy_id : ' + byOcc.size + ' across ' + rows.length + ' rows');
  if (!repeatedOcc.length) {
    console.log('   none. Every row is its own occupancy, so no unit below is double-counted.');
  } else {
    repeatedOcc.forEach(([k, n]) => console.log('   occupancy ' + pad(k, 16) + n + ' rows  <-- DOUBLE COUNTED'));
  }

  // 2. THE REPEATED UNITS, with the occupancy ids and the tenancy dates that
  //    tell two tenancies apart from one.
  const WATCH = [
    ['Ascent at Northgate', '3-116'],
    ['Ascent at Northgate', '3-216'],
    ['Sunset Palms', '111'],
  ];
  console.log('\n2. THE UNITS KARA ASKED ABOUT');
  const byUnit = new Map();
  rows.forEach(r => {
    const k = clean(r.property).toLowerCase() + '|' + clean(r.unit).toLowerCase();
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(r);
  });
  WATCH.forEach(([prop, unit]) => {
    const list = (byUnit.get(prop.toLowerCase() + '|' + unit.toLowerCase()) || [])
      .slice().sort((a, b) => clean(a.move_in).localeCompare(clean(b.move_in)));
    console.log('\n   ' + prop + '  unit ' + unit + '   ' + list.length + ' row(s)');
    if (!list.length) { console.log('      not in the table under that spelling'); return; }
    list.forEach(r => {
      const c = F.classify(r, TODAY, F.DEFAULT_DEADLINE);
      console.log('      occ ' + pad(clean(r.occupancy_id) || '(blank)', 14)
        + 'in ' + pad(clean(r.move_in).slice(0, 10) || '—', 12)
        + 'out ' + pad(clean(r.move_out).slice(0, 10) || '—', 12)
        + pad(clean(r.tenant_status) || '—', 10)
        + pad(c.bucket + (c.days == null ? '' : ' ' + c.days + 'd'), 16)
        + 'first seen ' + clean(r.first_seen_on).slice(0, 10));
    });
    // DO THE TENANCIES OVERLAP? Two rows for one unit whose occupancies run
    // over the same dates cannot both be real tenancies of that unit.
    const dated = list.filter(r => clean(r.move_in));
    for (let i = 1; i < dated.length; i++) {
      const prevOut = clean(dated[i - 1].move_out).slice(0, 10);
      const thisIn = clean(dated[i].move_in).slice(0, 10);
      if (prevOut && thisIn && thisIn < prevOut) {
        console.log('      *** OVERLAP: one tenancy starts ' + thisIn
          + ' before the previous ends ' + prevOut + ' — not two clean tenancies.');
      }
    }
  });

  // 3. EVERY unit that appears more than once, so the three above are not
  //    mistaken for the whole of it.
  console.log('\n3. EVERY REPEATED UNIT IN THE TABLE');
  const repeats = [...byUnit].filter(([, l]) => l.length > 1);
  if (!repeats.length) console.log('   none');
  repeats.sort().forEach(([k, l]) => {
    const occ = new Set(l.map(r => clean(r.occupancy_id)));
    console.log('   ' + pad(k, 40) + l.length + ' rows · ' + occ.size + ' distinct occupancy ids'
      + (occ.size === l.length ? '   (separate tenancies)' : '   <-- FEWER IDS THAN ROWS'));
  });

  // 4. PROPERTIES THE BOARD DOES NOT MANAGE. The FAS section groups whatever
  //    the deposit feed returns; nothing in that path consults the excluded
  //    list, which every other view applies.
  console.log('\n4. EXCLUDED PROPERTIES PRESENT IN THE DEPOSIT FEED');
  const excluded = new Map();
  rows.forEach(r => {
    const name = clean(r.property);
    if (!EXCLUDED.propertyIsExcluded(name)) return;
    const c = F.classify(r, TODAY, F.DEFAULT_DEADLINE);
    const e = excluded.get(name) || { rows: 0, overdue: 0 };
    e.rows++;
    if (c.bucket === 'overdue') e.overdue++;
    excluded.set(name, e);
  });
  if (!excluded.size) console.log('   none');
  [...excluded].sort().forEach(([name, e]) =>
    console.log('   ' + pad(name, 30) + e.rows + ' deposit row(s) · ' + e.overdue + ' overdue'));

  console.log('\nNothing was written. No resident name and no amount was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
