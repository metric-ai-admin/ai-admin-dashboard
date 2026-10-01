#!/usr/bin/env node
//
// READ ONLY probe. Run on Render Shell, where the AppFolio credentials live.
//
//   node scripts/probe-appfolio-moveouts.js
//
// It only reads reports. It writes nothing to AppFolio, nothing to Supabase,
// and nothing to disk. No report is saved, modified or deleted.
//
// TWO QUESTIONS, both raised by the KPI comparison on 2026-10-01:
//
// (a) Is `paginate_results: false` truncating us? leasing_lease_history holds
//     64 rows for a 398-unit portfolio, which is too few to be every lease.
//     The sync passes paginate_results:false; this asks for both and counts.
//
// (b) Where do weekly move-outs actually come from? Of our 64 synced rows,
//     ALL 64 have a move_in_date and only 3 have a move_out_date — including
//     42 rows whose status is "Completed". A finished lease with no move-out
//     date says the field is not populated by that report, not that nobody
//     moved out. Lyndsay's box score has move-outs for 09/20-09/26 and we have
//     none, so something else carries them.
//
// Output is a table. Nothing here decides anything — it produces the evidence
// for deciding which report the sync should call.

require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const WEEK = [process.env.PROBE_FROM || '2026-09-20', process.env.PROBE_TO || '2026-09-26'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inWeek = d => { const s = String(d || '').slice(0, 10); return s >= WEEK[0] && s <= WEEK[1]; };

async function report(path, body, label) {
  const auth = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://${HOST}${path}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (r.status === 429 || r.status === 503 || r.status === 502) { await sleep(2000 * (attempt + 1)); continue; }
    const txt = await r.text();
    if (!r.ok) return { error: `${r.status} ${txt.slice(0, 140).replace(/\s+/g, ' ')}` };
    let j; try { j = JSON.parse(txt); } catch { return { error: 'response was not JSON' }; }
    // The API answers either a bare array or an envelope. Page through
    // next_page_url when it is there, so "how many rows exist" is answered
    // honestly rather than by the first page.
    let rows = Array.isArray(j) ? j : (j.results || j.data || []);
    let next = j && j.next_page_url;
    let pages = 1;
    while (next && pages < 40) {
      const nr = await fetch(next.startsWith('http') ? next : `https://${HOST}${next}`,
        { method: 'GET', headers: { Authorization: auth } });
      if (!nr.ok) break;
      const nj = await nr.json().catch(() => null);
      if (!nj) break;
      rows = rows.concat(Array.isArray(nj) ? nj : (nj.results || nj.data || []));
      next = nj.next_page_url;
      pages++;
      await sleep(300);
    }
    return { rows, pages };
  }
  return { error: 'gave up after retries' };
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this environment.');
    console.error('This probe has to run where they are — Render Shell, not a laptop.');
    process.exit(1);
  }
  console.log('READ ONLY probe. Nothing is written anywhere.');
  console.log(`Host : ${HOST}`);
  console.log(`Week : ${WEEK[0]} .. ${WEEK[1]}\n`);

  // ── (a) pagination ────────────────────────────────────────────────────────
  console.log('='.repeat(78));
  console.log('(a) lease_history — does paginate_results change the row count?');
  console.log('='.repeat(78));
  for (const paginate of [false, true]) {
    const r = await report('/api/v2/reports/lease_history.json',
      { property_visibility: 'active', paginate_results: paginate });
    if (r.error) { console.log(`  paginate_results: ${String(paginate).padEnd(5)} -> ${r.error}`); continue; }
    const withOut = r.rows.filter(x => x.move_out).length;
    console.log(`  paginate_results: ${String(paginate).padEnd(5)} -> ${String(r.rows.length).padStart(6)} rows`
      + ` (${r.pages} page(s)) · with move_out: ${withOut}`
      + ` · move_out in week: ${r.rows.filter(x => inWeek(x.move_out)).length}`);
    if (paginate === false && r.rows[0]) {
      console.log(`     fields: ${Object.keys(r.rows[0]).join(', ')}`);
    }
    await sleep(600);
  }
  console.log('\n  The sync passes paginate_results:false. If the two counts differ,');
  console.log('  we have been syncing one page and the move-out gap may be part of it.');

  // ── (b) which report carries move-outs ────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('(b) which report carries move-outs for the week');
  console.log('='.repeat(78));
  const CANDIDATES = [
    ['/api/v2/reports/box_score.json', { from_date: WEEK[0], to_date: WEEK[1], property_visibility: 'active' }],
    ['/api/v2/reports/box_score.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/tenant_directory.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/move_out.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/move_ins_move_outs.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/tenant_tickler.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/unit_vacancy.json', { property_visibility: 'active', paginate_results: true }],
    ['/api/v2/reports/lease_expiration_detail.json', { property_visibility: 'active', paginate_results: true }],
  ];
  for (const [path, body] of CANDIDATES) {
    const name = path.split('/').pop().replace('.json', '');
    const r = await report(path, body);
    if (r.error) { console.log(`\n  ${name.padEnd(26)} ${r.error}`); await sleep(600); continue; }
    const fields = Object.keys(r.rows[0] || {});
    // Anything that could be a move-out: the date itself, or an event column
    // whose values say "Move Out".
    const dateFields = fields.filter(f => /move_?out|moved_out|vacate|notice/i.test(f));
    const eventFields = fields.filter(f => /event|type|transaction|activity/i.test(f));
    console.log(`\n  ${name.padEnd(26)} ${String(r.rows.length).padStart(6)} rows (${r.pages} page(s))`);
    if (dateFields.length) {
      dateFields.forEach(f => {
        const n = r.rows.filter(x => inWeek(x[f])).length;
        console.log(`      ${f.padEnd(26)} ${String(n).padStart(4)} in week`
          + `   ${r.rows.filter(x => x[f]).length} populated overall`);
      });
    }
    eventFields.forEach(f => {
      const vals = {};
      r.rows.forEach(x => { const v = String(x[f] ?? '').trim(); if (v) vals[v] = (vals[v] || 0) + 1; });
      const moveOutish = Object.keys(vals).filter(v => /move\s*-?\s*out/i.test(v));
      if (moveOutish.length) {
        console.log(`      ${f} values containing "move out": `
          + moveOutish.map(v => `${v}=${vals[v]}`).join(', '));
      }
    });
    if (!dateFields.length && !eventFields.length) {
      console.log(`      no move-out-shaped field. fields: ${fields.slice(0, 12).join(', ')}`);
    }
    await sleep(600);
  }

  console.log('\n' + '='.repeat(78));
  console.log('What to look for: a report with a populated move-out date column');
  console.log(`showing roughly as many rows in ${WEEK[0]}..${WEEK[1]} as the box score does.`);
  console.log('A 404 just means that report name does not exist in this tenant.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
