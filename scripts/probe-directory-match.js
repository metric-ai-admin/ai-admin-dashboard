#!/usr/bin/env node
//
// HOW BIG IS THE "no number on file" GAP on the Collections cards?
//
// READ ONLY. Two GETs against the live dashboard's report store
// (/api/appfolio/reports/:id/data, paged) and nothing else. No AppFolio
// request, no Supabase query, no write anywhere.
//
//   node scripts/probe-directory-match.js
//   node scripts/probe-directory-match.js --base https://ai-admin-dashboard-jkde.onrender.com
//
// COUNTS ONLY. No resident name, no unit, no phone number and no balance is
// printed — not in the summary, not in the per-property table, not in the
// diagnostics. Property names are ours and do appear, because the point of
// this probe is to say WHICH properties the gap lives on.
//
// WHAT IT IS MEASURING. The card looks up calls on the numbers that
// CM.numbersFor() can find: the delinquency row's own phone first, then the
// tenant directory's numbers for that property+unit, then for that name. When
// that list comes back empty the card says "no number on file" and no call
// history can ever be shown, however good the history feature is.
//
// The suspected cause is that tenant_directory is pulled with
// `property_visibility: 'active'`, so a resident on an inactive property — or
// one who has moved out and still owes — is absent from the directory while
// staying on the delinquency report. That is a guess until it is counted,
// which is what the D/C split below is for:
//
//   D  no number anywhere AND the name is not in the directory at all
//      -> consistent with the active-only filter. This is the group that
//         item 5 would be for.
//   C  no number anywhere BUT the name IS in the directory
//      -> the directory row exists and simply carries no phone. Widening
//         property_visibility would not fix one of these.
//
// Telling them apart matters because they have different fixes, and a single
// "N accounts have no number" total would hide that completely.

'use strict';

require('dotenv').config();

const CM = require('../lib/call-match.js');
const TD = require('../lib/tenant-directory.js');
const CT = require('../collections-triggers.js');
const EXCLUDED = require('../lib/excluded-properties.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = String(arg('base', process.env.PROBE_BASE_URL
  || 'https://ai-admin-dashboard-jkde.onrender.com')).replace(/\/+$/, '');
const KEY = process.env.METRIC_API_KEY || '';

// COPIED, NOT IMPORTED, and that is a liability worth naming. server.js:5436
// defines this inline and exports nothing, so there is no way to require it.
// If that list ever grows and this one does not, the denominator below silently
// includes accounts whose cards never show call data at all.
const EXTERNALLY_MANAGED_FRAGMENTS = ['cedar and sage'];
const isExternallyManaged = name =>
  EXTERNALLY_MANAGED_FRAGMENTS.some(f => String(name || '').toLowerCase().includes(f));

const clean = s => String(s == null ? '' : s).trim();

async function fetchRows(id) {
  const out = [];
  for (let offset = 0, guard = 0; guard < 50; guard++) {
    const url = `${BASE}/api/appfolio/reports/${id}/data?limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: KEY ? { 'x-metric-key': KEY } : {} });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const rows = j.rows || [];
    out.push(...rows);
    // `total` is the store's own row count, so this stops on the real end
    // rather than on a short page that happens to be exactly 1000.
    if (out.length >= (j.total || 0) || !rows.length) {
      return { rows: out, syncedAt: j.syncedAt || j.synced_at || j.at || null, total: j.total };
    }
    offset += rows.length;
  }
  return { rows: out, syncedAt: null, total: out.length };
}

(async () => {
  console.log('READ ONLY — two GETs against ' + BASE + ', nothing written.\n');

  const dq = await fetchRows('delinquency_as_of');
  const dir = await fetchRows('tenant_directory');
  console.log('delinquency_as_of : ' + dq.rows.length + ' rows'
    + (dq.syncedAt ? '   synced ' + dq.syncedAt : ''));
  console.log('tenant_directory  : ' + dir.rows.length + ' rows'
    + (dir.syncedAt ? '   synced ' + dir.syncedAt : ''));

  // The directory, indexed exactly as the card indexes it.
  const dirIndex = CM.indexDirectory(dir.rows);
  const withPhones = dir.rows.filter(r => (r.phones || TD.phonesOfRow(r)).length).length;
  console.log('  directory rows carrying at least one phone: ' + withPhones
    + ' of ' + dir.rows.length);

  // Every name the directory knows, for the C/D split. Lower-cased only; the
  // set is counted, never printed.
  const dirNames = new Set(dir.rows.map(r => TD.nameOf(r).toLowerCase()).filter(Boolean));
  const dirUnits = new Set(dir.rows
    .map(r => TD.propertyOf(r).toLowerCase() + '|' + TD.unitOf(r).toLowerCase())
    .filter(k => k !== '|'));

  // The denominator: the accounts whose cards could show call history. The
  // excluded properties are not on the board at all, and the externally
  // managed ones get `calls: null` in decisionQueueData — neither is a gap.
  const buckets = { A: 0, B: 0, C: 0, D: 0 };
  const noNumberByProperty = new Map();
  let excluded = 0, external = 0, considered = 0;

  for (const row of dq.rows) {
    // THE `.phone` HAS TO BE BUILT HERE. shapeAccount returns `phones` — the
    // raw combined string — and buildDecisionQueue is what turns it into
    // `.phone` via primaryPhone(). CM.numbersFor() reads `.phone`, so handing
    // it a bare shapeAccount makes every single account look like it has no
    // number on the row: the first run of this probe reported 0 in bucket A
    // and 72 in D, which is not a finding, it is this line missing.
    const shaped = CT.shapeAccount(row);
    const a = { ...shaped, phone: CT.primaryPhone(shaped.phones) };
    if (EXCLUDED.propertyIsExcluded(a.property)) { excluded++; continue; }
    if (isExternallyManaged(a.property)) { external++; continue; }
    considered++;

    const rowPhone = CM.normPhone(a.phone && a.phone.tel ? a.phone.tel : a.phone);
    const all = CM.numbersFor(a, dirIndex);

    if (rowPhone) { buckets.A++; continue; }
    if (all.length) { buckets.B++; continue; }

    const name = clean(a.name).toLowerCase();
    const unitKey = clean(a.property).toLowerCase() + '|' + clean(a.unit).toLowerCase();
    const known = dirNames.has(name) || dirUnits.has(unitKey);
    buckets[known ? 'C' : 'D']++;

    const p = clean(a.property) || '(no property on row)';
    const e = noNumberByProperty.get(p) || { C: 0, D: 0 };
    e[known ? 'C' : 'D']++;
    noNumberByProperty.set(p, e);
  }

  const gap = buckets.C + buckets.D;
  console.log('\nDELINQUENT ACCOUNTS');
  console.log('  on the report            : ' + dq.rows.length);
  console.log('  excluded property        : ' + excluded + '  (not on the board)');
  console.log('  externally managed       : ' + external + '  (card says no phone system)');
  console.log('  considered               : ' + considered);
  console.log('\nCAN THE CARD FIND A NUMBER?');
  console.log('  A  phone on the delinquency row    : ' + buckets.A);
  console.log('  B  no row phone, directory has one : ' + buckets.B);
  console.log('  C  no number, name IS in directory : ' + buckets.C);
  console.log('  D  no number, name NOT in directory: ' + buckets.D);
  console.log('  ------------------------------------');
  console.log('  THE GAP (C + D)                    : ' + gap
    + (considered ? '   ' + Math.round((gap / considered) * 1000) / 10 + '% of considered' : ''));
  console.log('  of which the active-only filter could explain (D): ' + buckets.D);

  if (noNumberByProperty.size) {
    console.log('\nTHE GAP BY PROPERTY  (C = in directory, no phone; D = absent from directory)');
    [...noNumberByProperty.entries()]
      .sort((x, y) => (y[1].C + y[1].D) - (x[1].C + x[1].D))
      .forEach(([p, e]) => console.log('  ' + String(p).padEnd(34)
        + 'C ' + String(e.C).padStart(3) + '   D ' + String(e.D).padStart(3)));
  }

  console.log('\nNo resident name, unit, phone or balance was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
