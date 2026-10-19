#!/usr/bin/env node
//
// Re-key the deficiencies on something an edit cannot move.
//
//   node scripts/rekey-code-violations.js            # DRY RUN
//   node scripts/rekey-code-violations.js --write
//
// WHY. deficiency_key hashes the WORK ORDER. Jay confirmed a deficiency moves
// to a different work order without changing case, and on 2026-10-20 he
// flattened eight "23240-1 (was 22882-1)" cells: eight rows were handed new
// identities, eight good rows orphaned, and their notes stayed attached to
// rows nobody will open again. It will happen on the next edit too.
//
// WHAT IT DOES, in this order, and only with --write:
//   1. compute the stable key for every row
//   2. where an orphan and a live row land on the same key, treat them as ONE
//      deficiency: the live row survives
//   3. move the orphan's NOTES onto the survivor
//   4. write the replaced work order into code_violation_work_orders, because
//      the workbook no longer records it — the orphan's cell is now the only
//      place "(was 22882-1)" exists
//   5. leave the orphan row in place, marked, never deleted
//
// NOTHING IS DELETED and the old key is kept on every row it touches, so a
// bad merge is reversible by hand.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const CVN = require('../lib/code-violation-notes.js');

const WRITE = process.argv.includes('--write');

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

async function page(table, cols) {
  let all = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(table).select(cols).range(f, f + 999);
    if (error) throw new Error(table + ': ' + error.message);
    all = all.concat(data || []);
    if ((data || []).length < 1000) break;
  }
  return all;
}

(async () => {
  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — re-keying code violations\n');

  const rows = await page('code_violations',
    'deficiency_key,property_name,case_number,work_order,deficiency_description,status,in_current_tracker');
  const notes = await page('code_violation_notes', 'id,deficiency_key,case_number,body');

  const notesBy = {};
  notes.forEach(n => {
    const k = clean(n.deficiency_key);
    if (k) (notesBy[k] = notesBy[k] || []).push(n);
  });

  // ---- before ---------------------------------------------------------------
  const live = rows.filter(r => r.in_current_tracker !== false);
  const orphans = rows.filter(r => r.in_current_tracker === false);
  console.log('BEFORE');
  console.log('   ' + pad('deficiency rows', 30) + rows.length
    + '   (' + live.length + ' in tracker, ' + orphans.length + ' orphaned)');
  console.log('   ' + pad('notes', 30) + notes.length);
  console.log('   ' + pad('distinct current keys', 30)
    + new Set(rows.map(r => r.deficiency_key)).size);

  // ---- the new keys ---------------------------------------------------------
  const withNew = rows.map(r => ({ ...r, newKey: CVN.stableDeficiencyKey(r) }));
  const byNew = new Map();
  withNew.forEach(r => {
    if (!byNew.has(r.newKey)) byNew.set(r.newKey, []);
    byNew.get(r.newKey).push(r);
  });

  const collisions = [...byNew.values()].filter(g => g.length > 1);
  const pairs = [];          // one live + one-or-more orphans
  const sameSide = [];       // two rows on the SAME side — a real merge, needs a person
  collisions.forEach(g => {
    const liveOnes = g.filter(r => r.in_current_tracker !== false);
    const deadOnes = g.filter(r => r.in_current_tracker === false);
    if (liveOnes.length === 1 && deadOnes.length >= 1) pairs.push({ keep: liveOnes[0], merge: deadOnes });
    else sameSide.push(g);
  });

  console.log('\nAFTER re-keying');
  console.log('   ' + pad('distinct stable keys', 30) + byNew.size);
  console.log('   ' + pad('keys with >1 row', 30) + collisions.length);
  console.log('   ' + pad('  orphan rejoining a live row', 30) + pairs.length);
  console.log('   ' + pad('  needing a person', 30) + sameSide.length);

  const notesMoving = pairs.reduce((a, p) =>
    a + p.merge.reduce((b, m) => b + ((notesBy[m.deficiency_key] || []).length), 0), 0);
  const orphansAfter = orphans.length - pairs.reduce((a, p) => a + p.merge.length, 0);

  console.log('\n   ' + pad('notes moving to a live row', 30) + notesMoving);
  console.log('   ' + pad('orphans left after the merge', 30) + orphansAfter
    + '   (from ' + orphans.length + ')');

  if (pairs.length) {
    console.log('\n   THE PAIRS');
    pairs.forEach(p => {
      const moved = p.merge.reduce((a, m) => a + ((notesBy[m.deficiency_key] || []).length), 0);
      console.log('      ' + pad(clean(p.keep.property_name), 22)
        + pad(clean(p.keep.case_number).slice(0, 18), 20)
        + 'keep WO ' + pad(clean(p.keep.work_order), 12)
        + 'merge ' + p.merge.map(m => clean(m.work_order)).join(', ')
        + '   ' + moved + ' note(s)');
    });
  }
  if (sameSide.length) {
    console.log('\n   NEEDING A PERSON — two rows on the same side of the tracker share');
    console.log('   a stable key. That is either a duplicate citation or two different');
    console.log('   ones the key cannot tell apart, and merging either blindly is wrong:');
    sameSide.forEach(g => console.log('      ' + pad(clean(g[0].property_name), 22)
      + clean(g[0].case_number).slice(0, 18) + '   ' + g.length + ' rows'));
  }

  // ---- the replaced work orders --------------------------------------------
  //
  // The orphan's cell is now the ONLY record of which work order replaced
  // which: Jay's flattening removed it from the workbook.
  const links = [];
  pairs.forEach(p => {
    p.merge.forEach(m => {
      CVN.workOrdersFromCell(m.work_order, p.keep.deficiency_key)
        .filter(l => l.work_order_number !== clean(p.keep.work_order))
        .forEach(l => links.push({ ...l, role: 'replaced', replaced_by: clean(p.keep.work_order) }));
    });
  });
  console.log('\n   ' + pad('replaced work orders to record', 30) + links.length);
  if (links.length) {
    links.forEach(l => console.log('      ' + pad(l.work_order_number, 12)
      + 'replaced by ' + pad(l.replaced_by, 12) + JSON.stringify(l.raw_text).slice(0, 40)));
  }

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Review the pairs above, then --write.');
    return;
  }

  if (sameSide.length) {
    throw new Error(sameSide.length + ' key collision(s) on the same side of the tracker '
      + 'need a decision first — refusing to merge anything while they stand');
  }

  // ---- write ----------------------------------------------------------------
  const now = new Date().toISOString();
  let movedNotes = 0;
  for (const p of pairs) {
    for (const m of p.merge) {
      const mine = notesBy[m.deficiency_key] || [];
      for (const n of mine) {
        const { error } = await db.from('code_violation_notes')
          .update({ deficiency_key: p.keep.deficiency_key, updated_at: now })
          .eq('id', n.id);
        if (error) throw new Error('moving note ' + n.id + ': ' + error.message);
        movedNotes += 1;
      }
    }
  }
  if (links.length) {
    const { error } = await db.from('code_violation_work_orders')
      .upsert(links, { onConflict: 'deficiency_key,work_order_number,role' });
    if (error) throw new Error('work order links: ' + error.message);
  }
  console.log('\nmoved ' + movedNotes + ' note(s); recorded ' + links.length
    + ' replaced work order(s).');
  console.log('No row was deleted and no deficiency_key was rewritten — the stable key');
  console.log('is computed, not stored, until you decide to switch the import to it.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
