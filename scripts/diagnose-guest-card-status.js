#!/usr/bin/env node
//
// Does the guest_cards report hide inactive cards?
//
//   node scripts/diagnose-guest-card-status.js
//
// READ ONLY. Calls the AppFolio Reports API and reads Supabase; writes to
// neither. Run on Render Shell, where the credentials are.
//
// WHERE THIS PICKS UP. The first diagnostic found no status parameter: of nine
// variants only property_visibility=all changed the count, and that governs
// PROPERTIES, not states. So "the 8 are not in the report" still has two
// readings and we cannot choose between them yet:
//
//   a) the report only ever returns ACTIVE cards, and those 8 went inactive
//   b) the 8 were merged or deleted
//
// Two counts settle it, and neither needs a parameter the API might ignore:
//
//   1. the distribution of `status` across every card the report will return.
//      If it is 100% Active, the report is filtered to active cards whether or
//      not it admits to a parameter — and (a) is live.
//   2. how many carry a tenant_id. A card that became a tenant is a CONVERTED
//      card; if converted cards are still listed, then conversion is not what
//      removes a card from the report, which weakens (a) for these 8.
//
// Output is masked the same way as the other diagnostic: emails, phones and
// free text by column name and by pattern, names and dates left intact.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const GUEST_CARDS = '/api/v2/reports/guest_cards.json';
const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const subdomain = process.env.APPFOLIO_SUBDOMAIN || 'metricpropertymanagement';
if (!id || !secret) {
  console.error('APPFOLIO_REPORTS_CLIENT_ID / APPFOLIO_REPORTS_CLIENT_SECRET are not set in this shell.');
  console.error('Run this on Render Shell for the dashboard service.');
  process.exit(2);
}
const AUTH = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
const HOST = `https://${subdomain}.appfolio.com`;

const SENSITIVE_COL = /email|phone|mobile|cell|address|street|city|zip|postal|dob|birth|ssn|social|note|comment|description|message|contact_info/i;
const FREE_TEXT_COL = /note|comment|description|message/i;
const maskEmails = t => String(t).replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (m, d) => `${m[0]}***@${d}`);
const LOOKS_LIKE_DATE = /^\s*\d{4}-\d{2}-\d{2}([T ]|$)/;
const maskPhones = t => {
  const s = String(t);
  if (LOOKS_LIKE_DATE.test(s)) return s;
  return s.replace(/\(?\+?\d[\d\s().-]{5,}\d\)?/g, m => {
    if (/\d{4}-\d{2}-\d{2}|T\d{2}:/.test(m)) return m;
    const d = m.replace(/\D/g, '');
    return (d.length < 7 || d.length > 15) ? m : `***-***-${d.slice(-4)}`;
  });
};
function maskValue(key, value) {
  if (value == null || String(value).trim() === '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (FREE_TEXT_COL.test(key)) return `[free text, ${String(value).length} chars]`;
  return maskPhones(maskEmails(String(value)));
}
const maskRow = row => JSON.stringify(Object.fromEntries(
  Object.entries(row || {}).map(([k, v]) => [k, maskValue(k, v)])));

async function report(path, body, { maxPages = 40 } = {}) {
  let url = HOST + path, rows = [];
  for (let p = 0; p < maxPages; p++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    const json = JSON.parse(text);
    rows.push(...(json.results || []));
    const next = json.next_page_url || json.nextPageUrl;
    if (!next) break;
    url = next.replace(/\/\/[^@]*@/, '//');
    body = null;
  }
  return rows;
}

const tally = (rows, key) => {
  const t = {};
  rows.forEach(r => { const v = r[key] == null || String(r[key]).trim() === '' ? '(empty)' : String(r[key]); t[v] = (t[v] || 0) + 1; });
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};

(async () => {
  console.log('Pulling guest_cards with property_visibility=all …\n');
  const cards = await report(GUEST_CARDS, { property_visibility: 'all' });
  console.log(`cards returned: ${cards.length}`);
  if (!cards.length) { console.log('nothing to analyse'); return; }

  const cols = Object.keys(cards[0]);
  console.log('columns:', cols.join(', '), '\n');

  // ---- 1. status ------------------------------------------------------------
  console.log('=== 1. DISTRIBUTION OF `status` =========================================');
  const statusCols = cols.filter(c => /status/i.test(c));
  if (!statusCols.length) console.log('  no column with "status" in its name');
  statusCols.forEach(c => {
    console.log(`  ${c}:`);
    tally(cards, c).forEach(([v, n]) => console.log(`    ${String(n).padStart(5)}  ${v}`));
  });
  const main = cols.includes('status') ? 'status' : statusCols[0];
  if (main) {
    const distinct = tally(cards, main);
    console.log(distinct.length === 1
      ? `\n  -> every card is "${distinct[0][0]}". The report IS filtered to that state,\n`
        + '     with or without a parameter, so a card that left it would simply vanish.\n'
        + '     That is consistent with the 8 having gone inactive rather than being deleted.'
      : `\n  -> ${distinct.length} distinct states are returned, so the report is NOT\n`
        + '     filtered to active cards. A missing card is missing for some other reason.');
  }

  // ---- 2. converted cards ---------------------------------------------------
  console.log('\n=== 2. CARDS THAT BECAME TENANTS ========================================');
  const tenantCols = cols.filter(c => /tenant|occupanc|lease|applicat|conver/i.test(c));
  console.log('  candidate columns:', tenantCols.join(', ') || '(none)');
  tenantCols.forEach(c => {
    const filled = cards.filter(r => r[c] != null && String(r[c]).trim() !== '').length;
    console.log(`    ${c.padEnd(28)} ${String(filled).padStart(5)} of ${cards.length} populated`);
  });
  const tcol = tenantCols.find(c => /^tenant_id$/i.test(c)) || tenantCols.find(c => /tenant/i.test(c));
  if (tcol) {
    const filled = cards.filter(r => r[tcol] != null && String(r[tcol]).trim() !== '').length;
    console.log(filled
      ? `\n  -> ${filled} converted card(s) are STILL LISTED. Conversion does not remove a\n`
        + '     card from this report, so it does not explain the 8 either.'
      : `\n  -> no card carries a ${tcol}. Either conversion removes them from the report\n`
        + '     (which would explain the 8) or this column is simply never populated here.');
  }

  // ---- 3. are the 8 really absent? -----------------------------------------
  console.log('\n=== 3. THE 8, CHECKED AGAINST THIS PULL =================================');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  const ours = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('leasing_leads').select('*').range(f, f + 999);
    if (error) throw new Error('leasing_leads: ' + error.message);
    ours.push(...data);
    if (data.length < 1000) break;
  }
  const lastSync = ours.map(r => r.synced_at).filter(Boolean).sort().pop();
  const cut = new Date(new Date(lastSync).getTime() - 30 * 60000).toISOString();
  const missing8 = ours.filter(r => r.week_ending === '2026-09-26' && !(r.synced_at && r.synced_at >= cut));

  const byUuid = new Map(cards.map(r => [String(r.guest_card_uuid), r]));
  const byId = new Map(cards.map(r => [String(r.guest_card_id), r]));
  missing8.forEach(m => {
    const hit = byUuid.get(String(m.appfolio_id)) || byId.get(String(m.guest_card_id));
    console.log(`  ${String(m.guest_card_id).padStart(5)}  ${String(m.name).slice(0, 24).padEnd(26)} ${hit ? 'PRESENT -> ' + maskRow(hit).slice(0, 220) : 'absent'}`);
  });

  // ---- 4. what our table holds that this pull does not ---------------------
  console.log('\n=== 4. OUR ROWS vs THIS PULL ============================================');
  const ourIds = new Set(ours.map(r => String(r.appfolio_id)));
  const theirs = new Set(cards.map(r => String(r.guest_card_uuid)));
  const onlyOurs = ours.filter(r => !theirs.has(String(r.appfolio_id)));
  const onlyTheirs = cards.filter(r => !ourIds.has(String(r.guest_card_uuid)));
  console.log(`  ours ${ours.length} · report ${cards.length}`);
  console.log(`  in our table but NOT in the report : ${onlyOurs.length}`);
  console.log(`  in the report but NOT in our table : ${onlyTheirs.length}`);
  const wk = {};
  onlyOurs.forEach(r => { const k = r.week_ending || '(null)'; wk[k] = (wk[k] || 0) + 1; });
  console.log('  the missing ones by week:');
  Object.keys(wk).sort().forEach(k => console.log(`    ${k}  ${wk[k]}`));

  console.log('\n=== READING THIS =======================================================');
  console.log('  status 100% Active            -> the report hides non-active cards; the 8');
  console.log('                                  most likely went inactive. 68 stands, and');
  console.log('                                  the sync needs a way to see inactive cards.');
  console.log('  several states returned       -> hiding is not the explanation; the 8 are');
  console.log('                                  gone for another reason, merge included.');
  console.log('  tenant_id populated on some   -> converted cards stay listed, so conversion');
  console.log('                                  is not what removed the 8.');
  console.log('\n  Nothing was written. Names and dates are intact; emails, phones and free');
  console.log('  text are masked.');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
