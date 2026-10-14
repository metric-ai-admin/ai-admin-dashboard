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
const OCCUPANCY = arg('occupancy', null);

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
const CANDIDATES = [
  'tenant_security_deposit', 'security_deposit', 'security_deposits',
  'deposit_disposition', 'tenant_deposit', 'tenant_deposits',
  'move_out_detail', 'move_outs', 'moveout_detail',
  'tenant_statement', 'resident_statement', 'statement_of_deposit_account',
  'tenant_refund', 'refunds', 'check_register', 'payable_check_register',
  'tenant_transactions', 'tenant_payments', 'receivable_transactions',
  'tenant_charges', 'prepaid_and_deposits', 'liability_balances',
];

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
      console.log('      columns: ' + cols.join(', '));
    }
    await sleep(500);
  }

  if (!exists.length) {
    console.log('\n   None of the candidates exist. The FAS is not reachable by guessing');
    console.log('   names, and the next step is AppFolio support or the admin UI’s own');
    console.log('   report list — not another round of guesses.');
  }

  // ---- 3. tenant_ledger, filtered ------------------------------------------
  console.log('\nTENANT LEDGER, FILTERED');
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

  console.log('\nNothing was written. No amount, payer, name, unit or date was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
