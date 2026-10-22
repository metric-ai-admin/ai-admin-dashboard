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
// Rocio is Rocío Hunsberger — confirmed by Arturo 2026-10-20, so the row
// carries her login and the check matches on that rather than on which of the
// two spellings of her name happens to be in the session.
//
// The other four have no account yet and their emails are the ones Arturo
// chose for the accounts he has not created. They are written here now so the
// roster matches them the moment the accounts exist; until then the match
// falls back to the name, which is all there is.
// THE SHORT FORM IS THE ACCOUNT. These were written as first.last before the
// accounts existed; the four created on 2026-10-21 are sammy@, oscar@, yeni@
// and daria@. The daily check matches a post to a person by LOGIN, so the long
// form would have let all four post and be reported missing — the roster names
// them, so they would have shown as absent rather than simply not counted.
const ROSTER = [
  { person: 'Rocio', email: 'rocio@metric.internal', expected: null, active: true },
  { person: 'Sammy', email: 'sammy@metric.internal', expected: null, active: true },
  { person: 'Oscar', email: 'oscar@metric.internal', expected: null, active: true },
  { person: 'Yeni',  email: 'yeni@metric.internal', expected: null, active: true },
  { person: 'Daria', email: 'daria@metric.internal', expected: null, active: true },
];

const pad = (s, w) => String(s == null ? '—' : s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim().toLowerCase();

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
  console.log('   ' + pad('person', 10) + pad('email', 34) + pad('expected', 10) + 'status');
  ROSTER.forEach(r => {
    const was = existing.find(e => e.person === r.person);
    // AN EXISTING ROW IS NOT OVERWRITTEN BLIND. If somebody has already set a
    // number, this script is not the place it gets reset to null.
    const status = !was ? 'new'
      : (was.expected == null ? 'already here' : 'already here — KEEPS expected=' + was.expected);
    console.log('   ' + pad(r.person, 10) + pad(r.email, 34) + pad(r.expected, 10) + status);
  });

  const strangers = existing.filter(e => !ROSTER.some(r => r.person === e.person));
  if (strangers.length) {
    console.log('\n   NOT IN BEKAH\'S LIST, left alone: '
      + strangers.map(s => s.person).join(', '));
  }

  console.log('\n   expected = NULL for all five: Lyndsay has not set a number.');
  console.log('   The daily check will count their posts and call nobody missing.');
  console.log('   All five match on the login: the four accounts were created 2026-10-21.');

  // THE EMAIL IS CORRECTED ON A ROW THAT EXISTS. Insert-only was right while
  // the emails were a guess at accounts nobody had created; now they are wrong
  // on file and an insert-only script would leave them wrong forever. Only the
  // email moves — `expected` and `active` are somebody's settings and are read
  // from the row and written back unchanged.
  const fixes = ROSTER.filter(r => {
    const was = existing.find(e => e.person === r.person);
    return was && clean(was.email) !== clean(r.email);
  });
  if (fixes.length) {
    console.log('\n   EMAIL CORRECTIONS (the account is the short form):');
    fixes.forEach(r => {
      const was = existing.find(e => e.person === r.person);
      console.log('      ' + pad(r.person, 10) + pad(was.email || '(none)', 34) + '-> ' + r.email);
    });
  }

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

  for (const r of fixes) {
    const was = existing.find(e => e.person === r.person);
    const { error } = await db.from('social_post_roster')
      .update({ email: r.email, updated_at: new Date().toISOString() })
      .eq('person', r.person);
    if (error) throw new Error(error.message);
    console.log('   ' + r.person + ': ' + was.email + ' -> ' + r.email
      + '   (expected ' + (was.expected === null ? 'NULL' : was.expected) + ' kept)');
  }

  const after = await db.from('social_post_roster').select('person,email,expected,active').order('person');
  if (after.error) throw new Error(after.error.message);
  console.log('\nsocial_post_roster now holds ' + after.data.length + ' row(s):');
  after.data.forEach(r => console.log('   ' + pad(r.person, 10) + pad(r.email, 34)
    + pad(r.expected, 10) + (r.active === false ? 'inactive' : 'active')));
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
