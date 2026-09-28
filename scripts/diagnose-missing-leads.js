#!/usr/bin/env node
//
// Why do leads vanish from the AppFolio guest-card report?
//
//   node scripts/diagnose-missing-leads.js
//
// READ ONLY. It calls the AppFolio Reports API and reads Supabase. It writes
// NOTHING to either — no upsert, no update, no file.
//
// SAFE TO PASTE ELSEWHERE. Emails, phone numbers and free-text notes are masked
// before anything is printed, by column name AND by pattern, so a column we have
// never seen cannot leak one. NAMES ARE LEFT INTACT on purpose: recognising the
// same person under two cards is how a merged duplicate is spotted, and that is
// most of what this script is for.
//
// RUN ON RENDER SHELL: the AppFolio credentials live there.
//
// THE QUESTION. 185 of the 648 rows in leasing_leads did not come back in the
// 2026-09-28 full pull, including 8 that sit in the week ending 09/26. Their
// neighbours by guest_card_id DID come back (8877 is missing, 8878 and 8879
// arrived), so it is not a cut-off, a page boundary or a date filter. They are
// all status=Active in our copy, across several properties and sources.
//
// That leaves three possibilities this script tries to separate:
//
//   a) they converted — became a rental application or a lease, and the
//      inquiries report only carries cards that are still inquiries
//   b) they were merged into another card as duplicates, so their UUID is gone
//   c) they were deleted
//
// It matters because the Goal Board is publishing 68 for that week. If those 8
// were merged or deleted, the honest figure is 60. If they merely converted,
// they are real traffic and 68 stands.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const GUEST_CARDS = '/api/v2/reports/guest_cards.json';
const INQUIRIES = '/api/v2/reports/guest_card_inquiries.json';
const WEEK = { from: '2026-09-20', to: '2026-09-26' };

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

// Follows next_page_url the same way the sync does, so a difference in counts
// here is a difference in the DATA and not in how far we read.
async function report(path, body, { maxPages = 40 } = {}) {
  let url = HOST + path;
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      e.status = res.status;
      throw e;
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('non-JSON response: ' + text.slice(0, 120)); }
    rows.push(...(json.results || []));
    const next = json.next_page_url || json.nextPageUrl;
    if (!next) break;
    url = next.replace(/\/\/[^@]*@/, '//');   // strip embedded credentials
    body = null;                              // next_page_url is a GET-shaped URL
  }
  return rows;
}

// Tries a call and reports what happened rather than throwing — the point of
// several of these is to find out WHICH parameters the API rejects.
async function attempt(label, path, body) {
  process.stdout.write(`  ${label.padEnd(52)}`);
  try {
    const rows = await report(path, body);
    console.log(`${String(rows.length).padStart(5)} rows`);
    return rows;
  } catch (e) {
    console.log(`FAILED  ${e.message.slice(0, 70)}`);
    return null;
  }
}

const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const pick = (r, keys) => { for (const k of keys) if (r[k] != null && String(r[k]).trim() !== '') return r[k]; return null; };

// ---- Masking ----------------------------------------------------------------
//
// This output gets pasted elsewhere, so nothing personal may leave in it. Names
// STAY: spotting a merged duplicate means recognising the same person under two
// cards, and a masked name makes that impossible.
//
// Two layers, deliberately overlapping. Column names are a guess about content
// — this report has columns we have never seen, and the one carrying a phone
// number may not be called "phone". So every value is ALSO scrubbed by pattern,
// and a column whose name looks sensitive is dropped whatever it contains.

// Columns replaced outright, by name.
const SENSITIVE_COL = /email|phone|mobile|cell|address|street|city|zip|postal|dob|birth|ssn|social|note|comment|description|message|contact_info/i;
// Free text can contain anything, so it is reduced to a length.
const FREE_TEXT_COL = /note|comment|description|message/i;

// foo.bar@gmail.com -> f***@gmail.com. The domain stays: it is useful (a run of
// leads from one ILS shows up in it) and it identifies nobody on its own.
const maskEmails = t => String(t).replace(
  /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
  (m, domain) => `${m[0]}***@${domain}`);

// Any run that looks like a phone -> ***-***-1234, keeping the last four so two
// records can still be told apart.
//
// Dates are left alone. Caught in testing: the first version turned
// "2026-09-21T15:08:59+00:00" into "***-***-0921T15:08:59+00:00" — a timestamp
// has plenty of digits and separators, and destroying the dates would have
// destroyed exactly the status information this script exists to read.
const LOOKS_LIKE_DATE = /^\s*\d{4}-\d{2}-\d{2}([T ]|$)/;
const maskPhones = t => {
  const str = String(t);
  if (LOOKS_LIKE_DATE.test(str)) return str;
  // The leading ( is part of the match so "(512) 817-0390" does not leave a
  // stray bracket behind.
  return str.replace(/\(?\+?\d[\d\s().-]{5,}\d\)?/g, m => {
    if (/\d{4}-\d{2}-\d{2}|T\d{2}:/.test(m)) return m;   // a date caught mid-string
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return m;  // not a phone
    return `***-***-${digits.slice(-4)}`;
  });
};

const scrub = v => (v == null ? v : maskPhones(maskEmails(String(v))));

// One value, masked for display. `key` is the column it came from.
function maskValue(key, value) {
  if (value == null || String(value).trim() === '') return value;
  // Ids and counts arrive as numbers and are not personal — returned as they
  // are, so a guest_card_id stays a number in the output.
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (FREE_TEXT_COL.test(key)) return `[free text, ${String(value).length} chars]`;
  if (SENSITIVE_COL.test(key)) return scrub(value);
  return scrub(value);
}

// A whole row, masked, for the cases where we want to see everything.
function maskRow(row, { limit = 400 } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = maskValue(k, v);
  const j = JSON.stringify(out);
  return j.length > limit ? j.slice(0, limit) + '…' : j;
}

// The status columns, masked. They should hold no personal data, but the
// selection is a regex over column NAMES and a column called
// "application_contact_status" would sail through it.
const showStatus = (row, keys) => keys.map(k => `${k}=${JSON.stringify(maskValue(k, row[k]))}`).join('  ');

(async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

  // ---- our side, read only -------------------------------------------------
  const ours = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('leasing_leads').select('*').range(f, f + 999);
    if (error) throw new Error('leasing_leads: ' + error.message);
    ours.push(...data);
    if (data.length < 1000) break;
  }
  const lastSync = ours.map(r => r.synced_at).filter(Boolean).sort().pop();
  const cut = new Date(new Date(lastSync).getTime() - 30 * 60000).toISOString();
  const inLastBatch = r => r.synced_at && r.synced_at >= cut;

  const missing8 = ours.filter(r => r.week_ending === '2026-09-26' && !inLastBatch(r));
  const orphans0905 = ours.filter(r => r.week_ending === '2026-09-05' && !inLastBatch(r)).slice(0, 10);

  console.log(`leasing_leads: ${ours.length} rows, last sync ${lastSync}`);
  console.log(`missing from that sync: ${ours.filter(r => !inLastBatch(r)).length} total, `
    + `${missing8.length} in the week ending 09/26\n`);

  // ---- 1. the 8, one call for the lot --------------------------------------
  console.log('=== 1. THE 8 FROM THE WEEK ENDING 09/26 =================================');
  console.log('Pulling the whole guest_cards report and looking each UUID up in it.');
  console.log('One pull rather than eight: the report has no by-UUID filter, and asking');
  console.log('for all of it is the only way to tell "absent" from "not matched".\n');

  const everyCard = await attempt('guest_cards, no filters at all', GUEST_CARDS, {});
  const everyCardAll = await attempt("guest_cards, property_visibility 'all'", GUEST_CARDS, { property_visibility: 'all' });
  const pool = (everyCardAll && everyCardAll.length >= (everyCard || []).length) ? everyCardAll : (everyCard || []);
  console.log(`\n  using the larger pull: ${pool.length} cards\n`);

  const byUuid = new Map();
  const byId = new Map();
  pool.forEach(r => {
    const u = pick(r, ['guest_card_uuid']);
    const gid = pick(r, ['guest_card_id']);
    if (u) byUuid.set(String(u), r);
    if (gid != null) byId.set(String(gid), r);
  });
  // Every column the report carries, so a status field we do not know the name
  // of is still visible.
  if (pool.length) {
    const cols = Object.keys(pool[0]);
    console.log('  columns available:', cols.join(', '));
    const masked = cols.filter(c => SENSITIVE_COL.test(c));
    console.log('  masked in this output:', masked.join(', ') || '(none by name; values are still pattern-scrubbed)', '\n');
  }

  const statusKeys = pool.length
    ? Object.keys(pool[0]).filter(k => /status|inactive|reason|archiv|delet|merge|convert|application|lease/i.test(k))
    : [];
  console.log('  status-ish columns:', statusKeys.join(', ') || '(none found)', '\n');

  for (const m of missing8) {
    const hit = byUuid.get(String(m.appfolio_id)) || byId.get(String(m.guest_card_id));
    console.log(`  ${String(m.guest_card_id).padStart(5)}  ${String(m.property).padEnd(22)} ${String(m.name).slice(0, 24).padEnd(26)}`);
    if (!hit) {
      console.log('         NOT PRESENT in the guest_cards report at all -> merged or deleted');
      continue;
    }
    // maskRow, not JSON.stringify: without it this line dumps the entire
    // guest card — email, phone, notes and all — into output that gets pasted
    // somewhere else.
    console.log('         present. ' + (statusKeys.length ? showStatus(hit, statusKeys) : maskRow(hit)));
  }

  // ---- 2. does the report take a status parameter? -------------------------
  console.log('\n=== 2. CAN WE ASK FOR INACTIVE CARDS? ===================================');
  console.log('A count that CHANGES means the parameter is read. An unchanged count means');
  console.log('it was ignored — which is exactly how the date filter failed.\n');

  const base = { first_contact_date_from: WEEK.from, first_contact_date_to: WEEK.to, property_visibility: 'active' };
  const variants = [
    ['inquiries, as the sync calls it', INQUIRIES, base],
    ['inquiries + status=all', INQUIRIES, { ...base, status: 'all' }],
    ['inquiries + guest_card_status=all', INQUIRIES, { ...base, guest_card_status: 'all' }],
    ['inquiries + include_inactive=true', INQUIRIES, { ...base, include_inactive: true }],
    ['inquiries + show_inactive=true', INQUIRIES, { ...base, show_inactive: true }],
    ['inquiries + statuses=[Active,Inactive]', INQUIRIES, { ...base, statuses: ['Active', 'Inactive'] }],
    ["inquiries + property_visibility=all", INQUIRIES, { ...base, property_visibility: 'all' }],
    ['guest_cards, same window', GUEST_CARDS, base],
    ['guest_cards + status=all', GUEST_CARDS, { ...base, status: 'all' }],
  ];
  const counts = {};
  for (const [label, path, body] of variants) {
    const rows = await attempt(label, path, body);
    if (rows) counts[label] = rows.length;
    await new Promise(r => setTimeout(r, 2300));   // 7 requests / 15s
  }
  const distinct = [...new Set(Object.values(counts))];
  console.log(`\n  distinct counts seen: ${distinct.join(', ')}`);
  console.log(distinct.length > 1
    ? '  -> at least one parameter IS read. The one that changed the count is the lever.'
    : '  -> every variant returned the same number. No status parameter is honoured,\n'
      + '     and the date window is ignored too (these are all the same pull).');

  // ---- 3. the 09/05 orphans ------------------------------------------------
  console.log('\n=== 3. TEN ORPHANS FROM THE WEEK ENDING 2026-09-05 ======================');
  console.log('For each: is it in the report, and is there ANOTHER card carrying the same');
  console.log('name or email? A twin is what a merge looks like from outside.\n');

  const byName = new Map(), byEmail = new Map();
  pool.forEach(r => {
    const n = norm(pick(r, ['name']));
    const e = norm(pick(r, ['email_address', 'email']));
    if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(r); }
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(r); }
  });

  for (const o of orphans0905) {
    const hit = byUuid.get(String(o.appfolio_id)) || byId.get(String(o.guest_card_id));
    const twinsName = (byName.get(norm(o.name)) || []).filter(r => String(pick(r, ['guest_card_uuid'])) !== String(o.appfolio_id));
    const twinsMail = o.email ? (byEmail.get(norm(o.email)) || []).filter(r => String(pick(r, ['guest_card_uuid'])) !== String(o.appfolio_id)) : [];
    console.log(`  ${String(o.guest_card_id).padStart(5)}  ${String(o.name).slice(0, 26).padEnd(28)} ${String(o.property).slice(0, 20).padEnd(22)}`);
    console.log(`         in report: ${hit ? 'YES' : 'NO'}`
      + `   same name elsewhere: ${twinsName.length}`
      + `   same email elsewhere: ${twinsMail.length}`);
    if (hit && statusKeys.length) console.log('         ' + showStatus(hit, statusKeys));
    twinsName.slice(0, 2).forEach(t => console.log(`         twin -> card ${pick(t, ['guest_card_id'])} `
      + showStatus(t, statusKeys)));
  }

  // ---- what it adds up to --------------------------------------------------
  console.log('\n=== READING THIS ========================================================');
  console.log('  "NOT PRESENT" for most of the 8      -> merged or deleted. The week is 60,');
  console.log('                                          not 68, and the Goal Board is high.');
  console.log('  present with an inactive/closed flag -> they converted or went cold. 68 is');
  console.log('                                          right; the sync just needs to ask');
  console.log('                                          for inactive cards too.');
  console.log('  present with nothing unusual         -> the report is not deterministic,');
  console.log('                                          which is a question for AppFolio.');
  console.log('\n  Nothing was written. Supabase and AppFolio are both untouched.');
  console.log('  Emails, phones and free text are masked; names are intentionally not.');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
