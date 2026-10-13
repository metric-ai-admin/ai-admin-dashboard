// Kara's 6 AM brief. Pure: given the numbers, decide what is red and lay it out.
//
// She asked for numbers and no graphics — "old school" — so this is plain
// text, aligned, one property per block, red ones first. The server gathers;
// this decides and renders, which is what makes it testable without a mailbox.
//
// THE FIRST LINE IS THE DATA'S AGE, not a greeting. A brief that arrives at
// 6 AM with yesterday's occupancy and says nothing is worse than one that does
// not arrive: she would act on it. If a morning sync failed, that is the first
// thing on the page.

'use strict';

const clean = s => String(s == null ? '' : s).trim();
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// ---- thresholds ------------------------------------------------------------

// What Arturo proposed on 2026-10-13, before Kara has seen one of these. They
// live in brief_thresholds (088) so she can change them without a deploy;
// these are only the fallback for a database that has not been seeded.
const DEFAULTS = { delinquency_over: 5000, make_ready_days: 7, application_days: 3 };

// The thresholds for one property: its own row, falling back to '*', falling
// back to the constants above.
function thresholdsFor(property, rows) {
  const all = rows || [];
  const star = all.find(r => clean(r.property) === '*') || {};
  const mine = all.find(r => clean(r.property).toLowerCase() === clean(property).toLowerCase()) || {};
  const pick = k => (num(mine[k]) !== null ? num(mine[k])
    : (num(star[k]) !== null ? num(star[k]) : DEFAULTS[k]));
  return {
    delinquency_over: pick('delinquency_over'),
    make_ready_days: pick('make_ready_days'),
    application_days: pick('application_days'),
    source: num(mine.delinquency_over) !== null || num(mine.make_ready_days) !== null
      || num(mine.application_days) !== null ? 'property' : (all.length ? 'default' : 'built-in'),
  };
}

// ---- what makes a property red --------------------------------------------
//
// EVERY RED SAYS WHICH THRESHOLD IT BROKE, and by how much. "Windy Hill is
// red" sends somebody looking; "Windy Hill — occupancy 55.6% against a 90%
// goal" sends them somewhere.
function flagsFor(p, t) {
  const out = [];
  const occ = num(p.occupancyPct);
  const goal = num(p.goalPct);
  if (occ !== null && goal !== null && occ < goal) {
    out.push({
      kind: 'occupancy',
      text: 'occupancy ' + pct(occ) + ' against a ' + pct(goal) + ' goal',
    });
  }
  const dq = num(p.delinquency);
  if (dq !== null && t.delinquency_over !== null && dq > t.delinquency_over) {
    out.push({ kind: 'delinquency', text: 'delinquency ' + money(dq) + ' over ' + money(t.delinquency_over) });
  }
  const mr = num(p.makeReadyOldestDays);
  if (mr !== null && t.make_ready_days !== null && mr > t.make_ready_days) {
    out.push({
      kind: 'make_ready',
      text: 'a make-ready open ' + mr + ' days (over ' + t.make_ready_days + ')',
    });
  }
  const ap = num(p.applicationOldestDays);
  if (ap !== null && t.application_days !== null && ap > t.application_days) {
    out.push({
      kind: 'applications',
      text: 'an application pending ' + ap + ' days (over ' + t.application_days + ')',
    });
  }
  return out;
}

// ---- formatting ------------------------------------------------------------

const pct = v => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');
const money = v => (v === null || v === undefined ? '—'
  : '$' + Math.round(v).toLocaleString('en-US'));
const n = v => (v === null || v === undefined ? '—' : String(v));
const pad = (s, w) => String(s).padEnd(w);

// ---- the brief -------------------------------------------------------------

// properties: [{ name, units, occupied, occupancyPct, goalPct, rentableUnits,
//   rentableOccupancyPct, rentableNote, preleased, applicationsPending,
//   applicationOldestDays, makeReadyOpen, makeReadyOldestDays, moveInsExpected,
//   moveOutsExpected, notices, delinquency }]
// freshness: { asOf, lines: [{source, when, ok, note}] }
function build(input) {
  const o = input || {};
  const thresholds = o.thresholds || [];
  const props = (o.properties || []).map(p => {
    const t = thresholdsFor(p.name, thresholds);
    return Object.assign({}, p, { thresholds: t, flags: flagsFor(p, t) });
  });

  // Red first, and within red the one with the most broken thresholds — a
  // property failing three ways is a different morning from one scraping
  // under its occupancy goal.
  const red = props.filter(p => p.flags.length)
    .sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));
  const ok = props.filter(p => !p.flags.length).sort((a, b) => a.name.localeCompare(b.name));

  return { red, ok, properties: red.concat(ok), portfolio: o.portfolio || null, freshness: o.freshness || null };
}

// The freshness block. FIRST, and loud when something is stale or failed.
function freshnessLines(f) {
  const L = [];
  if (!f) {
    L.push('DATA AS OF: not recorded. Treat every number below as unverified.');
    return L;
  }
  const bad = (f.lines || []).filter(x => !x.ok);
  L.push('DATA AS OF: ' + (f.asOf || 'unknown'));
  if (bad.length) {
    L.push('');
    L.push('*** ' + bad.length + ' MORNING SYNC' + (bad.length === 1 ? '' : 'S')
      + ' DID NOT RUN. The numbers below are older than they look. ***');
    bad.forEach(x => L.push('    ' + pad(x.source, 28) + (x.note || 'failed')));
  }
  const good = (f.lines || []).filter(x => x.ok);
  if (good.length) {
    L.push('');
    good.forEach(x => L.push('    ' + pad(x.source, 28) + (x.when || '—')));
  }
  return L;
}

function render(brief, opts) {
  const o = opts || {};
  const L = [];
  L.push('METRIC — MORNING NUMBERS' + (o.testMode ? '   [TEST — not sent to Kara]' : ''));
  L.push('='.repeat(72));
  freshnessLines(brief.freshness).forEach(l => L.push(l));
  L.push('');

  if (brief.red.length) {
    L.push('NEEDS ATTENTION — ' + brief.red.length + ' propert'
      + (brief.red.length === 1 ? 'y' : 'ies'));
    L.push('-'.repeat(72));
    brief.red.forEach(p => { propertyBlock(L, p, true); });
  } else {
    L.push('NEEDS ATTENTION — none. Every property is inside its thresholds.');
    L.push('-'.repeat(72));
    L.push('');
  }

  if (brief.ok.length) {
    L.push('EVERYTHING ELSE');
    L.push('-'.repeat(72));
    brief.ok.forEach(p => { propertyBlock(L, p, false); });
  }

  if (brief.portfolio) {
    L.push('PORTFOLIO TOTAL');
    L.push('-'.repeat(72));
    const p = brief.portfolio;
    L.push('  ' + pad('Occupancy', 26) + n(p.occupied) + '/' + n(p.units) + '   ' + pct(num(p.occupancyPct)));
    L.push('  ' + pad('Signed, not moved in', 26) + n(p.preleased));
    L.push('  ' + pad('Applications pending', 26) + n(p.applicationsPending));
    L.push('  ' + pad('Make-readies open', 26) + n(p.makeReadyOpen));
    L.push('  ' + pad('Move-ins expected', 26) + n(p.moveInsExpected));
    L.push('  ' + pad('Move-outs expected', 26) + n(p.moveOutsExpected));
    L.push('  ' + pad('Notices', 26) + n(p.notices));
    L.push('  ' + pad('Delinquency', 26) + money(num(p.delinquency)));
    L.push('');
  }

  L.push('-'.repeat(72));
  L.push('Thresholds: occupancy below the property goal; delinquency over '
    + money(DEFAULTS.delinquency_over) + '; a make-ready open over '
    + DEFAULTS.make_ready_days + ' days; an application pending over '
    + DEFAULTS.application_days + ' days.');
  L.push('Ask Arturo to change any of these — they are settings, not code.');
  return L.join('\n');
}

function propertyBlock(L, p, isRed) {
  L.push('  ' + p.name);
  if (isRed) p.flags.forEach(f => L.push('    >> ' + f.text));
  L.push('    ' + pad('Occupancy', 24) + n(p.occupied) + '/' + n(p.units)
    + '   ' + pct(num(p.occupancyPct))
    + (num(p.goalPct) !== null ? '   (goal ' + pct(num(p.goalPct)) + ')' : ''));
  // Only where a building cannot be leased. Everywhere else the line would be
  // the same number twice and would teach people to skip it.
  if (num(p.rentableOccupancyPct) !== null) {
    L.push('    ' + pad('Rentable occupancy', 24) + n(p.rentableOccupied) + '/' + n(p.rentableUnits)
      + '   ' + pct(num(p.rentableOccupancyPct))
      + (p.rentableNote ? '   (' + p.rentableNote + ')' : ''));
  }
  // "Signed, not moved in", NOT "Preleased".
  //
  // The KPI report's Preleased is occupied + vacant-rented — 42 at Windy Hill.
  // This line is the vacant-rented count alone — 2 — and calling both of them
  // Preleased put a 2 next to a 42 on two reports a VP reads in the same
  // week. The number here is the one she asked for; the label is now the one
  // that describes it.
  L.push('    ' + pad('Signed, not moved in', 24) + n(p.preleased));
  L.push('    ' + pad('Applications pending', 24) + n(p.applicationsPending)
    + (num(p.applicationOldestDays) !== null ? '   oldest ' + p.applicationOldestDays + 'd' : ''));
  L.push('    ' + pad('Make-readies open', 24) + n(p.makeReadyOpen)
    + (num(p.makeReadyOldestDays) !== null ? '   oldest ' + p.makeReadyOldestDays + 'd' : ''));
  L.push('    ' + pad('Move-ins this week', 24) + n(p.moveInsExpected));
  L.push('    ' + pad('Move-outs this week', 24) + n(p.moveOutsExpected));
  L.push('    ' + pad('Notices', 24) + n(p.notices));
  L.push('    ' + pad('Delinquency', 24) + money(num(p.delinquency)));
  L.push('');
}

module.exports = { DEFAULTS, thresholdsFor, flagsFor, build, render, freshnessLines, pct, money, clean, num };
