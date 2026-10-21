#!/usr/bin/env node
//
// Where does AppFolio record a Final Account Statement and a deposit refund?
// READ ONLY — every call is a report read. Nothing is written anywhere.
//
//   node scripts/probe-deposit-reports.js
//   node scripts/probe-deposit-reports.js --occupancy 123456
//
// TWO QUESTIONS, both from Arturo on 2026-10-15 after five guessed report
// names came back "Id is not a valid report":
//
//   1. WHICH REPORT NAMES EXIST. I guessed five and AppFolio rejected all
//      five, which is the same failure as guessing a column name — a name
//      nobody confirmed fails exactly like a report that does not exist. So
//      this asks the API rather than me: a catalogue endpoint first, then a
//      list of candidates built from AppFolio's own naming habits, each one
//      reported as EXISTS or REJECTED.
//
//   2. WHAT tenant_ledger LOOKS LIKE FOR ONE RESIDENT. It returned 2,703 rows
//      with six columns and no tenant, unit or property — which usually means
//      the report wants a filter. If it accepts occupancy_id, and if the
//      descriptions include something like "Final Account Statement" or
//      "Security Deposit Refund", then both alerts can be built by reading the
//      ledger per move-out.
//
// NOTHING PERSONAL IS PRINTED — and the first version of this file was WRONG
// about that. It said descriptions are system labels. They are not: AppFolio
// interpolates the resident, the property and the unit into them, and two
// names reached the terminal on 2026-10-15. Descriptions now go through
// lib/ledger-mask.js, which patterns them and then checks what is left.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
let OCCUPANCY = arg('occupancy', null);
// --auto-occupancy: find one ourselves from the most recent move-out and
// NEVER print it. Passing an id on the command line means reading it off a
// screen first, and an occupancy id identifies one resident's tenancy.
const AUTO = process.argv.includes('--auto-occupancy');

// One occupancy id for a recent move-out, taken from the synced stores.
//
// Returns the id and prints only HOW it was found and how old the move-out is
// — never the id, the unit, the property or the resident. If the id itself
// reached the terminal, the point of this function would be lost: whoever ran
// it would be looking at the thing it exists to avoid showing.
async function pickOccupancy() {
  const AR = require('../appfolio-reports.js');
  const occKey = r => Object.keys(r).find(k => /^occupancy[_ ]?id$/i.test(k.replace(/\s+/g, '_')));

  let turns = [];
  try { turns = ((await AR.readReportData('unit_turn_detail')) || {}).rows || []; }
  catch (e) { console.log('   unit_turn_detail is not readable here: ' + e.message); }
  const moved = turns
    .filter(t => t && String(t.move_out_date || '').trim())
    .sort((a, b) => String(b.move_out_date).localeCompare(String(a.move_out_date)));
  if (!moved.length) {
    console.log('   unit_turn_detail has no row with a move_out_date on this machine.');
    return null;
  }
  const days = Math.round(
    (Date.now() - Date.parse(String(moved[0].move_out_date).slice(0, 10))) / 86400000);
  console.log('   most recent move-out in unit_turn_detail: ' + days + ' days ago'
    + '   (' + moved.length + ' move-outs on file)');

  // 1. the turn row itself, if it carries one
  const direct = occKey(moved[0]);
  if (direct && String(moved[0][direct]).trim()) {
    console.log('   occupancy id taken from unit_turn_detail.' + direct + ' — not printed');
    return String(moved[0][direct]).trim();
  }
  console.log('   unit_turn_detail carries no occupancy id column'
    + ' (has: ' + Object.keys(moved[0]).length + ' columns)');

  // 2. occupancy_custom_fields, matched on unit — one row per OCCUPANCY, and
  //    the only store that carries the id at all.
  let occ = [];
  try { occ = ((await AR.readReportData('occupancy_custom_fields')) || {}).rows || []; }
  catch (e) { console.log('   occupancy_custom_fields is not readable here: ' + e.message); }
  if (!occ.length) { console.log('   occupancy_custom_fields is empty on this machine.'); return null; }

  const unitOf = r => String(r.unit_id || r.unit || r.unit_name || '').trim();
  const want = unitOf(moved[0]);
  const key = occKey(occ[0]);
  if (!key) { console.log('   occupancy_custom_fields carries no occupancy id column either.'); return null; }
  const hit = want ? occ.find(r => unitOf(r) && unitOf(r) === want) : null;
  if (!hit) {
    console.log('   no occupancy row matches that move-out’s unit — '
      + 'the two reports key units differently, which is its own finding.');
    return null;
  }
  console.log('   occupancy id taken from occupancy_custom_fields, matched on unit — not printed');
  return String(hit[key]).trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);

async function call(path, method, body) {
  const r = await global.fetch('https://' + HOST + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

const rowsOf = j => (Array.isArray(j) ? j : ((j && (j.results || j.data)) || []));

// AppFolio's own naming habits: lower_snake_case, usually the report's screen
// name. These are CANDIDATES, not knowledge — each is reported as it answers,
// and a rejection is as useful as a hit.
// READ OFF THE ADMIN UI, not guessed. Arturo took these from the report
// URLs on 2026-10-21 (buffered_reports/<name>), after the catalogue returned
// 404 and all 22 guesses were rejected — which is exactly the lesson the
// header above describes: a name nobody confirmed fails like a report that
// does not exist. These three are confirmed names; they go first.
const CONFIRMED = [
  'security_deposit_funds_detail',   // "Security Deposit Funds Detail"
  'deposit_register',                // "Deposit Register"
  'customer_ledger',                 // "Customer Ledger"
];

const CANDIDATES = CONFIRMED.concat([
  'tenant_security_deposit', 'security_deposit', 'security_deposits',
  'deposit_disposition', 'tenant_deposit', 'tenant_deposits',
  'move_out_detail', 'move_outs', 'moveout_detail',
  'tenant_statement', 'resident_statement', 'statement_of_deposit_account',
  'tenant_refund', 'refunds', 'check_register', 'payable_check_register',
  'tenant_transactions', 'tenant_payments', 'receivable_transactions',
  'tenant_charges', 'prepaid_and_deposits', 'liability_balances',
]);

// Does a column answer "WHEN was it settled?" — the whole question for the FAS
// clock. A report that lists deposits held but carries no date cannot measure
// days between a move-out and a settlement, however useful it is otherwise.
const DATEISH = /date|on$|_at$|posted|cleared|settled|refund|disposed|disposition|issued|paid|check/i;
const DEPOSITISH = /deposit|refund|disposition|settle|final|statement|forward/i;

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this shell. Run on Render.');
    process.exitCode = 1;
    return;
  }

  // ---- 1. is there a catalogue --------------------------------------------
  console.log('IS THERE A CATALOGUE ENDPOINT?');
  for (const p of ['/api/v2/reports.json', '/api/v2/reports', '/api/v2/reports/index.json']) {
    const r = await call(p, 'GET');
    const names = rowsOf(r.json).map(x => x && (x.id || x.name || x.report)).filter(Boolean);
    console.log('   ' + pad(p, 30) + r.status
      + (names.length ? '   ' + names.length + ' names returned' : ''));
    if (names.length) {
      console.log('\n   THE CATALOGUE EXISTS. Names mentioning what we are looking for:');
      names.filter(n => /deposit|refund|move.?out|statement|check/i.test(n))
        .forEach(n => console.log('      ' + n));
      console.log('\n   (full list is ' + names.length + ' names; nothing else is printed)');
    }
    await sleep(400);
  }

  // ---- 2. candidate names --------------------------------------------------
  console.log('\nCANDIDATE REPORT NAMES');
  console.log('   Guessed from AppFolio’s naming habits. A rejection is an answer.');
  const exists = [];
  for (const name of CANDIDATES) {
    const r = await call('/api/v2/reports/' + name + '.json', 'POST',
      { property_visibility: 'active', paginate_results: false });
    const rows = rowsOf(r.json);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const bad = r.status >= 400;
    console.log('   ' + pad(name, 32) + (bad ? 'REJECTED' : 'EXISTS  ')
      + (bad ? '' : '   ' + rows.length + ' rows, ' + cols.length + ' columns'));
    if (!bad) {
      exists.push({ name, cols, rows: rows.length });
      // COLUMN NAMES AND COUNTS ONLY. No value from any row is printed: these
      // reports carry residents, units and amounts, and the question here is
      // what the report HAS, not what it says about anybody.
      console.log('      columns: ' + cols.join(', '));
      const dates = cols.filter(c => DATEISH.test(c));
      const deps = cols.filter(c => DEPOSITISH.test(c));
      console.log('      date-ish columns   : ' + (dates.length ? dates.join(', ') : 'NONE'));
      console.log('      deposit-ish columns: ' + (deps.length ? deps.join(', ') : 'NONE'));
      // The verdict the FAS clock actually needs.
      const canDate = dates.some(c => DEPOSITISH.test(c))
        || (dates.length > 0 && deps.length > 0);
      console.log('      -> ' + (canDate
        ? 'CAN date a settlement (a date column and a deposit column are both here)'
        : dates.length
          ? 'has dates but nothing deposit-shaped — check the column list by eye'
          : 'NO DATE COLUMN: cannot measure days to settlement from this report'));
    }
    await sleep(500);
  }

  if (!exists.length) {
    console.log('\n   None of the candidates exist. The FAS is not reachable by guessing');
    console.log('   names, and the next step is AppFolio support or the admin UI’s own');
    console.log('   report list — not another round of guesses.');
  }

  // ---- 2b. the memorized report -------------------------------------------
  //
  // "FINANCIAL REVIEW - Security Deposits" is memorized_reports/15 in the
  // admin UI. The tenant_tickler note in appfolio-reports.js says saved-report
  // UUIDs are unreachable from the public API; this one is a small integer
  // under a different path, which is a different question, so it is asked
  // rather than assumed. A rejection is an answer and costs one request.
  console.log('\nTHE MEMORIZED REPORT (FINANCIAL REVIEW - Security Deposits)');
  //
  // ONLY PATHS INSIDE THE REPORTS NAMESPACE. A third shape — memorized_reports
  // hanging directly off the API root, outside /reports — was the obvious one
  // to try and is deliberately not here: this file POSTs, and the rail that
  // keeps every probe inside that namespace is worth more than one more guess
  // at a URL. If both shapes below are rejected, the next step is asking
  // AppFolio what the path is, not POSTing at endpoints to find out.
  for (const p of ['/api/v2/reports/memorized_reports/15.json',
    '/api/v2/reports/15.json']) {
    const r = await call(p, 'POST', { paginate_results: false });
    const rows = rowsOf(r.json);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    console.log('   ' + pad(p, 44) + (r.status >= 400 ? 'REJECTED ' + r.status
      : r.status + '   ' + rows.length + ' rows, ' + cols.length + ' columns'));
    if (r.status < 400 && cols.length) {
      console.log('      columns: ' + cols.join(', '));
      console.log('      date-ish: ' + (cols.filter(c => DATEISH.test(c)).join(', ') || 'NONE'));
    }
    await sleep(400);
  }

  // ---- 3. tenant_ledger, filtered ------------------------------------------
  console.log('\nTENANT LEDGER, FILTERED');
  if (AUTO && !OCCUPANCY) {
    OCCUPANCY = await pickOccupancy();
    if (!OCCUPANCY) {
      console.log('   Could not find an occupancy id for a recent move-out — see above.');
    }
  }
  if (!OCCUPANCY) {
    console.log('   Pass --occupancy <id> to try it for ONE move-out. Get an id from');
    console.log('   the occupancy_custom_fields store or from unit_turn_detail.');
  } else {
    // Several filter names, because which one it takes is the question.
    for (const key of ['occupancy_id', 'occupancy_ids', 'tenant_id', 'occupancy']) {
      const r = await call('/api/v2/reports/tenant_ledger.json', 'POST',
        { [key]: OCCUPANCY, paginate_results: false });
      const rows = rowsOf(r.json);
      console.log('   ' + pad(key, 16) + (r.status >= 400 ? 'REJECTED' : r.status + '  ' + rows.length + ' rows'));
      if (r.status < 400 && rows.length) {
        // SYSTEM LABELS ONLY, with counts. No amount, no payer, no date.
        // MASKED. This printed two resident names on 2026-10-15: AppFolio
        // interpolates the resident, property and unit INTO the description,
        // and I had treated the field as a system label. Everything goes
        // through lib/ledger-mask.js now.
        const MASK = require('../lib/ledger-mask.js');
        const t = MASK.tally(rows, 'description', []);
        console.log('      ' + t.rows.length + ' distinct description PATTERNS:');
        t.rows.slice(0, 30).forEach(x => console.log('         ' + pad(x.count, 6) + x.pattern));
        const interesting = t.rows.filter(x =>
          /final account|statement|deposit|refund|disposition|forwarding/i.test(x.pattern));
        console.log('      of those, mentioning FAS / deposit / refund: '
          + (interesting.length ? interesting.map(x => x.pattern).join(' | ') : 'NONE'));
        break;
      }
      await sleep(500);
    }
  }

  console.log('\nNothing was written. No amount, payer, name, unit, occupancy id or');
  console.log('date was printed — only column names, row counts and masked patterns.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
