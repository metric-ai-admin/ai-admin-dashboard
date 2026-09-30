// What a week is, for the whole dashboard. One definition, one file.
//
// WHY THIS EXISTS. The leasing week has moved three times — Mon–Sun, Sun–Sat on
// a mistaken claim about AppFolio, Mon–Sun again (migration 056), and Sun–Sat
// now by Lyndsay's decision (064). Each move meant finding the same rule written
// out by hand in server.js, in public/app.js and in the Goal Board, and each
// time one of them was missed for a while: the server bucketed a day into one
// week and the client into another, so the Roll-Up jumped to a week nobody had
// synced.
//
// An inventory on 2026-09-29 found the same arithmetic spelled out in ten more
// places — Tasks, Call Analyzer, the 6PM Report, Regional Performance, triage,
// auto-move, SimpleVOIP, the Command Center — each with its own copy of
// `(getDay() + 6) % 7`. This module is where that arithmetic lives now, and
// test/week-module.test.js fails the build if a copy comes back.
//
// TWO CONVENTIONS, NAMED. The dashboard is mid-migration: leasing is Sun–Sat,
// everything else is still Mon–Sun. Rather than hide that behind one "week",
// both are named and every call site says which it means. DASHBOARD is the alias
// the non-leasing surfaces use, and flipping it is the whole of Phase 3.
//
// PURE. No Date.now() anywhere: "now" is always a parameter. Dates in and out
// are YYYY-MM-DD strings, because a Date carries a time and a zone that this
// problem does not have — "the week of the 24th" is the same week whether you
// ask at 9am in Austin or midnight in UTC. Callers that hold Date objects
// convert at the edge.
//
// LOADS BOTH WAYS. require() on the server, <script> in the browser. The
// browser copy is the same file, served at /lib/week.js — not a copy that can
// drift, which is the failure this module is named after.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetricWeek = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // firstDay is the JS day number the week opens on: 0 = Sunday, 6 = Saturday,
  // matching both Date#getDay() and Postgres's extract(dow).
  var SUN_SAT = { firstDay: 0, name: 'Sun–Sat' };
  var MON_SUN = { firstDay: 1, name: 'Mon–Sun' };

  // The convention every surface uses unless it asks for another by name.
  //
  // PHASE 3 WAS THIS LINE, flipped 2026-09-30 by Lyndsay's decision. Tasks, the
  // 6PM Report, the Call Analyzer, SimpleVOIP, Regional Performance, the
  // auto-move counter, the EOD's BD CRM section and the Command Center all
  // moved together — which is what Phase 2 was for.
  //
  // Three things deliberately do NOT follow it, and each asks for its
  // convention by name so an edit here cannot move them:
  //   * leasing — SUN_SAT, with Supabase rows keyed on its Saturday
  //   * the Monday Morning Brief — MON_SUN; a Monday brief opening on Sunday
  //     is a product decision, not a consequence of this
  //   * the WO schedule calendar — MON_SUN; it is a grid, the one change a
  //     user sees as the page redrawing, and it moves when Erick has been told
  //
  var DASHBOARD = SUN_SAT;

  var YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

  // A YYYY-MM-DD string as a UTC Date, or null if it is not a real date.
  // The round-trip check is what rejects '2026-13-45', which Date would
  // otherwise roll forward into 2027 without complaint.
  function ymdToUTC(ymd) {
    var m = YMD.exec(String(ymd || ''));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toISOString().slice(0, 10) === ymd ? d : null;
  }

  function utcToYMD(d) { return d.toISOString().slice(0, 10); }

  // Day of week for a YMD string: 0 = Sunday … 6 = Saturday. null if malformed,
  // so a bad input yields nothing rather than a confidently wrong week.
  function dowYMD(ymd) {
    var d = ymdToUTC(ymd);
    return d ? d.getUTCDay() : null;
  }

  // Calendar-day arithmetic. UTC throughout, so adding 7 days across a DST
  // change lands seven calendar days later and not seven days minus an hour.
  function addDaysYMD(ymd, n) {
    var d = ymdToUTC(ymd);
    if (!d) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return utcToYMD(d);
  }

  // The calendar date, in a timezone, of an instant. Accepts a Date or anything
  // Date can parse. 'en-CA' formats as YYYY-MM-DD.
  function toZoneYMD(value, timeZone) {
    try {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return null;
      return d.toLocaleDateString('en-CA', { timeZone: timeZone });
    } catch (e) { return null; }
  }
  function toChicagoYMD(value) { return toZoneYMD(value, 'America/Chicago'); }

  // Midnight Central for a given day, as an ISO instant. The offset is derived
  // from the date itself rather than assumed, so CST and CDT both come out
  // right and the boundary does not drift by an hour twice a year.
  function chicagoStartOfDayISO(ymd) {
    var base = ymdToUTC(ymd);
    if (!base) return null;
    var guess = new Date(base.getTime() + 12 * 3600000);
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', timeZoneName: 'longOffset',
    }).formatToParts(guess);
    var tzName = '';
    for (var i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') tzName = parts[i].value;
    var m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
    var offsetMin = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0)) : -300;
    return new Date(base.getTime() - offsetMin * 60000).toISOString();
  }

  // ---- the week itself ------------------------------------------------------

  // The first day of the week containing `ymd`.
  function weekStartYMD(ymd, convention) {
    var conv = convention || DASHBOARD;
    var dow = dowYMD(ymd);
    if (dow === null) return null;
    return addDaysYMD(ymd, -(((dow - conv.firstDay) + 7) % 7));
  }

  // The last day of that week. Always weekStart + 6, so the two can never
  // describe spans of different lengths.
  function weekEndYMD(ymd, convention) {
    var start = weekStartYMD(ymd, convention);
    return start === null ? null : addDaysYMD(start, 6);
  }

  // { from, to } for the week containing `ymd` — the shape most callers want.
  function weekRange(ymd, convention) {
    var from = weekStartYMD(ymd, convention);
    return from === null ? null : { from: from, to: addDaysYMD(from, 6) };
  }

  // The last week that has actually FINISHED as of `todayYMD`.
  //
  // On the closing day itself this returns the week before, not the one ending
  // today: at 9am Saturday the Sun–Sat week is not over, and a roll-up that
  // counted a partial day would read as a collapse in performance.
  function lastCompleteWeekEnd(todayYMD, convention) {
    var start = weekStartYMD(todayYMD, convention);
    return start === null ? null : addDaysYMD(start, -1);
  }
  function lastCompleteWeekRange(todayYMD, convention) {
    var to = lastCompleteWeekEnd(todayYMD, convention);
    return to === null ? null : { from: addDaysYMD(to, -6), to: to };
  }

  // ---- leasing, by name -----------------------------------------------------
  // Leasing is Sun–Sat and must stay Sun–Sat whatever DASHBOARD says, so it
  // passes the convention explicitly. week_ending in Supabase is this value.

  function leasingWeekEnding(value) {
    var ymd = YMD.test(String(value)) ? String(value) : toChicagoYMD(value);
    return ymd === null ? null : weekEndYMD(ymd, SUN_SAT);
  }
  function leasingLastCompleteWeekEnding(nowValue) {
    var ymd = nowValue === undefined || nowValue === null
      ? toChicagoYMD(new Date())
      : (YMD.test(String(nowValue)) ? String(nowValue) : toChicagoYMD(nowValue));
    return ymd === null ? null : lastCompleteWeekEnd(ymd, SUN_SAT);
  }

  return {
    SUN_SAT: SUN_SAT, MON_SUN: MON_SUN, DASHBOARD: DASHBOARD,
    ymdToUTC: ymdToUTC, dowYMD: dowYMD, addDaysYMD: addDaysYMD,
    toZoneYMD: toZoneYMD, toChicagoYMD: toChicagoYMD,
    chicagoStartOfDayISO: chicagoStartOfDayISO,
    weekStartYMD: weekStartYMD, weekEndYMD: weekEndYMD, weekRange: weekRange,
    lastCompleteWeekEnd: lastCompleteWeekEnd, lastCompleteWeekRange: lastCompleteWeekRange,
    leasingWeekEnding: leasingWeekEnding,
    leasingLastCompleteWeekEnding: leasingLastCompleteWeekEnding,
  };
}));
