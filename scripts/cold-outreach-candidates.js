#!/usr/bin/env node
/**
 * Email Auto-Move — Phase 0. Proposes senders for cold_outreach_senders.
 *
 * READ-ONLY. Writes a CSV for review; touches no mailbox and no table.
 * Nothing here decides anything: a human approves the list before Phase 1
 * archives a single message.
 *
 *   node scripts/cold-outreach-candidates.js [--limit 2000] [--out FILE]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BOX = process.env.MAILBOX_LYNDSAY || 'lyndsay@metricpropertymanagement.com';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '2000'), 10);
const OUT = arg('--out', path.join(process.cwd(), 'cold-outreach-candidates.csv'));

// Senders that are systems, not people. Cold outreach is a human writing 1:1,
// so anything on this list is noise for this question — the Outlook rules
// already route most of it.
const SYSTEM_DOMAINS = [
  'appfolio.com', 'appfolio.us', 'simplevoip.com', 'simplevoip.us',
  'webwork-tracker.com', 'asana.com', 'microsoft.com', 'microsoftonline.com',
  'sharepoint.com', 'paycom.com', 'paylocity.com',
];
// Never propose ourselves.
const INTERNAL_DOMAINS = ['metricpropertymanagement.com', 'livewithmetric.com'];

// Suggestions only. They land in the category column, which is descriptive and
// never used for matching, so a wrong guess costs a word in a review.
const CATEGORY_HINTS = [
  ['M&A advisory',    /\b(m&a|acquisition|acquire|merger|sell(ing)? your|exit strategy|valuation|buy-?side|sell-?side)\b/i],
  ['cybersecurity',   /\b(cyber|ransomware|penetration test|pen-?test|soc ?2|phishing|threat|vulnerabilit)/i],
  ['deal blast',      /\b(off-?market|deal flow|portfolio for sale|cap rate|new listing|investment opportunity)\b/i],
  ['public adjuster', /\b(public adjuster|hail|storm damage|roof inspection|insurance claim)\b/i],
  ['bookkeeping',     /\b(bookkeep|accounting services|cfo services|tax prep|reconcil)/i],
  // Not a bare \bai\b — it matched a colleague's personal address and every
  // vendor invoice in the sample. The hints have to be worth more than the
  // time it takes to delete their mistakes.
  ['AI consulting',   /\b(ai (consult|strateg|solution|agent|transformation)|chatgpt|llm|agentic|workflow automation)/i],
  ['financing',       /\b(financing|cash flow|working capital|line of credit|funding|merchant advance)\b/i],
  ['staffing / VA',   /\b(virtual assistant|outsourc|staffing|offshore|recruit)/i],
];
const suggestCategory = (subjects) => {
  const hay = subjects.join(' || ');
  for (const pair of CATEGORY_HINTS) if (pair[1].test(hay)) return pair[0];
  return '';
};

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Graph drops or throttles the odd request over a long paged scan, and losing
// page 14 of 20 should not cost the whole run. Retries transient failures and
// honours Retry-After on 429/503.
async function gfetch(url, opts, tries) {
  tries = tries || 4;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) {
        const wait = parseInt(r.headers.get('retry-after') || '0', 10) || Math.pow(2, i);
        process.stderr.write('\n  ' + r.status + ' - waiting ' + wait + 's\n');
        await new Promise(res => setTimeout(res, wait * 1000));
        last = new Error('Graph ' + r.status);
        continue;
      }
      return r;
    } catch (e) {
      last = e;
      await new Promise(res => setTimeout(res, Math.pow(2, i) * 1000));
    }
  }
  throw last;
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch('https://login.microsoftonline.com/' + process.env.GRAPH_TENANT_ID + '/oauth2/v2.0/token', { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('Token failed: ' + (j.error_description || j.error));
  return j.access_token;
}

async function main() {
  if (!process.env.GRAPH_CLIENT_ID) { console.error('Graph credentials missing from .env'); process.exit(1); }
  const tk = await getToken();
  const H = { Authorization: 'Bearer ' + tk };
  const base = 'https://graph.microsoft.com/v1.0/users/' + BOX;

  // ---- 1. Page through Archive, newest first ------------------------------
  let url = base + '/mailFolders/archive/messages?$top=100&$orderby=receivedDateTime desc'
          + '&$select=id,subject,from,receivedDateTime,toRecipients';
  const msgs = [];
  while (url && msgs.length < LIMIT) {
    const r = await gfetch(url, { headers: H });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Graph ' + r.status));
    msgs.push.apply(msgs, j.value || []);
    url = j['@odata.nextLink'];
    process.stderr.write('\r  read ' + msgs.length);
  }
  process.stderr.write('\r  read ' + msgs.length + ' messages from Archive\n');

  // ---- 2. Group by sender -------------------------------------------------
  const bySender = new Map();
  for (const m of msgs) {
    const addr = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    if (!addr || addr.indexOf('@') < 0) continue;
    const domain = addr.split('@')[1];
    if (INTERNAL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) continue;
    if (SYSTEM_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) continue;
    // A blast to a distribution list is not 1:1 outreach.
    if ((m.toRecipients || []).length > 2) continue;

    if (!bySender.has(addr)) bySender.set(addr, { addr, domain, count: 0, last: '', ids: [], subjects: [] });
    const e = bySender.get(addr);
    e.count++;
    if ((m.receivedDateTime || '') > e.last) e.last = m.receivedDateTime || '';
    if (e.ids.length < 3) e.ids.push(m.id);
    if (e.subjects.length < 5 && m.subject) e.subjects.push(m.subject);
  }

  // ---- 3. Drop anyone who sends with List-Unsubscribe ---------------------
  // A header means it is a mailing list, which is action 2's job (move to
  // "Unsubscribe Needed"), not action 1's. One representative message per
  // sender, batched 20 at a time.
  const cands = Array.from(bySender.values()).sort((a, b) => b.count - a.count);
  const probe = cands.filter(c => c.ids.length);
  const hasLU = new Map();
  for (let i = 0; i < probe.length; i += 20) {
    const chunk = probe.slice(i, i + 20);
    const r = await gfetch('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      headers: Object.assign({}, H, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ requests: chunk.map((c, j) => ({
        id: String(j),
        method: 'GET',
        url: '/users/' + BOX + '/messages/' + encodeURIComponent(c.ids[0]) + '?$select=internetMessageHeaders',
      })) }),
    });
    const j = await r.json();
    for (const resp of (j.responses || [])) {
      const c = chunk[parseInt(resp.id, 10)];
      if (resp.status === 200) {
        const hs = (resp.body && resp.body.internetMessageHeaders) || [];
        hasLU.set(c.addr, hs.some(h => /^list-unsubscribe$/i.test(h.name)));
      }
    }
    process.stderr.write('\r  header-checked ' + Math.min(i + 20, probe.length) + '/' + probe.length);
  }
  process.stderr.write('\n');

  const newsletters = cands.filter(c => hasLU.get(c.addr) === true);
  const oneToOne = cands.filter(c => hasLU.get(c.addr) !== true);

  // ---- 4. Write the review file -------------------------------------------
  const rows = oneToOne.map(c => ({
    sender_email: c.addr,
    domain: c.domain,
    count: c.count,
    last_seen: (c.last || '').slice(0, 10),
    suggested_category: suggestCategory(c.subjects),
    sample_subject: c.subjects[0] || '',
  }));
  const head = ['sender_email', 'domain', 'count', 'last_seen', 'suggested_category', 'sample_subject'];
  const csv = [head.join(',')].concat(rows.map(r => head.map(k => csvCell(r[k])).join(','))).join('\n');
  fs.writeFileSync(OUT, csv, 'utf8');

  // ---- 5. Report ----------------------------------------------------------
  const withCat = rows.filter(r => r.suggested_category);
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log('');
  console.log('Archive sampled  : ' + msgs.length + ' messages');
  console.log('Distinct senders : ' + bySender.size + '  (system + internal domains and list blasts already dropped)');
  console.log('Newsletters      : ' + newsletters.length + ' dropped - they carry List-Unsubscribe, so they are action 2, not action 1');
  console.log('Candidates       : ' + rows.length + '   of which ' + withCat.length + ' matched a category hint');
  console.log('');
  console.log(pad('sender_email', 44) + pad('cnt', 5) + pad('last_seen', 12) + 'suggested_category');
  console.log('-'.repeat(92));
  for (const r of withCat.slice(0, 40)) {
    console.log(pad(r.sender_email, 44) + pad(r.count, 5) + pad(r.last_seen, 12) + r.suggested_category);
  }
  console.log('');
  console.log('Full list (all ' + rows.length + ', categorised or not) written to:');
  console.log('  ' + OUT);
  console.log('');
  console.log('Nothing was inserted. Review the CSV, delete every row that is not cold outreach,');
  console.log('and only then load what survives into cold_outreach_senders.');
}

main().catch(e => { console.error('\n' + e.message); process.exit(1); });
