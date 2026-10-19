#!/usr/bin/env node
//
// Do Jay's dashboard and ours count the same work orders?
// READ ONLY — one AppFolio report read, nothing written anywhere.
//
//   node scripts/reconcile-work-orders.js
//   node scripts/reconcile-work-orders.js --property "Ascent at Northgate"
//
// WHY ONE PULL AND TWO COUNTS. Running each dashboard's own query would make
// every difference ambiguous: a gap could be the definition, the moment each
// was fetched, or a property filter. So this fetches the work orders ONCE,
// with every status code, and applies both definitions to the same rows. Any
// difference left is the definition and nothing else.
//
// THE DEFINITIONS, read out of the two codebases rather than remembered:
//
//   ours   open  = 0,1,2,9,11,3,6,8,12      (appfolio-reports.js)
//   Jay's  open  = 0,1,2,9,11,3,6,8         (his server.js, before 2026-10-19)
//          closed includes 12, "Ready to Bill"
//
// Jay decided on 2026-10-19 that Ready to Bill counts as OPEN, which makes the
// two the same. THE DIFFERENCE IS STILL REPORTED ON ITS OWN LINE rather than
// folded away: it is the one number that moved, somebody will ask what it was,
// and a reconciliation that only prints "0" when it agrees cannot show its
// work.
require('dotenv').config();

const AFP = require('../lib/appfolio-properties.js');
const PA = require('../lib/property-aliases.js');
const EXCLUDED = require('../lib/excluded-properties.js');
const WOS = require('../lib/work-order-status.js');

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const ONLY = arg('property');

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

// Every status code, so both definitions can be applied to one pull.
const ALL_CODES = Array.from({ length: 31 }, (_, i) => String(i));

// Ready to Bill. The code the two dashboards disagreed about.
const READY_TO_BILL = '12';

const OURS_OPEN = new Set(['0', '1', '2', '9', '11', '3', '6', '8', '12']);
const JAYS_OPEN_BEFORE = new Set(['0', '1', '2', '9', '11', '3', '6', '8']);

(async () => {
  const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
  const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set. Run on Render.');
    process.exitCode = 1;
    return;
  }
  const host = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
  const res = await global.fetch('https://' + host + '/api/v2/reports/work_order.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      property_visibility: 'active',
      priority: 'All',
      work_order_statuses: ALL_CODES,
      work_order_types: ['unit_turn', 'tenant_requested', 'internal'],
      paginate_results: false,
    }),
  });
  if (!res.ok) throw new Error('AppFolio ' + res.status + ' on work_order');
  const j = await res.json().catch(() => null);
  const raw = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);

  console.log('READ ONLY. One work_order pull, both definitions applied to it.');
  console.log('work orders returned: ' + raw.length + '\n');

  // Both dashboards drop the properties Metric does not manage, so this does
  // too — otherwise the difference would be dominated by rows neither screen
  // has ever shown.
  const rows = raw.filter(r => !EXCLUDED.propertyIsExcluded(r.property_name))
    .filter(r => !ONLY || clean(PA.canonical(r.property_name) || r.property_name)
      .toLowerCase() === clean(ONLY).toLowerCase());

  const codeOf = r => clean(r.work_order_status_id || r.status_id || r.work_order_status || '');
  const statusText = r => clean(r.status || r.work_order_status || '');

  // The status column is not always a code. When it is a name, it is mapped
  // through lib/work-order-status.js — the same rule our screens use — rather
  // than guessed at here.
  const isOpen = (r, codes) => {
    const c = codeOf(r);
    if (/^\d+$/.test(c)) return codes.has(c);
    return WOS.isOpen(statusText(r));
  };

  const ours = rows.filter(r => isOpen(r, OURS_OPEN));
  const jaysBefore = rows.filter(r => isOpen(r, JAYS_OPEN_BEFORE));
  const readyToBill = rows.filter(r => codeOf(r) === READY_TO_BILL);
  const urgent = ours.filter(r => /urgent/i.test(clean(r.priority)));

  console.log('OPEN WORK ORDERS');
  console.log('   ' + pad('ours (Ready to Bill = open)', 38) + ours.length);
  console.log('   ' + pad("Jay's, before 2026-10-19", 38) + jaysBefore.length);
  console.log('   ' + pad('difference', 38) + (ours.length - jaysBefore.length));
  console.log('   ' + pad('  of which Ready to Bill (code 12)', 38) + readyToBill.length);
  console.log('\n   Jay decided on 2026-10-19 that Ready to Bill is OPEN, so the two');
  console.log('   definitions now agree and the difference above is what it was worth.');
  if (ours.length - jaysBefore.length !== readyToBill.length) {
    console.log('\n   THE DIFFERENCE IS NOT ONLY CODE 12. Something else differs between');
    console.log('   the two sets — worth finding before trusting either count.');
  }

  console.log('\nURGENT, inside the open set');
  console.log('   ' + pad('ours', 38) + urgent.length);

  // ---- per property ---------------------------------------------------------
  console.log('\nBY PROPERTY');
  console.log('   ' + pad('property', 28) + pad('open', 7) + pad('urgent', 8)
    + pad('ready to bill', 15) + 'awaiting billing');
  const names = [...new Set(rows.map(r => PA.canonical(r.property_name)
    || AFP.resolveProperty(r.property_name) || clean(r.property_name)).filter(Boolean))].sort();
  names.forEach(name => {
    const mine = rows.filter(r => (PA.canonical(r.property_name)
      || AFP.resolveProperty(r.property_name) || clean(r.property_name)) === name);
    const o = mine.filter(r => isOpen(r, OURS_OPEN));
    console.log('   ' + pad(name, 28)
      + pad(o.length, 7)
      + pad(o.filter(r => /urgent/i.test(clean(r.priority))).length, 8)
      + pad(mine.filter(r => codeOf(r) === READY_TO_BILL).length, 15)
      + o.filter(r => WOS.isAwaitingBilling(statusText(r))).length);
  });

  console.log('\n   "Awaiting billing" is a SUBSET of open, not a third state: the work');
  console.log('   is done and the money is not collected. Jay\'s screen has no such');
  console.log('   split, so his open count includes them without saying so.');

  console.log('\nWHAT THIS DOES NOT COMPARE');
  console.log('   Jay\'s numbers are recomputed here from his definition, not read from');
  console.log('   his dashboard. If his deployed code still excludes code 12, his screen');
  console.log('   will show the second line above and not the first. Confirm against the');
  console.log('   screen before calling the two reconciled.');
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
