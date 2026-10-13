#!/usr/bin/env node
//
// What the on-call table actually holds, and whether the dashboard can see it.
//
//   node scripts/check-oncall.js
//
// WHY BOTH CLIENTS. On 2026-10-13 the panel said "October 2026 is not in the
// dashboard" after both months had been imported and verified present. RLS is
// on and there is no anon policy, so a read through the anon key comes back as
// an EMPTY LIST with no error — indistinguishable from a month nobody has
// generated. This prints both answers side by side so that difference can never
// be mistaken for missing data again.
//
// Read only. Nothing is written.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const R = require('../lib/oncall-rotation.js');

// Not named URL: that shadows the global and new URL() stops being a thing.
const DB_URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

const mk = key => (key ? createClient(DB_URL, key, { auth: { persistSession: false } }) : null);

(async () => {
  console.log('project: ' + (DB_URL ? new URL(DB_URL).host : '(SUPABASE_URL not set)'));
  console.log('service role key: ' + (SERVICE ? 'set' : 'NOT SET'));
  console.log('anon key:         ' + (ANON ? 'set' : 'NOT SET'));
  if (!SERVICE) {
    console.log('\nWithout the service role key the dashboard reads this table as the anon');
    console.log('key, RLS returns nothing, and every month reads as "not in the dashboard".');
  }

  const admin = mk(SERVICE);
  const anon = mk(ANON);

  if (anon) {
    const { data, error } = await anon.from('oncall_rotations').select('year,month,state');
    console.log('\nas the ANON key:    ' + (error ? 'ERROR ' + error.message
      : (data || []).length + ' rows' + ((data || []).length ? '' : '   <-- RLS, not absence')));
  }
  if (!admin) return;

  const { data, error } = await admin.from('oncall_rotations')
    .select('year,month,state,carry_pair,carry_from,created_by,updated_at')
    .order('year').order('month');
  if (error) throw new Error(error.message);

  console.log('as the SERVICE key: ' + (data || []).length + ' rows\n');
  (data || []).forEach(r => {
    console.log('   ' + r.year + '-' + String(r.month).padStart(2, '0')
      + '  ' + String(r.state).padEnd(10)
      + '  carry-in: ' + ((r.carry_pair || []).map(R.shortOf).join(' + ') || '(none)')
      + (r.carry_from ? '  from ' + r.carry_from : '')
      + '   [' + (r.created_by || '?') + ']');
  });

  // The chain the generator walks: each month's last week is the next month's
  // carry-in. A break here is what makes a month generate wrong.
  console.log('\nTHE CARRY CHAIN — each month\'s last week feeds the next:');
  for (const r of data || []) {
    const { data: row } = await admin.from('oncall_rotations')
      .select('draft').eq('year', r.year).eq('month', r.month).single();
    const weeks = ((row || {}).draft || {}).weeks || [];
    const last = weeks[weeks.length - 1];
    if (!last) { console.log('   ' + r.year + '-' + r.month + ': no weeks stored'); continue; }
    console.log('   ' + String(row.draft.monthName).padEnd(16) + last.label
      + ' (' + last.range + ')  ' + (last.pair || []).map(R.shortOf).join(' + ')
      + (last.spillsInto ? '   -> carries into ' + last.spillsInto : '   (does not spill)'));
  }
  console.log('\nA month whose previous month is missing from this list will be refused');
  console.log('by /api/maintenance/oncall/generate until somebody supplies the pair.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
