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
    // Kept per payer, not just counted: "her sheet has residents ours does not"
    // is only actionable if you can see WHICH, and the amounts say how much of
    // the gap each one is.
    out.byProperty[p].payers[c0] = Math.round(((out.byProperty[p].payers[c0] || 0) + amt) * 100) / 100;
  });
  Object.keys(out.byProperty).forEach(p => {
    out.byProperty[p].residents = Object.keys(out.byProperty[p].payers).length;
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


// ---- her whole workbook, with her rules -------------------------------------
//
// Ported from hers() in scripts/kpi-compare-lyndsay.js rather than written
// again. That function reproduced her screen on 16 of 16 metrics on
// 2026-10-05, which is the only reason to trust any of these column indexes —
// her parsers read FIXED POSITIONS, not names, so every one of them is a fact
// about her workbook and not a guess.
//
// START and END are parameters here; in the script they were module constants.
function ymdOf(v) {
  if (!v) return null;
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return m[3] + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
  return null;
}

function herAll(sheets, start, end) {
  const out = {};
  const b = p => { const k = canon(p); if (!k) return null; if (!out[k]) out[k] = {}; return out[k]; };
  const add = (p, key, n) => { const x = b(p); if (x) x[key] = (x[key] || 0) + n; };
  const rows = name => sheets[name] || [];

  // occupancy: C units, D occupied, H vacant rented, I vacant unrented,
  // J + K notices. Her unit-type rows roll up per property.
  rows('occupancy').forEach(r => {
    if (!r[0] || r[0] === 'Property' || r[0] === 'Total' || r[2] === '') return;
    const p = canon(r[0]); if (!p) return;
    add(p, 'units', num(r[2]));
    add(p, 'occupied', num(r[3]));
    // Column H. Kept under its own name because she ALSO derives a
    // vacantRented from the apps tab ("Converting"), and the two are different
    // readings of the same words — see below.
    add(p, 'vacantRentedOcc', num(r[7]));
    add(p, 'vacantUnrented', num(r[8]));
    add(p, 'notices', num(r[9]) + num(r[10]));
  });

  // guest card interests: property is column J
  rows('guest card interests').forEach(r => {
    if (!r[9] || String(r[9]).indexOf(' - ') === -1) return;
    // Her RAW interest rows, not her Leads figure: she deduplicates per
    // property on phone/email/name, 136 interests becoming 105 leads. Named
    // separately so the panel cannot compare 136 against our 105.
    add(r[9], 'herInterestRows', 1);
  });

  // showings: property column O, status column J, "Completed" prefix only
  rows('showings').forEach(r => {
    if (!r[14] || r[14] === 'Property Name') return;
    add(r[14], 'showings', 1);
    if (String(r[9] || '').indexOf('Completed') === 0) add(r[14], 'tours', 1);
  });

  // apps and renewals are NOT parsed, on purpose.
  //
  // The ported apps block counts 3 applications against the 15 phase 1 read on
  // 2026-10-05: the received date is not in the column it was in then, and her
  // parsers read FIXED POSITIONS. The renewals indexes I would have to invent
  // outright — that tab was never parsed on either side.
  //
  // Both are left out rather than shipped. A number I cannot defend on a sheet
  // going into Monday's comparison is worse than a visible gap: the gap gets
  // asked about, and a wrong number gets believed. The panel shows them as
  // "her side not parsed".

  // box score: C event, matched on text; property is column A when it has ' - '
  let currentProp = null;
  rows('box score').forEach(r => {
    const c0 = String(r[0] || '');
    if (c0.indexOf(' - ') !== -1) { currentProp = c0; return; }
    if (!r[2] || !currentProp) return;
    const ev = String(r[2]).toLowerCase();
    if (ev.indexOf('move-in') !== -1 || ev.indexOf('move in') !== -1) add(currentProp, 'moveIns', 1);
    else if (ev.indexOf('move-out') !== -1 || ev.indexOf('move out') !== -1) add(currentProp, 'moveOuts', 1);
    else if (ev.indexOf('notice') !== -1) add(currentProp, 'newNotices', 1);
  });

  // work orders: property column K (10), status G (6), created J (9). Column A
  // is a short name and K is the full one, so K buckets alike with ours.
  const woDone = /^(completed|complete|canceled|cancelled)$/i;
  rows('work order open').forEach(r => {
    if (!r[10] || r[10] === 'Property Name') return;
    if (!woDone.test(String(r[6] || '').trim())) add(r[10], 'openWos', 1);
    // newWos is NOT counted here. Column J held the created date on 2026-10-05
    // and holds nothing usable in this export — every row falls outside the
    // week, which would report 0 new work orders as though that were a finding.
  });
  // Her closed report is ALREADY scoped to the leasing week by its own filter,
  // so every row counts.
  rows('work order closed').forEach(r => {
    if (!r[10] || r[10] === 'Property Name') return;
    add(r[10], 'closedThisWeek', 1);
  });

  // delinquency: grouped, Amount Receivable (column F), positives only.
  const dq = herDelinquency(rows('delinquency'));
  Object.keys(dq.byProperty).forEach(p => {
    const x = b(p);
    if (!x) return;
    x.dqTotal = dq.byProperty[p].total;
    x.dqResidents = dq.byProperty[p].residents;
  });

  Object.keys(out).forEach(p => {
    const x = out[p];
    x.preleased = (x.occupied || 0) + (x.vacantRentedOcc || 0);
    x.occPct = x.units ? x.occupied / x.units : null;
  });
  return { byProperty: out, delinquency: dq };
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
  dqTotal: 'both read the Aged Receivable Detail; ours also depends on which tenant statuses delinquency_kpi pulls',
  tours: 'hers counts showings whose status starts with "Completed"',
  applications: 'hers is the apps tab; ours is leasing_applications in the week',
  renewals: 'hers is the KPI Renewal Summary tab',
  didNotRenew: 'hers is the KPI Renewal Summary tab',
  evictionsInProcess: 'hers counts a resident as evicting on Tenant Status = Evict or any eviction status set',
  needToFile: 'same rule as evictions in process',
};

// The sixteen phase 1 reproduced against her screen, plus the ones Monday
// will be read across. A metric we cannot source from her workbook is still
// listed: it shows as a gap on her side, which is a fact worth seeing rather
// than a row quietly missing from the table.
const METRICS = [
  ['units', 'units'], ['occupied', 'occupied'], ['occPct', 'occPct'],
  ['preleased', 'preleased'], ['vacantRented', 'vacantRented'],
  ['vacantUnrented', 'vacantUnrented'], ['notices', 'notices'],
  ['leadsByInterest', 'leads'], ['tours', 'tours'],
  ['applications', 'applications'], ['approved', 'approved'],
  ['denied', 'denied'], ['canceled', 'canceled'],
  ['moveIns', 'moveIns'], ['moveOuts', 'moveOuts'],
  ['renewals', 'renewals'], ['didNotRenew', 'didNotRenew'],
  ['newWos', 'newWos'], ['closedThisWeek', 'closedThisWeek'], ['openWos', 'openWos'],
  ['evictionsInProcess', 'evictionsInProcess'], ['needToFile', 'needToFile'],
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
  // her.byProperty comes from herAll() — every sheet we can read with her
  // rules. The fallback keeps the older two-sheet shape working.
  const dq = her.delinquency || { byProperty: {} };
  const herByProperty = {};
  const src = her.byProperty || her.occupancy || {};
  Object.keys(src).forEach(p => { herByProperty[p] = { ...src[p] }; });
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

// Who is on her delinquency sheet and not on ours, per property.
//
// Hyde Park reads 7,131 our side against her 13,166 and The Chateau 3,688
// against 6,590 — ours lower at every property. The suspicion is that her
// report carries tenant statuses our delinquency_kpi pull does not ask for, and
// the only way to settle that is name by name.
//
// Names are matched on a normalised "Last, First": her sheet writes
// "Castilla, Dulce P." and ours may carry a middle initial or not.
function residentDiff(herByProperty, ourRows, properties) {
  const key = s => norm(s).replace(/[a-z]/g, '').replace(/\s+/g, ' ').trim();
  const ourByProp = {};
  (ourRows || []).forEach(r => {
    const p = canon(r.property_name || r.property);
    if (!p) return;
    const name = r.tenant_name || r.payer_name || r.resident || r.tenant || r.name;
    if (!name) return;
    if (!ourByProp[p]) ourByProp[p] = {};
    ourByProp[p][key(name)] = (ourByProp[p][key(name)] || 0) + num(r.total || r.amount || r.balance || 0);
  });
  const out = {};
  (properties || Object.keys(herByProperty)).forEach(p => {
    const hers = (herByProperty[p] || {}).payers || {};
    const ours = ourByProp[p] || {};
    const onlyHers = [], both = [];
    Object.keys(hers).forEach(nm => {
      const k = key(nm);
      if (Object.prototype.hasOwnProperty.call(ours, k)) both.push({ name: nm, hers: hers[nm], ours: ours[k] });
      else onlyHers.push({ name: nm, hers: hers[nm] });
    });
    const herNames = new Set(Object.keys(hers).map(key));
    const onlyOurs = Object.keys(ours).filter(k => !herNames.has(k)).map(k => ({ name: k, ours: ours[k] }));
    out[p] = {
      onlyHers: onlyHers.sort((a, b) => b.hers - a.hers),
      onlyOurs: onlyOurs.sort((a, b) => b.ours - a.ours),
      both: both.length,
      onlyHersTotal: Math.round(onlyHers.reduce((a, x) => a + x.hers, 0) * 100) / 100,
    };
  });
  return out;
}

module.exports = { norm, num, canon, herDelinquency, herOccupancy, herAll, ymdOf, residentDiff, compare, compareOne, flatten, METRICS, EXPLANATIONS };
