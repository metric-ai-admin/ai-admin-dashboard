#!/usr/bin/env node
//
// Fill in source_as_of on the weekly occupancy snapshots already written.
//
//   node scripts/mark-occupancy-history.js            # DRY RUN
//   node scripts/mark-occupancy-history.js --write
//
// WHY MARK AND NOT CORRECT. The rows for 2026-10-03 and 2026-10-10 were copied
// from leasing_occupancy while it held 2026-10-02 figures, because the sync
// that refreshes it ran only when somebody pressed a button and nobody had
// since 10/02. The honest fix would be to rewrite them with what those
// Saturdays really looked like — and AppFolio cannot tell us: occupancy_summary
// reports as of now and takes no historical date. The figures for those two
// Saturdays do not exist anywhere any more.
//
// Overwriting them with today's numbers would replace a wrong row with a
// differently wrong row that also claims to be about a week it is not. So the
// rows stay and the table says what they are made of.
//
// SETS ONLY source_as_of. No measurement is touched. Nothing is deleted.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');

const WRITE = process.argv.includes('--write');

// What each already-written week was really made of. Established from
// leasing_occupancy.synced_at (last sync 2026-10-02T20:10Z, next 2026-10-12)
// and from the rows themselves: both weeks carry identical figures, which two
// real consecutive weeks of a 397-unit portfolio do not.
const KNOWN = {
  '2026-10-03': '2026-10-02',
  '2026-10-10': '2026-10-02',
};

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  const rows = await selectAll(() => db.from('leasing_occupancy_history')
    .select('id,as_of,property_name,source_as_of,occupied_units,total_units,captured_at'),
  { label: 'occupancy history' });

  const weeks = {};
  rows.forEach(r => {
    const w = String(r.as_of).slice(0, 10);
    if (!weeks[w]) weeks[w] = [];
    weeks[w].push(r);
  });

  console.log('weeks in leasing_occupancy_history: ' + Object.keys(weeks).length + '\n');
  const plan = [];
  Object.keys(weeks).sort().forEach(w => {
    const list = weeks[w];
    const occ = list.reduce((s, r) => s + (r.occupied_units || 0), 0);
    const units = list.reduce((s, r) => s + (r.total_units || 0), 0);
    const already = [...new Set(list.map(r => r.source_as_of).filter(Boolean))];
    const want = KNOWN[w];
    console.log(w + '  ' + String(list.length).padStart(2) + ' properties   '
      + occ + '/' + units + '   captured ' + String(list[0].captured_at).slice(0, 10)
      + '   source_as_of now: ' + (already.length ? already.join(',') : '(null)'));
    if (!want) { console.log('        not in the known list — left alone'); return; }
    const todo = list.filter(r => r.source_as_of !== want);
    if (!todo.length) { console.log('        already marked ' + want); return; }
    console.log('        -> mark source_as_of = ' + want
      + (want === w ? '' : '   (STALE: made of figures ' + want + ', filed as ' + w + ')'));
    plan.push({ week: w, want, ids: todo.map(r => r.id) });
  });

  const n = plan.reduce((s, p) => s + p.ids.length, 0);
  console.log('\nrows to mark: ' + n);
  if (!n) { console.log('nothing to do.'); return; }
  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  for (const p of plan) {
    // Guarded on source_as_of still being unset, so a re-run cannot overwrite
    // a value somebody set deliberately in between.
    const { data, error } = await db.from('leasing_occupancy_history')
      .update({ source_as_of: p.want }).in('id', p.ids).is('source_as_of', null).select('id');
    if (error) { console.log(p.week + ': FAILED — ' + error.message); continue; }
    console.log(p.week + ': marked ' + ((data || []).length) + ' of ' + p.ids.length
      + (data && data.length < p.ids.length ? '  (the rest already carried a value — left alone)' : ''));
  }

  const after = await selectAll(() => db.from('leasing_occupancy_history').select('as_of,source_as_of'),
    { label: 'verify' });
  const unmarked = after.filter(r => !r.source_as_of).length;
  console.log('\nstill unmarked: ' + unmarked);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
