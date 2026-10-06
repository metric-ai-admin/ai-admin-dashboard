#!/usr/bin/env node
//
// Would the Command Center's cards close themselves correctly?
//
//   node scripts/probe-cc-autocomplete.js
//
// READ-ONLY. Nothing is written to Supabase or to AppFolio.
//
// Erick marks ~200 cards a day by hand. Most of them are about a work order
// that AppFolio already knows is finished, so the tick is being asked of a
// person who has no new information to add. This measures, against the real
// stored boards, how many cards carry a work order at all, which of those are
// closed now, and what would therefore have ticked itself.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WOS = require('../lib/work-order-status.js');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } });

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const { data: states, error } = await db.from('cc_daily_state')
    .select('state_date, tasks, checks, total_tasks, completed_tasks, generated_at, updated_at')
    .order('state_date', { ascending: true });
  if (error) { console.error('cc_daily_state:', error.message); process.exit(1); }

  console.log('=== 1. WHAT IS ACTUALLY STORED ===');
  console.log('rows:', states.length);
  if (!states.length) { console.log('nothing to measure'); process.exit(0); }
  console.log('dates:', states.map(s => s.state_date).join(', '));
  console.log('');

  // Work orders, as the dashboard currently holds them.
  const { data: wos, error: we } = await db.from('maintenance_work_orders')
    .select('work_order_number, work_order_id, status, completed_on, updated_at');
  if (we) { console.error('maintenance_work_orders:', we.message); process.exit(1); }
  const byNum = new Map();
  wos.forEach(w => { if (w.work_order_id) byNum.set(String(w.work_order_id).trim(), w); });
  console.log('work orders on file:', wos.length);
  const statusTally = {};
  wos.forEach(w => { statusTally[w.status || '(null)'] = (statusTally[w.status || '(null)'] || 0) + 1; });
  console.log('statuses present:');
  Object.entries(statusTally).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('   ' + pad(k, 34) + lpad(v, 6)
      + '   closed=' + (WOS.isClosed(k) ? 'yes' : WOS.isUnknown(k) ? '?' : 'no')));
  console.log('');

  // The work order a card is about. The id is cat + ':' + woId, but the card
  // also carries wo.woId — read that first and fall back to the id, so a card
  // whose shape changes does not silently stop matching.
  // The work order a card is about.
  //
  // It is wo.woId, and it joins maintenance_work_orders on work_order_id --
  // NOT on work_order_number. Those are different identifiers: woId 24231 is
  // the work order, service_request_id 22847 is the request behind it, and
  // work_order_number is "22847-1". Matching on the number finds nothing at
  // all, which looks exactly like "no card is ever closed".
  //
  // The id suffix is NOT a fallback. 'insppend:1430' carries an INSPECTION id
  // in the same position, and it is a number of the same shape, so a regex on
  // the id would silently join inspections to whatever work order shares their
  // number. Only the explicit wo.woId counts.
  const woOf = t => {
    const v = t && t.wo && t.wo.woId;
    return v ? String(v).trim() : null;
  };

  console.log('=== 2. CARD TYPES: WHICH CARRY A WORK ORDER ===');
  const cats = new Map();
  for (const s of states) {
    for (const t of (Array.isArray(s.tasks) ? s.tasks : [])) {
      const c = t.cat || '(none)';
      if (!cats.has(c)) cats.set(c, { cat: c, n: 0, withWo: 0, matched: 0, closed: 0, ticked: 0, sample: null });
      const e = cats.get(c);
      e.n++;
      const num = woOf(t);
      if (num) {
        e.withWo++;
        const w = byNum.get(num);
        if (w) { e.matched++; if (WOS.isClosed(w.status)) e.closed++; }
      }
      if (s.checks && s.checks[t.id]) e.ticked++;
      if (!e.sample) e.sample = t.id;
    }
  }
  console.log(pad('category', 14) + lpad('cards', 7) + lpad('w/ WO', 7) + lpad('matched', 9)
    + lpad('closed', 8) + lpad('ticked', 8) + '   sample id');
  [...cats.values()].sort((a, b) => b.n - a.n).forEach(e =>
    console.log(pad(e.cat, 14) + lpad(e.n, 7) + lpad(e.withWo, 7) + lpad(e.matched, 9)
      + lpad(e.closed, 8) + lpad(e.ticked, 8) + '   ' + String(e.sample).slice(0, 46)));
  console.log('');

  console.log('=== 3. DRY RUN: WHAT WOULD HAVE TICKED ITSELF, PER DAY ===');
  // Judged against the status the work order had ON THAT DAY, not the status it
  // has now. "Closed at some point since" is a different and much larger
  // number, and reporting it as what would have happened on the 29th would
  // overstate the feature by roughly a week of closures.
  const ymd = v => (v ? String(v).slice(0, 10) : null);
  console.log(pad('date', 12) + lpad('cards', 7) + lpad('with WO', 9) + lpad('auto', 7)
    + lpad('manual', 8) + lpad('rest', 7) + '   stored completed_tasks');
  const examples = [];
  for (const s of states) {
    const tasks = Array.isArray(s.tasks) ? s.tasks : [];
    const checks = s.checks || {};
    let withWo = 0, auto = 0, manual = 0;
    for (const t of tasks) {
      if (checks[t.id]) manual++;
      const num = woOf(t);
      if (!num) continue;
      withWo++;
      const w = byNum.get(num);
      if (!w || !WOS.isClosed(w.status)) continue;
      const on = ymd(w.completed_on);
      if (!on || on > s.state_date) continue;
      auto++;
      if (examples.length < 10 && !checks[t.id]) {
        examples.push({ date: s.state_date, id: t.id, status: w.status, on,
          title: String(t.title || '').slice(0, 48) });
      }
    }
    console.log(pad(s.state_date, 12) + lpad(tasks.length, 7) + lpad(withWo, 9) + lpad(auto, 7)
      + lpad(manual, 8) + lpad(tasks.length - auto - manual, 7) + lpad(s.completed_tasks, 10));
  }
  console.log('');
  console.log('=== 4. TEN THAT WOULD HAVE TICKED THEMSELVES ===');
  if (!examples.length) console.log('(none)');
  examples.forEach(e => console.log('  ' + e.date + '  ' + pad(e.id, 20) + pad(e.status, 26)
    + 'closed ' + e.on + '  ' + e.title));
  console.log('');

  // The ticks that DO exist. completed_tasks has read 0 every day, and the
  // reason is here rather than in the counting: the only boxes ticked are the
  // fixed routine checklist, whose ids are "routine:*" and are not in tasks at
  // all, so tasks.filter(t => checks[t.id]) can only ever be zero.
  console.log('=== 4b. WHAT IS ACTUALLY TICKED ===');
  for (const s of states) {
    const ids = new Set((Array.isArray(s.tasks) ? s.tasks : []).map(t => t.id));
    const on = Object.keys(s.checks || {}).filter(k => s.checks[k]);
    const card = on.filter(k => ids.has(k)).length;
    console.log('  ' + s.state_date + '  ticks ' + lpad(on.length, 3)
      + ' | on a generated card ' + lpad(card, 3)
      + ' | elsewhere ' + lpad(on.length - card, 3)
      + (on.length - card ? '  e.g. ' + on.filter(k => !ids.has(k)).slice(0, 3).join(' ') : ''));
  }
  console.log('');

  console.log('=== 5. CARDS WITH NO WORK ORDER, BY CATEGORY ===');
  [...cats.values()].filter(e => e.withWo < e.n).sort((a, b) => (b.n - b.withWo) - (a.n - a.withWo))
    .forEach(e => console.log('  ' + pad(e.cat, 14) + lpad(e.n - e.withWo, 6) + ' of ' + e.n + ' have no WO number'));
  console.log('');
  console.log('=== 6. CARDS WHOSE WORK ORDER IS NOT ON FILE ===');
  [...cats.values()].filter(e => e.withWo > e.matched)
    .forEach(e => console.log('  ' + pad(e.cat, 14) + lpad(e.withWo - e.matched, 6) + ' of ' + e.withWo + ' not found in maintenance_work_orders (by work_order_id)'));
})().catch(e => { console.error(e); process.exit(1); });
