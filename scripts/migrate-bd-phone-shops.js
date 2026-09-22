// Migrate bd_phone_shops -> phone_shops.
//
// WHY: the BD CRM property page reads phone_shops only (server.js:6997), so the
// 335 historical calls imported into bd_phone_shops on 2026-09-03 are invisible
// on every property. That is the "0 call(s) logged" Katie reported on The
// Victoria, which actually has two calls in the other table.
//
//   node scripts/migrate-bd-phone-shops.js            # dry run, writes nothing
//   node scripts/migrate-bd-phone-shops.js --apply    # insert
//
// Idempotent: every migrated row carries its bd external_id inside notes JSON,
// and the script skips any external_id already present in phone_shops. Re-running
// is safe.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes('--apply');

const page = async (t, s) => { let a = []; for (let f = 0; ; f += 1000) { const { data, error } = await db.from(t).select(s).range(f, f + 999); if (error) throw new Error(t + ': ' + error.message); a = a.concat(data || []); if ((data || []).length < 1000) break; } return a; };

// bd's connection vocabulary is finer-grained than the UI's. CRM_CONN_LABEL in
// public/app.js knows answered_agent, answered_ai, voicemail, no_answer,
// wrong_number and not_working — so bd's no_answer_vm / no_answer_no_vm would
// render as blank badges if carried across unchanged.
const CONNECTION_MAP = {
  answered_agent: 'answered_agent',
  answered_ai: 'answered_ai',
  not_working: 'not_working',
  no_answer_vm: 'voicemail',     // rang out, voicemail reached
  no_answer_no_vm: 'no_answer',  // rang out, no voicemail offered
};

// Property-name matching for the rows bd never linked. Deliberately
// conservative: exact match on a normalised name, then again with any trailing
// parenthetical removed ("Stadium View Apartments (100 Warden Ln)"). No fuzzy
// or partial matching — a wrong link puts someone else's call on a property
// page, which is worse than leaving it unlinked and reported.
const norm = s => String(s || '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const stripParen = s => String(s || '').replace(/\s*\([^)]*\)\s*$/, '');

(async () => {
  const [bd, props, existing] = await Promise.all([
    page('bd_phone_shops', '*'),
    page('properties', 'id,property_name'),
    page('phone_shops', 'id,notes'),
  ]);

  console.log(`BEFORE  bd_phone_shops ${bd.length} | phone_shops ${existing.length} | properties ${props.length}`);

  const byName = new Map();
  for (const p of props) {
    byName.set(norm(p.property_name), p.id);
    byName.set(norm(stripParen(p.property_name)), p.id);
  }

  // Already migrated? external_id is stored inside the notes JSON.
  const done = new Set();
  for (const r of existing) {
    try { const n = JSON.parse(r.notes); if (n && n.external_id) done.add(n.external_id); } catch { /* plain-text note */ }
  }

  const rows = [], unmatched = [], skipped = [], nameMatches = [];
  const propNameById = new Map(props.map(p => [p.id, p.property_name]));
  let linkedDirect = 0, linkedByName = 0;

  for (const r of bd) {
    if (done.has(r.external_id)) { skipped.push(r.external_id); continue; }

    let propertyId = r.property_id || null;
    if (propertyId) linkedDirect++;
    else {
      propertyId = byName.get(norm(r.property)) || byName.get(norm(stripParen(r.property))) || null;
      if (propertyId) { linkedByName++; nameMatches.push(`${r.property}  ->  ${propNameById.get(propertyId)}`); }
    }
    if (!propertyId) { unmatched.push(r.property); continue; }

    const notes = { connection: CONNECTION_MAP[r.connection] || null, text: r.notes || '' };
    if (r.appt_set) notes.appointment_set = r.appt_set;
    if (r.recording === 'yes') notes.recording = 'yes';
    // Provenance: makes this script idempotent and keeps the bd id recoverable
    // after the source table is dropped.
    notes.source = 'bd_phone_shops';
    notes.external_id = r.external_id;

    rows.push({
      property_id: propertyId,
      shop_date: r.shop_date || null,
      agent_name: r.agent || null,
      caller_name: r.caller || null,
      call_time: r.shop_time || null,
      score: r.call_score == null ? null : Number(r.call_score),
      notes: JSON.stringify(notes),
      phone_number_version: 0,   // every property is on version 0
    });
  }

  // ---- report
  const connTally = {};
  rows.forEach(r => { const c = JSON.parse(r.notes).connection || '(null)'; connTally[c] = (connTally[c] || 0) + 1; });
  console.log(`\nMAPPED ${rows.length} of ${bd.length}`);
  console.log(`  property_id already set : ${linkedDirect}`);
  console.log(`  matched by name         : ${linkedByName}`);
  console.log(`  UNMATCHED (not migrated): ${unmatched.length}`);
  console.log(`  already migrated (skip) : ${skipped.length}`);
  console.log('  connection after mapping:', JSON.stringify(connTally));
  if (nameMatches.length) {
    console.log('\n  name matches (verify these are the same property):');
    [...new Set(nameMatches)].forEach(m => console.log('    ' + m));
  }

  if (unmatched.length) {
    const u = {}; unmatched.forEach(n => { u[n] = (u[n] || 0) + 1; });
    console.log('\n  unmatched property names (top 15):');
    Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([n, c]) => console.log(`    ${String(c).padStart(3)}  ${n}`));
  }

  const VIC = '747cf6a0-a13f-4a33-9bdf-f5563ff89210';
  const vic = rows.filter(r => r.property_id === VIC);
  console.log(`\n  The Victoria rows to insert: ${vic.length}`);
  vic.forEach(r => console.log(`    ${r.shop_date} agent=${JSON.stringify(r.agent_name)} notes=${r.notes}`));

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to insert.'); return; }

  console.log('\nINSERTING…');
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await db.from('phone_shops').insert(chunk);
    if (error) { console.error('  chunk failed:', error.message); process.exit(1); }
    inserted += chunk.length;
    console.log(`  ${inserted}/${rows.length}`);
  }
  const after = await page('phone_shops', 'id');
  console.log(`\nAFTER   phone_shops ${after.length} (was ${existing.length}, +${after.length - existing.length})`);
})();
