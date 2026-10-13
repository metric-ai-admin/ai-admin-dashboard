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

// Open make-readies and the oldest, from unit-turn rows. A turn with a
// move-out and no end date is still open; its age is days since the resident
// left.
function makeReadiesFrom(turns, todayCT) {
  const out = {};
  (turns || []).forEach(t => {
    const name = AFP.resolveProperty(t.property_name || t.property);
    if (!name) return;
    if (clean(t.turn_end_date)) return;            // finished
    const age = daysSince(t.move_out_date, todayCT);
    if (age === null || age < 0) return;
    if (!out[name]) out[name] = { open: 0, oldest: 0 };
    out[name].open++;
    if (age > out[name].oldest) out[name].oldest = age;
  });
  return out;
}

// Applications still standing, and the oldest. The SAME rule the KPI report
// uses — not cancelled, not denied, not carried through to a signed lease —
// so the brief and the report cannot disagree about what is pending.
function pendingApplicationsFrom(apps, todayCT) {
  const out = {};
  (apps || []).forEach(a => {
    const name = AFP.resolveProperty(a.property_name);
    if (!name) return;
    const st = clean(a.status);
    const det = clean(a.detailed_status);
    if (/^cancel/i.test(st) || /denied|declined/i.test(st)) return;
    if (det === 'Converted' || det === 'Converting') return;
    const age = daysSince(a.application_date, todayCT);
    if (!out[name]) out[name] = { pending: 0, oldest: null };
    out[name].pending++;
    if (age !== null && (out[name].oldest === null || age > out[name].oldest)) out[name].oldest = age;
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

  const mrBy = makeReadiesFrom(await store('unit_turn_detail'), todayCT);
  const apps = await d.selectAll(() => d.db.from('leasing_applications')
    .select('property_name,status,detailed_status,application_date'), { label: 'kara apps' });
  const apBy = pendingApplicationsFrom(apps, todayCT);

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
  MORNING_FEEDS, daysSince, makeReadiesFrom, pendingApplicationsFrom, flatten, gather,
};
