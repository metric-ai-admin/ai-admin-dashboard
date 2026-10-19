#!/usr/bin/env node
//
// Remove one watchlist row, after keeping it.
//
//   node scripts/remove-watchlist-duplicate.js <id>            # DRY RUN
//   node scripts/remove-watchlist-duplicate.js <id> --keep <keep-id> --write
//
// WHY A SCRIPT AND NOT A DELETE IN THE SQL EDITOR. The row has to be in
// code_violation_watchlist_history BEFORE it goes, and the two steps have to
// be in that order with the second refusing if the first did not happen. A
// delete typed by hand is one statement and one chance to forget.
//
// IT REFUSES WITHOUT THE HISTORY TABLE. Migration 106 is not optional here:
// deleting with nothing behind it is the thing this exists to prevent.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const ID = process.argv[2];
const WRITE = process.argv.includes('--write');
const KEEP = (() => { const i = process.argv.indexOf('--keep'); return i > -1 ? process.argv[i + 1] : null; })();
const REASON = (() => { const i = process.argv.indexOf('--reason'); return i > -1 ? process.argv[i + 1] : null; })();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  if (!ID) {
    console.error('Pass the watchlist id to remove.');
    process.exitCode = 1;
    return;
  }

  const { data: row, error } = await db.from('code_violation_watchlist')
    .select('*').eq('id', ID).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) {
    console.log('No watchlist row has id ' + ID + '. Nothing to do.');
    return;
  }

  // The row being kept, so the reason can name it and a reader can see both.
  let keep = null;
  if (KEEP) {
    const r = await db.from('code_violation_watchlist').select('*').eq('id', KEEP).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    keep = r.data;
    if (!keep) throw new Error('--keep ' + KEEP + ' does not exist; refusing to remove anything.');
  }

  const { count: before } = await db.from('code_violation_watchlist')
    .select('*', { count: 'exact', head: true });

  console.log('REMOVE');
  console.log('   ' + row.id);
  console.log('   ' + row.property_name + '   WO ' + (row.work_order || '—'));
  console.log('   ' + String(row.title || '').slice(0, 70));
  if (keep) {
    console.log('\nKEEP');
    console.log('   ' + keep.id);
    console.log('   ' + keep.property_name + '   WO ' + (keep.work_order || '—'));
    console.log('   ' + String(keep.title || '').slice(0, 70));
  }
  console.log('\nwatchlist rows: ' + before + ' now, ' + (before - 1) + ' after.');

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written and nothing deleted. Add --write.');
    return;
  }

  // ---- keep it first --------------------------------------------------------
  const reason = REASON || (keep ? 'duplicate of ' + keep.id : 'removed by hand');
  const { error: hErr } = await db.from('code_violation_watchlist_history').insert({
    watchlist_id: row.id,
    previous: row,
    property_name: row.property_name,
    work_order: row.work_order,
    title: row.title,
    reason,
    removed_by: process.env.USER || process.env.USERNAME || 'script',
  });
  if (hErr) {
    if (/code_violation_watchlist_history/.test(hErr.message || '')) {
      throw new Error('run supabase/migrations/106_code_violation_watchlist_history.sql '
        + 'first — nothing is deleted without somewhere to put it');
    }
    throw new Error('history: ' + hErr.message);
  }

  // READ IT BACK. The delete happens only if the copy is really there; an
  // insert that reported no error and stored nothing would otherwise take the
  // row with it.
  const { data: saved, error: readErr } = await db.from('code_violation_watchlist_history')
    .select('id,previous').eq('watchlist_id', row.id).order('removed_at', { ascending: false }).limit(1);
  if (readErr) throw new Error('verifying the copy: ' + readErr.message);
  if (!saved || !saved.length || !saved[0].previous) {
    throw new Error('the history row is not readable back — refusing to delete');
  }
  console.log('\nkept: history row ' + saved[0].id);

  const { error: dErr } = await db.from('code_violation_watchlist').delete().eq('id', row.id);
  if (dErr) throw new Error('delete: ' + dErr.message);

  const { count: after } = await db.from('code_violation_watchlist')
    .select('*', { count: 'exact', head: true });
  console.log('deleted: 1 row. watchlist now holds ' + after + '.');
  console.log('Put it back from code_violation_watchlist_history.previous if this was wrong.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
