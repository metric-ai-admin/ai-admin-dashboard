#!/usr/bin/env node
//
// What SHAPE are the cells on one sheet of the Code Violations workbook?
// READ ONLY — nothing is written, and no cell contents are printed.
//
//   node scripts/probe-cv-sheet-shapes.js "Closed Cases"
//
// WHY SHAPES AND NOT VALUES. "Items" has to be stored as a number if it is a
// count and as text if it is a list, and the mapping cannot be guessed from a
// column name — but these sheets carry addresses, unit numbers and the names
// of city officers and residents. So each cell is reduced to EMPTY, int(n),
// date, or text[length], and nothing else leaves this script.
require('dotenv').config();

const msal = require('@azure/msal-node');
const XLSX = require('xlsx');

const SHEET = process.argv[2];
const DRIVE_OWNER = process.env.CV_WORKBOOK_OWNER || 'admin@metricpropertymanagement.com';
const WORKBOOK_PATH = process.env.CV_WORKBOOK_PATH
  || 'Ops Dashboard Files/Maintenance/Code_Violations_Tracker.xlsx';

const clean = s => String(s == null ? '' : s).trim();
const INT = /^[0-9]+$/;
const DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function shapeOf(v) {
  const s = clean(v);
  if (!s) return 'EMPTY';
  if (INT.test(s)) return 'int(' + s + ')';
  if (DATE.test(s)) return 'date';
  return 'text[' + s.length + ']';
}

async function token() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) throw new Error('GRAPH_* not set');
  const app = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenant, clientSecret: secret },
  });
  const r = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'], skipCache: true,
  });
  return r.accessToken;
}

(async () => {
  if (!SHEET) { console.error('Pass a sheet name.'); process.exitCode = 1; return; }
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(DRIVE_OWNER)
    + '/drive/root:/' + WORKBOOK_PATH.split('/').map(encodeURIComponent).join('/') + ':/content';
  const res = await global.fetch(url, { headers: { Authorization: 'Bearer ' + await token() } });
  if (!res.ok) throw new Error('Graph ' + res.status);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  if (!wb.Sheets[SHEET]) { console.error('no sheet called "' + SHEET + '"'); process.exitCode = 1; return; }

  const grid = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: null, raw: false });
  const header = (grid[0] || []).map(c => clean(c));
  console.log('READ ONLY. Shapes only — no cell contents are printed.\n');
  console.log('SHEET: ' + SHEET + '   columns: ' + header.filter(Boolean).join(' | ') + '\n');

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (!row.some(c => clean(c))) continue;
    const parts = header.filter(Boolean)
      .map(col => col + '=' + shapeOf(row[header.indexOf(col)]));
    console.log('   row ' + (r + 1) + ':  ' + parts.join('   '));
  }
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
