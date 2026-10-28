#!/usr/bin/env node
//
// Kara's 6 AM brief, as it would go out right now. NOTHING IS SENT.
//
//   node scripts/kara-brief-preview.js
//   node scripts/kara-brief-preview.js --today 2026-10-15
//   node scripts/kara-brief-preview.js --html out.html
//   node scripts/kara-brief-preview.js --deadline 5 --basis business
//
// WHY A SCRIPT RATHER THAN THE TEST ROUTE. /api/brief/kara/test renders the
// brief AND SENDS IT to Arturo. That is the right tool for checking what lands
// in a mailbox, and the wrong one for reading a draft four times while the
// wording changes — each read is a real email. This writes to the terminal and
// touches no mailbox at all.
//
// Read only. No writes, no mail.
require('dotenv').config();

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const WEEK = require('../lib/week.js');
const B = require('../lib/kara-brief.js');
const H = require('../lib/kara-brief-html.js');
const G = require('../lib/kara-brief-gather.js');
const FAS = require('../lib/fas-deposits.js');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};
const TODAY = arg('today', WEEK.todayYMD());
const HTML_OUT = arg('html', null);

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// The paging helper the gather expects. PostgREST caps a plain select at 1000
// rows whatever limit is asked for, and a capped read returns a plausible
// short answer rather than an error.
async function selectAll(build, opts) {
  const o = opts || {};
  const page = 1000;
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await build().range(from, from + page - 1);
    if (r.error) throw new Error((o.label || 'select') + ': ' + r.error.message);
    out.push(...(r.data || []));
    if ((r.data || []).length < page) break;
  }
  return out;
}

(async () => {
  const af = require('../appfolio-reports.js');
  const kpiBuild = require('../lib/kpi-build.js');

  // The same dependencies server.js hands the gather. Goals come from the
  // leasing table there; without that function the brief would compare every
  // property against nothing and show no occupancy flags at all, so it is
  // passed explicitly rather than defaulted.
  const input = await G.gather({
    db,
    selectAll,
    // THE FAS SECTION IS PREVIEW-ONLY. server.js does not pass this, so the
    // 06:00 email keeps the NOT MEASURABLE note until Arturo has read a
    // preview and said otherwise. The flag lives here and not in a default so
    // that turning it on for the real email is a deliberate edit somebody
    // makes, not a line nobody noticed.
    fas: true,
    // 5 BUSINESS DAYS, confirmed by Kara on 2026-10-28, and it now lives in
    // FAS.DEFAULT_DEADLINE rather than in an environment variable: a decided
    // rule kept in config is a rule that reverts the first time somebody runs
    // this where the variable is not set.
    //
    // --deadline / --basis, then the environment, then the confirmed default.
    // The overrides stay so a future change can be SEEN before it is made.
    fasDeadline: FAS.readDeadline(
      arg('deadline', process.env.FAS_DEADLINE_DAYS),
      arg('basis', process.env.FAS_DEADLINE_BASIS)),
    // Opt OUT, not in. The rule is confirmed, so the section no longer prints
    // the "not confirmed yet" caveat unless somebody deliberately says the
    // deadline is open again — FAS_DEADLINE_CONFIRMED=no.
    fasDeadlineUnconfirmed: process.env.FAS_DEADLINE_CONFIRMED === 'no',
    buildKpiReport: kpiBuild.buildKpiReport,
    readReportData: id => af.readReportData(id),
    // THE REAL GOALS, from the same table server.js uses. Passing () => null
    // here is what made this preview lie: no property had a goal, so no
    // property was red for occupancy, while the footer still said "occupancy
    // below the property goal". The email going out was correct the whole
    // time, which is the worst version of that bug — a preview that disagrees
    // with the email is worse than no preview, because it gets believed.
    goalPctFor: name => require('../lib/leasing-goals.js').leasingGoalFraction(name),
    now: TODAY === WEEK.todayYMD() ? undefined : new Date(TODAY + 'T12:00:00Z'),
  });

  const brief = B.build(input);
  const text = B.render(brief, { testMode: true });

  console.log(text);

  // ---- what the reader cannot see from the text ----------------------------
  //
  // Both renderers are built from the same brief, but only one of them is in
  // front of you. A section present in the text and missing from the HTML is
  // the kind of difference that reaches a mailbox unnoticed.
  const html = H.renderHtml(brief, { testMode: true });
  // ANCHORED TO THE HEADING, not to the words. /MOVE-OUTS/i matched the
  // "Move-outs this week" row inside every property block, so the move-out
  // SECTION reported as present in both renderers while it was switched off
  // in both — a check that could only ever agree with itself.
  const sections = [
    ['collections', /^COLLECTIONS vs/m, />Collections vs/],
    ['call scores', /^CALL SCORES/m, />Call scores/],
    ['projected occupancy', /^PROJECTED OCCUPANCY/m, />Projected occupancy</],
    ['final account statements', /^FINAL ACCOUNT STATEMENTS/m, />Final account statements</],
    ['move-outs', /^MOVE-OUTS$/m, />Move-outs</],
  ];
  console.log('');
  console.log('='.repeat(72));
  console.log('SECTIONS IN EACH RENDERER          text    html');
  sections.forEach(([name, t, h]) => {
    const inText = t.test(text);
    const inHtml = h.test(html);
    console.log('  ' + name.padEnd(33)
      + (inText ? 'yes' : 'no ').padEnd(8) + (inHtml ? 'yes' : 'no ')
      + (inText === inHtml ? '' : '   <-- THEY DISAGREE'));
  });
  console.log('');
  console.log('move-out section enabled: ' + brief.moveOutSection
    + '   (brief_thresholds.move_out_section_enabled, NULL = off)');
  console.log('html: ' + html.length + ' bytes');

  if (HTML_OUT) {
    fs.writeFileSync(HTML_OUT, html);
    console.log('html written to ' + HTML_OUT + ' — open it in a browser.');
  }
  console.log('\nNOTHING WAS SENT. No mailbox was touched.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
