#!/usr/bin/env node
//
// The open work orders, as a workbook to send Jay.
// READ ONLY against AppFolio. Writes one .xlsx and nothing else.
//
//   node scripts/export-open-work-orders.js
//   node scripts/export-open-work-orders.js --out "C:/path/open.xlsx"
//
// WHY A LIST AND NOT A NUMBER. Jay counts 103 open (97 field + 6 work done)
// and we count 102 (96 + 6); urgent agrees at 10 and 10. One row differs and
// no total will ever say which. Two lists of numbers do.
//
// NUMBER, PROPERTY, STATUS, and our classification of that status. Nothing
// else: the point is for Jay to diff it against his, and resident names or
// descriptions would make that harder, not easier, as well as putting
// resident data in a file that travels.
require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');
const WOS = require('../lib/work-order-status.js');
const PA = require('../lib/property-aliases.js');
const AFP = require('../lib/appfolio-properties.js');
const EXCLUDED = require('../lib/excluded-properties.js');

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const OUT = arg('out') || path.join(process.cwd(), 'exports',
  'open-work-orders-' + new Date().toISOString().slice(0, 10) + '.xlsx');

const clean = s => String(s == null ? '' : s).trim();
const ALL_CODES = Array.from({ length: 31 }, (_, i) => String(i));

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
  if (!res.ok) throw new Error('AppFolio ' + res.status);
  const j = await res.json().catch(() => null);
  const raw = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);

  // The same exclusions both dashboards apply, or the diff would be dominated
  // by rows neither screen has ever shown.
  const rows = raw.filter(r => !EXCLUDED.propertyIsExcluded(r.property_name));
  const open = rows.filter(r => WOS.isOpen(clean(r.status)));

  const out = open.map(r => ({
    'Work order': clean(r.work_order_number),
    'Property': PA.canonical(r.property_name) || AFP.resolveProperty(r.property_name)
      || clean(r.property_name),
    'Status': clean(r.status),
    // So a disagreement can be read as "we classify this differently" rather
    // than "one of us is missing a row".
    'We count it as': WOS.isWorkDone(clean(r.status)) ? 'work done — pending review' : 'field work',
    'Priority': clean(r.priority),
  })).sort((a, b) =>
    a.Property.localeCompare(b.Property)
    || String(a['Work order']).localeCompare(String(b['Work order'])));

  const workDone = out.filter(r => r['We count it as'].startsWith('work done')).length;
  const urgent = out.filter(r => /urgent/i.test(r.Priority)).length;

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(out);
  ws['!cols'] = [{ wch: 14 }, { wch: 26 }, { wch: 24 }, { wch: 26 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Open work orders');

  const about = [
    ['What this is'],
    ['Every work order we count as OPEN right now, from one live AppFolio pull.'],
    [''],
    ['Our totals', ''],
    ['open', out.length],
    ['  field work', out.length - workDone],
    ['  work done — pending review', workDone],
    ['urgent (inside open)', urgent],
    [''],
    ['The definition, agreed 2026-10-19'],
    ['Ready to Bill is CLOSED — the maintenance work is finished and only the'],
    ['invoice is outstanding — and is reported separately, not here.'],
    ['Work Done is OPEN: somebody still has to close it.'],
    ['"Unknown — not in feed" is neither open nor closed and is not here either.'],
    [''],
    ['How to use it'],
    ['Diff the Work order column against your open list. A number on one side'],
    ['only is a row one of us is missing; a number on both with a different'],
    ['status is a timing difference between the two pulls.'],
    [''],
    ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
  ];
  const aboutWs = XLSX.utils.aoa_to_sheet(about);
  aboutWs['!cols'] = [{ wch: 72 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, aboutWs, 'About');

  require('fs').mkdirSync(path.dirname(OUT), { recursive: true });
  XLSX.writeFile(wb, OUT);

  console.log('open: ' + out.length + '   field work: ' + (out.length - workDone)
    + '   work done: ' + workDone + '   urgent: ' + urgent);
  console.log('written: ' + OUT);
  console.log('No resident data is in it: number, property, status, priority only.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
