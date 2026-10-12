// Buildings that cannot be rented, and therefore cannot be counted as vacancy.
//
// Kara, 2026-10-12: Windy Hill's building 3 — "all the units that start with
// 3 are that building" — has no certificate of occupancy. Reporting Windy
// Hill against all 72 units counts 30 units nobody is allowed to lease as
// empty, which reads as a leasing failure and is not one.
//
// ONE PLACE, because this is temporary by nature. The certificate arrives and
// the rule has to come out, and a rule spelled out in the KPI report and again
// in the Goal Board would come out of one of them. Deleting the entry below is
// the whole removal.
//
// WHAT THIS IS NOT. It never changes a total. Windy Hill's occupancy and the
// portfolio's stay exactly what Lyndsay's report says, because that is what
// owners are reading and a number that quietly means something new is worse
// than one that is hard to interpret. The rentable figure is an ADDITIONAL
// line, always beside the total, never instead of it.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// property: as the report names it. prefix: the unit-number prefix.
// since / reason: why it is here, so the next person can tell whether it still
// applies without asking anybody.
const RULES = [
  {
    property: 'Windy Hill Apartment',
    prefix: '3',
    label: 'Building 3',
    reason: 'no certificate of occupancy — cannot be leased',
    since: '2026-10-12',
    // What the rent roll actually holds, counted 2026-10-12: 23 units, not the
    // 30 Kara named. Not corrected to 30 and not quietly dropped — the count is
    // kept so a CHANGE is visible. 23 is itself unconfirmed; Arturo is checking
    // it with Kara, and either answer is better than a figure nobody is
    // watching.
    expectedUnits: 23,
    expectedCountedOn: '2026-10-12',
    expectedNote: 'Kara said 30; the rent roll says 23. Unresolved.',
  },
];

// A unit number belongs to the building when it STARTS with the prefix.
//
// Compared as text, not as a number. Windy Hill's units are "112", "233",
// "3-104" — a numeric compare would make 3 and 300 the same answer and would
// throw away a unit called "3A" entirely.
function matchesPrefix(unit, prefix) {
  const u = clean(unit);
  const p = clean(prefix);
  return !!u && !!p && u.startsWith(p);
}

// The rules for one property; [] when none, which is the normal case.
function rulesFor(property) {
  const p = clean(property).toLowerCase();
  return RULES.filter(r => clean(r.property).toLowerCase() === p);
}

function isExcludedUnit(property, unit) {
  return rulesFor(property).some(r => matchesPrefix(unit, r.prefix));
}

// Does this rent-roll row describe somebody living there?
//
// rent_roll's `status` is the UNIT's state: Current, Notice-Rented,
// Notice-Unrented, Vacant-Rented, Vacant-Unrented. A unit on notice is still
// occupied today — the resident has not left — so "Notice" counts as occupied
// and only "Vacant" does not. That is the same rule the occupancy report uses,
// and the reason the two figures reconcile.
function looksOccupied(status) {
  const s = clean(status).toLowerCase();
  if (!s) return false;
  if (s.startsWith('vacant')) return false;
  return s.startsWith('current') || s.startsWith('notice') || s.startsWith('occupied');
}

// Total and rentable, from unit-level rows.
//
// Returns null when there are no rows for the property — "we could not work
// this out" is not the same statement as "nothing is excluded", and on a
// report that goes to owners the difference matters. The caller shows the
// total alone rather than a rentable figure built from nothing.
//
// occupiedExcluded is the one that must never be silently dropped. A unit that
// is occupied inside a building with no certificate is not a rounding
// question: subtracting it would hide a person living somewhere they should
// not be, so it is counted, named and handed back.
function rentable(property, rows, opts) {
  const o = opts || {};
  const unitOf = o.unit || (r => r.unit);
  const statusOf = o.status || (r => r.status);
  const rules = rulesFor(property);
  if (!rows || !rows.length) return null;

  // One row per LEASE: a unit with a past and a current lease appears twice,
  // and counting rows would inflate both the building and the portfolio.
  const byUnit = new Map();
  rows.forEach(r => {
    const u = clean(unitOf(r));
    if (!u) return;
    if (!byUnit.has(u)) byUnit.set(u, []);
    byUnit.get(u).push(r);
  });
  if (!byUnit.size) return null;

  const occupied = u => byUnit.get(u).some(r => looksOccupied(statusOf(r)));
  const excluded = u => rules.some(r => matchesPrefix(u, r.prefix));
  // Signed but empty. In a building with no certificate of occupancy this is
  // a lease on a unit that cannot legally be handed over, and it is the one
  // thing here that needs a person today rather than a line on a report.
  const preleasedStatus = s => /^vacant-rented/i.test(clean(s));
  const preleased = u => byUnit.get(u).some(r => preleasedStatus(statusOf(r)));

  const all = [...byUnit.keys()];
  const out = all.filter(excluded);
  const keep = all.filter(u => !excluded(u));

  // Did the building change size since somebody last looked? A rule that
  // silently covers more units than it was agreed to cover is how an
  // exclusion grows into a number nobody can explain.
  const expected = rules.length && rules[0].expectedUnits != null ? rules[0].expectedUnits : null;
  const countChanged = expected !== null && out.length !== expected;

  return {
    property,
    rules: rules.map(r => ({ label: r.label, prefix: r.prefix, reason: r.reason })),
    units: all.length,
    occupied: all.filter(occupied).length,
    excludedUnits: out.length,
    rentableUnits: keep.length,
    rentableOccupied: keep.filter(occupied).length,
    // Percentages as fractions, like the rest of the report. Null rather than
    // zero when there is no denominator: a property whose every unit is
    // excluded has no rentable occupancy, and 0% would read as total failure.
    occPct: all.length ? all.filter(occupied).length / all.length : null,
    rentablePct: keep.length ? keep.filter(occupied).length / keep.length : null,
    // Named, not just counted — a number here is a question for a person.
    occupiedExcluded: out.filter(occupied).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })),
    // Signed leases inside the excluded building, named the same way.
    preleasedExcluded: out.filter(preleased).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })),
    expectedUnits: expected,
    countChanged,
  };
}

// What a reader has to be told, in words, written once so the KPI report and
// the Goal Board cannot word it differently.
//
// Severity is 'alarm' for anything that means a person should look today and
// 'note' for anything that only affects how a figure is read. A list that
// treats both the same trains people to skim it.
function alerts(r) {
  if (!r) return [];
  const out = [];
  const label = (r.rules[0] && r.rules[0].label) || 'the excluded building';
  const list = u => u.join(', ');
  if (r.occupiedExcluded.length) {
    out.push({
      severity: 'alarm',
      text: `${r.occupiedExcluded.length} unit${r.occupiedExcluded.length === 1 ? '' : 's'} in `
        + `${label} read${r.occupiedExcluded.length === 1 ? 's' : ''} as occupied `
        + `(${list(r.occupiedExcluded)}) — that building has no certificate of occupancy.`,
    });
  }
  if (r.preleasedExcluded.length) {
    out.push({
      severity: 'alarm',
      text: `${r.preleasedExcluded.length} unit${r.preleasedExcluded.length === 1 ? '' : 's'} in `
        + `${label} ${r.preleasedExcluded.length === 1 ? 'has' : 'have'} a signed lease and nobody `
        + `in yet (${list(r.preleasedExcluded)}) — a lease on a unit that cannot be handed over.`,
    });
  }
  if (r.countChanged) {
    out.push({
      severity: 'note',
      text: `${label} counts ${r.excludedUnits} units today against the ${r.expectedUnits} `
        + 'recorded with the rule. The rentable figure moved with it.',
    });
  }
  return out;
}

module.exports = {
  RULES, rulesFor, matchesPrefix, isExcludedUnit, looksOccupied, rentable, alerts, clean,
};
