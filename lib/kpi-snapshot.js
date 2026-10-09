// "Last report → current", per property and for the portfolio.
//
// WHY A SNAPSHOT AND NOT A SECOND QUERY. The report is computed live from
// whatever the sync holds today, and none of its sources keeps history:
// leasing_occupancy is one row per property, replaced on every pull, and the
// delinquency and work-order stores are overwritten the same way. So last
// week's figures change under us as rows arrive late, and asking the report
// for "the week of 09/27" next month gives a different answer than it gave on
// the Monday. A week-on-week comparison needs a number that was true on the
// Saturday and stays true. That is this file, and kpi_property_snapshots (083).
//
// WRITTEN ONCE PER WEEK, NEVER RECOMPUTED. A snapshot that gets rewritten is
// not evidence of anything — it just agrees with the live report again, which
// is the one thing it exists not to do.

'use strict';

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// The five figures Kara named, plus the parts they are computed from.
//
// PARTS, NOT JUST PERCENTAGES. A stored percentage cannot be re-aggregated:
// the mean of two properties' occupancy weights a 12-unit property like a
// 200-unit one. Groups are recomputed from units / occupied / notices /
// preleased, the same rule rollUp follows in the live report.
const FIELDS = {
  units: 'units', occupied: 'occupied', preleased: 'preleased', notices: 'notices',
  delinquency_total: 'dqTotal', rent_collected: 'mtdIncome',
  renewals: 'renewals', did_not_renew: 'didNotRenew',
  cv_open: 'cvOpen', cv_closed: 'cvClosedTotal',
};

// PROJECTED OCCUPANCY, as Kara defines it (2026-10-09): current occupancy
// taking notices and preleases into account.
//
//   (occupied - notices + vacant-but-leased) / units
//
// and since the report's `preleased` is occupied + vacant rented, that is
// exactly (preleased - notices) / units.
//
// A unit on notice is still occupied today and still counts in `occupied`;
// it is subtracted because the projection answers "where will this land", not
// "where is it". A unit that is leased but empty is added for the same reason.
// Nothing is clamped: a projection above 1 or below 0 means the inputs
// disagree, and hiding that behind a clamp would make a data problem look like
// a quiet quarter.
function projectedOccupancy(m) {
  const units = num(m && m.units);
  if (!units) return null;
  const pre = num(m && m.preleased), notices = num(m && m.notices);
  if (pre === null || notices === null) return null;
  return (pre - notices) / units;
}

function occupancy(m) {
  const units = num(m && m.units), occ = num(m && m.occupied);
  return units && occ !== null ? occ / units : null;
}

// One row, from the metrics of one column of the report.
function snapshotRow(week_ending, property, metrics, opts) {
  const o = opts || {};
  const m = metrics || {};
  const row = {
    week_ending, property,
    occupancy_pct: occupancy(m),
    occupancy_projected: projectedOccupancy(m),
    sources: o.sources || {},
    captured_by: o.captured_by || null,
  };
  Object.keys(FIELDS).forEach(col => { row[col] = num(m[FIELDS[col]]); });
  return row;
}

// Every column of a built report, flattened back to {metric: value} so the
// snapshot is taken from what the report SAID, not from a second computation
// that could disagree with it.
function metricsFromColumn(column) {
  const out = {};
  (column || []).forEach(sec => {
    (sec.cards || []).concat(sec.funnel || []).forEach(c => {
      if (typeof c.value === 'number' && isFinite(c.value)) out[c.metric] = c.value;
      if (c.pct !== undefined && c.pct !== null) out[c.metric + 'Pct'] = c.pct;
    });
  });
  return out;
}

// Where each figure came from, in the report's own vocabulary. A snapshot that
// cannot say which of its numbers were adjusted by hand is not evidence.
function sourcesFromColumn(column) {
  const out = {};
  (column || []).forEach(sec => {
    (sec.cards || []).concat(sec.funnel || []).forEach(c => { out[c.metric] = c.source; });
  });
  return out;
}

function rowsFromReport(report, opts) {
  const r = report || {};
  const rows = [];
  const add = (property, column) => {
    if (!column) return;
    rows.push(snapshotRow(r.week_ending, property, metricsFromColumn(column),
      { sources: sourcesFromColumn(column), captured_by: (opts || {}).captured_by }));
  };
  Object.keys(r.properties || {}).sort().forEach(p => add(p, r.properties[p]));
  add('Portfolio', r.portfolio);
  return rows;
}

// ---- the comparison --------------------------------------------------------

// The five Kara reads across, in the order she named them.
const COMPARED = [
  { key: 'occupancy_pct', label: 'Occupancy', percent: true },
  { key: 'occupancy_projected', label: 'Projected Occupancy', percent: true },
  { key: 'delinquency_total', label: 'Delinquency', money: true },
  { key: 'rent_collected', label: 'Total Income Collected', money: true },
  { key: 'renewals', label: 'Renewals' },
];

// One property, two weeks.
//
// A MISSING FIGURE IS NOT A CHANGE OF ZERO. `delta: null` with `had: false`
// says the previous report did not record this, which is a different statement
// from "it did not move" — and on a report that goes to owners the difference
// between those two is the whole point. Kara reading "0" where we mean "we
// never captured it" is how a gap becomes a disagreement.
function diffRow(prev, cur) {
  const out = { property: (cur || prev || {}).property, fields: {} };
  COMPARED.forEach(f => {
    const a = prev ? num(prev[f.key]) : null;
    const b = cur ? num(cur[f.key]) : null;
    out.fields[f.key] = {
      label: f.label, percent: !!f.percent, money: !!f.money,
      previous: a, current: b,
      delta: (a === null || b === null) ? null : b - a,
      had: a !== null,
    };
  });
  return out;
}

// Both weeks, matched on property. A property present in only one of them
// still appears — a community that arrived or left between reports is exactly
// the thing a reader must not have to notice for themselves.
function compare(prevRows, curRows) {
  const by = rows => {
    const m = {};
    (rows || []).forEach(r => { m[r.property] = r; });
    return m;
  };
  const A = by(prevRows), B = by(curRows);
  const names = [...new Set(Object.keys(A).concat(Object.keys(B)))]
    .filter(n => n !== 'Portfolio').sort();
  const out = names.map(n => {
    const d = diffRow(A[n], B[n]);
    d.onlyIn = A[n] && B[n] ? null : (B[n] ? 'current' : 'previous');
    return d;
  });
  if (A.Portfolio || B.Portfolio) {
    const d = diffRow(A.Portfolio, B.Portfolio);
    d.onlyIn = A.Portfolio && B.Portfolio ? null : (B.Portfolio ? 'current' : 'previous');
    out.push(d);
  }
  return out;
}

module.exports = {
  FIELDS, COMPARED,
  projectedOccupancy, occupancy,
  snapshotRow, metricsFromColumn, sourcesFromColumn, rowsFromReport,
  diffRow, compare,
};
