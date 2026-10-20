#!/usr/bin/env node
//
// The five leasing agents Bekah confirmed, into social_post_roster.
//
//   node scripts/load-social-roster.js            # DRY RUN
//   node scripts/load-social-roster.js --write
//
// NEEDS MIGRATION 109. Before it, `expected` is NOT NULL DEFAULT 1 and loading
// these names would set everybody's target to one post a day — a number
// Lyndsay has not chosen. The script refuses to run rather than invent it.
//
// expected stays NULL for all five. The daily check reads NULL as "no target
// set": it counts what they posted and never calls anybody short.
//
// email is the match key where we have one. Four of the five have no dashboard
// account, so their rows match on the name — which is all that exists for them
// — and the screen says so instead of implying the match is solid.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const WRITE = process.argv.includes('--write');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// Bekah, 2026-10-20. Spelled as she gave them.
//
// ROCIO'S EMAIL IS DELIBERATELY NOT SET. dashboard_users holds a "Rocío
// Hunsberger" (rocio@metric.internal, collections_leasing), and she is
// Collections & Leasing, so she is probably the same person — but "probably"
// is not a key. Tying the row to that login when it is somebody else would
// credit her with another agent's posts, which is worse than matching on the
// name until Bekah confirms. Set it in one line once she does.
const ROSTER = [
  { person: 'Rocio', email: null, expected: null, active: true },
  { person: 'Sammy', email: null, expected: null, active: true },
  { person: 'Oscar', email: null, expected: null, active: true },
  { person: 'Yeni',  email: null, expected: null, active: true },
  { person: 'Daria', email: null, expected: null, active: true },
];

const pad = (s, w) => String(s == null ? '—' : s).padEnd(w);

(async () => {
  const probe = await db.from('social_post_roster').select('person,email,expected,active');
  if (probe.error) {
    if (/email/.test(probe.error.message || '')) {
      throw new Error('migration 109 has not been run — social_post_roster has no email column.\n'
        + '        Run supabase/migrations/109_social_roster_expected_nullable.sql first.\n'
        + '        Without it `expected` is NOT NULL DEFAULT 1 and this would set a '
        + 'daily target nobody chose.');
    }
    throw new Error(probe.error.message);
  }

  const existing = probe.data || [];
  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — social_post_roster\n');
  console.log('   ' + pad('person', 10) + pad('email', 26) + pad('expected', 10) + 'status');
  ROSTER.forEach(r => {
    const was = existing.find(e => e.person === r.person);
    // AN EXISTING ROW IS NOT OVERWRITTEN BLIND. If somebody has already set a
    // number, this script is not the place it gets reset to null.
    const status = !was ? 'new'
      : (was.expected == null ? 'already here' : 'already here — KEEPS expected=' + was.expected);
    console.log('   ' + pad(r.person, 10) + pad(r.email, 26) + pad(r.expected, 10) + status);
  });

  const strangers = existing.filter(e => !ROSTER.some(r => r.person === e.person));
  if (strangers.length) {
    console.log('\n   NOT IN BEKAH\'S LIST, left alone: '
      + strangers.map(s => s.person).join(', '));
  }

  console.log('\n   expected = NULL for all five: Lyndsay has not set a number.');
  console.log('   The daily check will count their posts and call nobody missing.');
  console.log('   Rocio: email left unset — "Rocío Hunsberger" in dashboard_users may or');
  console.log('   may not be her. Matching on the name until Bekah confirms.');

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  // Insert only what is absent; never touch a row somebody has configured.
  const fresh = ROSTER.filter(r => !existing.some(e => e.person === r.person));
  if (!fresh.length) {
    console.log('\nNothing to insert — all five are already there.');
  } else {
    const { data, error } = await db.from('social_post_roster').insert(fresh).select('person');
    if (error) throw new Error(error.message);
    console.log('\nadded ' + (data || []).length + ' row(s): '
      + (data || []).map(d => d.person).join(', '));
  }

  const after = await db.from('social_post_roster').select('person,email,expected,active').order('person');
  if (after.error) throw new Error(after.error.message);
  console.log('\nsocial_post_roster now holds ' + after.data.length + ' row(s):');
  after.data.forEach(r => console.log('   ' + pad(r.person, 10) + pad(r.email, 26)
    + pad(r.expected, 10) + (r.active === false ? 'inactive' : 'active')));
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
