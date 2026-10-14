#!/usr/bin/env node
//
// The Monday Brief, as it would be built right now. NOTHING IS SENT.
//
//   node scripts/brief-preview.js
//   node scripts/brief-preview.js --today 2026-10-14
//
// There is nothing to send: the Monday Brief is a panel, not an email, so this
// is a preview in the sense of "what would the page show", not "hold the
// message back". Kara's 6 AM brief is the one with a mailbox behind it and it
// has its own test route.
//
// WHY IT EXISTS. "Which seven days does this cover" could only be answered by
// opening the panel with the right role, and the answer is the thing most
// likely to be wrong after a rule change. --today makes it answerable for any
// date without waiting for that date.
//
// Read only. No writes, no mail.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const WB = require('../weekly-brief.js');
const WEEK = require('../lib/week.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const TODAY = arg('today', WEEK.todayYMD());

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  const af = require('../appfolio-reports.js');
  const store = async id => {
    try { const d = await af.readReportData(id); return (d && d.rows) || []; }
    catch (e) { return []; }
  };
  const [tickler, vacancy, rentRoll, leaseExpirations] = await Promise.all([
    store('tenant_tickler'), store('unit_vacancy'), store('rent_roll'),
    store('lease_expiration_detail'),
  ]);
  const lease = await db.from('leasing_lease_history')
    .select('property_name,move_in_date,tenant_name,renewal,status').limit(5000);
  const shows = await db.from('leasing_showings')
    .select('property_name,unit,prospect,showing_date,status,type').limit(5000);

  const brief = WB.buildWeeklyBrief({
    tickler, vacancy, rentRoll, leaseExpirations,
    leaseHistory: lease.data || [], showings: shows.data || [],
  }, { today: TODAY, lookbackMode: arg('mode', undefined) });

  console.log('Monday Brief — built for ' + TODAY + ' (Central). NOTHING WAS SENT.\n');

  console.log('WINDOWS');
  console.log('   forward  ' + brief.windows.forward.start + ' → ' + brief.windows.forward.end
    + '   the week in progress (' + brief.week.convention + ')');
  console.log('            sections: ' + brief.windows.forward.sections.join(', '));
  console.log('   back     ' + brief.lookback.start + ' → ' + brief.lookback.end
    + '   [' + brief.lookback.mode + ']');
  console.log('            ' + brief.lookback.label);
  console.log('   horizon  to ' + brief.horizon.end + '   lease expirations, '
    + brief.horizon.days + ' days out');

  // The two are DIFFERENT on any day but Sunday, and the Goal Board beside this
  // page runs on the Sun-Sat week. Saying so is the point of the preview.
  if (brief.lookback.start !== brief.week.start) {
    console.log('\n   The two windows are not the same span. That is expected: what is');
    console.log('   coming runs on the week in progress, what already happened runs on');
    console.log('   the seven days before today.');
  }

  console.log('\nCOUNTS (forward sections)');
  Object.entries(brief.counts).forEach(([k, v]) =>
    console.log('   ' + k.padEnd(14) + v));

  if (lease.error) console.log('\nleasing_lease_history: ' + lease.error.message);
  if (shows.error) console.log('leasing_showings: ' + shows.error.message);
  const empty = ['tickler', 'vacancy', 'rentRoll', 'leaseExpirations']
    .filter(n => !({ tickler, vacancy, rentRoll, leaseExpirations })[n].length);
  if (empty.length) {
    console.log('\nEMPTY SOURCES: ' + empty.join(', '));
    console.log('   These stores live on the Render disk. Run this there for real counts;');
    console.log('   the WINDOWS above are correct either way — they are pure date logic.');
  }
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
