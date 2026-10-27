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
const PA = require('./property-aliases.js');

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
// THE RENT ROLL DECIDES, NOT THE AGE — corrected by Bekah 2026-10-13.
//
// The first version sent anything past `staleDays` to "records to clean up"
// whatever the rent roll said, on the reasoning that nobody is 300 days into a
// make-ready. Bekah checked them: "they aren't done", except the one at iConic
// Round Rock. They are real make-readies on units that have been sitting empty
// for a very long time, which is the single most expensive thing on this brief
// and exactly what the age rule was hiding.
//
//   OCCUPIED today  -> a record. Somebody lives there; the turn finished and
//                      the paperwork did not. Age is irrelevant.
//   VACANT today    -> real work, at any age. A 490-day-old one is not less
//                      real than a 10-day-old one, it is worse.
//
// The vacant ones past `staleDays` get their own section rather than being
// folded in with a make-ready that started on Tuesday: "Long-open make-readies
// (90+ days)", in red. An average over both tells Kara nothing about either.
function makeReadiesFrom(turns, todayCT, opts) {
  const o = opts || {};
  const vacant = o.vacantUnits || new Set();
  const staleDays = o.staleDays == null ? 90 : o.staleDays;
  const out = {};
  const bucket = name => {
    if (!out[name]) {
      out[name] = {
        open: 0, oldest: 0, staleCount: 0, staleOldest: 0,
        longOpen: 0, longOpenOldest: 0, longOpenUnits: [],
      };
    }
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
    // No unit number means the rent roll cannot be asked. Treated as vacant:
    // an unverifiable turn is shown as work, because the cost of chasing one
    // that is already done is a phone call and the cost of hiding a real empty
    // unit is a month of rent.
    const isVacant = unit ? vacant.has(name + '|' + unit) : true;
    if (!isVacant) {
      b.staleCount++;
      if (age > b.staleOldest) b.staleOldest = age;
      return;
    }
    b.open++;
    if (age > b.oldest) b.oldest = age;
    if (age > staleDays) {
      b.longOpen++;
      if (age > b.longOpenOldest) b.longOpenOldest = age;
      // Units, so the section names what to go and look at. No resident data —
      // a vacant unit has no resident, and the turn row's tenant columns are
      // never read here.
      b.longOpenUnits.push({ unit: unit || '(no unit)', days: age, since: clean(t.move_out_date).slice(0, 10) });
    }
  });
  Object.values(out).forEach(b => b.longOpenUnits.sort((a, c) => c.days - a.days));
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
// The FAS counts, read from deposit_held and deposit_sync_runs.
//
// READS ONLY. The snapshot is taken by the 04:00 cron; the brief reports what
// is on file and never fetches, for the same reason the KPI report does not:
// a brief that syncs can be late for a reason that has nothing to do with its
// numbers.
async function gatherFas(db, todayCT, deadline, deadlineUnconfirmed, selectAll) {
  const FAS = require('./fas-deposits.js');

  // PAGED. PostgREST caps a response at 1000 rows and .limit() does not raise
  // it, so a plain select returns a plausible short answer once the table
  // passes that — and a deposit missing from THIS read is a deposit the brief
  // does not report as overdue. 218 rows today, 258 after the
  // tenant_statuses fix, and it only grows.
  //
  // ORDERED BY occupancy_id, NOT id: deposit_held has no `id` column — it is
  // keyed on occupancy_id. Left to the default, selectAll pages this table
  // unordered, which is not trustworthy past the first page.
  const page = selectAll || (async make => {
    const r = await make();
    if (r.error) throw new Error(r.error.message);
    return r.data || [];
  });
  const rows = await page(() => db.from('deposit_held')
    .select('occupancy_id,unit,property,property_source,tenant_status,move_in,move_out,amount,first_seen_on,last_seen_on,in_feed,gone_first_seen_on'),
  { label: 'deposit_held', order: 'occupancy_id' });

  const runs = await db.from('deposit_sync_runs')
    .select('ran_on,status,rows_returned,status_counts')
    .order('ran_on', { ascending: false }).limit(60);
  if (runs.error) throw new Error(runs.error.message);
  const all = runs.data || [];
  const good = all.filter(r => r.status === 'ok');

  // NO SNAPSHOT MEANS NOT MEASURABLE, not "nothing overdue". The cron has not
  // run yet the first morning, and an empty table must not read as a clean
  // week — which is the exact failure the old NOT MEASURABLE note existed to
  // avoid.
  if (!rows.length || !good.length) {
    return {
      measurable: false,
      reason: !good.length
        ? 'No deposit snapshot has been taken yet. The first one is due at 04:00.'
        : 'The deposit table is empty.',
    };
  }

  const start = good[good.length - 1].ran_on;
  // Days between the first snapshot and today that have no run at all. A
  // settlement on one of them is dated to the next run that did happen.
  const span = FAS.daysBetween(start, todayCT, 'calendar');
  const missedDays = span === null ? null : Math.max(0, (span + 1) - all.length);

  const grouped = FAS.byProperty(rows, todayCT, { deadline });
  return {
    measurable: true,
    deadline: deadline || FAS.DEFAULT_DEADLINE,
    snapshotsStart: start,
    lastRun: all[0] || null,
    statusCounts: (all[0] && all[0].status_counts) || null,
    missedDays,
    ...grouped,
    deadlineUnconfirmed: !!deadlineUnconfirmed,
    caveats: FAS.caveats({
      deadline: deadline || FAS.DEFAULT_DEADLINE,
      deadlineUnconfirmed,
      snapshotsStart: start,
      runs: {
        missedDays,
        lastStatus: all[0] && all[0].status,
        lastGoodOn: good[0] && good[0].ran_on,
      },
    }),
  };
}

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
  // PENDING APPLICATIONS ARE A STATEMENT ABOUT NOW, so rows the report has
  // stopped returning are dropped — an application frozen as "Decision
  // Pending" would sit in Kara's brief for ever, which is what a lease dated
  // 2026-11-10 did from a row last seen on 2026-10-02.
  //
  // ONLY AN EXPLICIT false COUNTS. NULL means "outside the 90-day window the
  // sync asks about, never assessed" (migration 101) — and, before that
  // migration, it means the column does not exist. Neither is a reason to
  // drop the row. Asking for the column at all is wrapped, because selecting
  // one that does not exist fails the whole query.
  const APP_COLS = 'property_name,status,detailed_status,application_date';
  const apps = await d.selectAll(() => d.db.from('leasing_applications')
    .select(APP_COLS + ',in_feed'), { label: 'kara apps' })
    .catch(() => d.selectAll(() => d.db.from('leasing_applications')
      .select(APP_COLS), { label: 'kara apps (no in_feed)' }));
  const apBy = pendingApplicationsFrom(
    (apps || []).filter(a => a.in_feed !== false), todayCT, { staleDays: apStale });

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
      // Vacant units whose turn has been open past the cutoff. Real work, and
      // the most expensive line on the brief — its own section, in red.
      longOpenMakeReadies: mr.longOpen ?? 0,
      longOpenOldestDays: mr.longOpen ? mr.longOpenOldest : null,
      longOpenUnits: mr.longOpenUnits || [],
      // Records, not work: the unit is OCCUPIED and the turn was never closed.
      // Reported in their own section, never in red.
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

  // Kara's Phase C item 1: today's move-outs, and the ones with no inspection
  // behind them two business days on. The FAS alert is deliberately absent —
  // see the note at the top of lib/moveout-alerts.js.
  const MOVEOUT = require('./moveout-alerts.js');
  const turns = await store('unit_turn_detail');
  const inspections = await (async () => {
    try {
      const r = await d.db.from('maintenance_inspections')
        .select('inspection_id,inspection_name,property_name,unit,status,marked_done_on,created_on')
        .limit(5000);
      return r.error ? [] : (r.data || []);
    } catch (e) { return []; }
  })();

  // Collections against the same stretch of last month (Kara, 2026-10-16).
  // NOT MEASURABLE until a month of captures exists, and the alert says so —
  // a collections alert that goes quiet reads as "collections are fine".
  const COLL = require('./collections-mtd.js');
  const collections = await (async () => {
    try {
      const r = await d.db.from('collections_mtd')
        .select('captured_on,property,rent_income').limit(5000);
      return COLL.alert(r.error ? [] : (r.data || []), todayCT);
    } catch (e) { return COLL.alert([], todayCT); }
  })();

  // ---- (b) yesterday's call scores ------------------------------------------
  //
  // Kara's option 1: a count per property, never red. Yesterday, not today —
  // the brief runs at 06:00 and today's calls have not happened.
  //
  // PAGED, NOT .limit(). call_grades passed a thousand rows long ago, and
  // PostgREST caps a plain select at 1000 whatever limit is asked for — a cap
  // that returns a plausible short answer rather than an error.
  const CALLS = require('./brief-calls.js');
  const yesterday = WEEK.addDaysYMD(todayCT, -1);
  const calls = await (async () => {
    try {
      const rows = await d.selectAll(() => d.db.from('call_grades')
        .select('call_date,property_name,overall_score,not_scoreable')
        .gte('call_date', yesterday).lte('call_date', yesterday + 'T23:59:59'),
      { label: 'kara calls' });
      // DID ANY CALL ARRIVE? Without this the section can only say "none were
      // graded", which on 2026-10-20 sent somebody to check whether the Call
      // Analyzer was still receiving recordings — 61 calls had arrived with
      // transcripts, and the grading step was what had stopped. Two very
      // different problems behind one sentence.
      //
      // A COUNT, not the calls: nothing here reads a transcript.
      let arrived = null;
      try {
        const c = await d.db.from('simplevoip_daily_calls')
          .select('*', { count: 'exact', head: true }).eq('call_date', yesterday);
        if (!c.error) arrived = c.count;
      } catch (e) { arrived = null; }

      return CALLS.failedCalls(rows || [], yesterday, thresholds, {
        // null means the question could not be asked, which is neither "calls
        // arrived" nor "none did".
        arrived,
        // PA.canonical, NOT AFP.resolveProperty. resolveProperty hands back
        // whatever it is given — it is a normaliser, not a membership test —
        // so using it put "Not property-specific" in the list of managed
        // properties, looking exactly like a property with a bad morning.
        // canonical() returns null for anything that is not one of the eight,
        // which is the question being asked. Cedar & Sage lands in `others`:
        // present, with its own heading, out of the portfolio's numbers.
        isManaged: name => !!PA.canonical(name),
      });
    } catch (e) {
      return CALLS.failedCalls([], yesterday, thresholds, { isManaged: () => true });
    }
  })();

  // ---- (c) projected occupancy ----------------------------------------------
  //
  // Departures are dated from unit_turn_detail, the same source the move-out
  // alerts read.
  //
  // ARRIVALS ARE NOT INVENTED. If no dated move-in source is present, `moveIns`
  // stays NULL rather than becoming an empty array: an empty array means "we
  // looked and there are none", which would make occupancy fall every week at
  // every property and read as a portfolio in trouble. Null means "we cannot
  // see them", and the brief prints that above the table.
  const OCC = require('./brief-occupancy.js');
  const datedMoveOuts = (turns || [])
    .map(t => ({
      property: AFP.resolveProperty(t.property_name || t.property),
      date: clean(t.move_out_date).slice(0, 10),
    }))
    .filter(r => r.property && OCC.isYmd(r.date) && r.date >= todayCT);

  const portfolioMap = await (async () => {
    try {
      const r = await d.db.from('brief_portfolios').select('property,portfolio');
      if (r.error) return {};
      const m = {};
      (r.data || []).forEach(x => { m[clean(x.property)] = clean(x.portfolio); });
      return m;
    } catch (e) { return {}; }
  })();

  // DATED ARRIVALS, from the source the email already counts.
  //
  // The brief prints "Move-ins this week" and "Signed, not moved in" for every
  // property, so a projection claiming the move-in source was empty disagreed
  // with its own email three inches further up. leasing_lease_history carries
  // the move-in date; this reads the ones still ahead of us.
  let staleLeaseRows = 0;
  let staleLeaseFutureMoveIns = 0;
  const datedMoveIns = await (async () => {
    try {
      // ASKING FOR in_feed BEFORE MIGRATION 100 FAILS THE WHOLE SELECT, and
      // the catch below would turn that into "no dated move-in source" — the
      // projection would silently go back to counting departures only. So the
      // column is asked for, and a failure falls back to the set without it
      // rather than losing the query.
      const BASE = 'property_name,move_in_date,status,tenant_name,synced_at';
      const rows = await d.selectAll(() => d.db.from('leasing_lease_history')
        .select(BASE + ',in_feed'), { label: 'kara move-ins' })
        .catch(() => d.selectAll(() => d.db.from('leasing_lease_history')
          .select(BASE), { label: 'kara move-ins (no in_feed)' }));
      // THE UNIT IS NOT IN THIS TABLE. leasing_lease_history has property,
      // dates, status, renewal and tenant — no unit. When the projection hits
      // a contradiction, "check the unit in AppFolio" without a unit number
      // is an instruction to go hunting, so the unit is looked up from the
      // rent roll by tenant name.
      //
      // ONLY AN UNAMBIGUOUS MATCH COUNTS. A name that appears in two units is
      // left blank rather than resolved to whichever sorts first — the same
      // rule as the call matching, for the same reason: a wrong unit number
      // sends somebody to the wrong door and looks exactly like a right one.
      const unitByTenant = {};
      (rentRoll || []).forEach(rr => {
        const name = clean(rr.tenant || rr.tenant_name || rr.resident).toLowerCase();
        const unit = clean(rr.unit);
        if (!name || !unit) return;
        unitByTenant[name] = (unitByTenant[name] === undefined || unitByTenant[name] === unit)
          ? unit : null;          // null = seen in more than one unit
      });
      // STALE ROWS ARE NOT CURRENT FACTS.
      //
      // The sync UPSERTS whatever the report returns and never removes what it
      // does not. A lease that falls out of the report — rescheduled,
      // completed, cancelled — keeps its last known values for ever, and they
      // read exactly like today's.
      //
      // The Chateau on 2026-10-15: a "future move-in" dated 2026-11-10 whose
      // row had not been touched since 2026-10-02, while 31 other rows were
      // refreshed that morning. Leasing says the real date is 10/11 — in the
      // past, which is why it is no longer in the report. The projection
      // counted a phantom arrival and reported a data conflict over it.
      //
      // So a row is trusted only if the report still returns it. `in_feed` is
      // written by the sync (migration 100) and is the real answer.
      //
      // THE synced_at COMPARISON IS KEPT AS A FALLBACK, for the window where
      // the column exists nowhere or the sync has not run since it was added.
      // Reading `in_feed` on a table that does not have it yet yields
      // undefined for every row, which under a plain truthiness test would
      // mark the whole table stale and empty the projection — a column that is
      // missing must not look like a column that says no.
      const hasFlag = (rows || []).some(r => r.in_feed === true || r.in_feed === false);
      const newest = (rows || [])
        .map(r => clean(r.synced_at).slice(0, 10)).filter(Boolean).sort().pop() || null;
      const fresh = hasFlag
        ? (rows || []).filter(r => r.in_feed !== false)
        : (rows || []).filter(r => clean(r.synced_at).slice(0, 10) === newest);
      staleLeaseRows = (rows || []).length - fresh.length;
      const isStale = r => (hasFlag ? r.in_feed === false
        : clean(r.synced_at).slice(0, 10) !== newest);
      staleLeaseFutureMoveIns = (rows || []).filter(r =>
        isStale(r)
        && OCC.isYmd(clean(r.move_in_date).slice(0, 10))
        && clean(r.move_in_date).slice(0, 10) >= todayCT).length;

      return fresh
        .map(r => ({
          property: AFP.resolveProperty(r.property_name),
          date: clean(r.move_in_date).slice(0, 10),
          unit: unitByTenant[clean(r.tenant_name).toLowerCase()] || null,
        }))
        .filter(r => r.property && OCC.isYmd(r.date) && r.date >= todayCT);
    } catch (e) { return null; }
  })();

  // SIGNED LEASES WITH NO DATE WE CAN READ.
  //
  // `preleased` is the "Signed, not moved in" figure already in the email.
  // Whatever part of it has no future dated lease behind it is a signature
  // without a date — and dropping those would make the projection end lower
  // than the count printed above it, in the same message. They are placed in
  // the first week, the earliest they could happen, and the brief says how
  // many were placed that way rather than letting them arrive silently.
  const undatedMoveInsBy = {};
  if (datedMoveIns) {
    properties.forEach(p => {
      const signed = Number(p.preleased);
      if (!isFinite(signed) || signed <= 0) return;
      const dated = datedMoveIns.filter(r =>
        clean(r.property).toLowerCase() === clean(p.name).toLowerCase()).length;
      const gap = signed - dated;
      if (gap > 0) undatedMoveInsBy[p.name] = gap;
    });
  }

  const occupancy = OCC.project({
    todayCT,
    properties: properties.map(p => ({ name: p.name, units: p.units, occupied: p.occupied })),
    moveOuts: datedMoveOuts,
    moveIns: datedMoveIns,
    undatedMoveInsBy,
    portfolioMap,
    staleLeaseRows,
    staleLeaseFutureMoveIns,
  });

  // ---- (d) Final Account Statements, through the deposit ------------------
  //
  // PREVIEW ONLY FOR NOW. d.fas is set by scripts/kara-brief-preview.js and by
  // nothing else: the 06:00 cron does not pass it, so the email that actually
  // goes out still carries the NOT MEASURABLE note until Arturo has read a
  // preview and said otherwise. A section that starts appearing in a live
  // email because a flag defaulted the other way is how a half-checked number
  // reaches an owner.
  //
  // Its own try/catch: deposit_held is new, and a table that is not there yet
  // must cost this section and not the brief.
  let fas = null;
  if (d.fas) {
    try { fas = await gatherFas(d.db, todayCT, d.fasDeadline, d.fasDeadlineUnconfirmed, d.selectAll); }
    catch (e) { fas = { measurable: false, error: e.message }; }
  }

  return {
    properties, portfolio, thresholds, collections, calls, occupancy, fas,
    moveOuts: {
      today: MOVEOUT.moveOutsOn(turns, todayCT),
      walkOverdue: MOVEOUT.walkOverdue({ turns, inspections }, todayCT, { businessDays: 2 }),
      // No inspections at all is not "every walk is done". A section that goes
      // quiet because its source is empty is the most expensive kind of quiet.
      sourceEmpty: !inspections.length,
    },
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
