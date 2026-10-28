#!/usr/bin/env node
//
// Katie says the dashboard KPI and AppFolio disagree. Which numbers?
//
//   node scripts/probe-kpi-reconcile.js                       # week ending 2026-10-24
//   node scripts/probe-kpi-reconcile.js --week 2026-10-24 --metric occupancy
//
// READ ONLY. It reads Supabase and the saved-report store over the
// dashboard's own read endpoint. It writes nothing to either, makes no
// AppFolio request, and nothing the dashboard shows changes because this runs.
//
// IT DOES NOT CALL /api/kpi/report. That route CAPTURES A SNAPSHOT — a GET
// that writes a row. Running it to "just read" the numbers would put a second
// 2026-10-24 capture in kpi_property_snapshots under whoever ran it, on top of
// the one this is trying to explain.
//
// THE DASHBOARD SIDE IS KATIE'S OWN CAPTURE, where there is one.
// kpi_property_snapshots holds what the page rendered for her at
// 2026-10-26T13:58Z, captured_by Katie. That is the number she was looking at
// when she said they differ — better evidence than recomputing today and
// hoping nothing moved. For the metrics the snapshot does not store (leads,
// tours, move-ins/outs, work orders) the dashboard's own module computes them,
// and that is said in the output rather than implied.
//
// THE SOURCE SIDE IS COMPUTED HERE, NOT BY lib/kpi-lyndsay.js. Reusing the
// dashboard's module for both columns would agree by construction and prove
// nothing — the same reason scripts/kpi-compare-lyndsay.js re-implements her
// rules instead of importing ours. Every source figure below is counted
// straight off the synced AppFolio rows by code in this file.
//
// WHAT "APPFOLIO VALUE" MEANS HERE, EXACTLY. It is the AppFolio report rows as
// last synced, NOT a fresh pull: this laptop has no AppFolio reporting
// credentials (APPFOLIO_REPORTS_CLIENT_ID is empty in .env), and every route
// on Render that re-pulls a report also WRITES it. So each source is printed
// with its own as-of and sync time, and a difference that those timestamps
// explain is reported as sync timing rather than as a disagreement about a
// definition. Anything needing a genuinely fresh pull is named at the end.
'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
// The roll-up definitions, taken from the report's own module rather than
// retyped. Greystone, Round Rock and Portfolio are GROUPS, not properties:
// the first run reported all three as 'no AppFolio rows under this name',
// which was this script's bug and would have sent somebody looking for a
// property that does not exist.
const kpiReport = require('../lib/kpi-report.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const WEEK_END = arg('week', '2026-10-24');
const ONLY = (arg('metric', '') || '').toLowerCase();
const BASE = String(arg('base', process.env.PROBE_BASE_URL
  || 'https://ai-admin-dashboard-jkde.onrender.com')).replace(/\/+$/, '');
const KEY = process.env.METRIC_API_KEY || '';

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEK_START = addDays(WEEK_END, -6);

const clean = v => String(v == null ? '' : v).trim();
const ymd = v => clean(v).slice(0, 10);
const num = v => {
  if (v == null || v === '') return 0;
  let s = String(v).trim().replace(/[$,%\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
};
// The community name, without the street address AppFolio appends. The same
// rule the occupancy sync uses, so the two sides key on the same string.
const canon = raw => {
  let s = clean(raw);
  if (!s || s.toLowerCase() === 'total') return null;
  const i = s.indexOf(' - ');
  if (i > 0) s = s.slice(0, i).trim();
  return s || null;
};
const inWeek = v => { const d = ymd(v); return d && d >= WEEK_START && d <= WEEK_END; };

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// PAGED, because PostgREST stops at 1000 and .limit() does not raise it. A
// capped read returns a plausible number, which is the worst kind of wrong on
// a page whose whole job is to say whether two numbers agree.
async function all(table, cols, tweak) {
  const out = [];
  for (let from = 0; from < 60000; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (tweak) q = tweak(q);
    const r = await q;
    if (r.error) throw new Error(table + ': ' + r.error.message);
    out.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
  }
  return out;
}

// The saved-report store lives on Render's disk. This is its READ endpoint —
// no sync, no write.
async function store(id) {
  const rows = [];
  let meta = {};
  for (let offset = 0, guard = 0; guard < 60; guard++) {
    const res = await fetch(BASE + '/api/appfolio/reports/' + id + '/data?limit=1000&offset=' + offset,
      { headers: KEY ? { 'x-metric-key': KEY } : {} });
    if (!res.ok) throw new Error(id + ': HTTP ' + res.status);
    const j = await res.json();
    meta = { fetchedAt: j.fetchedAt || j.syncedAt || j.synced_at || null, total: j.total };
    const got = j.rows || [];
    rows.push(...got);
    if (!got.length || rows.length >= (j.total || 0)) break;
    offset += got.length;
  }
  return { rows, ...meta };
}

const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const fmt = v => (v === null || v === undefined) ? '—' : (typeof v === 'number'
  ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

// A group's source figure is the SUM OF ITS MEMBERS, because no AppFolio
// report has a row called "Greystone". Portfolio is every non-excluded
// property the source itself carries — not a hard-coded list, which would
// drift the first time a property was added.
const GROUPS = { Greystone: 1, 'Round Rock': 1, Portfolio: 1 };
const isGroup = p => Object.prototype.hasOwnProperty.call(GROUPS, p);
function groupValue(name, lookup, universe) {
  const members = name === 'Portfolio'
    ? universe.filter(p => !isGroup(p) && !kpiReport.isExcluded(p))
    : kpiReport.groupMembers(name, null).filter(p => !kpiReport.isExcluded(p));
  if (!members.length) return { value: null, members: [] };
  let any = false, sum = 0;
  members.forEach(m => { const v = lookup(m); if (v != null) { any = true; sum += v; } });
  return { value: any ? Math.round(sum * 100) / 100 : null, members };
}

const ROWS = [];
// One comparison line. `cause` is REQUIRED when the two differ: a difference
// with no explanation is the thing this script exists to stop producing.
function compare(metric, property, dash, af, cause, note) {
  const differs = !(dash === af || (dash == null && af == null)
    || (typeof dash === 'number' && typeof af === 'number' && Math.abs(dash - af) < 0.005));
  if (differs && !cause) cause = 'UNEXPLAINED — do not report this as a known difference';
  ROWS.push({ metric, property, dash, af, differs, cause: differs ? cause : (note || ''), note });
}

function table(title, rows) {
  if (!rows.length) return;
  console.log('\n' + title);
  console.log('  ' + pad('property', 26) + lpad('dashboard', 11) + lpad('appfolio', 11) + '  ' + 'verdict');
  console.log('  ' + '-'.repeat(26 + 11 + 11 + 2 + 8));
  rows.forEach(r => {
    console.log('  ' + pad(r.property, 26) + lpad(fmt(r.dash), 11) + lpad(fmt(r.af), 11)
      + '  ' + (r.differs ? 'DIFFERS' : 'match'));
    if (r.differs) console.log('  ' + ' '.repeat(26) + '    cause: ' + r.cause);
  });
}

const SKIPPED = [];
const want = m => !ONLY || ONLY === m.toLowerCase();

(async () => {
  console.log('KPI RECONCILIATION — dashboard vs the AppFolio reports behind it');
  console.log('week ' + WEEK_START + ' .. ' + WEEK_END + '   (read-only; no AppFolio request, no writes)\n');

  // ── The dashboard side: Katie's capture ────────────────────────────────
  const snaps = await all('kpi_property_snapshots', '*', q => q.eq('week_ending', WEEK_END));
  if (!snaps.length) throw new Error('No kpi_property_snapshots row for week_ending ' + WEEK_END
    + '. Without the capture there is no "what the dashboard showed" to compare against.');
  const capturedAt = [...new Set(snaps.map(s => s.captured_at))].sort();
  const capturedBy = [...new Set(snaps.map(s => s.captured_by).filter(Boolean))];
  console.log('DASHBOARD SIDE  kpi_property_snapshots, week ending ' + WEEK_END);
  console.log('  captured ' + capturedAt[0] + ' by ' + (capturedBy.join(', ') || 'unknown')
    + '   ' + snaps.length + ' properties');
  const snapBy = new Map();
  snaps.forEach(s => { const c = canon(s.property); if (c) snapBy.set(c, s); });

  // ── The source side ────────────────────────────────────────────────────
  const [occNow, occHist, interests, cards, showings, leaseHist, wos] = await Promise.all([
    all('leasing_occupancy', 'property_name,total_units,occupied_units,vacant_rented,notice_units,as_of,synced_at'),
    all('leasing_occupancy_history',
      'property_name,as_of,source_as_of,total_units,occupied_units,vacant_rented,notice_units,captured_at'),
    all('leasing_lead_interests', 'property,interest_received,guest_card_uuid'),
    all('leasing_leads', 'guest_card_uuid,name,email,phone'),
    all('leasing_showings', 'property_name,showing_date,status'),
    all('leasing_lease_history', 'property_name,move_in_date,move_out_date,renewal'),
    all('maintenance_work_orders',
      'property_name,status,work_order_type,created_at_appfolio,completed_on,updated_at'),
  ]);

  const occAsOf = [...new Set(occNow.map(r => ymd(r.as_of)).filter(Boolean))].sort();
  const occSynced = [...new Set(occNow.map(r => r.synced_at).filter(Boolean))].sort();
  console.log('\nSOURCE SIDE   (AppFolio rows as last synced — see the note on fresh pulls at the end)');
  console.log('  occupancy_summary -> leasing_occupancy         as_of ' + occAsOf.join(', ')
    + '   synced ' + (occSynced[occSynced.length - 1] || '?'));
  const histWeek = occHist.filter(r => ymd(r.as_of) === WEEK_END);
  console.log('  occupancy_summary -> leasing_occupancy_history  rows at as_of=' + WEEK_END + ': ' + histWeek.length);

  // A MATCH HERE CAN STILL BE BUILT ON A STALE ROW. leasing_occupancy_history
  // stamps its own as_of when it captures, and records in source_as_of what
  // the AppFolio row said about itself. When those disagree, the week's
  // "history" is a copy of an older reading filed under this week's date —
  // and it agreeing with the dashboard proves only that both read the same
  // stale number. Reported whether or not the comparison differs, because a
  // match is exactly when nobody would otherwise look.
  const staleHist = histWeek.filter(r => ymd(r.source_as_of) && ymd(r.source_as_of) < WEEK_END);
  if (staleHist.length) {
    console.log('\n  WARNING — ' + staleHist.length + ' of ' + histWeek.length
      + ' history rows at as_of=' + WEEK_END + ' were captured from an older AppFolio reading:');
    staleHist.sort((a, b) => ymd(a.source_as_of).localeCompare(ymd(b.source_as_of))).forEach(r =>
      console.log('    ' + pad(canon(r.property_name), 26) + ' source_as_of ' + ymd(r.source_as_of)
        + '   (' + Math.round((Date.parse(WEEK_END) - Date.parse(ymd(r.source_as_of))) / 86400000)
        + ' days before the week ended)'));
  }

  // ── OCCUPANCY / PRELEASED / NOTICES ────────────────────────────────────
  //
  // THE SOURCE FOR THIS WEEK IS THE HISTORY TABLE, NOT THE LIVE ONE.
  // leasing_occupancy holds ONE ROW PER PROPERTY, upserted on property_name
  // with no history — it describes today and nothing else. The report for a
  // past week reads it anyway, so every occupancy figure on a week-ending
  // page is as-of the day somebody opened it.
  const histBy = new Map();
  histWeek.forEach(r => { const c = canon(r.property_name); if (c) histBy.set(c, r); });

  if (want('occupancy') || want('preleased') || want('notices')) {
    const occRows = [], preRows = [], notRows = [];
    for (const [prop, s] of [...snapBy].sort()) {
      const h = histBy.get(prop);
      if (!h) {
        SKIPPED.push('occupancy/preleased/notices · ' + prop
          + ' — no leasing_occupancy_history row at as_of=' + WEEK_END
          + ', so there is no AppFolio occupancy FOR THIS WEEK to compare against');
        continue;
      }
      const stale = ymd(h.source_as_of) && ymd(h.source_as_of) < WEEK_END ? ymd(h.source_as_of) : null;
      const liveRow = occNow.find(r => canon(r.property_name) === prop);
      const liveAsOf = liveRow ? ymd(liveRow.as_of) : null;

      // occupied units
      const dOcc = s.occupied == null ? null : num(s.occupied);
      const aOcc = num(h.occupied_units);
      occRows.push({ prop, dOcc, aOcc, stale, liveAsOf, h, s, liveRow });

      // preleased = occupied + vacant_rented (the dashboard's own definition)
      const dPre = s.preleased == null ? null : num(s.preleased);
      const aPre = num(h.occupied_units) + num(h.vacant_rented);
      preRows.push({ prop, dPre, aPre, stale, liveAsOf, h, liveRow });

      const dNot = s.notices == null ? null : num(s.notices);
      const aNot = num(h.notice_units);
      notRows.push({ prop, dNot, aNot, stale, liveAsOf, h, liveRow });
    }

    const occCause = r => {
      if (r.stale) {
        return 'date window + source staleness — the ' + WEEK_END + ' history row was captured from an '
          + 'occupancy_summary whose own source_as_of is ' + r.stale + '; neither side describes ' + WEEK_END;
      }
      if (r.liveAsOf && r.liveAsOf !== WEEK_END) {
        return 'date window (as-of) — the report reads leasing_occupancy, a CURRENT snapshot now as_of '
          + r.liveAsOf + '. Katie opened it on 2026-10-26, so the page showed that day, not ' + WEEK_END;
      }
      return 'date window (as-of) — current-snapshot occupancy on a past-week page';
    };

    // THE AGREEMENT ABOVE IS NOT EVIDENCE, and this is the finding of the run.
    // Every history row for this week was captured from the 2026-09-16
    // reading, and the page Katie opened reads the same leasing_occupancy. So
    // both columns are copies of ONE stale number and they agree for that
    // reason alone. What she would have seen in AppFolio on 2026-10-26 is a
    // live figure neither column contains — and the occupancy sync has since
    // run (2026-10-28), so the drift can be measured. That is the table that
    // is actually worth reading.
    if (staleHist.length === histWeek.length && histWeek.length) {
      const moved = [];
      for (const [prop] of [...snapBy].sort()) {
        const h = histBy.get(prop);
        const live = occNow.find(r => canon(r.property_name) === prop);
        if (!h || !live) continue;
        const was = num(h.occupied_units), now = num(live.occupied_units);
        const wasT = num(h.total_units), nowT = num(live.total_units);
        if (was !== now || wasT !== nowT) moved.push({ prop, was, now, wasT, nowT });
      }
      console.log('\n  DRIFT SINCE THAT READING — what the stale figure costs');
      console.log('  ' + pad('property', 26) + lpad('as stored', 12)
        + lpad('as of ' + (occAsOf[occAsOf.length - 1] || '?'), 18));
      if (!moved.length) {
        console.log('  (no property changed — the stale figure happens to still be right)');
      } else {
        moved.forEach(m => console.log('  ' + pad(m.prop, 26)
          + lpad(m.was + '/' + m.wasT, 12) + lpad(m.now + '/' + m.nowT, 18)
          + '   ' + (m.now - m.was >= 0 ? '+' : '') + (m.now - m.was) + ' occupied'));
      }
      SKIPPED.push('occupancy/preleased/notices · ALL — NOT A LIKE-FOR-LIKE COMPARISON. Every '
        + 'leasing_occupancy_history row for this week was captured from the 2026-09-16 AppFolio '
        + 'reading, and the page reads the same leasing_occupancy, so the two columns agree because '
        + 'they are the same stale number — not because the dashboard matches AppFolio. The drift '
        + 'table above is what the staleness actually cost.');
    }

    if (want('occupancy')) {
      occRows.forEach(r => compare('occupancy (occupied units)', r.prop, r.dOcc, r.aOcc, occCause(r)));
      table('OCCUPANCY — occupied units   dashboard: Katie\'s capture · appfolio: occupancy_summary at as_of='
        + WEEK_END, ROWS.filter(x => x.metric.startsWith('occupancy')));
    }
    if (want('preleased')) {
      preRows.forEach(r => compare('preleased', r.prop, r.dPre, r.aPre,
        'definition + date window — preleased is occupied + vacant_rented, both read from the CURRENT '
        + 'occupancy snapshot' + (r.stale ? ' (history source_as_of ' + r.stale + ')' : '')));
      table('PRELEASED — occupied + vacant_rented', ROWS.filter(x => x.metric === 'preleased'));
    }
    if (want('notices')) {
      notRows.forEach(r => compare('notices', r.prop, r.dNot, r.aNot,
        'definition + date window — notices is notice_rented + notice_unrented from the CURRENT occupancy '
        + 'snapshot, a point-in-time count, not notices GIVEN during the week'
        + (r.stale ? ' (history source_as_of ' + r.stale + ')' : '')));
      table('NOTICES — notice_rented + notice_unrented', ROWS.filter(x => x.metric === 'notices'));
    }
  }

  // ── DELINQUENCY ────────────────────────────────────────────────────────
  if (want('delinquency')) {
    const dq = await store('delinquency_kpi');
    console.log('\n  delinquency_kpi store: ' + dq.rows.length + ' rows, fetched ' + (dq.fetchedAt || '?'));
    const dqBy = new Map();
    dq.rows.forEach(r => {
      const c = canon(r.property);
      if (!c) return;
      // amount_receivable is the report's own delinquency column. The first
      // run guessed total_balance/balance/total — none of which exist — and
      // every property came back 0.00, which looked exactly like a property
      // owing nothing rather than like a column that was never read.
      //
      // POSITIVE BALANCES ONLY. A credit is not negative delinquency, and
      // netting one resident's credit against another's arrears understates
      // what is owed.
      const amt = num(r.amount_receivable !== undefined ? r.amount_receivable : r.balance);
      if (amt > 0) dqBy.set(c, (dqBy.get(c) || 0) + amt);
    });
    const universe = [...new Set(dq.rows.map(r => canon(r.property)).filter(Boolean))];
    const lookup = p => (dqBy.has(p) ? Math.round(dqBy.get(p) * 100) / 100 : null);
    for (const [prop, s2] of [...snapBy].sort()) {
      const d = s2.delinquency_total == null ? null : num(s2.delinquency_total);
      let a, note = '';
      if (isGroup(prop)) {
        const g = groupValue(prop, lookup, universe);
        a = g.value;
        note = 'roll-up of ' + (g.members.join(' + ') || 'nothing');
      } else {
        a = lookup(prop);
      }
      compare('delinquency', prop, d, a,
        a === null ? 'property mapping — no delinquency_kpi rows under this name'
          : 'sync timing / as-of — delinquency_kpi is a CURRENT balance report with no week '
            + 'dimension; the store was fetched ' + ymd(dq.fetchedAt) + ' and the capture is '
            + '2026-10-26, so these are two different days of the same moving balance',
        note);
    }
    table('DELINQUENCY — total balance   (dashboard: capture · appfolio: delinquency_kpi, CURRENT)',
      ROWS.filter(x => x.metric === 'delinquency'));
    SKIPPED.push('delinquency · ALL — delinquency_kpi has no as-of or week dimension at all. '
      + 'It cannot be asked what a property owed on ' + WEEK_END + ', so no figure here is a '
      + 'like-for-like comparison for the week; it is today vs the day of the capture.');
  }

  // ── TOURS, LEADS ───────────────────────────────────────────────────────
  if (want('tours')) {
    const by = new Map();
    showings.forEach(r => {
      if (!inWeek(r.showing_date)) return;
      const c = canon(r.property_name);
      if (!c) return;
      // Status STARTING WITH "Completed" — takes "Completed (Unconfirmed)",
      // excludes Scheduled and Cancelled.
      if (clean(r.status).indexOf('Completed') === 0) by.set(c, (by.get(c) || 0) + 1);
    });
    console.log('\n  showings in week: ' + showings.filter(r => inWeek(r.showing_date)).length
      + ', of which Completed*: ' + [...by.values()].reduce((a, b) => a + b, 0));
    SKIPPED.push('tours · ALL — kpi_property_snapshots does not store tours, so there is no record of '
      + 'what the page showed Katie. Recomputing today gives the dashboard\'s CURRENT answer, not hers. '
      + 'Source count for the week is printed above.');
  }
  if (want('leads')) {
    const cardBy = new Map();
    cards.forEach(c => { if (c.guest_card_uuid) cardBy.set(clean(c.guest_card_uuid), c); });
    const seen = new Map();
    interests.forEach(r => {
      if (!inWeek(r.interest_received)) return;
      const c = canon(r.property);
      if (!c) return;
      // Deduplicated per property on the guest card's phone/email/name — one
      // card registering interest twice in a week is one lead.
      const card = cardBy.get(clean(r.guest_card_uuid)) || {};
      const who = (clean(card.phone) || clean(card.email) || clean(card.name)
        || clean(r.guest_card_uuid)).toLowerCase();
      if (!seen.has(c)) seen.set(c, new Set());
      seen.get(c).add(who);
    });
    const total = [...seen.values()].reduce((a, s) => a + s.size, 0);
    console.log('\n  lead interests in week: ' + interests.filter(r => inWeek(r.interest_received)).length
      + ', deduplicated per property: ' + total);
    SKIPPED.push('leads · ALL — not stored in kpi_property_snapshots either; same reason as tours.');
  }

  // ── MOVE-INS / MOVE-OUTS / RENEWALS ────────────────────────────────────
  if (want('moveins') || want('moveouts') || want('renewals')) {
    const mi = new Map(), mo = new Map(), rn = new Map(), dn = new Map();
    leaseHist.forEach(r => {
      const c = canon(r.property_name);
      if (!c) return;
      if (inWeek(r.move_in_date)) mi.set(c, (mi.get(c) || 0) + 1);
      if (inWeek(r.move_out_date)) mo.set(c, (mo.get(c) || 0) + 1);
      if (inWeek(r.move_in_date)) {
        if (clean(r.renewal) === 'Yes') rn.set(c, (rn.get(c) || 0) + 1);
        else if (clean(r.renewal) === 'No') dn.set(c, (dn.get(c) || 0) + 1);
      }
    });
    console.log('\n  lease_history in week: move-ins ' + [...mi.values()].reduce((a, b) => a + b, 0)
      + ', move-outs ' + [...mo.values()].reduce((a, b) => a + b, 0));

    if (want('renewals')) {
      const uni = [...new Set(leaseHist.map(r => canon(r.property_name)).filter(Boolean))];
      const rnAt = p => isGroup(p) ? groupValue(p, q => rn.get(q) || 0, uni).value : (rn.get(p) || 0);
      const dnAt = p => isGroup(p) ? groupValue(p, q => dn.get(q) || 0, uni).value : (dn.get(p) || 0);
      for (const [prop, s] of [...snapBy].sort()) {
        compare('renewals', prop, s.renewals == null ? null : num(s.renewals), rnAt(prop),
          'definition — the dashboard counts a renewal off lease_history rows whose MOVE-IN date falls in '
          + 'the week with renewal=Yes; a renewal is a lease event, and a renewing resident does not move in');
        compare('did not renew', prop, s.did_not_renew == null ? null : num(s.did_not_renew), dnAt(prop),
          'definition — same rule as renewals, keyed on move_in_date');
      }
      table('RENEWALS', ROWS.filter(x => x.metric === 'renewals'));
      table('DID NOT RENEW', ROWS.filter(x => x.metric === 'did not renew'));
    }
    if (want('moveouts')) {
      const ut = await store('unit_turn_detail');
      const byTurn = new Map();
      ut.rows.forEach(r => {
        if (!inWeek(r.move_out_date)) return;
        const c = canon(r.property);
        if (c) byTurn.set(c, (byTurn.get(c) || 0) + 1);
      });
      console.log('\n  unit_turn_detail move-outs in week: '
        + [...byTurn.values()].reduce((a, b) => a + b, 0) + '   (store fetched ' + (ut.fetchedAt || '?') + ')');
      console.log('  lease_history  move-outs in week: ' + [...mo.values()].reduce((a, b) => a + b, 0));
      const props = [...new Set([...byTurn.keys(), ...mo.keys()])].sort();
      props.forEach(p => compare('move-outs (two sources)', p, mo.get(p) || 0, byTurn.get(p) || 0,
        'TWO AppFolio reports disagree with each other — lease_history vs unit_turn_detail. The report '
        + 'reads unit_turn_detail. This is a source conflict, not a dashboard bug'));
      table('MOVE-OUTS — lease_history (left) vs unit_turn_detail (right)',
        ROWS.filter(x => x.metric === 'move-outs (two sources)'));
      SKIPPED.push('move-outs · ALL — not in kpi_property_snapshots, so neither column above is '
        + 'what Katie saw; the table compares the two AppFolio sources against each other.');
    }
    if (want('moveins')) {
      SKIPPED.push('move-ins · ALL — not stored in kpi_property_snapshots; source count printed above.');
    }
  }

  // ── WORK ORDERS ────────────────────────────────────────────────────────
  if (want('wos')) {
    const IS_TURN = /unit\s*turn/i;
    const closed = new Map(), created = new Map(), open = new Map();
    wos.forEach(r => {
      const c = canon(r.property_name);
      if (!c) return;
      if (IS_TURN.test(clean(r.work_order_type))) return;   // her sheet excludes Unit Turns
      if (inWeek(r.completed_on) && /complete/i.test(clean(r.status))) closed.set(c, (closed.get(c) || 0) + 1);
      if (inWeek(r.created_at_appfolio)) created.set(c, (created.get(c) || 0) + 1);
      if (/^(new|assigned|in progress|on hold|scheduled)/i.test(clean(r.status))) open.set(c, (open.get(c) || 0) + 1);
    });
    console.log('\n  work_order: closed in week ' + [...closed.values()].reduce((a, b) => a + b, 0)
      + ', created in week ' + [...created.values()].reduce((a, b) => a + b, 0)
      + ', open now ' + [...open.values()].reduce((a, b) => a + b, 0) + '   (Unit Turns excluded)');
    SKIPPED.push('work orders · ALL — kpi_property_snapshots stores cv_open/cv_closed (CODE VIOLATIONS), '
      + 'not work orders. There is no record of the WO figures the page showed Katie, so nothing here '
      + 'can be compared to her screen; the source counts are printed above.');
  }

  // ── COLLECTIONS ────────────────────────────────────────────────────────
  if (want('collections')) {
    const withRent = snaps.filter(s => s.rent_collected != null).length;
    console.log('\nCOLLECTIONS / RENT COLLECTED');
    console.log('  rent_collected is non-null on ' + withRent + ' of ' + snaps.length + ' captured properties.');
    const src = snaps[0] && snaps[0].sources || {};
    console.log('  the capture\'s own sources say  mtdIncome: ' + (src.mtdIncome || '?')
      + '   laborBilled: ' + (src.laborBilled || '?'));
    SKIPPED.push('collections · ALL — NO SINGLE APPFOLIO REPORT BACKS THIS. The capture records '
      + 'mtdIncome as "unavailable" and rent_collected is null on every row, so the dashboard did not '
      + 'show Katie a collections figure for this week at all. Whatever she compared came from somewhere '
      + 'else — worth asking her which screen.');
  }

  // ── SUMMARY ────────────────────────────────────────────────────────────
  const diffs = ROWS.filter(r => r.differs);
  console.log('\n' + '='.repeat(72));
  console.log('COMPARED : ' + ROWS.length + ' metric/property pairs');
  console.log('  match  : ' + (ROWS.length - diffs.length));
  console.log('  differ : ' + diffs.length);
  const unexplained = diffs.filter(d => /^UNEXPLAINED/.test(d.cause));
  if (unexplained.length) console.log('  of which UNEXPLAINED: ' + unexplained.length);

  const byCause = new Map();
  diffs.forEach(d => {
    const k = d.cause.split(' — ')[0];
    byCause.set(k, (byCause.get(k) || 0) + 1);
  });
  if (byCause.size) {
    console.log('\nDIFFERENCES BY CAUSE');
    [...byCause].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + lpad(n, 4) + '  ' + k));
  }

  if (SKIPPED.length) {
    console.log('\nNOT COMPARED — said rather than guessed');
    SKIPPED.forEach(s => console.log('  · ' + s));
  }

  console.log('\nWHAT A FRESH PULL WOULD ADD, AND WHY IT DID NOT HAPPEN HERE');
  console.log('  Every figure above is the AppFolio data AS LAST SYNCED. A genuinely fresh pull needs');
  console.log('  AppFolio reporting credentials, which are empty in this .env, and every route on Render');
  console.log('  that re-pulls a report also WRITES the store or the table — not read-only. The one');
  console.log('  difference a fresh pull could still expose is a source that changed since its sync time,');
  console.log('  and those times are printed beside each source above.');
  console.log('\nNothing was written. No AppFolio request was made. No resident names were printed.');
})().catch(e => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; });
