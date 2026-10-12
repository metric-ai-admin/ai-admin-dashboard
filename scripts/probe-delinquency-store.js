#!/usr/bin/env node
//
// What the delinquency_kpi store actually carries. READ ONLY.
//
//   node scripts/probe-delinquency-store.js
//
// WHY. On 2026-10-12 the comparison read evictionsInProcess 34 on Katie's side
// against 2 on ours, where the week before both read 25. Our side counts rows
// the feed marks tenant_status = Evict, so either those residents left that
// status in a week — implausible — or the store is not holding what we think.
//
// The eviction STAGE is a separate question and already answered: the
// delinquency report does not return it, which is why needToFile is now
// reported as unavailable instead of as a zero. This is about the other half.
//
// NO RESIDENT NAMES. The question is how many rows carry which status and what
// the columns are called, and a name answers none of it.
require('dotenv').config();

const clean = s => String(s == null ? '' : s).trim();

(async () => {
  let data;
  try {
    data = await require('../appfolio-reports.js').readReportData('delinquency_kpi');
  } catch (e) { console.error('Could not read the store: ' + e.message); process.exit(1); }
  if (!data) {
    console.error('No delinquency_kpi store on this machine — run this on Render.');
    process.exit(2);
  }
  const rows = data.rows || [];
  console.log('delinquency_kpi: ' + rows.length + ' rows, fetched ' + (data.fetchedAt || '(unknown)'));
  console.log('params it was fetched with: ' + JSON.stringify(data.params || {}));
  console.log('\nThe filter should be tenant_statuses ["0","4","3"] = Current + Notice + Evict.');
  console.log('If Evict ("3") is missing from it, that alone explains the drop.\n');

  if (!rows.length) { console.log('The store is empty. That is the answer.'); return; }

  console.log('columns: ' + Object.keys(rows[0]).join(' | '));

  const tally = (label, pick) => {
    const t = {};
    rows.forEach(r => { const v = clean(pick(r)) || '(blank)'; t[v] = (t[v] || 0) + 1; });
    console.log('\n' + label);
    Object.entries(t).sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log('   ' + String(n).padStart(5) + '  ' + k));
  };

  tally('tenant_status — ours counts "Evict":', r => r.tenant_status);
  tally('eviction_status — blank on every row is the expected answer:', r => r.eviction_status);

  const evict = rows.filter(r => clean(r.tenant_status) === 'Evict');
  console.log('\nrows at tenant_status = Evict: ' + evict.length
    + '   (this is what the report reports as evictionsInProcess)');

  // Per property, so a drop can be placed rather than just counted.
  const byProp = {};
  evict.forEach(r => {
    const p = clean(r.property_name || r.property) || '(no property)';
    byProp[p] = (byProp[p] || 0) + 1;
  });
  Object.entries(byProp).sort((a, b) => b[1] - a[1])
    .forEach(([p, n]) => console.log('   ' + String(n).padStart(4) + '  ' + p));

  // Her rule counts any delinquent tenant with a stage set. If the stage is
  // blank here, our side cannot answer her question from this feed at all —
  // which is a sourcing decision, not a bug to patch in the comparison.
  const withStage = rows.filter(r => clean(r.eviction_status));
  console.log('\nrows carrying an eviction stage: ' + withStage.length);
  if (!withStage.length) {
    console.log('None — as expected. Her 34 comes from Occupancy Custom Fields,');
    console.log('which this dashboard does not sync. Matching her number means');
    console.log('syncing that report, not changing the comparison.');
  }
  console.log('\nNothing was written. This script only reads.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
