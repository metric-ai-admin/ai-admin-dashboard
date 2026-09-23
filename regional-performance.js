// =====================================================================
// Regional Performance — portfolio health, one card per property.
//
// Pure functions, no I/O. Same reasoning as vacancy-rules.js and
// collections-triggers.js: deterministic aggregation belongs in code where it
// can be unit-tested.
//
// SOURCES, all already synced — no new AppFolio calls:
//   unit_vacancy              vacant units and their rents
//   delinquency_as_of         balances
//   maintenance_work_orders   ageing and urgent work orders, code violations
//   leasing_leads / _showings / _applications / _lease_history   the funnel
//
// OCCUPANCY % IS NOT COMPUTABLE, and this module says so rather than guessing.
// unit_vacancy lists ONLY vacant and on-notice units — 157 rows, 157 distinct
// unit ids, every one of them vacant or on notice. It carries no total-unit
// count, and properties.units (the CRM's CoStar data) matched 0 of the 12
// Metric properties when checked on 2026-09-23. Without a denominator any
// percentage would be invented. What IS real: the vacant-unit count and the
// rent those units are advertised at, so the cards show vacancy COUNT and
// monthly $ exposure instead.
// =====================================================================

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Thresholds as specified. Occupancy is absent for the reason above.
const THRESHOLDS = {
  delinquency: { red: 2000, yellow: 500 },   // total balance owed
  agedWos: { red: 5, yellow: 3 },            // work orders open 14+ days
};

const band = (value, t) => (value > t.red ? 'red' : value >= t.yellow ? 'yellow' : 'green');

const normName = s => String(s || '').trim();
const keyOf = s => normName(s).toLowerCase();

// Rows that name the management company rather than a property. Seen in the
// work-order data as "Metric Property Management of Texas LLC".
const NOT_A_PROPERTY = /property management|of texas llc/i;

/**
 * @param {object} src
 *   vacancy[]      unit_vacancy rows
 *   delinquency[]  delinquency_as_of rows
 *   workOrders[]   maintenance_work_orders rows (open only — that table holds no closed ones)
 *   leads[] showings[] applications[] moveIns[]   leasing funnel
 * @param {object} opts
 *   today                  YYYY-MM-DD, Central
 *   isExcludedProperty     injected, so server.js keeps the single exclusion list
 *   weekStart/weekEnd, prevStart/prevEnd   ISO dates for the funnel comparison
 */
function buildRegionalPerformance(src = {}, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const isExcluded = opts.isExcludedProperty || (() => false);
  const keep = name => normName(name) && !isExcluded(name) && !NOT_A_PROPERTY.test(name);

  const props = new Map();
  const bucket = name => {
    const k = keyOf(name);
    if (!props.has(k)) {
      props.set(k, {
        property: normName(name),
        vacantUnits: 0, vacancyMonthly: 0, onNotice: 0,
        delinquentBalance: 0, delinquentAccounts: 0, highestBalance: 0,
        openWos: 0, agedWos: 0, urgentWos: 0, codeViolations: 0,
      });
    }
    return props.get(k);
  };

  // ---- vacancy
  for (const r of src.vacancy || []) {
    const name = r.property_name || r.property;
    if (!keep(name)) continue;
    const p = bucket(name);
    const status = String(r.unit_status || '');
    // Vacant-Rented / Notice-Rented are already committed to a new resident, so
    // they are not lost income.
    if (/^vacant-unrented/i.test(status)) {
      p.vacantUnits++;
      // Each unit's own asking rent, not a portfolio average — the report
      // carries it for 149 of 157 rows.
      p.vacancyMonthly += num(r.advertised_rent) || num(r.schd_rent) || num(r.computed_market_rent);
    } else if (/^notice-unrented/i.test(status)) {
      p.onNotice++;
    }
  }

  // ---- delinquency
  for (const r of src.delinquency || []) {
    const name = r.property_name || r.property;
    if (!keep(name)) continue;
    const p = bucket(name);
    const bal = num(r.delinquent_rent);
    if (bal > 0) {
      p.delinquentBalance += bal;
      p.delinquentAccounts++;
      if (bal > p.highestBalance) p.highestBalance = bal;
    }
  }

  // ---- work orders
  const ageDays = w => {
    const c = String(w.created_at_appfolio || '').slice(0, 10);
    if (!c) return null;
    return Math.floor((new Date(today + 'T00:00:00') - new Date(c + 'T00:00:00')) / 86400000);
  };
  for (const w of src.workOrders || []) {
    const name = w.property_name || w.property;
    if (!keep(name)) continue;
    const p = bucket(name);
    p.openWos++;
    if ((ageDays(w) ?? 0) >= 14) p.agedWos++;
    if (/urgent|emergency|critical/i.test(String(w.priority || ''))) p.urgentWos++;
    // Identifiable only by the phrase in the issue text — there is no violation
    // field. A loose /violation/ match pulls in "Daily Groundskeeping" rows.
    if (/code violation/i.test(String(w.issue || '') + String(w.description || ''))) p.codeViolations++;
  }

  // ---- per-property banding
  const cards = [...props.values()].map(p => ({
    ...p,
    vacancyMonthly: Math.round(p.vacancyMonthly),
    delinquentBalance: Math.round(p.delinquentBalance),
    highestBalance: Math.round(p.highestBalance),
    bands: {
      delinquency: band(p.delinquentBalance, THRESHOLDS.delinquency),
      agedWos: band(p.agedWos, THRESHOLDS.agedWos),
    },
  }));
  // Worst first: anything red, then yellow, then by money owed.
  const rank = c => (c.bands.delinquency === 'red' || c.bands.agedWos === 'red' ? 0
    : c.bands.delinquency === 'yellow' || c.bands.agedWos === 'yellow' ? 1 : 2);
  cards.sort((a, b) => rank(a) - rank(b) || b.delinquentBalance - a.delinquentBalance
    || a.property.localeCompare(b.property));

  // ---- leasing funnel, portfolio totals, this week vs last
  const inRange = (d, from, to) => { const s = String(d || '').slice(0, 10); return s && s >= from && s <= to; };
  const countWeek = (rows, dateField, from, to, extra) => (rows || []).filter(r =>
    inRange(r[dateField], from, to) && (!extra || extra(r))).length;

  const wk = (from, to) => ({
    traffic: countWeek(src.leads, 'interest_received', from, to),
    tours: countWeek(src.showings, 'showing_date', from, to,
      r => !/cancel|no.?show/i.test(String(r.status || ''))),
    applications: countWeek(src.applications, 'application_date', from, to),
    approved: countWeek(src.applications, 'application_date', from, to,
      r => /approved/i.test(String(r.status || ''))),
    moveIns: countWeek(src.moveIns, 'move_in_date', from, to),
  });

  const funnel = (opts.weekStart && opts.prevStart)
    ? { thisWeek: wk(opts.weekStart, opts.weekEnd), lastWeek: wk(opts.prevStart, opts.prevEnd),
        range: { thisWeek: [opts.weekStart, opts.weekEnd], lastWeek: [opts.prevStart, opts.prevEnd] } }
    : null;

  const sum = f => cards.reduce((a, c) => a + c[f], 0);
  return {
    cards,
    funnel,
    totals: {
      properties: cards.length,
      vacantUnits: sum('vacantUnits'), onNotice: sum('onNotice'),
      vacancyMonthly: sum('vacancyMonthly'),
      delinquentBalance: sum('delinquentBalance'), delinquentAccounts: sum('delinquentAccounts'),
      openWos: sum('openWos'), agedWos: sum('agedWos'), urgentWos: sum('urgentWos'),
      codeViolations: sum('codeViolations'),
    },
    thresholds: THRESHOLDS,
    occupancyAvailable: false,   // see the header note
  };
}

module.exports = { buildRegionalPerformance, THRESHOLDS, band, num, NOT_A_PROPERTY };
