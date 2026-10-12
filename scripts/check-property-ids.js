#!/usr/bin/env node
//
// Re-derive the AppFolio property-id map from live data. READ ONLY.
//
//   node scripts/check-property-ids.js
//
// lib/appfolio-properties.js is a hard-coded table, and a hard-coded table of
// somebody else's identifiers goes stale the first time a property is added or
// renamed. This checks it against the rows this dashboard has already synced,
// where each id travels next to its own name.
//
// Exits non-zero when the map disagrees with the data or when an id appears in
// the data that the map does not carry, so it can be run from a check.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const AFP = require('../lib/appfolio-properties.js');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// Every table that carries an AppFolio property id beside a name. More than
// one on purpose: a single table agreeing with the map proves only that the
// map was copied from it.
const SOURCES = [
  ['leasing_occupancy', 'property_id', 'property_name'],
  ['leasing_leads', 'property_id', 'property'],
  ['leasing_showings', 'property_id', 'property_name'],
  ['leasing_applications', 'property_id', 'property_name'],
  ['leasing_lease_history', 'property_id', 'property_name'],
  ['maintenance_work_orders', 'property_id', 'property_name'],
];

const clean = s => String(s == null ? '' : s).trim();

(async () => {
  // id -> name -> the tables that said so
  const seen = new Map();
  for (const [table, idCol, nameCol] of SOURCES) {
    let rows;
    try {
      rows = await selectAll(() => db.from(table).select(idCol + ',' + nameCol), { label: table });
    } catch (e) { console.log(table.padEnd(26) + 'unreadable — ' + e.message); continue; }
    let used = 0;
    rows.forEach(r => {
      const id = clean(r[idCol]);
      // The name as every other surface spells it: the part before " - ".
      const name = AFP.resolveProperty(r[nameCol]);
      if (!id || !name) return;
      used++;
      if (!seen.has(id)) seen.set(id, new Map());
      const names = seen.get(id);
      if (!names.has(name)) names.set(name, []);
      names.get(name).push(table);
    });
    console.log(table.padEnd(26) + used + ' rows carried both');
  }

  console.log('\nid    name                        tables  verdict');
  let bad = 0;
  const ids = [...seen.keys()].sort((a, b) => Number(a) - Number(b));
  ids.forEach(id => {
    const names = seen.get(id);
    const mapped = AFP.nameForId(id);
    if (names.size > 1) {
      bad++;
      console.log(id.padEnd(6) + '** ' + [...names.keys()].join(' / ') + '   SAME ID, TWO NAMES');
      return;
    }
    const name = [...names.keys()][0];
    const n = names.get(name).length;
    let verdict;
    if (mapped === name) verdict = 'ok';
    else if (mapped === null) { verdict = 'NOT IN THE MAP — add it'; bad++; }
    else { verdict = 'MAP SAYS "' + mapped + '"'; bad++; }
    console.log(id.padEnd(6) + name.padEnd(28) + String(n).padStart(5) + '   ' + verdict);
  });

  // The other direction: an entry nobody uses any more. Not a failure — a
  // property can leave and its id stays valid history — but worth seeing.
  const unused = Object.keys(AFP.BY_ID).filter(id => !seen.has(String(id)));
  if (unused.length) {
    console.log('\nin the map but absent from every synced table (left alone):');
    unused.forEach(id => console.log('   ' + id + '  ' + AFP.BY_ID[id]));
  }

  console.log('\nmap verified on ' + AFP.VERIFIED_ON + '; ' + ids.length + ' ids seen today, '
    + bad + ' disagreement' + (bad === 1 ? '' : 's'));
  if (bad) process.exit(1);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
