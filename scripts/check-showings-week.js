#!/usr/bin/env node
// READ ONLY. leasing_showings for a week, per property and status, against
// Katie's sheet. Writes nothing.
//
//   node scripts/check-showings-week.js [start] [end]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');

const START = process.argv[2] || '2026-09-27';
const END = process.argv[3] || '2026-10-03';

// Her showings tab for 09/27-10/03, per property.
const HERS = {
  'Ascent at Northgate': 5, 'Hyde Park Square': 3, 'Sunset Palms': 2,
  'The Chateau': 1, 'The Highlander': 2, 'Windy Hill Apartment': 9,
  'iConic Downtown': 4,
};

(async () => {
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  const rows = await selectAll(() => db.from('leasing_showings')
    .select('property_name,showing_date,status,prospect,unit')
    .gte('showing_date', START).lte('showing_date', END), { label: 'showings' });

  const byProp = {}, statusOf = {};
  rows.forEach(r => {
    const p = r.property_name || '(none)';
    byProp[p] = (byProp[p] || 0) + 1;
    const s = String(r.status || '(blank)');
    (statusOf[p] = statusOf[p] || {})[s] = (statusOf[p][s] || 0) + 1;
  });

  const props = [...new Set([...Object.keys(HERS), ...Object.keys(byProp)])].sort();
  console.log(START + ' .. ' + END + '\n');
  console.log('  property                      hers   ours   ');
  let ours = 0, hers = 0, bad = 0;
  for (const p of props) {
    const h = HERS[p] == null ? '-' : HERS[p];
    const o = byProp[p] || 0;
    ours += o; if (HERS[p]) hers += HERS[p];
    const ok = HERS[p] == null ? (o === 0 ? 'ok' : 'EXTRA') : (o === HERS[p] ? 'ok' : 'MISMATCH');
    if (ok !== 'ok') bad++;
    console.log('  ' + p.padEnd(28) + String(h).padStart(5) + String(o).padStart(7) + '   ' + ok);
    if (statusOf[p]) console.log('      ' + JSON.stringify(statusOf[p]));
  }
  console.log('\n  TOTAL' + String(hers).padStart(28) + String(ours).padStart(7)
    + (ours === hers && !bad ? '   26 = 26 per property' : '   ' + bad + ' property/properties off'));

  // The five she has that we were missing, by name.
  const completed = rows.filter(r => /complete/i.test(String(r.status || '')));
  console.log('\n  Completed in the week: ' + completed.length);
  ['The Highlander', 'Windy Hill Apartment'].forEach(p => {
    const mine = completed.filter(r => r.property_name === p);
    console.log('    ' + p + ': ' + mine.length
      + (mine.length ? ' — ' + mine.map(r => r.prospect || '(no name)').join(', ') : ''));
  });
})().catch(e => { console.error(e.message); process.exit(1); });
