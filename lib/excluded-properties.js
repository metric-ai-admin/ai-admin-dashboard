// Properties Metric does not manage, hidden from every view that describes
// the present.
//
// WHY THIS IS A LIB. It was a const in server.js, which meant anything outside
// that file had to be handed the list or redefine it. lib/leasing-goals.js was
// pulled out for the same reason the week before, after a preview was handed a
// goal function returning null and rendered a brief with no occupancy reds.
// A list that two files keep their own copy of is a list that will disagree
// with itself.
//
// THE LIST IS FRAGMENTS, NOT NAMES, and matched case-insensitively against a
// substring. AppFolio spells the same property several ways — "513 Wolf Ridge
// Georgetown, TX 78628" is one row in leasing_occupancy — so an equality test
// would miss most of them.

'use strict';

// 'sidney': Lyndsay had The Sidney hidden in AppFolio on 2026-10-07; Metric no
// longer manages it. It was already on this list before that, which is why no
// view ever showed it — the gap was the weekly SNAPSHOT, which writes history
// and was copying the table unfiltered.
const METRIC_EXCLUDED_PROPERTY_FRAGMENTS = [
  'lily pad', 'wolf ridge', 'sidney', 'brazos', 'live with metric',
];

const propertyIsExcluded = name => {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  if (!n) return false;
  return METRIC_EXCLUDED_PROPERTY_FRAGMENTS.some(frag => n.includes(frag));
};

const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
};

/**
 * The rows of a history table, with the excluded properties dropped.
 *
 * FILTERED ON THE WAY OUT, NOT CORRECTED ON THE WAY IN. Arturo, 2026-10-15:
 * leasing_occupancy_history holds one row per property per week, and the two
 * weeks captured so far include The Sidney at 29/40. Rewriting them would put
 * a different number under a date that has already been reported; dropping
 * them at read time gives 279/398 from the same stored 334/478 without
 * touching anything.
 */
const liveRows = rows => (rows || []).filter(r => !propertyIsExcluded(r.property_name));

/**
 * A portfolio occupancy figure from history rows.
 *
 * sum(occupied) / sum(units), NEVER the mean of the per-property percentages:
 * that would weight a 12-unit property like a 200-unit one. The components are
 * returned alongside so a caller can show "279/398" rather than only a ratio.
 */
function portfolio(rows) {
  const live = liveRows(rows);
  const units = live.reduce((a, r) => a + num(r.total_units), 0);
  const occupied = live.reduce((a, r) => a + num(r.occupied_units), 0);
  return {
    units,
    occupied,
    pct: units ? occupied / units : null,
    properties: live.length,
    excluded: (rows || []).length - live.length,
  };
}

/**
 * Week over week, excluded properties dropped, newest first.
 *
 * `sourceAsOf` TRAVELS WITH EVERY WEEK. The snapshot copies leasing_occupancy,
 * and until a 05:00 Sunday sync existed it copied whatever was last there: the
 * weeks of 2026-10-03 and 2026-10-10 both carry source_as_of 2026-10-02, so
 * they are the same frozen figures filed under two dates. A comparison that
 * shows them as two weeks of flat occupancy would be reporting a sync gap as a
 * fact about the portfolio.
 */
function weeks(rows) {
  const byWeek = new Map();
  (rows || []).forEach(r => {
    const w = String(r.as_of || '').slice(0, 10);
    if (!w) return;
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  });
  return [...byWeek.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([as_of, rs]) => {
      const p = portfolio(rs);
      const sources = [...new Set(rs.map(r => String(r.source_as_of || '').slice(0, 10))
        .filter(Boolean))].sort();
      return {
        as_of,
        ...p,
        sourceAsOf: sources,
        // True when the week was filed under a date later than the data it was
        // copied from. The reader has to be told; the number is not wrong, it
        // is just not about the week it is filed under.
        copiedFromEarlier: sources.length > 0 && sources.every(s => s < as_of),
      };
    });
}

module.exports = {
  METRIC_EXCLUDED_PROPERTY_FRAGMENTS, propertyIsExcluded,
  liveRows, portfolio, weeks,
};
