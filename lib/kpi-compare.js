// Katie's workbook against the combined report.
//
// Pure: it is handed her parsed sheets and our built report and returns the
// table of differences. The route supplies both, so the comparison can run on
// the server — where delinquency_kpi and unit_turn_detail live — instead of on
// a laptop where those stores are absent and every metric that depends on them
// reads zero.
//
// Monday 2026-10-12 is the last side-by-side against the Excel. What this
// returns is the list of things to settle before then.

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[$,%\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}

function canon(raw) {
  let n = String(raw == null ? '' : raw).trim();
  if (!n || norm(n) === 'total') return null;
  const i = n.indexOf(' - ');
  if (i !== -1) n = n.slice(0, i).trim();
  return n || null;
}

// ---- her delinquency sheet --------------------------------------------------
//
// Aged Receivable Detail: one row per CHARGE LINE, grouped by
// "Property - Address - Unit - Payer". A row with text in column A and nothing
// else opens a group; the charge rows under it belong to it.
//
// The sum is AMOUNT RECEIVABLE, positives only. Reading the aging buckets
// instead gives $332k against her $106k — the buckets and the receivable
// column do not agree on every row. And the negatives are concessions:
// netting them off would report less delinquency than there is, which is the
// direction that matters.
function herDelinquency(rows) {
  const out = { byProperty: {}, positives: 0, negatives: 0, negativeRows: 0, rows: 0, groups: 0 };
  // Start AFTER the header. The five metadata rows above it include a title
  // that has text in column A and nothing else — the same shape as a group
  // header — and counting it as one made the group count wrong (harmlessly for
  // the totals, but a count nobody can trust is not worth printing).
  let start = 0;
  for (let i = 0; i < Math.min(20, (rows || []).length); i++) {
    if (norm((rows[i] || [])[0]) === 'payer name') { start = i + 1; break; }
  }
  let current = null;
  (rows || []).slice(start).forEach(r => {
    const c0 = String(r[0] == null ? '' : r[0]).trim();
    if (!c0) return;
    const rest = r.slice(1).some(c => String(c == null ? '' : c).trim() !== '');
    if (!rest) { current = c0 === 'Total' ? null : c0; out.groups++; return; }
    if (!current || c0 === 'Total') return;
    out.rows++;
    const amt = num(r[5]);
    if (amt < 0) { out.negatives += amt; out.negativeRows++; return; }
    if (!amt) return;
    const p = canon(current);
    if (!p) return;
    out.positives += amt;
    if (!out.byProperty[p]) out.byProperty[p] = { total: 0, payers: {} };
    out.byProperty[p].total = Math.round((out.byProperty[p].total + amt) * 100) / 100;
    out.byProperty[p].payers[c0] = true;
  });
  Object.keys(out.byProperty).forEach(p => {
    out.byProperty[p].residents = Object.keys(out.byProperty[p].payers).length;
    delete out.byProperty[p].payers;
  });
  out.positives = Math.round(out.positives * 100) / 100;
  return out;
}

// ---- her occupancy ----------------------------------------------------------
// C units, D occupied, H vacant rented, I vacant unrented, J+K notices, summed
// per property. Her unit-type rows roll up; a mean of per-row percentages would
// weight a 4-unit type like a 200-unit one.
function herOccupancy(rows) {
  const out = {};
  let header = -1;
  for (let i = 0; i < Math.min(15, (rows || []).length); i++) {
    const r = (rows[i] || []).map(norm);
    if (r.some(c => /unit/.test(c)) && r.some(c => /occupied/.test(c))) { header = i; break; }
  }
  if (header === -1) return out;
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const p = canon(r[0]);
    if (!p) continue;
    if (!out[p]) out[p] = { units: 0, occupied: 0, vacantRented: 0, vacantUnrented: 0, notices: 0 };
    out[p].units += num(r[2]);
    out[p].occupied += num(r[3]);
    out[p].vacantRented += num(r[7]);
    out[p].vacantUnrented += num(r[8]);
    out[p].notices += num(r[9]) + num(r[10]);
  }
  Object.keys(out).forEach(p => {
    out[p].preleased = out[p].occupied + out[p].vacantRented;
    out[p].occPct = out[p].units ? out[p].occupied / out[p].units : null;
  });
  return out;
}

// ---- the comparison ---------------------------------------------------------
//
// Why a metric differs, where we know. An unexplained difference is left
// unexplained rather than given a plausible-sounding reason — a wrong
// explanation is worse than none, because it stops the question being asked.
const EXPLANATIONS = {
  openWos: 'her scope excludes Unit Turn and Awaiting Billing work orders; the split is in the report',
  newWos: 'her scope excludes Unit Turn and Awaiting Billing work orders',
  closedThisWeek: 'her window comes from the box score dates, ours from completed_on',
  units: 'snapshot date — hers is as of the Saturday, ours is whatever leasing_occupancy last stored',
  occupied: 'snapshot date — hers is as of the Saturday',
  occPct: 'follows occupied and units',
  vacantUnrented: 'snapshot date, and derived: units − occupied − vacant rented',
  preleased: 'follows occupied and vacant rented',
  notices: 'hers is Notice Rented + Notice Unrented from the occupancy sheet',
  moveIns: 'hers comes from the box score event list, ours from lease history dates',
  moveOuts: 'hers comes from the box score event list, ours from unit_turn_detail',
  leadsByInterest: 'both count interests deduplicated per property; a gap is usually one card',
  dqTotal: 'hers sums Amount Receivable, positives only, from the Aged Receivable Detail',
};

const METRICS = [
  ['units', 'units'], ['occupied', 'occupied'], ['occPct', 'occPct'],
  ['preleased', 'preleased'], ['vacantRented', 'vacantRented'],
  ['vacantUnrented', 'vacantUnrented'], ['notices', 'notices'],
  ['dqTotal', 'dqTotal'],
];

function flatten(sections) {
  const out = {};
  (sections || []).forEach(sec => {
    (sec.cards || []).concat(sec.funnel || []).forEach(c => { out[c.metric] = c; });
  });
  return out;
}

const near = (a, b) => Math.abs(a - b) < 0.005;

// One row of the table: hers, ours, the difference, and why — or nothing where
// we do not know why, which is the point of running this.
function compareOne(property, hers, ours) {
  const rows = [];
  METRICS.forEach(([key]) => {
    const card = ours[key];
    const o = card && card.value !== null && card.value !== undefined ? card.value : null;
    const h = hers && hers[key] !== undefined && hers[key] !== null ? hers[key] : null;
    if (h === null && o === null) return;
    const diff = (h === null || o === null) ? null : o - h;
    rows.push({
      property, metric: key, hers: h, ours: o, diff,
      // A source of 'unavailable' is not a disagreement — it is a gap, and the
      // page must not show it as if we had measured something different.
      source: card ? card.source : null,
      agrees: diff !== null && near(diff, 0),
      why: diff !== null && !near(diff, 0) ? (EXPLANATIONS[key] || null) : null,
    });
  });
  return rows;
}

function compare(report, her) {
  const occ = her.occupancy || {};
  const dq = her.delinquency || { byProperty: {} };
  const herByProperty = {};
  Object.keys(occ).forEach(p => { herByProperty[p] = { ...occ[p] }; });
  Object.keys(dq.byProperty).forEach(p => {
    if (!herByProperty[p]) herByProperty[p] = {};
    herByProperty[p].dqTotal = dq.byProperty[p].total;
    herByProperty[p].dqResidents = dq.byProperty[p].residents;
  });

  const ourNames = Object.keys(report.properties || {})
    .filter(p => p !== 'Portfolio' && !(report.properties[p] || {}).__members);
  const names = [...new Set(ourNames.concat(Object.keys(herByProperty)))].sort();

  const rows = [];
  const onlyHers = [], onlyOurs = [];
  names.forEach(p => {
    const ours = report.properties[p] ? flatten(report.properties[p]) : null;
    const hers = herByProperty[p] || null;
    if (!ours) { onlyHers.push(p); return; }
    if (!hers) { onlyOurs.push(p); return; }
    rows.push(...compareOne(p, hers, ours));
  });

  // Portfolio: her totals are the sum of the properties she carries, so ours
  // is summed over the SAME set — comparing our whole portfolio against her
  // subset would manufacture a difference out of scope, not out of data.
  const shared = names.filter(p => report.properties[p] && herByProperty[p]);
  const herTotal = {};
  METRICS.forEach(([k]) => {
    const vals = shared.map(p => herByProperty[p][k]).filter(v => typeof v === 'number');
    if (vals.length) herTotal[k] = Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
  });
  const ourTotal = {};
  METRICS.forEach(([k]) => {
    const vals = shared.map(p => {
      const c = flatten(report.properties[p])[k];
      return c && typeof c.value === 'number' ? c.value : null;
    }).filter(v => v !== null);
    ourTotal[k] = vals.length ? { value: Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100, source: 'appfolio' } : { value: null, source: 'unavailable' };
  });
  // Percentages are recomputed from the totals, never summed.
  if (herTotal.units) herTotal.occPct = herTotal.occupied / herTotal.units;
  if (ourTotal.units && ourTotal.units.value) {
    ourTotal.occPct = { value: ourTotal.occupied.value / ourTotal.units.value, source: 'appfolio' };
  }

  return {
    portfolio: compareOne('Portfolio (shared properties)', herTotal, ourTotal),
    rows,
    onlyHers, onlyOurs, shared,
    delinquency: {
      herPositives: dq.positives, herNegatives: dq.negatives,
      herNegativeRows: dq.negativeRows, herChargeLines: dq.rows, herGroups: dq.groups,
    },
    disagreements: rows.filter(r => r.diff !== null && !near(r.diff, 0)).length,
    unexplained: rows.filter(r => r.diff !== null && !near(r.diff, 0) && !r.why).length,
  };
}

module.exports = { norm, num, canon, herDelinquency, herOccupancy, compare, compareOne, flatten, METRICS, EXPLANATIONS };
