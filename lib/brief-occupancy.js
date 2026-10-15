// Projected occupancy, week by week, for Kara's 6 AM brief.
//
// KARA'S OPTION (b): week by week out to 30 days, then 30 to 60 days shown in
// grey as "notices only — no leases signed yet for this period". Per property
// and for Metric as a whole, with the portfolio grouping (RR, Greystone) left
// ready for the day she says which properties belong to each.
//
// WHY THE TWO HALVES ARE DIFFERENT KINDS OF NUMBER, and why the grey matters
// more than it looks. Inside 30 days both sides of the arithmetic are real:
// people have given notice and people have signed leases. Past 30 days only
// the leaving side exists — nobody signs a lease two months out — so the line
// falls every week by construction. It is not a forecast of occupancy; it is
// "here is the hole, if nothing else is leased". Printing that in the same ink
// as the 30-day figure would be the most alarming wrong number in the email.
//
// NOTHING IS CLAMPED. A projection above 100% or below 0 means the inputs
// disagree with each other, and hiding that behind a clamp turns a data
// problem into a quiet quarter. Same rule as lib/kpi-snapshot.js.
//
// MOVE-INS ARE NOT ASSUMED. If the dated move-in source is missing, this does
// NOT quietly treat it as zero — that would make occupancy fall every single
// week at every property, which looks exactly like a portfolio in trouble.
// `moveInsKnown` is false and every line says so.

'use strict';

const WEEK = require('./week.js');

const clean = s => String(s == null ? '' : s).trim();
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(clean(s).slice(0, 10));
const ymd = s => clean(s).slice(0, 10);

function addDays(day, n) {
  const d = new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// WEEK BY WEEK INSIDE 30 DAYS, ONE LINE BEYOND IT.
//
// Kara asked for the 30-to-60 stretch as "the drop from known notices" —
// singular — and she is right to. Nine weekly rows per property is sixty-odd
// lines in an email, and every row past day 30 falls for the same reason: no
// leases are signed that far out. Week by week where the weeks differ, one
// grey line where they do not.
//
// A week is firm only if it ENDS inside the horizon. A week straddling day 30
// counts as beyond it: the half past the line has no move-ins behind it, so
// calling the whole week firm would overstate exactly the part least known.
function buckets(todayCT, opts) {
  const o = opts || {};
  const horizon = o.horizonDays || 30;
  const outer = o.outerDays || 60;
  const out = [];
  let start = todayCT;
  const horizonEnd = addDays(todayCT, horizon);
  while (start <= horizonEnd) {
    const end = addDays(start, 6);
    const last = end <= horizonEnd ? end : horizonEnd;
    if (last < start) break;
    out.push({ from: start, to: last, firm: true, label: start + ' → ' + last });
    start = addDays(last, 1);
  }
  const outerEnd = addDays(todayCT, outer);
  if (start <= outerEnd) {
    out.push({
      from: start, to: outerEnd, firm: false,
      label: start + ' → ' + outerEnd + '  (days ' + (horizon + 1) + '–' + outer + ')',
    });
  }
  return out;
}

/**
 * Week-by-week projection for one property.
 *
 * @param {object} p        { name, units, occupied }
 * @param {object[]} outs   dated departures: { property, date }
 * @param {object[]} ins    dated arrivals (signed leases): { property, date }
 * @param {string} todayCT
 */
function projectOne(p, outs, ins, todayCT, opts) {
  const o = opts || {};
  const units = Number(p.units) || null;
  let occupied = Number(p.occupied);
  if (!units || !isFinite(occupied)) {
    return { property: p.name, units, weeks: [], note: 'units or occupied missing' };
  }

  const mine = rows => (rows || []).filter(r =>
    clean(r.property).toLowerCase() === clean(p.name).toLowerCase() && isYmd(r.date));

  const myOuts = mine(outs);
  const myIns = mine(ins);

  // SIGNED, BUT WITH NO MOVE-IN DATE. The email already shows a "Signed, not
  // moved in" count per property, and some of those leases carry no date we
  // can read. Dropping them would make the projection lower than the figure
  // printed three inches above it, in the same email — so they land in the
  // FIRST week, which is the earliest they could happen, and the line says how
  // many were placed that way. Arbitrary, and better than a projection that
  // silently disagrees with its own email.
  const undated = Math.max(0, Number(o.undatedMoveIns || 0));

  const weeks = buckets(todayCT, o).map((b, i) => {
    const left = myOuts.filter(r => ymd(r.date) >= b.from && ymd(r.date) <= b.to).length;
    // Past the horizon, arrivals are not counted even if a stray one exists:
    // the whole point of the grey is that the leasing side of those weeks has
    // not happened yet, and one early signature does not make it a forecast.
    const dated = b.firm
      ? myIns.filter(r => ymd(r.date) >= b.from && ymd(r.date) <= b.to).length
      : 0;
    const placed = (b.firm && i === 0) ? undated : 0;
    const arrived = dated + placed;
    occupied = occupied - left + arrived;
    return {
      ...b,
      moveOuts: left,
      moveIns: b.firm ? arrived : null,
      undatedPlaced: placed || 0,
      occupied,
      pct: units ? occupied / units : null,
    };
  });

  return { property: p.name, units, weeks, undated, note: null };
}

/**
 * Every property, the Metric total, and the portfolio groups.
 *
 * THE TOTAL IS RECOMPUTED FROM UNITS AND OCCUPIED, never averaged from the
 * percentages: the mean of two properties' occupancy weights a 12-unit
 * property like a 200-unit one. Same rule the KPI roll-up follows.
 */
function project(input) {
  const o = input || {};
  const todayCT = o.todayCT;
  const properties = o.properties || [];
  const outs = o.moveOuts || [];
  const ins = o.moveIns || null;        // null = source absent, NOT zero

  const moveInsKnown = Array.isArray(ins);
  const undatedBy = o.undatedMoveInsBy || {};
  const rows = properties.map(p => projectOne(p, outs, moveInsKnown ? ins : [], todayCT,
    { ...o, undatedMoveIns: moveInsKnown ? (undatedBy[p.name] || 0) : 0 }));
  const undatedTotal = rows.reduce((a, r) => a + (r.undated || 0), 0);

  const bs = buckets(todayCT, o);
  const total = bs.map((b, i) => {
    const units = rows.reduce((a, r) => a + (r.units || 0), 0);
    const occupied = rows.reduce((a, r) => a + ((r.weeks[i] || {}).occupied || 0), 0);
    const moveOuts = rows.reduce((a, r) => a + ((r.weeks[i] || {}).moveOuts || 0), 0);
    const moveIns = b.firm
      ? rows.reduce((a, r) => a + ((r.weeks[i] || {}).moveIns || 0), 0) : null;
    return { ...b, units, occupied, moveOuts, moveIns, pct: units ? occupied / units : null };
  });

  return {
    todayCT,
    rows,
    total,
    // PORTFOLIO GROUPS, BUILT AND EMPTY ON PURPOSE. Kara has not said which
    // properties belong to RR and which to Greystone. The grouping is wired
    // so that answering the question is a row in a table rather than a code
    // change, and until then the brief says the split is pending instead of
    // inventing one.
    groups: groupsFrom(rows, o.portfolioMap || {}),
    moveInsKnown,
    undatedMoveIns: undatedTotal,
    horizonDays: o.horizonDays || 30,
    outerDays: o.outerDays || 60,
    greyNote: 'notices only — no leases signed yet for this period',
  };
}

// { 'Ascent at Northgate': 'RR', ... } -> one projection per named group.
// A property with no group is NOT silently dropped: it lands in `ungrouped`,
// which the brief prints, because a portfolio total missing two properties and
// a portfolio total that is correct look identical.
function groupsFrom(rows, map) {
  const named = new Map();
  const ungrouped = [];
  rows.forEach(r => {
    const g = clean((map || {})[r.property]);
    if (!g) { ungrouped.push(r.property); return; }
    if (!named.has(g)) named.set(g, []);
    named.get(g).push(r);
  });
  const out = [...named.entries()].map(([name, members]) => ({
    name,
    members: members.map(m => m.property),
    weeks: (members[0] ? members[0].weeks : []).map((_, i) => {
      const units = members.reduce((a, r) => a + (r.units || 0), 0);
      const occupied = members.reduce((a, r) => a + ((r.weeks[i] || {}).occupied || 0), 0);
      return {
        ...members[0].weeks[i],
        units, occupied, pct: units ? occupied / units : null,
      };
    }),
  }));
  return { groups: out, ungrouped, configured: out.length > 0 };
}

module.exports = { addDays, buckets, projectOne, project, groupsFrom, isYmd, ymd };
