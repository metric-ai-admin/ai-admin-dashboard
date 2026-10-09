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
    const [occupancy, leads, showings, applications, leaseHistory, workOrders] = await Promise.all([
      grab('leasing_occupancy', 'property_name,total_units,occupied_units,vacant_rented,notice_units,as_of'),
      grab('leasing_leads', 'property,interest_received'),
      grab('leasing_showings', 'property_name,showing_date,status'),
      grab('leasing_applications', 'property_name,application_date,status,detailed_status'),
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
    const delinquency = await store('delinquency_kpi');

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

    const out = {};
    real.forEach(p => {
      out[p] = kpiReport.sectionsFor(byProperty[p], {
        workbook: workbook[p] || {}, overrides: overrides[p] || {},
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
        workbook: workbook[g] || kpiReport.rollUp(members.map(m => workbook[m]), ['mtdIncome', 'mtdExpenses', 'laborBilled', 'laborUnbilled', 'followUps']) || {},
        overrides: overrides[g] || {},
      });
      out[g].__members = members;
    });

    const portfolio = kpiReport.sectionsFor(
      kpiReport.rollUp(real.map(p => byProperty[p]), kpiReport.CARD_METRICS.concat(['units'])) || {},
      { workbook: workbook.Portfolio || {}, overrides: overrides.Portfolio || {} });

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
      notes,
      editableFields: KPI_EDITABLE_FIELDS,
      noteFields: KPI_NOTE_FIELDS,
    };
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
    const map = {
      mtd_cash: 'mtdIncome',
      mtd_accrual: 'mtdExpenses',
      occupancy_goals: 'followUps',
    }[r.sheet];
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


module.exports = { buildKpiReport, KPI_EDITABLE_FIELDS, KPI_NOTE_FIELDS };
