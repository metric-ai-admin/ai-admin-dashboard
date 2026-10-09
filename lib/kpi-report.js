// The combined KPI report — portfolio shape, groups and provenance.
//
// Phase 2. Phase 1 established that the numbers agree with Lyndsay's workbook
// (occupancy, move-outs, leads 105 = 105, work orders explained). This is the
// part that assembles them into the report she hands out, so the Monday
// 2026-10-12 comparison can be the last one against the Excel.
//
// Everything here is pure. The route supplies the rows; this decides what
// counts, what rolls up into what, and — the part that matters most — where
// each number came from.

// Read out of kpi_dashboard_17.html on 2026-10-07 and confirmed by Arturo.
//
// Only ONE virtual group is defined in that file. "Round Rock" is NOT one of
// them: it is a separate roll-up that summaryColumnOrder places BEFORE the
// virtual groups, between the real properties and Greystone. Same members,
// different slot — and the column order is what people read across, so it is
// reproduced rather than tidied.
const VIRTUAL_GROUPS = {
  Greystone: ['Hyde Park Square', 'The Chateau', 'Sunset Palms', 'The Highlander'],
};
const ROUND_ROCK = { name: 'Round Rock', members: ['iConic Round Rock', 'iConic Downtown'] };

// Not ours to report on. Brazos Lofts and Lily Pad Lane are not managed;
// The Sidney is in cession and is being hidden in AppFolio.
const EXCLUDED_PROPERTIES = ['Brazos Lofts', 'Lily Pad Lane', 'The Sidney'];

// Out of scope for a DIFFERENT reason, and worth keeping separate from the
// three above: these are not properties her report declines to cover, they are
// not managed properties at all. Two corporate entities, a one-off address and
// a name that has no column in her workbook. They appeared as columns on the
// first comparison run, which would have made Monday about explaining them.
const OUT_OF_SCOPE = [
  'Metric Property Management of Texas LLC',   // the corporate entity, 0 units
  'Live With Metric',                          // also corporate
  '513 Wolf Ridge Georgetown, TX 78628',       // not in her workbook
  'Cedar and Sage',                            // no column in her report
];

// The six sections, in the order the report renders them, with the metric
// behind each card. The labels are hers: an export with different words on the
// same number is something people have to learn instead of recognise.
const SECTIONS = [
  { key: 'occupancy', title: 'Occupancy', cards: [
    // Units first. It was computed in the roll-up and in byProperty but no card
    // asked for it, so CARD_METRICS left it out and it arrived at the page as
    // "unavailable" on every property — taking occPct with it, which is the
    // first number an owner looks at.
    { label: 'Units', metric: 'units' },
    { label: 'Occupied', metric: 'occupied', pct: 'occPct' },
    { label: 'Occupancy %', metric: 'occPct', percent: true },
    { label: 'Preleased', metric: 'preleased', pct: 'prePct' },
    { label: 'Move-Ins', metric: 'moveIns' },
    { label: 'Move-Outs', metric: 'moveOuts' },
    { label: 'New Notices', metric: 'newNotices' },
    { label: 'Total Notices', metric: 'notices' },
  ] },
  { key: 'leasing', title: 'Leasing Activity', cards: [
    { label: 'Vacant Rented', metric: 'vacantRented' },
    { label: 'Vacant Unrented', metric: 'vacantUnrented' },
    { label: 'Follow Ups Completed', metric: 'followUps', source: 'workbook' },
    { label: 'Traffic Sources', metric: 'trafficSources' },
  ], funnel: [
    // leadsByInterest, not leads: hers counts interests deduplicated per
    // property, which is 105 for 2026-09-27..10-03 against 79 the other way.
    { label: 'Leads', metric: 'leadsByInterest' },
    { label: 'Tours', metric: 'tours' },
    { label: 'New Applications', metric: 'applications' },
    { label: 'Canceled', metric: 'canceled' },
    { label: 'Denied', metric: 'denied' },
    { label: 'Total Approved Apps with Signed Lease', metric: 'approved' },
  ] },
  { key: 'renewals', title: 'Renewals', cards: [
    { label: 'Renewals', metric: 'renewals' },
    { label: 'Did Not Renew', metric: 'didNotRenew' },
  ] },
  // Entirely from the workbook. income_statement returns 309 rows whatever you
  // ask it and answers portfolio totals only; her MTD sheets are per property.
  { key: 'income', title: 'Income Snapshot (MTD)', workbook: true, cards: [
    { label: 'MTD Income (Cash Receipts)', metric: 'mtdIncome', source: 'workbook' },
    { label: 'MTD Expenses', metric: 'mtdExpenses', source: 'workbook' },
  ] },
  { key: 'maintenance', title: 'Maintenance', cards: [
    { label: 'New Work Orders', metric: 'newWos' },
    { label: 'Work Orders Closed This Week', metric: 'closedThisWeek' },
    { label: 'Work Orders Open (Total)', metric: 'openWos' },
    { label: 'Labor Hours Billed (MTD)', metric: 'laborBilled', source: 'workbook' },
    { label: 'Labor Hours Unbilled (MTD)', metric: 'laborUnbilled', source: 'workbook' },
  ] },
  { key: 'delinquency', title: 'Delinquency & Evictions', cards: [
    { label: 'DQ Total', metric: 'dqTotal', money: true },
    { label: 'Eviction $', metric: 'evictionDollars', money: true },
    { label: 'Evictions Pending', metric: 'evictionsInProcess' },
    { label: 'Need To File Eviction', metric: 'needToFile' },
  ] },
  // Kara, 2026-10-09, asked for these on the report: "open and closed, total
  // transparency". Open AND closed, deliberately — an owner reading only a
  // falling open count cannot tell work being finished from work being
  // reclassified, and the pair is what makes either number mean anything.
  { key: 'violations', title: 'Code Violations', cards: [
    { label: 'Open', metric: 'cvOpen' },
    { label: 'Closed This Week', metric: 'cvClosedThisWeek' },
    { label: 'Closed (All Time)', metric: 'cvClosedTotal' },
    { label: 'Past Due', metric: 'cvPastDue' },
  ] },
];

// Every metric a card asks for, so nothing is computed and then silently
// dropped — which is exactly what happened to the work-order split in phase 1.
const CARD_METRICS = SECTIONS.reduce((all, s) => all
  .concat((s.cards || []).map(c => c.metric))
  .concat((s.funnel || []).map(c => c.metric)), []);

const isExcluded = name => {
  const n = String(name || '').trim();
  return EXCLUDED_PROPERTIES.includes(n) || OUT_OF_SCOPE.includes(n);
};

// Which real properties feed each roll-up. A member that is excluded, or that
// has no data this week, is dropped here rather than contributing a zero.
function groupMembers(name, present) {
  const list = name === ROUND_ROCK.name ? ROUND_ROCK.members : (VIRTUAL_GROUPS[name] || []);
  return list.filter(p => !isExcluded(p) && (!present || present.includes(p)));
}

// Summed, never averaged.
//
// occPct and prePct are RATIOS and a mean of per-property percentages weights a
// 12-unit property like a 200-unit one. They are recomputed from the summed
// numerator and denominator, the same way kpi-lyndsay rolls unit-type rows up
// within a property.
function rollUp(rows, metrics) {
  const out = {};
  // Deduplicated. Callers append 'units' to CARD_METRICS, and once a Units
  // card existed that name was in the list twice — so the portfolio summed
  // 397 units as 794 and reported 35% occupancy against her 70%. A metric
  // counted twice is worse than one counted not at all: it looks like data.
  const list = [...new Set(metrics || [])];
  list.forEach(m => { out[m] = 0; });
  let any = false;
  rows.forEach(r => {
    if (!r) return;
    any = true;
    list.forEach(m => {
      const v = r[m];
      if (typeof v === 'number' && isFinite(v)) out[m] += v;
    });
  });
  if (!any) return null;
  out.occPct = out.units ? out.occupied / out.units : null;
  out.prePct = out.units ? out.preleased / out.units : null;
  return out;
}

// The Summary column order, reproduced from summaryColumnOrder() in the HTML:
// real properties alphabetically, then Round Rock, then the virtual groups,
// then Portfolio. People read across this; a different order is a different
// report even with identical numbers.
function columnOrder(presentProperties) {
  const real = (presentProperties || [])
    .filter(n => n !== 'Portfolio' && n !== ROUND_ROCK.name
      && !Object.prototype.hasOwnProperty.call(VIRTUAL_GROUPS, n) && !isExcluded(n))
    .slice().sort();
  return real
    .concat([ROUND_ROCK.name])
    .concat(Object.keys(VIRTUAL_GROUPS))
    .concat(['Portfolio']);
}

// Where every number came from, per property and metric.
//
// 'appfolio'   computed from synced data
// 'workbook'   only Katie's Excel has it (the MTD figures, Occupancy Goals)
// 'manual'     a person adjusted it
// 'unavailable' could not be computed, WITH a reason
//
// A number that could not be worked out must not arrive as 0. That was the
// phase-1 lesson on work orders, and it is the difference between a report
// that is wrong and one that says what it does not know.
function provenance(value, declared, overridden) {
  if (overridden) return 'manual';
  // "unavailable" is checked BEFORE "workbook", not after. A workbook metric
  // with no workbook uploaded is not sourced from the workbook — it is
  // missing, and labelling it 'workbook' would put a confident provenance on
  // an empty cell.
  if (value === null || value === undefined) return 'unavailable';
  if (declared === 'workbook') return 'workbook';
  return 'appfolio';
}

// Assemble one property's section data, carrying the source beside each value.
function sectionsFor(metrics, opts) {
  const o = opts || {};
  const workbook = o.workbook || {};
  const overrides = o.overrides || {};
  const m = metrics || {};
  return SECTIONS.map(sec => ({
    key: sec.key,
    title: sec.title,
    workbook: !!sec.workbook,
    cards: (sec.cards || []).map(c => cardValue(c, m, workbook, overrides)),
    funnel: (sec.funnel || []).map(c => cardValue(c, m, workbook, overrides)),
  }));
}

function cardValue(card, metrics, workbook, overrides) {
  const over = Object.prototype.hasOwnProperty.call(overrides, card.metric);
  const base = card.source === 'workbook'
    ? (workbook[card.metric] === undefined ? null : workbook[card.metric])
    : (metrics[card.metric] === undefined ? null : metrics[card.metric]);
  const value = over ? overrides[card.metric].value : base;
  const out = {
    label: card.label,
    metric: card.metric,
    value: value === undefined ? null : value,
    source: provenance(base, card.source, over),
    money: !!card.money,
  };
  if (card.pct) out.pct = metrics[card.pct] === undefined ? null : metrics[card.pct];
  if (over) {
    // Both numbers travel together. The page shows "18 (adjusted from 17 by
    // Kara, 10/09)" rather than a 18 nobody can question.
    out.computed = base;
    out.adjusted_by = overrides[card.metric].updated_by || null;
    out.adjusted_at = overrides[card.metric].updated_at || null;
    out.note = overrides[card.metric].note || null;
  }
  if (out.source === 'unavailable') {
    out.reason = card.source === 'workbook'
      ? 'needs Katie’s workbook for this week'
      : 'not computed from the synced data';
  }
  return out;
}

module.exports = {
  VIRTUAL_GROUPS, ROUND_ROCK, EXCLUDED_PROPERTIES, OUT_OF_SCOPE, SECTIONS, CARD_METRICS,
  isExcluded, groupMembers, rollUp, columnOrder, provenance, sectionsFor, cardValue,
};
