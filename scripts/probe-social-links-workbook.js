#!/usr/bin/env node
//
// What is in Katie's social-links workbook? READ ONLY — structure and counts
// only, no cell contents are printed.
//
//   node scripts/probe-social-links-workbook.js "<sharing url>"
//
// A SHARING URL IS NOT A PATH. Graph resolves one through /shares/{id}, where
// the id is the full URL base64url-encoded with the padding stripped and "u!"
// in front — the same encoding Jay's dashboard uses for the Facebook Tracker.
// Nothing about the file is written anywhere.
require('dotenv').config();

const msal = require('@azure/msal-node');
const XLSX = require('xlsx');

const SHARE_URL = process.argv[2] || process.env.SOCIAL_LINKS_SHARE_URL;

const clean = s => String(s == null ? '' : s).trim();
const pad = (s, w) => String(s).padEnd(w);

// A link, a date, a number, or text — never the value itself.
const LINK = /^https?:\/\//i;
const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}/;
function shapeOf(v) {
  const s = clean(v);
  if (!s) return 'EMPTY';
  if (LINK.test(s)) {
    // The HOST is structure: which platforms are in here is the question.
    try { return 'link(' + new URL(s).hostname.replace(/^www\./, '') + ')'; }
    catch (e) { return 'link(unparseable)'; }
  }
  if (DATE.test(s)) return 'date';
  if (/^\d+$/.test(s)) return 'int';
  return 'text[' + s.length + ']';
}

function encodeSharingUrl(url) {
  const b64 = Buffer.from(url, 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return 'u!' + b64;
}

async function token() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) throw new Error('GRAPH_* are not set.');
  const app = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenant, clientSecret: secret },
  });
  const r = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'], skipCache: true,
  });
  return r.accessToken;
}

(async () => {
  if (!SHARE_URL) { console.error('Pass the sharing URL.'); process.exitCode = 1; return; }
  const t = await token();
  const head = { Authorization: 'Bearer ' + t };

  const metaRes = await global.fetch(
    'https://graph.microsoft.com/v1.0/shares/' + encodeSharingUrl(SHARE_URL) + '/driveItem',
    { headers: head });
  if (!metaRes.ok) {
    throw new Error('resolving the share failed: ' + metaRes.status + ' '
      + (await metaRes.text()).slice(0, 160));
  }
  const item = await metaRes.json();
  console.log('READ ONLY. Structure and counts only; no cell contents are printed.\n');
  console.log('file:     ' + item.name);
  console.log('modified: ' + String(item.lastModifiedDateTime || '').slice(0, 16).replace('T', ' '));
  console.log('size:     ' + Math.round((item.size || 0) / 1024) + ' KB');

  const binRes = await global.fetch('https://graph.microsoft.com/v1.0/drives/'
    + item.parentReference.driveId + '/items/' + item.id + '/content', { headers: head });
  if (!binRes.ok) throw new Error('downloading failed: ' + binRes.status);
  const wb = XLSX.read(Buffer.from(await binRes.arrayBuffer()), { type: 'buffer' });

  console.log('\nsheets: ' + wb.SheetNames.join(', '));

  let totalLinks = 0;
  const hosts = {};
  wb.SheetNames.forEach(name => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: false });
    const ws = wb.Sheets[name];
    // A header is the first row with two or more short non-empty cells.
    let h = -1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const cells = (grid[i] || []).map(c => clean(c)).filter(Boolean);
      if (cells.length >= 2 && cells.every(c => c.length <= 48)) { h = i; break; }
    }
    const header = h >= 0 ? grid[h].map(c => clean(c)) : [];
    const dataRows = grid.slice(h + 1).filter(r => (r || []).some(c => clean(c)));

    // Links live in the text OR as real hyperlinks on the cell — Jay's tracker
    // stores them the second way, and a count that only reads text would
    // report zero on a sheet full of them.
    let cellLinks = 0;
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let r = 0; r <= range.e.r; r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const target = cell.l && cell.l.Target ? cell.l.Target : (LINK.test(clean(cell.v)) ? clean(cell.v) : null);
        if (!target) continue;
        cellLinks += 1;
        try {
          const hhost = new URL(target).hostname.replace(/^www\./, '');
          hosts[hhost] = (hosts[hhost] || 0) + 1;
        } catch (e) { hosts['(unparseable)'] = (hosts['(unparseable)'] || 0) + 1; }
      }
    }
    totalLinks += cellLinks;

    console.log('\nSHEET: ' + name + '  — ' + dataRows.length + ' data row(s), '
      + cellLinks + ' link(s)');
    if (h < 0) { console.log('   no header-shaped row in the first 15'); return; }
    console.log('   header row #' + (h + 1) + ': ' + header.filter(Boolean).join(' | '));
    // One sample row, as shapes.
    if (dataRows.length) {
      console.log('   first data row, as shapes:');
      console.log('      ' + header.filter(Boolean)
        .map(col => col + '=' + shapeOf(dataRows[0][header.indexOf(col)])).join('   '));
    }
  });

  console.log('\nLINKS BY HOST (every sheet)');
  Object.entries(hosts).sort((a, b) => b[1] - a[1])
    .forEach(([h2, n]) => console.log('   ' + pad(h2, 28) + n));
  console.log('   ' + pad('TOTAL', 28) + totalLinks);
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
