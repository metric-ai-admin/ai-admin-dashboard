// Everything Kara's 6 AM brief needs, per property.
//
// WHY THIS IS NOT IN server.js ANY MORE. It was, and it referenced AFP — a
// module required in lib/kpi-build.js and not in server.js. The route threw
// "AFP is not defined" the first time anybody called it, with a full suite of
// passing tests behind it: every one of them read the SOURCE of server.js and
// checked that the right calls were written down. None ran the function.
//
// A test that reads code cannot find an undefined identifier. So the gather
// lives here, its dependencies are arguments, and test/kara-brief.test.js
// renders the whole brief against stubs — which is the only kind of test that
// would have caught it.

'use strict';

const WEEK = require('./week.js');
const AFP = require('./appfolio-properties.js');
const kpiReport = require('./kpi-report.js');

const clean = s => String(s == null ? '' : s).trim();

// Days between a YYYY-MM-DD and today, or null if it is not a date.
function daysSince(ymd, todayCT) {
  const d = clean(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Math.round((Date.parse(todayCT + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
}

// A unit that is vacant TODAY, from the rent roll. Keyed "Property|Unit".
//
// This is what tells a make-ready that is actually happening from a unit-turn
// record nobody closed: if somebody is living there, the turn finished and the
// paperwork did not.
function vacantUnitsFrom(rentRoll) {
  const out = new Set();
  (rentRoll || []).forEach(r => {
    const name = AFP.resolveProperty(r.property_name || r.property);
    const unit = clean(r.unit);
    if (!name || !unit) return;
    if (/^vacant/i.test(clean(r.status))) out.add(name + '|' + unit);
  });
  return out;
}

// Monthly rent per property, from the rent roll. Used to show delinquency as a
// share of the rent it is a share of — a $6k balance is a different problem at
// Windy Hill than at iConic Downtown.
function monthlyRentFrom(rentRoll) {
  const out = {};
  (rentRoll || []).forEach(r => {
    const name = AFP.resolveProperty(r.property_name || r.property);
    if (!name) return;
    const v = Number(String(r.rent == null ? '' : r.rent).replace(/[$,\s]/g, ''));
    if (!isFinite(v) || v <= 0) return;
    out[name] = (out[name] || 0) + v;
  });
  return out;
}

// Make-readies, split into the ones that are WORK and the ones that are
// RECORDS.
//
// Ascent came back with 40 open and the oldest at 490 days. None of that is a
// turn anybody is doing: they are unit_turn_detail rows that were never closed
// in AppFolio. A brief that calls them make-readies puts seven of eight
// properties in red on its first morning, and a report that is all red is a
// report nobody opens twice.
//
// ACTIVE requires the unit to be vacant today. A turn on a unit somebody lives
// in finished; only the record is open. And anything past `staleDays` is a
// record whatever the rent roll says — nobody is 300 days into a make-ready.
//
// The stale ones are COUNTED AND REPORTED, never dropped: they are real work,
// just in AppFolio rather than in a unit.
function makeReadiesFrom(turns, todayCT, opts) {
  const o = opts || {};
  const vacant = o.vacantUnits || new Set();
  const staleDays = o.staleDays == null ? 90 : o.staleDays;
  const out = {};
  const bucket = name => {
    if (!out[name]) out[name] = { open: 0, oldest: 0, staleCount: 0, staleOldest: 0 };
    return out[name];
  };
  (turns || []).forEach(t => {
    const name = AFP.resolveProperty(t.property_name || t.property);
    if (!name) return;
    if (clean(t.turn_end_date)) return;            // finished
    const age = daysSince(t.move_out_date, todayCT);
    if (age === null || age < 0) return;
    const b = bucket(name);
    const unit = clean(t.unit || t.unit_name);
    // No unit number means the rent roll cannot be asked, so age decides alone.
    const isVacant = unit ? vacant.has(name + '|' + unit) : true;
    if (age > staleDays || !isVacant) {
      b.staleCount++;
      if (age > b.staleOldest) b.staleOldest = age;
      return;
    }
    b.open++;
    if (age > b.oldest) b.oldest = age;
  });
  return out;
}

// Applications still standing, and the oldest. The SAME rule the KPI report
// uses — not cancelled, not denied, not carried through to a signed lease —
// so the brief and the report cannot disagree about what is pending.
function pendingApplicationsFrom(apps, todayCT, opts) {
  const o = opts || {};
  // An application pending 89 days is not a decision being taken slowly. It is
  // a record nobody closed, and chasing it as if somebody were waiting wastes
  // the one thing a morning brief is for.
  const staleDays = o.staleDays == null ? 60 : o.staleDays;
  const out = {};
  (apps || []).forEach(a => {
    const name = AFP.resolveProperty(a.property_name);
    if (!name) return;
    const st = clean(a.status);
    const det = clean(a.detailed_status);
    if (/^cancel/i.test(st) || /denied|declined/i.test(st)) return;
    if (det === 'Converted' || det === 'Converting') return;
    const age = daysSince(a.application_date, todayCT);
    if (!out[name]) out[name] = { pending: 0, oldest: null, staleCount: 0, staleOldest: 0 };
    const b = out[name];
    if (age !== null && age > staleDays) {
      b.staleCount++;
      if (age > b.staleOldest) b.staleOldest = age;
      return;
    }
    b.pending++;
    if (age !== null && (b.oldest === null || age > b.oldest)) b.oldest = age;
  });
  return out;
}

// One column of the built report, flattened to {metric: value}.
function flatten(column) {
  const out = {};
  (column || []).forEach(sec => (sec.cards || []).concat(sec.funnel || [])
    .forEach(c => { out[c.metric] = c.value; }));
  return out;
}

// The sources that have a scheduled run between 05:00 and 05:55. Whether each
// one happened THIS MORNING is the question the freshness block answers —
// not how old it is. See the note in build().
const MORNING_FEEDS = ['delinquency_kpi', 'occupancy_custom_fields', 'unit_turn_detail',
  'rent_roll', 'tenant_tickler'];

// deps: { db, selectAll, buildKpiReport, readReportData, goalPctFor, now }
async function gather(deps) {
  const d = deps || {};
  const todayCT = WEEK.todayYMD(d.now);
  const weekEnd = WEEK.leasingLastCompleteWeekEnding(d.now);

  // maxAgeHours 0 — the brief REPORTS, it does not sync. At 06:00 a refresh
  // would fire an AppFolio call at the same minute as the work-order sync,
  // and a brief that fetches can be late for a reason that has nothing to do
  // with the numbers.
  const report = await d.buildKpiReport(d.db, { week_ending: weekEnd, maxAgeHours: 0 });

  // A thresholds table that is not there costs the settings, not the brief.
  let thresholds = [];
  try {
    const r = await d.db.from('brief_thresholds').select('*');
    if (!r.error) thresholds = r.data || [];
  } catch (e) { thresholds = []; }

  const store = async id => {
    try { const s = await d.readReportData(id); return (s && s.rows) || []; }
    catch (e) { return []; }
  };

  // The cutoffs that separate work from paperwork. Settings like the rest:
  // the thresholds table may carry them, and lib/kara-brief has the defaults.
  const star = (thresholds || []).find(r => clean(r.property) === '*') || {};
  const mrStale = star.make_ready_stale_days == null ? 90 : Number(star.make_ready_stale_days);
  const apStale = star.application_stale_days == null ? 60 : Number(star.application_stale_days);

  const rentRoll = await store('rent_roll');
  const vacantUnits = vacantUnitsFrom(rentRoll);
  const rentBy = monthlyRentFrom(rentRoll);

  const mrBy = makeReadiesFrom(await store('unit_turn_detail'), todayCT,
    { vacantUnits, staleDays: mrStale });
  const apps = await d.selectAll(() => d.db.from('leasing_applications')
    .select('property_name,status,detailed_status,application_date'), { label: 'kara apps' });
  const apBy = pendingApplicationsFrom(apps, todayCT, { staleDays: apStale });

  const names = (report.columns || []).filter(c =>
    c !== 'Portfolio' && c !== kpiReport.ROUND_ROCK.name
    && !Object.prototype.hasOwnProperty.call(kpiReport.VIRTUAL_GROUPS, c));

  const properties = names.map(name => {
    const m = flatten((report.properties || {})[name]);
    const rent = (report.rentable || {})[name] || null;
    const ap = apBy[name] || {};
    const mr = mrBy[name] || {};
    return {
      name,
      units: m.units ?? null,
      occupied: m.occupied ?? null,
      occupancyPct: m.occPct ?? null,
      goalPct: d.goalPctFor ? d.goalPctFor(name) : null,
      rentableUnits: rent ? rent.rentableUnits : null,
      rentableOccupied: rent ? rent.rentableOccupied : null,
      rentableOccupancyPct: rent ? rent.rentablePct : null,
      rentableNote: rent && rent.rules.length
        ? 'excludes ' + rent.rules.map(r => r.label).join(', ') : null,
      preleased: m.vacantRented ?? null,
      applicationsPending: ap.pending ?? 0,
      applicationOldestDays: ap.oldest ?? null,
      makeReadyOpen: mr.open ?? 0,
      makeReadyOldestDays: mr.open ? mr.oldest : null,
      // Records, not work. Reported in their own section, never in red.
      staleMakeReadies: mr.staleCount ?? 0,
      staleMakeReadyOldest: mr.staleCount ? mr.staleOldest : null,
      staleApplications: ap.staleCount ?? 0,
      staleApplicationOldest: ap.staleCount ? ap.staleOldest : null,
      monthlyRent: rentBy[name] ?? null,
      moveInsExpected: m.moveIns ?? null,
      moveOutsExpected: m.moveOuts ?? null,
      notices: m.notices ?? null,
      delinquency: m.dqTotal ?? null,
    };
  });

  const pm = flatten(report.portfolio);
  const portfolio = {
    units: pm.units ?? null, occupied: pm.occupied ?? null, occupancyPct: pm.occPct ?? null,
    preleased: pm.vacantRented ?? null,
    applicationsPending: properties.reduce((a, p) => a + (p.applicationsPending || 0), 0),
    makeReadyOpen: properties.reduce((a, p) => a + (p.makeReadyOpen || 0), 0),
    monthlyRent: properties.reduce((a, p) => a + (p.monthlyRent || 0), 0) || null,
    moveInsExpected: pm.moveIns ?? null, moveOutsExpected: pm.moveOuts ?? null,
    notices: pm.notices ?? null, delinquency: pm.dqTotal ?? null,
  };

  // THE FRESHNESS BLOCK, and the rule it turns on: a source is NOT ok when it
  // was not written THIS MORNING.
  //
  // Not "older than N hours". Every one of these has a scheduled run between
  // 05:00 and 05:55, so the honest question is whether that run happened, and
  // the answer is a date comparison. The first version asked about age, which
  // at 06:00 is true of anything synced the evening before and raised the
  // alarm every single day — and an alarm that is always on is one nobody
  // reads on the morning it is real.
  const lines = [];
  const f = report.freshness || {};
  lines.push({
    source: 'occupancy', ok: f.as_of === todayCT,
    when: f.as_of ? 'synced ' + f.as_of : null,
    note: f.as_of ? 'last synced ' + f.as_of + ', not this morning' : 'never synced',
  });
  for (const id of MORNING_FEEDS) {
    let when = null;
    try {
      const s = await d.readReportData(id);
      when = s && s.fetchedAt ? WEEK.toChicagoYMD(s.fetchedAt) : null;
    } catch (e) { when = null; }
    lines.push({
      source: id, ok: when === todayCT,
      when: when ? 'synced ' + when : null,
      note: when ? 'last synced ' + when + ', not this morning' : 'no data on disk',
    });
  }
  (report.gaps || []).forEach(g => {
    const src = String(g).split(':')[0];
    if (lines.some(l => l.source === src && !l.ok)) return;   // already said
    lines.push({ source: src, ok: false, note: String(g).slice(src.length + 1).trim() });
  });

  return {
    properties, portfolio, thresholds,
    freshness: {
      asOf: todayCT + ' (Central), for the week ending ' + report.week_ending,
      lines,
    },
  };
}

module.exports = {
  MORNING_FEEDS, daysSince, makeReadiesFrom, pendingApplicationsFrom,
  vacantUnitsFrom, monthlyRentFrom, flatten, gather,
};
