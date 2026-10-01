// Lyndsay's Executive KPI metrics, computed from the data the dashboard already
// syncs — the same numbers her HTML gets from the uploaded workbook.
//
// PURE. No database, no network, no dates read from the clock. Rows in, numbers
// out, so every rule below is testable against her report without touching
// AppFolio or Supabase.
//
// WHY THIS EXISTS. Her report and ours have to agree before anything replaces
// anything. The rules here are copied from kpi_dashboard_17.html deliberately,
// including the ones that look arbitrary — they are what she reads every
// Monday, and a "better" definition is a different number.
//
// SEE docs/kpi-dashboard-data-map.md for where each of her sheets comes from.
//
// WHAT IS DELIBERATELY NOT HERE (phase 1 scope): MTD financials, Follow-Ups,
// Traffic Sources.
//
// WHAT CANNOT BE COMPUTED YET, and why it returns null rather than a guess:
//   * vacantRented — her report counts rental applications whose detailed
//     status is "Converting". leasing_applications.status holds the rolled-up
//     value (Approved / Decision Pending / Canceled / New / In Screening) and
//     never "Converting", so the distinction does not exist in our data.
//   * occupancy at an arbitrary as-of date — leasing_occupancy is a snapshot
//     table keyed on property, not a history. It answers "as of its own
//     as_of", and asking it for another date silently returns the wrong day.
//     occupancyFrom() therefore reports the as_of it actually used.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KpiLyndsay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UNAVAILABLE = {
    vacantRented: 'leasing_applications has no "Converting" status — the rolled-up status column cannot express it',
  };

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  // YYYY-MM-DD out of a date, a timestamp or an ISO string, without going
  // through the local timezone — a Date built from "2026-09-26" is UTC
  // midnight, and toLocaleDateString in Central would call it the 25th.
  function ymd(v) {
    if (!v) return null;
    if (v instanceof Date) {
      return v.getUTCFullYear() + '-' + String(v.getUTCMonth() + 1).padStart(2, '0')
        + '-' + String(v.getUTCDate()).padStart(2, '0');
    }
    var s = String(v);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return m[3] + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
    return null;
  }
  var inWeek = function (d, start, end) {
    var k = ymd(d);
    return !!k && k >= start && k <= end;
  };

  // Her report strips the address: "Sunset Palms - 902 Romeria Drive" is
  // "Sunset Palms". Ours mostly stores the bare name already, but a row that
  // arrived with the address attached has to land in the same bucket.
  function canonicalProperty(raw) {
    if (raw === null || raw === undefined) return null;
    var name = String(raw).trim();
    if (!name || name === 'Total') return null;
    var i = name.indexOf(' - ');
    if (i !== -1) name = name.slice(0, i).trim();
    return name || null;
  }

  function bucket(map, prop) {
    var p = canonicalProperty(prop);
    if (!p) return null;
    if (!map[p]) map[p] = {};
    return map[p];
  }

  // ── Occupancy ─────────────────────────────────────────────────────────────
  // occPct = sum(Occupied) / sum(Units). Summed across the rows, NOT an average
  // of per-row percentages — her report rolls unit-type rows up per property
  // and a mean of percentages would weight a 4-unit type like a 200-unit one.
  //
  // vacantUnrented is derived: Units = Occupied + Vacant Rented + Vacant
  // Unrented. Verified against her 09/26 sheet, which totals 398 = 273 + 11 +
  // 114. It is derived rather than stored because leasing_occupancy has no
  // column for it.
  function occupancyFrom(rows) {
    var out = {};
    var asOfSeen = {};
    (rows || []).forEach(function (r) {
      var b = bucket(out, r.property_name || r.property);
      if (!b) return;
      b.units = (b.units || 0) + num(r.total_units);
      b.occupied = (b.occupied || 0) + num(r.occupied_units);
      b.vacantRentedSnapshot = (b.vacantRentedSnapshot || 0) + num(r.vacant_rented);
      b.notices = (b.notices || 0) + num(r.notice_units);
      if (r.as_of) asOfSeen[ymd(r.as_of)] = true;
    });
    Object.keys(out).forEach(function (p) {
      var b = out[p];
      // Preleased = Occupied + Vacant Rented. Not a projection: a unit with a
      // signed lease counts as leased even though nobody lives in it yet.
      b.preleased = b.occupied + b.vacantRentedSnapshot;
      b.vacantUnrented = Math.max(0, b.units - b.occupied - b.vacantRentedSnapshot);
      b.occPct = b.units > 0 ? b.occupied / b.units : 0;
      b.prePct = b.units > 0 ? b.preleased / b.units : 0;
    });
    return { byProperty: out, asOfDates: Object.keys(asOfSeen).filter(Boolean).sort() };
  }

  // ── Leasing funnel ────────────────────────────────────────────────────────
  // Leads: interest_received inside the week. first_contact_date is what the
  // roll-up uses for traffic, but her report's "Leads" comes from the Guest
  // Card INTERESTS sheet, whose range filter is Interest Received.
  function leadsFrom(rows, start, end) {
    var out = {};
    (rows || []).forEach(function (r) {
      if (!inWeek(r.interest_received, start, end)) return;
      var b = bucket(out, r.property);
      if (!b) return;
      b.leads = (b.leads || 0) + 1;
    });
    return out;
  }

  // Tours: Status STARTING WITH "Completed". That takes
  // "Completed (Unconfirmed)" as well as "Completed", and excludes Scheduled,
  // Canceled, Prospect Canceled and No Show. Her rule is indexOf===0, not
  // equality, and the difference is 19 showings in the 09/20–09/26 week.
  function toursFrom(rows, start, end) {
    var out = {};
    (rows || []).forEach(function (r) {
      if (!inWeek(r.showing_date, start, end)) return;
      var b = bucket(out, r.property_name);
      if (!b) return;
      b.showings = (b.showings || 0) + 1;
      if (String(r.status || '').indexOf('Completed') === 0) b.tours = (b.tours || 0) + 1;
    });
    return out;
  }

  // Applications received in the week, split by status.
  //
  // vacantRented is NOT derived here. Her report counts apps whose detailed
  // status is "Converting" — approved and moving toward a move-in that has not
  // happened yet — and our status column cannot express that. Returning
  // "Approved" in its place would look right and be a different population.
  function appsFrom(rows, start, end) {
    var out = {};
    (rows || []).forEach(function (r) {
      if (!inWeek(r.application_date, start, end)) return;
      var b = bucket(out, r.property_name);
      if (!b) return;
      var s = String(r.status || '').trim();
      b.applications = (b.applications || 0) + 1;
      if (s === 'Approved') b.approved = (b.approved || 0) + 1;
      else if (s === 'Canceled' || s === 'Cancelled') b.canceled = (b.canceled || 0) + 1;
      else if (/denied|declined/i.test(s)) b.denied = (b.denied || 0) + 1;
      else b.pending = (b.pending || 0) + 1;
      b.vacantRented = null;
    });
    return out;
  }

  // ── Move-ins / move-outs / renewals ───────────────────────────────────────
  function leaseActivityFrom(rows, start, end) {
    var out = {};
    (rows || []).forEach(function (r) {
      var p = canonicalProperty(r.property_name);
      if (!p) return;
      if (inWeek(r.move_in_date, start, end)) {
        var a = bucket(out, p); a.moveIns = (a.moveIns || 0) + 1;
      }
      if (inWeek(r.move_out_date, start, end)) {
        var b = bucket(out, p); b.moveOuts = (b.moveOuts || 0) + 1;
      }
      // Renewal is a property of the lease, not of the week — counted where it
      // falls so a weekly report can show what renewed in that window.
      if (inWeek(r.move_in_date, start, end) || inWeek(r.move_out_date, start, end)) {
        var c = bucket(out, p);
        if (String(r.renewal) === 'Yes') c.renewals = (c.renewals || 0) + 1;
        else if (String(r.renewal) === 'No') c.didNotRenew = (c.didNotRenew || 0) + 1;
      }
    });
    return out;
  }

  // ── Work orders ───────────────────────────────────────────────────────────
  // "New this week" is created_at_appfolio inside the week. "Open" is a point
  // in time and ignores the week entirely — a work order opened in June and
  // still open on Saturday belongs in the open count.
  var WO_DONE = /^(completed|complete|canceled|cancelled)$/i;
  function workOrdersFrom(rows, start, end) {
    var out = {};
    (rows || []).forEach(function (r) {
      var b = bucket(out, r.property_name || r.property);
      if (!b) return;
      var status = String(r.status || '').trim();
      if (inWeek(r.created_at_appfolio, start, end)) b.newWos = (b.newWos || 0) + 1;
      if (!WO_DONE.test(status)) b.openWos = (b.openWos || 0) + 1;
      if (/^complet/i.test(status) && inWeek(r.updated_at || r.synced_at, start, end)) {
        b.closedThisWeek = (b.closedThisWeek || 0) + 1;
      }
    });
    return out;
  }

  // ── Assembly ──────────────────────────────────────────────────────────────
  // One row per property, every metric present, missing ones explicitly null
  // rather than zero — a zero is a measurement and a null is an admission.
  var METRICS = ['units', 'occupied', 'preleased', 'vacantRented', 'vacantUnrented',
    'notices', 'occPct', 'prePct', 'leads', 'showings', 'tours', 'applications',
    'approved', 'denied', 'canceled', 'pending', 'moveIns', 'moveOuts',
    'renewals', 'didNotRenew', 'newWos', 'openWos', 'closedThisWeek'];

  function build(sources, opts) {
    var o = opts || {};
    var start = o.weekStart, end = o.weekEnd;
    if (!start || !end) throw new Error('weekStart and weekEnd (YYYY-MM-DD) are required');

    var occ = occupancyFrom(sources.occupancy);
    var parts = [
      occ.byProperty,
      leadsFrom(sources.leads, start, end),
      toursFrom(sources.showings, start, end),
      appsFrom(sources.applications, start, end),
      leaseActivityFrom(sources.leaseHistory, start, end),
      workOrdersFrom(sources.workOrders, start, end),
    ];

    var names = {};
    parts.forEach(function (p) { Object.keys(p).forEach(function (k) { names[k] = true; }); });

    var byProperty = {};
    Object.keys(names).sort().forEach(function (p) {
      var row = { property: p };
      METRICS.forEach(function (m) { row[m] = null; });
      parts.forEach(function (part) {
        var src = part[p];
        if (!src) return;
        Object.keys(src).forEach(function (k) {
          if (METRICS.indexOf(k) === -1) return;
          if (src[k] === null) return;                 // keep the null, it means something
          row[k] = (row[k] === null ? 0 : row[k]) + src[k];
        });
      });
      // occPct is a ratio, not a sum — recompute it rather than adding.
      if (occ.byProperty[p]) {
        row.occPct = occ.byProperty[p].occPct;
        row.prePct = occ.byProperty[p].prePct;
      }
      // A property with no move-ins had zero move-ins; that is a measurement.
      // null is reserved for metrics we genuinely cannot compute, so that the
      // two never read the same on a comparison sheet.
      METRICS.forEach(function (m) {
        if (row[m] === null && !UNAVAILABLE[m]) row[m] = 0;
      });
      if (!occ.byProperty[p]) { row.occPct = null; row.prePct = null; }
      byProperty[p] = row;
    });

    // Portfolio: sums for counts, recomputed ratio for percentages.
    var total = { property: 'Portfolio' };
    METRICS.forEach(function (m) { total[m] = null; });
    Object.keys(byProperty).forEach(function (p) {
      METRICS.forEach(function (m) {
        if (m === 'occPct' || m === 'prePct') return;
        var v = byProperty[p][m];
        if (v === null) return;
        total[m] = (total[m] === null ? 0 : total[m]) + v;
      });
    });
    total.occPct = total.units ? total.occupied / total.units : null;
    total.prePct = total.units ? total.preleased / total.units : null;

    return {
      week: { start: start, end: end, asOf: o.asOf || end },
      occupancyAsOf: occ.asOfDates,
      byProperty: byProperty,
      portfolio: total,
      metrics: METRICS,
      unavailable: UNAVAILABLE,
    };
  }

  return {
    build: build,
    occupancyFrom: occupancyFrom,
    leadsFrom: leadsFrom,
    toursFrom: toursFrom,
    appsFrom: appsFrom,
    leaseActivityFrom: leaseActivityFrom,
    workOrdersFrom: workOrdersFrom,
    canonicalProperty: canonicalProperty,
    ymd: ymd,
    METRICS: METRICS,
    UNAVAILABLE: UNAVAILABLE,
  };
}));
