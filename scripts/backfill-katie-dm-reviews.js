#!/usr/bin/env node
//
// Attribute seventeen digital-marketing reviews to Katie.
//
//   node scripts/backfill-katie-dm-reviews.js            # DRY RUN
//   node scripts/backfill-katie-dm-reviews.js --write
//
// WHY ONLY THESE SEVENTEEN. dm_reviews has never recorded who did the work —
// all 133 rows have a null agent_name, and 736 rows across the CRM tables are
// in the same state. These seventeen are the only ones anybody can name: Katie
// listed the properties and the dates match. The other 719 are left alone,
// because "probably hers" is not attribution, it is a guess written into an
// audit trail.
//
// MATCHED ON PROPERTY NAME **AND** DATE, and every one must match exactly once
// or nothing is written. A fuzzy match here would credit somebody else's
// review to Katie, which is the same failure as the one being fixed.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');

const WRITE = process.argv.includes('--write');
const AGENT = 'Katie';
const FROM = '2026-10-08';
const TO = '2026-10-09';

// Katie's own list, verbatim.
const PROPERTIES = [
  'Pointe 360 Apartments', 'Legacy Rental Homes', 'Burnett Place Apartments',
  'Liberty Trails Apartment Homes', 'Sunchase Square', 'Sunset Duplexes Apartments',
  'Braeburn Apartments', 'Brentwood Townhomes', 'The Enclave', 'Garden Gate Apartments',
  'Bee Caves Vistas', 'Towns on Tenth', 'Barton Springs', 'Mosscliff Apartments',
  'Arbor Coves', 'The Colony of San Marcos', 'Affinity at Southpark Meadows',
];

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// Case and surrounding space only. NOT a fuzzy match: "The Enclave" and "The
// Enclave at Dove Mountain" are different properties, and deciding they are the
// same is exactly the mistake this script exists to avoid making.
const key = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

(async () => {
  const props = await selectAll(() => db.from('properties').select('id,property_name'),
    { label: 'properties' });
  const byName = new Map();
  props.forEach(p => {
    const k = key(p.property_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  });

  const rows = await selectAll(() => db.from('dm_reviews')
    .select('id,property_id,agent_name,reviewed_at,updated_at,ai_filled')
    .gte('updated_at', FROM).lte('updated_at', TO + 'T23:59:59.999Z'), { label: 'dm_reviews' });

  console.log('dm_reviews in ' + FROM + '..' + TO + ': ' + rows.length);
  console.log('  with an agent already: ' + rows.filter(r => r.agent_name).length);
  console.log('  AI-filled            : ' + rows.filter(r => r.ai_filled).length);
  console.log("Katie's list            : " + PROPERTIES.length + ' properties\n');

  const nameOf = new Map(props.map(p => [p.id, p.property_name]));
  const plan = [], problems = [];

  for (const want of PROPERTIES) {
    const candidates = byName.get(key(want)) || [];
    if (candidates.length === 0) { problems.push({ want, why: 'no property with that name' }); continue; }
    if (candidates.length > 1) {
      problems.push({ want, why: candidates.length + ' properties share that name — cannot tell them apart' });
      continue;
    }
    const pid = candidates[0].id;
    const matches = rows.filter(r => r.property_id === pid);
    if (matches.length === 0) { problems.push({ want, why: 'no dm_review for it on those dates' }); continue; }
    if (matches.length > 1) { problems.push({ want, why: matches.length + ' reviews on those dates — cannot tell which' }); continue; }
    const row = matches[0];
    if (row.agent_name) { problems.push({ want, why: 'already attributed to ' + row.agent_name }); continue; }
    plan.push({ want, id: row.id, when: String(row.updated_at).slice(0, 16).replace('T', ' ') });
  }

  console.log('MATCHED ONE TO ONE: ' + plan.length + ' of ' + PROPERTIES.length);
  plan.forEach(p => console.log('   ' + p.when + '  ' + p.want));

  // Reviews in the window that Katie's list does not account for. Reported,
  // never touched: an unexplained row is the thing most worth seeing.
  const claimed = new Set(plan.map(p => p.id));
  const extra = rows.filter(r => !claimed.has(r.id));
  if (extra.length) {
    console.log('\nIN THE WINDOW BUT NOT ON HER LIST — left alone: ' + extra.length);
    extra.forEach(r => console.log('   ' + String(r.updated_at).slice(0, 16).replace('T', ' ')
      + '  ' + (nameOf.get(r.property_id) || '(unknown property ' + r.property_id + ')')
      + (r.agent_name ? '   [' + r.agent_name + ']' : '')));
  }

  if (problems.length) {
    console.log('\nDID NOT MATCH — nothing will be written for these: ' + problems.length);
    problems.forEach(p => console.log('   ' + p.want + '  ->  ' + p.why));
  }

  if (plan.length !== PROPERTIES.length) {
    console.log('\n' + plan.length + ' of ' + PROPERTIES.length + ' matched. Not all seventeen line up.');
    if (WRITE) {
      console.log('REFUSING TO WRITE A PARTIAL SET — the instruction was all seventeen or none.');
      console.log('Report the misses above, then decide.');
      process.exit(3);
    }
  }

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  let done = 0;
  const failed = [];
  for (const p of plan) {
    // Guarded on agent_name still being null: if anything attributed this row
    // between the dry run and now, it is not ours to overwrite.
    const { data, error } = await db.from('dm_reviews')
      .update({ agent_name: AGENT }).eq('id', p.id).is('agent_name', null).select('id');
    if (error) { failed.push({ want: p.want, error: error.message }); continue; }
    if (!data || !data.length) { failed.push({ want: p.want, error: 'no longer unattributed — left alone' }); continue; }
    done++;
  }
  console.log('\nattributed to ' + AGENT + ': ' + done + ' of ' + plan.length);
  if (failed.length) { console.log('not written:'); failed.forEach(f => console.log('   ' + f.want + ': ' + f.error)); }

  const after = await selectAll(() => db.from('dm_reviews').select('agent_name')
    .gte('updated_at', FROM).lte('updated_at', TO + 'T23:59:59.999Z'), { label: 'verify' });
  console.log('verified in window: ' + after.filter(r => r.agent_name === AGENT).length + ' now credited to ' + AGENT
    + ', ' + after.filter(r => !r.agent_name).length + ' still unattributed');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
