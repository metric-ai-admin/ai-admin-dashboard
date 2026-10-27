#!/usr/bin/env node
//
// Today's security deposits, and which ones stopped being held.
//
//   node scripts/sync-deposit-snapshot.js            # DRY RUN
//   node scripts/sync-deposit-snapshot.js --write
//
// The report lists what is held TODAY with no settlement date and no history,
// so the date is derived: a row that was here yesterday and is gone today was
// settled between those two runs. That makes the ABSENCE of a row the signal,
// and an absence is exactly what a broken fetch produces.
//
// SO NOTHING IS SETTLED FROM A FEED THAT CAME BACK SHORT. A run that returns
// zero rows — rate limit, changed filter, expired token — would settle all 215
// deposits on the same day and the brief would report a perfect week on the
// morning the sync broke. The guard is in lib/fas-deposits.js and the refusal
// is written to deposit_sync_runs, because a day nobody measured has to be a
// day the brief can say nobody measured.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const FAS = require('../lib/fas-deposits.js');
const AFP = require('../lib/appfolio-properties.js');
const AR = require('../appfolio-reports.js');

const WRITE = process.argv.includes('--write');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const MAX_DROP = Number(arg('max-drop', 20));

const db = () => createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const clean = s => String(s === null || s === undefined ? '' : s).trim();
const ymd = v => clean(v).slice(0, 10) || null;
const todayCT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// occupancy_id -> property name, through the store that carries both.
//
// A DEPOSIT THAT WILL NOT RESOLVE IS KEPT. The brief groups by property and
// this report has no property column; a row we cannot place is a real
// move-out, and dropping it would make it vanish from a report whose entire
// job is to notice things nobody has dealt with.
async function propertyIndex(log) {
  const idx = new Map();
  let rows = [];
  try { rows = ((await AR.readReportData('occupancy_custom_fields')) || {}).rows || []; }
  catch (e) { log('occupancy_custom_fields is not readable: ' + e.message); return idx; }
  const key = r => Object.keys(r).find(k => /^occupancy[_\s]?id$/i.test(k.replace(/\s+/g, '_')));
  const propKey = r => Object.keys(r).find(k => /^property[_\s]?id$/i.test(k.replace(/\s+/g, '_')));
  if (!rows.length) { log('occupancy_custom_fields is empty — every property will be unresolved'); return idx; }
  const k = key(rows[0]);
  const pk = propKey(rows[0]);
  if (!k || !pk) { log('occupancy_custom_fields carries no occupancy/property id columns'); return idx; }
  rows.forEach(r => {
    const occ = clean(r[k]);
    const name = AFP.nameForId(clean(r[pk]));
    if (occ && name) idx.set(occ, name);
  });
  log('property index: ' + idx.size + ' occupancies mapped');
  return idx;
}

async function syncDepositSnapshot(opts) {
  const o = opts || {};
  const log = o.log || (m => console.log(m));
  const write = o.write === undefined ? WRITE : o.write;
  const day = o.today || todayCT();
  const D = db();

  // ---- the previous good run, which the guard measures against ------------
  // status_counts comes back too: the composition guard needs the SHAPE of
  // the last good run, not only its size.
  const prev = await D.from('deposit_sync_runs')
    .select('ran_on,rows_returned,status,status_counts').eq('status', 'ok')
    .order('ran_on', { ascending: false }).limit(1);
  if (prev.error) throw new Error(prev.error.message);
  const previousRows = prev.data && prev.data.length ? prev.data[0].rows_returned : 0;
  const previousOn = prev.data && prev.data.length ? prev.data[0].ran_on : null;
  const previousCounts = prev.data && prev.data.length ? prev.data[0].status_counts : null;

  // ---- today's feed -------------------------------------------------------
  let feed = null;
  let fetchError = null;
  try {
    const r = await AR.syncReport('security_deposit_funds_detail');
    if (r && r.ok === false) throw new Error(r.error || 'sync returned not ok');
    feed = ((await AR.readReportData('security_deposit_funds_detail')) || {}).rows || [];
  } catch (e) { fetchError = e.message; }

  const counts = feed ? FAS.statusCounts(feed) : null;
  const sizeGuard = FAS.feedGuard(feed ? feed.length : null, previousRows, MAX_DROP);
  // TWO GUARDS, AND EITHER ONE REFUSES. The size guard catches a feed that
  // came back short; the composition guard catches one that came back the
  // right size with a whole tenant status missing — which is what losing the
  // tenant_statuses parameter looks like, and which is a 16% fall the size
  // guard waves through. `first` is preserved so the first run still settles
  // nothing.
  const shapeGuard = feed ? FAS.compositionGuard(counts, previousCounts)
    : { ok: true, vanished: [], reason: null };
  const guard = sizeGuard.ok && !shapeGuard.ok
    ? { ok: false, status: 'suspect', first: sizeGuard.first,
        dropPct: sizeGuard.dropPct, reason: shapeGuard.reason, vanished: shapeGuard.vanished }
    : sizeGuard;

  log((write ? 'WRITE' : 'DRY RUN') + ' — deposits for ' + day);
  log('  previous good run : ' + (previousOn || 'none') + '  (' + previousRows + ' rows)');
  log('  returned today    : ' + (feed ? feed.length : 'FETCH FAILED: ' + fetchError));
  if (counts) {
    log('  by tenant_status  : '
      + Object.keys(counts).sort().map(k => k + ' ' + counts[k]).join(' · '));
  }
  log('  guard             : ' + guard.status + (guard.dropPct === null ? ''
    : '  (' + guard.dropPct + '% change)'));
  if (guard.vanished && guard.vanished.length) {
    log('  statuses vanished : ' + guard.vanished.join(', '));
  }
  if (guard.reason) log('  ' + guard.reason);

  const run = {
    ran_on: day,
    rows_returned: feed ? feed.length : null,
    status: fetchError ? 'failed' : guard.status,
    previous_rows: previousRows || null,
    drop_pct: guard.dropPct,
    status_counts: counts,
    settled: 0,
    error: fetchError || guard.reason || null,
  };

  // NOTHING IS SETTLED unless the feed is trustworthy. The run is still
  // recorded: a refusal nobody can see is the same as a day nobody noticed.
  if (!guard.ok) {
    log('  -> nothing settled. The run is recorded so the brief can say so.');
    if (write) {
      const ins = await D.from('deposit_sync_runs').insert(run);
      if (ins.error) throw new Error(ins.error.message);
    }
    return { ok: false, status: run.status, settled: 0, rows: run.rows_returned, day };
  }

  // ---- place every row, then upsert ----------------------------------------
  const idx = await propertyIndex(log);
  const seen = new Set();
  const rows = feed.map(r => {
    const occ = clean(r.occupancy_id);
    seen.add(occ);
    const name = idx.get(occ) || null;
    return {
      occupancy_id: occ,
      unit: clean(r.unit) || null,
      property: name,
      property_source: name ? 'occupancy_custom_fields' : 'unresolved',
      tenant_status: clean(r.tenant_status) || null,
      move_in: ymd(r.move_in),
      move_out: ymd(r.move_out),
      amount: clean(r.amount) === '' ? null : Number(String(r.amount).replace(/[$,]/g, '')),
      first_seen_on: day,
      last_seen_on: day,
      in_feed: true,
      gone_first_seen_on: null,
      updated_at: new Date().toISOString(),
    };
  }).filter(r => r.occupancy_id);

  const unresolved = rows.filter(r => r.property_source === 'unresolved').length;
  log('  rows to store     : ' + rows.length + '  (' + unresolved + ' with no property)');

  // What is on file now, so the ones that stopped coming back can be found.
  const held = await D.from('deposit_held').select('occupancy_id,first_seen_on,in_feed,gone_first_seen_on');
  if (held.error) throw new Error(held.error.message);
  const onFile = new Map((held.data || []).map(r => [r.occupancy_id, r]));
  const settling = (held.data || []).filter(r => r.in_feed && !seen.has(r.occupancy_id));
  log('  settled today     : ' + settling.length
    + (guard.first ? '   (first run ever — nothing can have settled yet)' : ''));
  run.settled = guard.first ? 0 : settling.length;

  if (!write) {
    log('\nDRY RUN — nothing written.');
    return { ok: true, status: 'ok', settled: run.settled, rows: rows.length, day, dryRun: true };
  }

  // first_seen_on must survive: it is the first day we ever saw this deposit,
  // and overwriting it with today would make every row look new.
  const toUpsert = rows.map(r => {
    const was = onFile.get(r.occupancy_id);
    return was && was.first_seen_on ? { ...r, first_seen_on: was.first_seen_on } : r;
  });
  const up = await D.from('deposit_held').upsert(toUpsert, { onConflict: 'occupancy_id' });
  if (up.error) throw new Error(up.error.message);

  // The tombstone. gone_first_seen_on is written ONCE — if it is already set,
  // the row left earlier and that earlier date is the one that brackets the
  // settlement.
  if (!guard.first && settling.length) {
    for (const r of settling) {
      const patch = { in_feed: false, updated_at: new Date().toISOString() };
      if (!r.gone_first_seen_on) patch.gone_first_seen_on = day;
      const u = await D.from('deposit_held').update(patch).eq('occupancy_id', r.occupancy_id);
      if (u.error) throw new Error(u.error.message);
    }
  }

  const ins = await D.from('deposit_sync_runs').insert(run);
  if (ins.error) throw new Error(ins.error.message);
  log('\nstored ' + toUpsert.length + ' held, settled ' + run.settled + '.');
  return { ok: true, status: 'ok', settled: run.settled, rows: toUpsert.length, day };
}

module.exports = { syncDepositSnapshot };

if (require.main === module) {
  syncDepositSnapshot({})
    .catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
