// Month-to-date collections, and the comparison Kara asked for.
//
// THE SHAPE OF THE PROBLEM. income_statement filters by property —
// properties: {properties_ids:["1703"]} works, probed 2026-10-16 — and ignores
// every date parameter in every shape tried. So it answers one period of its
// own choosing and cannot be asked about September. The history is ours to
// keep, starting the day the sync runs for the first time.
//
// WHICH MEANS THE ALERT CANNOT EXIST YET, and the honest thing is to say so.
// Comparing the 1st-to-the-14th of this month against the 1st-to-the-14th of
// last month needs last month captured, and we have never captured it. Until
// then the alert reads "not measurable" with the date the history starts —
// never a quiet pass, because a collections alert that stays silent reads as
// "collections are fine" to the person who asked for it.

// THE BASIS IS NOT SETTLED, AND THE LABEL DEPENDS ON IT. Arturo, 2026-10-14:
// the dry run showed income_statement reports BILLED income, not money
// received. Ascent came back at 56,336 against 47,301 of monthly rent while
// carrying 16,118 of delinquency — it cannot have collected more than it bills
// with a sixth of it unpaid — and accounting_basis is ignored like every other
// parameter.
//
// Kara asked about CASH RECEIVED. Until scripts/probe-cash-basis.js finds a
// cash-basis source, this module compares billed income, and calling that
// "collections" in her email would be wrong in a way no reader could catch:
// the number is real, the arithmetic is right, and it answers a different
// question. Either the source changes or the wording does — Arturo's call,
// with Kara. The 04:30 capture is gated off in server.js until then.

'use strict';

const WEEK = require('./week.js');

const clean = s => String(s == null ? '' : s).trim();
const PORTFOLIO = '*';

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : null;
}

// ---- reading the report ----------------------------------------------------
//
// The income statement comes back as account lines. We do not know which column
// holds the account name or the amount — that varies — so both are found by
// shape: the first cell that reads like a name, the first that reads like a
// number.
//
// RENT INCOME IS NAMED, everything else is kept. "Which accounts are cash
// receipts" is a question Kara and Katie have not settled, and a sync that
// stored only today's answer could not be re-asked tomorrow.
const RENT_LINE = /^rent income$/i;
const INCOME_SECTION = /income|revenue|receipt/i;
const TOTAL_LINE = /^total (income|revenue)$/i;

function accountOf(row) {
  const vals = Object.values(row || {});
  const name = vals.find(v => typeof v === 'string' && /[a-z]{3}/i.test(v) && num(v) === null);
  return clean(name);
}

function amountOf(row) {
  const vals = Object.values(row || {});
  for (const v of vals) {
    const n = num(v);
    if (n !== null && String(v).trim() !== '') return n;
  }
  return null;
}

/**
 * One property's capture, from the report's rows.
 *
 * Returns { rentIncome, totalIncome, accounts } — accounts being every line
 * that looks like income, kept whole.
 */
function readStatement(rows) {
  const accounts = {};
  let rentIncome = null;
  let totalIncome = null;

  (rows || []).forEach(r => {
    const name = accountOf(r);
    const amount = amountOf(r);
    if (!name || amount === null) return;
    if (RENT_LINE.test(name)) rentIncome = amount;
    if (TOTAL_LINE.test(name)) totalIncome = amount;
    // Everything in the income section, so the definition can change later.
    if (INCOME_SECTION.test(name) || RENT_LINE.test(name)) accounts[name] = amount;
  });

  return { rentIncome, totalIncome, accounts };
}

// ---- the comparison report's per-property field -----------------------------
//
// income_statement_comparison returns account_name / properties / total, and
// `properties` is meant to hold one figure per property — which would make the
// daily capture ONE call instead of nine.
//
// THE REAL SHAPE, seen on Render 2026-10-14, is keyed by APPFOLIO ID:
//
//   [{"id":1925,"value":"0.00"}, ...]   15 entries
//
// The first version of this did not recognise it and SAID SO, printing the
// entry it could not read — which is the only reason the shape is known. A
// version that had quietly returned {} would have looked exactly like a report
// with no breakdown in it, and the sync would have been built the slow way for
// no reason. The other shapes are kept because nothing says this one is the
// only one the endpoint ever returns.
//
// An id-keyed map is NOT a name-keyed map and callers must not confuse the
// two, so `idKeyed` says which it is and `resolveNames` does the lookup.
function breakdown(value) {
  if (value === null || value === undefined) return { map: {}, how: 'field is absent' };
  if (typeof value === 'string') {
    const n = num(value);
    return n === null
      ? { map: {}, how: 'a string, not a breakdown: ' + JSON.stringify(value).slice(0, 120) }
      : { map: {}, how: 'a single number (' + n + '), not per property' };
  }
  if (Array.isArray(value)) {
    const map = {};
    let idKeyed = false;
    value.forEach(e => {
      if (!e || typeof e !== 'object') return;
      const name = e.name || e.property || e.property_name || e.label;
      const amount = num(e.amount !== undefined ? e.amount
        : (e.value !== undefined ? e.value : e.total));
      if (name) { map[String(name)] = amount; return; }
      // The shape AppFolio actually returns. A zero is a real figure — a
      // property that collected nothing this month — so it is kept, and only
      // an entry with no id at all is passed over.
      if (e.id !== undefined && e.id !== null) {
        map[String(e.id)] = amount;
        idKeyed = true;
      }
    });
    return Object.keys(map).length
      ? {
        map,
        idKeyed,
        how: 'an array of ' + value.length + ' entries, keyed by '
          + (idKeyed ? 'AppFolio property id' : 'name'),
      }
      : {
        map: {},
        how: 'an array of ' + value.length + ' entries in an unrecognised shape: '
          + JSON.stringify(value[0] || null).slice(0, 160),
      };
  }
  if (typeof value === 'object') {
    const map = {};
    Object.entries(value).forEach(([k, v]) => { map[k] = num(v); });
    return { map, how: 'an object with ' + Object.keys(map).length + ' keys' };
  }
  return { map: {}, how: 'type ' + typeof value };
}

/**
 * An id-keyed breakdown, turned into names through the id map we already keep.
 *
 * NOTHING IS DROPPED SILENTLY. An id with no name in the map comes back under
 * `unknown` with its figure, because an id that stops resolving — a property
 * added in AppFolio and not yet in BY_ID — would otherwise vanish from the
 * capture and look like a property that collected nothing.
 *
 * @param {object} b      what breakdown() returned
 * @param {object} byId   { '1703': 'Ascent at Northgate', ... }
 */
function resolveNames(b, byId) {
  const named = {};
  const unknown = {};
  if (!b || !b.map) return { named, unknown };
  Object.entries(b.map).forEach(([key, amount]) => {
    if (!b.idKeyed) { named[key] = amount; return; }
    const name = (byId || {})[key] || (byId || {})[String(Number(key))];
    if (name) named[name] = amount;
    else unknown[key] = amount;
  });
  return { named, unknown };
}

// ---- what period is this ----------------------------------------------------
//
// The report will not say, so this is a CHECK rather than an answer: compare
// the month-to-date figure against the property's monthly rent from the rent
// roll. A full month of rent collected on the 14th would be about 100% of it;
// a tenth of it would mean the report is describing something else entirely.
//
// Reported as a ratio with the reasoning, never as a verdict. "It is probably
// the current month" is a sentence a person should write after seeing this,
// not one the code should assert.
function periodCheck(rentIncome, monthlyRent, todayCT) {
  if (!rentIncome || !monthlyRent) return null;
  const ratio = rentIncome / monthlyRent;
  const day = Number(String(todayCT).slice(8, 10));
  const daysInMonth = new Date(Date.UTC(
    Number(String(todayCT).slice(0, 4)), Number(String(todayCT).slice(5, 7)), 0)).getUTCDate();
  return {
    ratio: Math.round(ratio * 100) / 100,
    dayOfMonth: day,
    monthElapsed: Math.round((day / daysInMonth) * 100) / 100,
    note: ratio > 0.8
      ? 'close to a full month of rent — consistent with the current month, most rent arriving in the first week'
      : (ratio > 0.3
        ? 'between a third and most of a month — consistent with the current month, or with a period that is not a month'
        : 'far below one month of rent — this is probably NOT the current month-to-date'),
  };
}

// ---- the comparison --------------------------------------------------------

const SAME_SLICE = 'the same stretch of the month';

/**
 * This month to date against last month to the SAME DAY.
 *
 * @param {object[]} history  collections_mtd rows: { captured_on, property, rent_income }
 * @param {string} todayCT
 * @returns per property: { property, now, then, delta, pct } or a reason it cannot be said.
 */
function compare(history, todayCT, opts) {
  const o = opts || {};
  const field = o.field || 'rent_income';
  const day = String(todayCT).slice(8, 10);
  const thisMonth = String(todayCT).slice(0, 7);
  const lastMonth = prevMonth(thisMonth);
  // The same day number, last month. The 31st of a 30-day month falls back to
  // the last capture of that month rather than silently comparing nothing.
  const wanted = lastMonth + '-' + day;

  const byProp = new Map();
  (history || []).forEach(r => {
    const p = clean(r.property) || PORTFOLIO;
    if (!byProp.has(p)) byProp.set(p, []);
    byProp.get(p).push(r);
  });

  const rows = [];
  byProp.forEach((all, property) => {
    const now = all.find(r => String(r.captured_on).slice(0, 10) === todayCT);
    const sameSlice = all
      .filter(r => String(r.captured_on).slice(0, 7) === lastMonth
        && String(r.captured_on).slice(0, 10) <= wanted)
      .sort((a, b) => String(b.captured_on).localeCompare(String(a.captured_on)))[0];
    if (!now) return;
    if (!sameSlice) {
      rows.push({ property, now: num(now[field]), then: null, delta: null, pct: null,
        why: 'no capture from ' + lastMonth });
      return;
    }
    const a = num(now[field]);
    const b = num(sameSlice[field]);
    if (a === null || b === null) {
      rows.push({ property, now: a, then: b, delta: null, pct: null, why: 'a figure is missing' });
      return;
    }
    rows.push({
      property, now: a, then: b,
      comparedOn: String(sameSlice.captured_on).slice(0, 10),
      delta: Math.round((a - b) * 100) / 100,
      pct: b ? Math.round(((a - b) / b) * 1000) / 10 : null,
      why: null,
    });
  });

  rows.sort((x, y) => (x.pct ?? 0) - (y.pct ?? 0));
  return rows;
}

function prevMonth(ym) {
  const y = Number(String(ym).slice(0, 4));
  const m = Number(String(ym).slice(5, 7));
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * What the brief should say.
 *
 * NOT MEASURABLE IS A RESULT, and it is the one this returns until a full month
 * has been captured. A collections alert that goes quiet reads as "collections
 * are fine" to the person who asked for it.
 */
function alert(history, todayCT, opts) {
  const o = opts || {};
  const startedOn = (history || [])
    .map(r => String(r.captured_on).slice(0, 10)).sort()[0] || null;
  const thisMonth = String(todayCT).slice(0, 7);
  const lastMonth = prevMonth(thisMonth);
  const haveLastMonth = (history || [])
    .some(r => String(r.captured_on).slice(0, 7) === lastMonth);

  if (!haveLastMonth) {
    // THE EXACT DAY, not just the month. The comparison is this month to date
    // against the SAME STRETCH of last month, so the first answerable date is
    // the earliest captured day-of-month, one month on: with captures starting
    // 2026-10-05, the 1st to the 4th of November have no counterpart and the
    // 5th does. "Possible in November" would have the reader open the email on
    // the 1st and find the same sentence.
    const starts = comparisonStarts(startedOn);
    return {
      measurable: false,
      startedOn,
      comparisonStarts: starts,
      note: startedOn
        // WHAT IS ACTUALLY TRUE, corrected 2026-10-15. An earlier version of
        // this sentence said AppFolio cannot be asked about a past period.
        // It can: posted_on_from/to = "2026-09" returns all of September. What
        // it will not do is a PART of a month — the day components are
        // ignored, so "the 1st to the 15th of September" comes back as the
        // whole month. The comparison Kara asked for is same-stretch against
        // same-stretch, and a part month against a whole one would show every
        // property down. That is why the history has to be ours.
        ? 'Collections vs last month: NOT MEASURABLE — comparison starts ' + starts
          + '. There is no capture from ' + lastMonth + ' to compare against; this '
          + 'history starts ' + startedOn + '. AppFolio can be asked about a whole '
          + 'past month, but not about part of one — the day is ignored — so the '
          + 'same-stretch comparison has to be built from our own daily captures.'
        : 'Collections vs last month: NOT MEASURABLE. Nothing has been captured yet.',
      rows: [],
    };
  }

  // TODAY'S CAPTURE HAS TO EXIST. If the 04:30 sync failed, compare() finds no
  // 'now' row for anybody, returns nothing, and "no property is collecting
  // less" would be a false all-clear built on an empty table — the exact
  // failure this alert was asked to prevent.
  const capturedToday = (history || [])
    .some(r => String(r.captured_on).slice(0, 10) === todayCT);
  if (!capturedToday) {
    return {
      measurable: false,
      startedOn,
      note: 'Collections vs last month: NOT MEASURABLE TODAY. There is no capture '
        + 'from ' + todayCT + ' — the sync did not run or did not finish. Last month '
        + 'is on file, so this is a broken sync and not a missing history.',
      rows: [],
    };
  }

  const rows = compare(history, todayCT, o);
  const down = rows.filter(r => r.delta !== null && r.delta < 0);
  return {
    measurable: true,
    startedOn,
    comparedTo: lastMonth,
    rows,
    down,
    note: down.length
      ? down.length + ' propert' + (down.length === 1 ? 'y is' : 'ies are')
        + ' collecting less than ' + SAME_SLICE + ' last month'
      : 'No property is collecting less than ' + SAME_SLICE + ' last month',
  };
}

// The first date on which the same-stretch comparison can be answered: the
// earliest captured day-of-month, one month after it was captured.
function comparisonStarts(startedOn) {
  if (!startedOn) return null;
  return nextMonth(startedOn) + '-' + String(startedOn).slice(8, 10);
}

function nextMonth(ymd) {
  const y = Number(String(ymd).slice(0, 4));
  const m = Number(String(ymd).slice(5, 7));
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

module.exports = {
  PORTFOLIO, RENT_LINE, SAME_SLICE,
  num, accountOf, amountOf, readStatement, periodCheck,
  compare, alert, prevMonth, nextMonth, comparisonStarts, clean, breakdown, resolveNames,
};
