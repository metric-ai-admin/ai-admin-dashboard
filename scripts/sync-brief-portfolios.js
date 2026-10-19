#!/usr/bin/env node
//
// Fill brief_portfolios from the portfolio groups the KPI report already uses.
//
//   node scripts/sync-brief-portfolios.js            # DRY RUN
//   node scripts/sync-brief-portfolios.js --write
//
// ONE SOURCE, NOT TWO. Kara's projected-occupancy section has been printing
// "not split yet — waiting on Kara to say which properties belong to each"
// since it was built. The split already existed: lib/kpi-report.js has carried
// VIRTUAL_GROUPS.Greystone and ROUND_ROCK since long before, and the KPI
// report has been rolling up by them the whole time.
//
// CONFIRMED AGAINST JAY'S DASHBOARD, 2026-10-19. His cv-live.js defines
// CV_PROPERTY_GROUPS as Greystone Properties = Sunset Palms, The Highlander,
// Hyde Park Square, The Chateau — the same four, independently. Two systems
// that agree without having been compared is the strongest evidence available
// that the grouping is the real one.
//
// So this copies from kpi-report rather than restating the membership. A list
// typed out a second time is a list that will drift from the first, which is
// why the exclusion fragments and the leasing goals were both pulled into
// libs this month.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const KPI = require('../lib/kpi-report.js');

const WRITE = process.argv.includes('--write');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pad = (s, w) => String(s).padEnd(w);

// { property -> portfolio }, from the KPI report's own definitions.
function rowsFromKpi() {
  const out = [];
  Object.entries(KPI.VIRTUAL_GROUPS || {}).forEach(([portfolio, members]) => {
    (members || []).forEach(property => out.push({ property, portfolio }));
  });
  const rr = KPI.ROUND_ROCK;
  if (rr && rr.name) {
    (rr.members || []).forEach(property => out.push({ property, portfolio: rr.name }));
  }
  return out;
}

(async () => {
  const rows = rowsFromKpi();
  if (!rows.length) {
    console.error('kpi-report exported no groups — refusing to write an empty split.');
    process.exitCode = 1;
    return;
  }

  console.log('FROM lib/kpi-report.js');
  const byPortfolio = {};
  rows.forEach(r => { (byPortfolio[r.portfolio] = byPortfolio[r.portfolio] || []).push(r.property); });
  Object.entries(byPortfolio).forEach(([p, members]) =>
    console.log('   ' + pad(p, 14) + members.join(', ')));

  // ---- which properties the brief will still have no portfolio for ---------
  //
  // NAMED, NOT COUNTED. The brief prints its ungrouped list, and a property
  // that quietly belongs to nothing looks exactly like one nobody has decided
  // about yet.
  const { data: live, error: liveErr } = await db.from('leasing_occupancy')
    .select('property_name');
  if (!liveErr) {
    const EX = require('../lib/excluded-properties.js');
    const assigned = new Set(rows.map(r => r.property.toLowerCase()));
    const missing = (live || [])
      .map(r => String(r.property_name || '').trim())
      .filter(n => n && !EX.propertyIsExcluded(n) && !assigned.has(n.toLowerCase()));
    if (missing.length) {
      console.log('\n   NOT IN ANY PORTFOLIO: ' + [...new Set(missing)].join(', '));
      console.log('   The brief will list these as ungrouped, which is the honest');
      console.log('   answer until somebody says where they belong.');
    }
  }

  const { data: existing } = await db.from('brief_portfolios').select('property,portfolio');
  console.log('\n   brief_portfolios currently holds ' + ((existing || []).length) + ' row(s)');

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Add --write to store '
      + rows.length + ' rows.');
    return;
  }

  // Upsert on property: re-running replaces an assignment rather than
  // doubling it, and a property moved between portfolios follows.
  const { error } = await db.from('brief_portfolios')
    .upsert(rows.map(r => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: 'property' });
  if (error) throw new Error(error.message);
  console.log('\nstored: ' + rows.length + ' rows.');
  console.log('Nothing was removed: a property dropped from kpi-report keeps its');
  console.log('row here until somebody deletes it on purpose.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
