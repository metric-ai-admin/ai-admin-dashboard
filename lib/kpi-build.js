// Assembling the weekly KPI report.
//
// A module, not a closure inside server.js, so the comparison that validates
// this report can run the SAME function the route runs. A script that
// reimplemented the assembly would be comparing itself.
//
// Takes a Supabase client and the week; returns the report. No express, no
// request object — the two callers that need those wrap this.
const WEEK = require('./week.js');
const KPI = require('./kpi-lyndsay.js');
const kpiReport = require('./kpi-report.js');
const EB = require('./excluded-buildings.js');
const EV = require('./evictions.js');
const CF = require('./custom-fields.js');
const AFP = require('./appfolio-properties.js');

// How stale a saved report may be before the report re-pulls it. Six hours
// keeps Monday morning's export off Sunday evening's figures without making
// every page load an AppFolio call.
const DEFAULT_MAX_AGE_HOURS = 6;

// The name key both sides of the eviction join use: lowercase, punctuation
// out, single-letter words dropped so "Castilla, Dulce P." and "Castilla,
// Dulce" are one person. Deliberately the same rule as kpi-compare's, because
// the two have to agree about who is delinquent.
const normName = s => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b[a-z]\b/g, '').replace(/\s+/g, ' ').trim();

// WHICH NUMBERS BEKAH AND KARA MAY ADJUST (Kara, 2026-10-09: "the values in
// the Property Summary, traffic especially").
//
// It is the card metrics themselves, taken from the report's own definition
// rather than retyped here — a hand-kept second list would start as a copy and
// end as a disagreement, and the one that lost would be this one, silently
// refusing a field the report shows.
//
// An adjustment never erases the calculated figure: cardValue keeps the live
// computed value beside it on every render, so the page shows both and an owner
// can always ask why they differ. That is the whole reason numbers are
// adjustable here instead of in the spreadsheet afterwards.
const KPI_EDITABLE_FIELDS = [...new Set(kpiReport.CARD_METRICS)];

// The free-text fields, which are a different thing and go to a different
// table: these ADD something the report never computed, so there is no
// computed value to keep beside them (083). Kara named the first two; the
// other two were in the migration already.
const KPI_NOTE_FIELDS = ['renewal_comment', 'delinquency_note', 'traffic_adjustment', 'unit_transfer'];

// How current the occupancy figures are, and whether that matters for the week
// being reported.
//
// `as_of` is what the rows say about themselves; `synced_at` is when the sync
// wrote them. They are normally the same day and disagree when a sync is
// re-run. The OLDEST as_of wins: a report is only as current as its stalest
// property, and taking the newest would describe it more kindly than it is.
//
// `staleForWeek` is the one a reader acts on. Occupancy is a point-in-time
// figure, so a report for the week ending Saturday should be built from data
// as of that Saturday or later; anything earlier describes a different day.
// ONLY THE PROPERTIES THIS REPORT COVERS. The sync upserts on property_name
// and never deletes, so a property that leaves the portfolio keeps its last
// row for ever: The Sidney went into cession in September and its 2026-09-16
// row is still there. Counting it made a freshly synced report claim to be 24
// days behind — a false alarm on a panel whose whole job is to tell a date
// problem from a real difference.
function occupancyFreshness(rows, week_ending) {
  const live = (rows || []).filter(r => !kpiReport.isExcluded(r.property_name));
  const days = live.map(r => String(r.as_of || '').slice(0, 10)).filter(Boolean).sort();
  const synced = live.map(r => r.synced_at).filter(Boolean).sort();
  const asOf = days.length ? days[0] : null;
  return {
    source: 'leasing_occupancy',
    as_of: asOf,
    as_of_newest: days.length ? days[days.length - 1] : null,
    synced_at: synced.length ? synced[synced.length - 1] : null,
    week_ending,
    // Null rather than false when there is nothing to judge: "we do not know"
    // and "it is fine" are different answers and only one of them is safe.
    staleForWeek: asOf ? asOf < week_ending : null,
    // AFTER the week counts as a mismatch too, and the sign says which way.
    // Today's data against last Saturday's workbook is a real difference —
    // three units moved in on Sunday and Monday — and a panel that only
    // flagged "behind" would present it as our number being wrong.
    matchesWeek: asOf ? asOf === week_ending : null,
    daysBehind: asOf ? Math.round(
      (Date.parse(week_ending + 'T00:00:00Z') - Date.parse(asOf + 'T00:00:00Z')) / 86400000) : null,
  };
}

async function buildKpiReport(db, opts) {
  opts = opts || {};
    const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const week_ending = isDay(opts.week_ending)
      ? opts.week_ending
      : WEEK.leasingLastCompleteWeekEnding();
    const weekStart = WEEK.addDaysYMD(week_ending, -6);


    // The same six tables scripts/kpi-compare-lyndsay.js reads, in the same
    // shape, so the report and the comparison that validates it cannot drift
    // apart. If they ever disagree it is a bug in one of them, not in which
    // columns were asked for.
    const gaps = [];
    // How old each saved report was when this ran, and whether it was re-pulled.
    const freshness = {};
    // PAGED. .limit(20000) does not raise PostgREST's own ceiling, which is
    // 1000 rows — it only promises not to ask for more. maintenance_work_orders
    // passed 1,000 the moment the closed backfill ran, and the report silently
    // saw two thirds of it: closedThisWeek read 61 against her 76 with every
    // missing row sitting in the table. A cap that returns a plausible number
    // is the worst kind.
    const PAGE = 1000;
    const grab = async (t, cols) => {
      let all = [], error = null;
      for (let from = 0; from < 50000; from += PAGE) {
        const r = await db.from(t).select(cols).range(from, from + PAGE - 1);
        if (r.error) { error = r.error; break; }
        all = all.concat(r.data || []);
        if (!r.data || r.data.length < PAGE) break;
      }
      const data = all;
      // An unreadable table yields an empty array and a named gap rather than
      // a 500 — a missing source should cost its own metrics, not the report.
      if (error) { gaps.push(t + ': ' + error.message); return []; }
      return data || [];
    };
    // The same read, with one column that may not exist yet. Asked for with
    // it, retried without, and the absence is REPORTED rather than guessed at:
    // appsFrom tells "there is no column" from "the column is null" and the
    // two mean different things to her rule.
    //
    // A select naming a column that is not there fails the whole read, and
    // losing every application metric to gain one column is the wrong trade.
    const grabOptional = async (t, cols, maybe) => {
      const probe = await db.from(t).select(maybe).limit(1);
      if (!probe.error) return grab(t, cols + ',' + maybe);
      if (!new RegExp(maybe).test(probe.error.message || '')) return grab(t, cols);
      gaps.push(t + ': no ' + maybe + ' column yet — run supabase/migrations/087_application_lease_start.sql');
      return grab(t, cols);
    };

    const [occupancy, leads, showings, applications, leaseHistory, workOrders] = await Promise.all([
      grab('leasing_occupancy', 'property_name,total_units,occupied_units,vacant_rented,notice_units,as_of,synced_at'),
      grab('leasing_leads', 'property,interest_received'),
      grab('leasing_showings', 'property_name,showing_date,status'),
      // lease_start_date is asked for ONLY when it exists. A select naming a
      // column that is not there fails the whole read, and losing every
      // application metric to gain one column is the wrong trade; grab()
      // reports the gap and appsFrom falls back on its own.
      grabOptional('leasing_applications', 'property_name,application_date,status,detailed_status', 'lease_start_date'),
      grab('leasing_lease_history', 'property_name,move_in_date,move_out_date,renewal'),
      // completed_on and work_order_type are REQUIRED by workOrdersFrom and
      // were not being asked for. Without completed_on it dates the closure
      // from updated_at — the exact mistake migration 076 was added to fix —
      // and without work_order_type the Unit Turn exclusion silently never
      // fires, because IS_UNIT_TURN.test(undefined) is false. The Highlander
      // read 19 closed against her 9 on both counts at once.
      grab('maintenance_work_orders',
        'property_name,status,work_order_type,created_at_appfolio,completed_on,updated_at'),
    ]);
    // Move-outs come from unit_turn_detail, which lives in the saved-report
    // store rather than in Supabase.
    // readReportData returns NULL for a store that is not there — it does not
    // throw. The try/catch alone therefore caught nothing, and an absent store
    // became an empty array and a metric of 0: move-outs and DQ Total both read
    // zero on a machine without the Render disk, which is the exact failure
    // `gaps` exists to prevent. An empty store is reported too.
    const store = async id => {
      try {
        const d = await require('../appfolio-reports.js').readReportData(id);
        const rows = (d && d.rows) || [];
        if (!rows.length) gaps.push(id + (d ? ': store is empty' : ': no store on this machine'));
        return rows;
      } catch (e) { gaps.push(id + ': ' + e.message); return []; }
    };
    // Leads, counted HER way.
    //
    // `leads` off leasing_leads gives 79 for 2026-09-27..10-03; her report says
    // 105. The difference is the grain: hers counts INTERESTS (one guest card
    // can register interest in several properties), deduplicated per property
    // on phone/email/name, with the two iConics collapsed into one namespace.
    // That is what migration 080 re-keyed leasing_lead_interests for, and the
    // report was still reading the old table — found by the first run of
    // scripts/kpi-compare-report.js, which is what the comparison is for.
    const interests = await grab('leasing_lead_interests', 'property,interest_received,guest_card_uuid');
    const cardRows = await grab('leasing_leads', 'guest_card_uuid,name,email,phone');
    const leadCards = {};
    cardRows.forEach(c => { if (c.guest_card_uuid) leadCards[String(c.guest_card_uuid).trim()] = c; });

    const unitTurns = await store('unit_turn_detail');
    // DELINQUENCY, REFRESHED IF IT HAS GONE COLD.
    //
    // The store is written by a cron at 17:45 and read here whenever somebody
    // opens the report or runs an export. Monday's export at 9am therefore
    // read Sunday evening's figures, and the comparison against Katie's file —
    // pulled that morning — showed the difference as a disagreement about
    // money. `refreshIfStale` re-pulls when the store is older than the
    // threshold and leaves it alone otherwise, so a reader opening the report
    // twice in an hour does not spend two AppFolio calls on it.
    const delinquency = await refreshIfStale('delinquency_kpi', opts.maxAgeHours);
    const evictionRows = await refreshIfStale('occupancy_custom_fields', opts.maxAgeHours);

    // Read a saved report, re-pulling it first when it is older than
    // `hours`. A failed refresh is NOT fatal: the stale copy is better than no
    // copy, and the age is reported either way so a reader can see what they
    // are looking at.
    async function refreshIfStale(id, hours) {
      const maxAge = (hours === undefined || hours === null ? DEFAULT_MAX_AGE_HOURS : Number(hours));
      const af = require('../appfolio-reports.js');
      let data = null;
      try { data = await af.readReportData(id); } catch (e) { /* handled below */ }
      const fetchedAt = data && data.fetchedAt ? Date.parse(data.fetchedAt) : NaN;
      const ageHours = isFinite(fetchedAt) ? (Date.now() - fetchedAt) / 3600000 : Infinity;
      if (maxAge > 0 && ageHours > maxAge) {
        try {
          const r = await af.syncReport(id);
          if (r && r.ok) {
            data = await af.readReportData(id);
            freshness[id] = { refreshed: true, wasHours: isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null };
          } else {
            gaps.push(id + ': refresh failed (' + ((r && r.error) || 'unknown') + '); using the copy on disk');
          }
        } catch (e) { gaps.push(id + ': refresh failed (' + e.message + '); using the copy on disk'); }
      }
      const rows = (data && data.rows) || [];
      if (!rows.length) gaps.push(id + (data ? ': store is empty' : ': no store on this machine'));
      if (!freshness[id]) {
        freshness[id] = { refreshed: false, ageHours: isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null };
      }
      return rows;
    }

    const built = KPI.build(
      { occupancy, leads, showings, applications, leaseHistory, workOrders, unitTurns, delinquency,
        leadInterests: interests, leadCards: leadCards },
      { weekStart: weekStart, weekEnd: week_ending, asOf: week_ending });

    // ── Code violations (Kara, 2026-10-09) ───────────────────────────────
    //
    // Open and closed are defined by code-violations.js, not by a second list
    // written here. That module already learned this lesson: The Sidney was
    // dropped everywhere else while its own hand-kept list still named it, and
    // two lists of the same thing drift apart with nothing to say they have.
    //
    // A closure is dated by closed_at, falling back to status_set_at and then
    // verified_at. "Closed this week" with no date at all is NOT counted as
    // this week's — an undated closure landing in whichever week happens to be
    // on screen would inflate exactly the number Kara asked for to see work
    // being finished.
    // The same object `byProperty` below names; the violations are merged into
    // the per-property rows BEFORE the groups roll up, so Greystone and Round
    // Rock sum them with everything else instead of needing their own case.
    const byPropertyPre = built.byProperty || {};

    // ── Evictions, from Occupancy Custom Fields ──────────────────────────
    //
    // This OVERWRITES what the delinquency feed produced, and that is the
    // point: delinquency_as_of returns the eviction columns blank, so its
    // evictionsInProcess counted only tenant_status = Evict and its
    // needToFile could never be anything but zero. This report carries the
    // stage, which is where Katie's 34 and 13 come from.
    //
    // HER RULE COUNTS ONLY RESIDENTS WHO ARE ALSO DELINQUENT. Without that
    // restriction every resident with a stage counts, which is a larger and
    // different population — 120 against her 34 on the 2026-10-12 export.
    // The delinquent set is taken from the same store the dqTotal came from,
    // so the two halves of the Delinquency section agree with each other.
    const evictionMode = EV.mode(opts.evictionMode || process.env.KPI_EVICTION_MODE);
    const delinquentNames = {};
    (delinquency || []).forEach(r => {
      const p = AFP.resolveProperty(r.property_name || r.property);
      const n = EV.clean(r.name || r.payer_name || r.tenant);
      if (!p || !n) return;
      if (!delinquentNames[p]) delinquentNames[p] = new Set();
      delinquentNames[p].add(normName(n));
    });
    // FLATTENED FIRST. occupancy_custom_fields returns five columns and
    // everything Katie's tab shows as its own — Eviction Status, JP Court
    // Date, Cause — lives nested inside `custom_fields`. "Eviction Status"
    // was never a key, it was a value inside a value, which is why looking
    // for it among the keys found nothing twice over.
    //
    // Done on READ rather than in the sync: the store already holds the data
    // and re-syncing 827 rows to change their shape would cost an AppFolio
    // call to fix a parsing decision. The original columns win on a clash, so
    // a custom field called property_id cannot rename the real one.
    const evictionFlat = CF.flattenAll(evictionRows);
    const evictions = EV.countFrom(evictionFlat, {
      mode: evictionMode,
      // NOTHING IS PINNED HERE. The stage, the resident and the PROPERTY
      // columns are all detected by normalised name, because these are custom
      // fields and the report returns them under their human labels —
      // "Eviction Status", "Property ID". Pinning `eviction_status` was the
      // whole bug, and pinning `property_id` would have been the next one.
      // countFrom reports which key it found for each.
      resolveValue: v => AFP.resolveProperty(v),
      isDelinquent: (n, p) => {
        const set = delinquentNames[p];
        return !!set && set.has(normName(n));
      },
    });
    // WHY, when the answer is zero. A bare 0 reads as "nobody is being
    // evicted", which is the one interpretation that needs no action — and it
    // was wrong four different ways while this was being built.
    const evictionWhy = EV.diagnose(evictions.__stats);
    if (evictionWhy) gaps.push('evictions: ' + evictionWhy);
    Object.keys(byPropertyPre).forEach(p => {
      const e = evictions[p];
      // ZERO, not null, for a property with nobody in eviction — the report
      // read the source and the answer is none. A property the source could
      // not be read for keeps whatever it had, and `gaps` already says so.
      if (evictionRows.length) {
        byPropertyPre[p].evictionsInProcess = e ? e.evictionsInProcess : 0;
        byPropertyPre[p].needToFile = e ? e.needToFile : 0;
        byPropertyPre[p].evictionsEho = e ? e.evictionsEho : 0;
      }
    });

    const CV = require('../code-violations.js');
    const cvRows = await grab('code_violations',
      'property_name,status,closed_at,status_set_at,verified_at,due_date');
    const cvDate = r => String(r.closed_at || r.status_set_at || r.verified_at || '').slice(0, 10) || null;
    const cvBlank = () => ({ cvOpen: 0, cvClosedThisWeek: 0, cvClosedTotal: 0, cvPastDue: 0 });
    const cvByProperty = {};
    // Every property the report covers gets a zero rather than no value: a
    // property with no violations is a fact, and "—" would read as "not known".
    Object.keys(byPropertyPre).forEach(p => { cvByProperty[p] = cvBlank(); });
    cvRows.forEach(r => {
      const p = String(r.property_name || '').trim();
      if (!p) return;
      if (!cvByProperty[p]) cvByProperty[p] = cvBlank();
      const b = cvByProperty[p];
      const open = CV.OPEN_STATUSES.includes(String(r.status || '').trim());
      if (open) {
        b.cvOpen++;
        if (CV.pastDeadline(r, week_ending)) b.cvPastDue++;
      } else {
        b.cvClosedTotal++;
        const d = cvDate(r);
        if (d && d >= weekStart && d <= week_ending) b.cvClosedThisWeek++;
      }
    });
    Object.keys(cvByProperty).forEach(p => {
      if (byPropertyPre[p]) Object.assign(byPropertyPre[p], cvByProperty[p]);
    });

    // ── Rentable occupancy, where a building cannot be leased ────────────
    //
    // Windy Hill's building 3 has no certificate of occupancy (Kara,
    // 2026-10-12), so counting its units as vacancy makes a property that is
    // not allowed to rent them look like one failing to.
    //
    // ADDITIONAL, NEVER INSTEAD. This does not touch a single card: the
    // property's occupancy and the portfolio's stay exactly what Lyndsay's
    // report says, because that is what owners read. It rides alongside, and
    // the page shows it as an extra line under Occupancy.
    //
    // Needs UNIT-LEVEL data, which leasing_occupancy does not have — it is one
    // aggregate row per property. rent_roll does, and lives in the saved-report
    // store, so on a machine without that store this is simply absent and the
    // total stands alone. A named gap, not a zero.
    const rentable = {};
    const rentableAlerts = [];
    if (EB.RULES.length) {
      const rr = await store('rent_roll');
      if (rr.length) {
        [...new Set(EB.RULES.map(r => r.property))].forEach(p => {
          const rows = rr.filter(r => EB.clean(r.property_name).toLowerCase() === p.toLowerCase());
          const res = EB.rentable(p, rows);
          if (!res) { gaps.push('rentable occupancy for ' + p + ': no rent-roll rows'); return; }
          rentable[p] = res;
          EB.alerts(res).forEach(a => rentableAlerts.push(Object.assign({ property: p }, a)));
        });
      }
    }

    // What is still only in Katie's Excel, what a person adjusted, and what a
    // person wrote.
    const [wbRes, ovRes, noteRes] = await Promise.all([
      db.from('kpi_workbook_data').select('*').eq('week_ending', week_ending),
      db.from('kpi_manual_overrides').select('*').eq('week_ending', week_ending),
      db.from('kpi_field_notes').select('*').eq('week_ending', week_ending),
    ]);
    // Notes, grouped {property: {field: [row, …]}}. A LIST per field, not one
    // row: they are keyed per subject (a resident, a unit), so a property can
    // carry several delinquency notes in a week and flattening them to one
    // would silently drop all but the last — the failure 083 is keyed to avoid.
    const notes = {};
    (noteRes.error ? [] : (noteRes.data || [])).forEach(r => {
      if (!notes[r.property]) notes[r.property] = {};
      if (!notes[r.property][r.field]) notes[r.property][r.field] = [];
      notes[r.property][r.field].push({
        subject: r.subject || '', body: r.body || '',
        updated_by: r.updated_by, updated_at: r.updated_at,
      });
    });
    // A missing kpi_field_notes table costs the notes and nothing else.
    if (noteRes.error) gaps.push('kpi_field_notes: ' + noteRes.error.message);
    // A missing table is not a failure: the report is useful without either,
    // and saying "needs the workbook" beats a 500 on a Monday morning.
    const workbook = kpiWorkbookByProperty(wbRes.error ? [] : (wbRes.data || []));
    const overrides = {};
    (ovRes.error ? [] : (ovRes.data || [])).forEach(r => {
      if (!overrides[r.property]) overrides[r.property] = {};
      overrides[r.property][r.field] = r;
    });

    // Real properties, minus the three that are not ours to report on.
    const byProperty = built.byProperty || {};
    const real = Object.keys(byProperty).filter(p => !kpiReport.isExcluded(p));

    // THE FOLLOW-UPS GOAL, from kpi_dashboard_17.html lines 1977-1991.
    //
    //   target    = ceil(units x occupancy goal)
    //   needed    = max(0, target - preleased)          preleased = occupied + vacant rented
    //   leads     = needed / (0.25 x 0.75 x 0.75)       lead->tour, tour->app, app->lease
    //   goal      = ceil(leads x 5)
    //
    // It is computed, not read: the goal percentage comes from the workbook
    // and the units and preleased from our own occupancy, so it belongs with
    // the workbook figures (it cannot exist without one) but is derived from
    // both. Written into the workbook map so one card reads it and the group
    // and portfolio columns sum it, which is what her page does — the
    // portfolio is the SUM of the per-property goals, never a goal computed
    // from portfolio totals.
    //
    // A property with no occupancy goal contributes nothing and shows blank.
    // Ascent is that property this week: 111 units, the furthest from any
    // target, and no goal on file — so the number measures everything except
    // the property that most needs measuring. Worth knowing when reading it.
    // A property left out of the goal, and why — said on the row rather than
    // left to whoever remembers. Ascent is 111 units, the furthest from any
    // target, and has no goal in the workbook: without this the portfolio's
    // 677 reads as if it covered everything.
    // Whether a workbook reached us at all, and specifically whether the
    // goals sheet did: a missing sheet and a sheet with no row for this
    // property are different facts and only the second names a property.
    const wbLoaded = (wbRes.error ? [] : (wbRes.data || []))
      .some(r => r.sheet === 'occupancy_goals');
    const goalReasons = {};
    const goalNotes = [];
    const NO_GOAL = 'No occupancy goal in the workbook — Follow Ups Goal not calculated';

    real.forEach(p => {
      const goalFrac = (workbook[p] || {}).occupancyGoal;
      const m = byProperty[p] || {};
      if (goalFrac === null || goalFrac === undefined) {
        // Only when a workbook IS loaded. With no workbook at all every
        // property is missing a goal and the generic reason is the right one;
        // naming eight properties would be noise, not information.
        if (wbLoaded) {
          goalReasons[p] = { followUpsGoal: NO_GOAL };
          goalNotes.push({ property: p, text: NO_GOAL });
        }
        return;
      }
      if (!(m.units > 0)) return;
      const needed = Math.max(0, Math.ceil(m.units * goalFrac) - (m.preleased || 0));
      if (!workbook[p]) workbook[p] = {};
      workbook[p].followUpsGoal = Math.ceil((needed / FOLLOW_UP_CONVERSION) * 5);
      workbook[p].followUpsUnitsNeeded = needed;
    });

    const out = {};
    real.forEach(p => {
      out[p] = kpiReport.sectionsFor(byProperty[p], {
        workbook: workbook[p] || {}, overrides: overrides[p] || {},
        reasons: goalReasons[p] || null,
      });
    });

    // Round Rock and Greystone, summed from their members. Never averaged:
    // occPct and prePct are recomputed from the summed numerator and
    // denominator inside rollUp.
    const groups = [kpiReport.ROUND_ROCK.name].concat(Object.keys(kpiReport.VIRTUAL_GROUPS));
    groups.forEach(g => {
      const members = kpiReport.groupMembers(g, real);
      const rolled = kpiReport.rollUp(members.map(m => byProperty[m]), kpiReport.CARD_METRICS.concat(['units']));
      if (!rolled) return;                       // no member has data this week
      out[g] = kpiReport.sectionsFor(rolled, {
        workbook: workbook[g] || kpiReport.rollUp(members.map(m => workbook[m]), kpiReport.WORKBOOK_ROLLUP_METRICS) || {},
        overrides: overrides[g] || {},
      });
      out[g].__members = members;
    });

    // THE PORTFOLIO'S WORKBOOK FIGURES ARE SUMMED TOO.
    //
    // This read `workbook.Portfolio`, a key kpiWorkbookByProperty never writes
    // — it is keyed by property — so every workbook metric on the Portfolio
    // column has always been blank. The group columns were rolling theirs up
    // all along, which is why nobody noticed: Greystone had a figure and the
    // column beside it did not.
    //
    // Same list as the groups use, so the two cannot drift.
    const portfolio = kpiReport.sectionsFor(
      kpiReport.rollUp(real.map(p => byProperty[p]), kpiReport.CARD_METRICS.concat(['units'])) || {},
      {
        workbook: workbook.Portfolio
          || kpiReport.rollUp(real.map(p => workbook[p]), kpiReport.WORKBOOK_ROLLUP_METRICS)
          || {},
        overrides: overrides.Portfolio || {},
      });

    return {
      week_ending,
      range: { from: weekStart, to: week_ending },
      // Said out loud: a reader should not have to work out whether this is the
      // week they meant.
      defaulted: !isDay(opts.week_ending),
      columns: kpiReport.columnOrder(real),
      portfolio,
      properties: out,
      excluded: kpiReport.EXCLUDED_PROPERTIES,
      workbook: kpiWorkbookStatus(wbRes.error ? [] : (wbRes.data || [])),
      // Named, not swallowed. A source that could not be read makes its own
      // metrics unavailable, and the page must be able to say which.
      gaps: gaps,
      // How old each saved report was, and whether this run re-pulled it.
      sourceFreshness: freshness,
      // Which eviction rule produced the figures above, named on the report
      // rather than left to whoever remembers the setting.
      evictionMode,
      evictionModes: EV.MODES,
      // The tally behind the eviction figures: rows seen, which column the
      // stage was read from, and what happened to the ones that did not count.
      evictionStats: evictions.__stats || null,
      // Properties held out of the report because nobody has confirmed what
      // they are. A note, not an absence.
      unconfirmed: kpiReport.UNCONFIRMED,
      // Rentable occupancy where a building cannot be leased, and anything
      // about it that needs saying out loud. Keyed by property; absent for
      // every property with no rule, which is all of them but one.
      rentable,
      rentableAlerts,
      // WHAT DAY OUR OCCUPANCY IS ACTUALLY FROM.
      //
      // leasing_occupancy is a snapshot the sync overwrites, so its as_of is
      // whatever day the sync last ran — which until 2026-10-12 was a button
      // nobody had pressed since 10/02. Every occupancy figure in this report
      // was ten days old and nothing said so, and against Katie's workbook
      // that reads as a disagreement rather than as two different days.
      //
      // Carried on the report so the comparison can print it beside hers. A
      // date is not a disclaimer: it is the first thing to check when two
      // numbers differ, and it costs nothing to show.
      freshness: occupancyFreshness(occupancy, week_ending),
      notes,
      // WHERE THE WORKBOOK'S GOAL AND THE DASHBOARD'S DISAGREE.
      //
      // The Occupancy Goal row shows the WORKBOOK's figure, because that is
      // the number on the report Katie sends today. The dashboard keeps its
      // own table (lib/leasing-goals.js, matching the Goal Board's
      // GOAL_OVERRIDE) and that is what decides whether a property shows red
      // in Kara's brief.
      //
      // Two screens quietly disagreeing about whether a property is hitting
      // its target is worse than either number being wrong, so every
      // difference is listed — not only Windy Hill, which is the one somebody
      // happened to notice. Nothing is reconciled here: which table is right
      // is Kara's to say.
      goalDiffs: occupancyGoalDiffs(workbook),
      // Properties with no occupancy goal, so the Follow Ups Goal total is
      // never read as covering them.
      goalNotes,
      editableFields: KPI_EDITABLE_FIELDS,
      noteFields: KPI_NOTE_FIELDS,
    };
}

// Lead -> Tour 25%, Tour -> Application 75%, Application -> Lease 75%. The last
// one appears nowhere else on the dashboard; it is what turns a unit gap into a
// lead count. Named rather than written inline three times.
const FOLLOW_UP_CONVERSION = 0.25 * 0.75 * 0.75;

// The workbook's occupancy goal against the dashboard's, per property.
//
// Both as percentages, which is how both are written down and how anybody
// comparing them would say them out loud.
const LEASING_GOALS = require('./leasing-goals.js');
function occupancyGoalDiffs(workbook) {
  const out = [];
  Object.keys(workbook || {}).forEach(prop => {
    const wb = (workbook[prop] || {}).occupancyGoal;
    if (wb === null || wb === undefined) return;
    const theirs = Math.round(wb * 1000) / 10;
    const ours = LEASING_GOALS.leasingGoalPct(prop);
    // A tenth of a point of slack: 0.9 and 90 are the same goal written twice.
    if (Math.abs(theirs - ours) < 0.05) return;
    out.push({ property: prop, workbook: theirs, dashboard: ours });
  });
  return out.sort((a, b) => a.property.localeCompare(b.property));
}

// The workbook rows, reshaped to {property: {metric: value}}.
function kpiWorkbookByProperty(rows) {
  const out = {};
  const put = (prop, key, value) => {
    if (!prop) return;
    if (!out[prop]) out[prop] = {};
    out[prop][key] = value;
  };
  rows.forEach(r => {
    const d = r.data || {};
    // occupancy_goals USED TO LAND ON followUps. An occupancy goal of 0.9 was
    // being reported as "Follow Ups Completed: 0.9" — a number owners read,
    // taken from a sheet about something else entirely. Found 2026-10-20 while
    // fixing the reader for that same sheet.
    //
    // The goals are kept under their own key. They have no card in
    // kpiReport.SECTIONS, so nothing displays them yet: where an occupancy
    // goal belongs on this report is a decision, not a mapping, and inventing
    // a row for it here would be making that decision in the wrong place.
    //
    // Follow Ups Completed now has no source at all, which is the truth — no
    // sheet in the workbook carries it — and it shows as unavailable rather
    // than as a goal wearing its label.
    const map = {
      mtd_cash: 'mtdIncome',
      mtd_accrual: 'mtdExpenses',
      occupancy_goals: 'occupancyGoal',
    }[r.sheet];
    // Guest card inquiries carries TWO numbers per property, so it does not
    // fit the one-sheet-one-metric map above.
    if (r.sheet === 'guest_card_inquiries') {
      Object.keys(d).forEach(prop => {
        put(prop, 'followUps', (d[prop] || {}).followUps);
        put(prop, 'overdueFollowUps', (d[prop] || {}).overdue);
      });
      return;
    }
    if (!map) return;
    Object.keys(d).forEach(prop => put(prop, map, d[prop]));
  });
  return out;
}

function kpiWorkbookStatus(rows) {
  if (!rows.length) {
    return { loaded: false, sheets: [], note: 'The MTD figures and Occupancy Goals need Katie’s workbook for this week.' };
  }
  return {
    loaded: true,
    sheets: rows.map(r => r.sheet),
    filename: rows[0].filename || null,
    uploaded_by: rows[0].uploaded_by || null,
    uploaded_at: rows[0].uploaded_at || null,
  };
}


module.exports = { buildKpiReport, occupancyFreshness, occupancyGoalDiffs, KPI_EDITABLE_FIELDS, KPI_NOTE_FIELDS };
