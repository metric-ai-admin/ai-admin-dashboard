// The monthly on-call rotation. Erick asked for it on 2026-10-06; the rules are
// Arturo's, from the September and October 2026 calendars he built by hand.
//
// WEEKS RUN SATURDAY 8:00 AM TO FRIDAY 7:59 AM. Week 1 starts on the first
// Saturday of the month, so the first days of most months are covered by the
// last week of the month before — which is why every calendar carries a
// carry-in note and the last week carries a "spills into" warning. The month is
// generated ON ITS OWN, never two at a time: a technician can join or leave.
//
// ---- the property split, and the one thing it is not -----------------------
//
// Each on-call technician takes THEIR OWN assigned properties, fixed. What is
// left over goes to whichever of the two is nearer. That is the whole rule
// (Arturo, 2026-10-13), and it means a week can land somewhere other than the
// familiar north/south blocks when the pair owns properties on both sides.
// North/south is a TIEBREAK for equal distance, nothing more.
//
// The October Week 3 calendar gave José the north block while Angel — who
// maintains three of its four properties — took the south. Arturo confirmed
// that as an oversight, and September Week 2 has the identical pair the other
// way round, so the two hand-built calendars already disagreed with each other.
//
// ---- the zero guard --------------------------------------------------------
//
// Carlos lives in Round Rock and is the FARTHEST of the five from every
// property except iConic Round Rock, which Raúl owns. So a Raúl + Carlos week
// under the rule above gives Raúl all eight and Carlos none. Covered, yes — but
// a pair where one person is on call for nothing is not a pair, and the roster
// would be saying something untrue.
//
// So when a technician would end a week with nothing, they are given the
// unowned property where they are LEAST disadvantaged — smallest ratio of their
// distance to the other's, not smallest distance, because Carlos loses every
// contest on absolute distance and the question is which one he loses by least.
// It is marked in the draft as a guard, never silently, and it can be turned
// off with { zeroGuard: false }.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// Austin is near 30°N, where a degree of longitude is about 0.87 of a degree of
// latitude. Good enough to rank five technicians against eight addresses; this
// is not navigation.
const LNG_SCALE = 0.87;
function distance(a, b) {
  return Math.hypot(a.lat - b.lat, (a.lng - b.lng) * LNG_SCALE);
}

// The north/south blocks, used ONLY to break a tie in distance. They are not
// the rule; they are what the rule happened to produce in most weeks.
const BLOCKS = {
  North: ['Hyde Park Square', 'The Chateau', 'The Highlander', 'Ascent at Northgate'],
  South: ['Sunset Palms', 'Windy Hill Apartment', 'iConic Round Rock', 'iConic Downtown'],
};
function blockOf(property) {
  return BLOCKS.North.includes(property) ? 'North'
    : (BLOCKS.South.includes(property) ? 'South' : null);
}

// ---- who is in the pool ----------------------------------------------------
//
// Derived from the roster, never a list typed out here — a technician who
// leaves has to disappear from the rotation by leaving the roster.
//
// A technician is excluded WITH A REASON, which the draft prints. Yeison
// Salgado is the case this exists for: an active maintenance tech whose role
// Erick has not confirmed and who has no location on file. Dropping him
// silently would make the calendar look complete while a person who may be on
// call is missing from it.
const ONCALL_POSITIONS = ['senior_maint_tech', 'maint_tech'];

function poolFrom(technicians) {
  const pool = [];
  const excluded = [];
  (technicians || []).forEach(t => {
    const name = clean(t.full_name);
    if (!name) return;
    if (!t.active) return;                                  // not on the roster at all
    if (!ONCALL_POSITIONS.includes(clean(t.position))) {
      // Supervisors and make-ready staff are not on the on-call rotation. Not
      // reported: they are not candidates, so saying so every month is noise.
      return;
    }
    if (t.home_lat == null || t.home_lng == null) {
      excluded.push({ name, reason: 'no location on file — role not confirmed' });
      return;
    }
    if (!t.show_on_map) {
      excluded.push({ name, reason: 'role not confirmed' });
      return;
    }
    pool.push({
      id: clean(t.id) || name, name,
      short: name.split(/\s+/)[0],
      lat: Number(t.home_lat), lng: Number(t.home_lng),
    });
  });
  pool.sort((a, b) => a.name.localeCompare(b.name));
  return { pool, excluded };
}

// ---- the weeks -------------------------------------------------------------

const pad2 = n => String(n).padStart(2, '0');
const ymd = d => d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
const md = d => pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * The on-call weeks of one month.
 *
 * @param {number} year
 * @param {number} month  1-12
 * @returns {{weeks, carryDays, monthName}}  carryDays = how many days at the
 *          start of the month belong to the previous month's last week.
 */
function weeksOf(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  const carryDays = d.getUTCDate() - 1;
  const weeks = [];
  while (d.getUTCMonth() === month - 1) {
    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 6);
    weeks.push({
      n: weeks.length + 1,
      start: ymd(d), end: ymd(end),
      label: 'Week ' + (weeks.length + 1),
      range: 'Sat ' + md(d) + ' 8am – Fri ' + md(end) + ' 7:59am',
      spillsInto: end.getUTCMonth() !== month - 1 ? MONTHS[end.getUTCMonth()] : null,
    });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return { weeks, carryDays, monthName: MONTHS[month - 1] + ' ' + year };
}

// ---- the pairs -------------------------------------------------------------
//
// Equal weeks per technician over the month, COUNTING THE CARRY-IN: the pair
// that covered the first days of the month has already served one, so it owes
// fewer. Nobody works two weeks running, and no pair repeats — including the
// carry-in pair, so the month does not open with a repeat of how it began.
//
// These constraints leave many valid rotations and the hand-built calendars are
// one of them. This produces A valid rotation, not THE rotation, which is why
// the draft is editable.
function rotate(weekCount, pool, carryPair, opts) {
  const o = opts || {};
  const names = pool.map(p => p.name);
  const served = {};
  names.forEach(n => { served[n] = 0; });
  (carryPair || []).forEach(n => { if (served[n] !== undefined) served[n] += 1; });

  const slots = weekCount * 2;
  const total = slots + names.reduce((a, n) => a + served[n], 0);
  const fair = Math.floor(total / (names.length || 1));
  const target = {};
  names.forEach(n => { target[n] = Math.max(0, fair - served[n]); });

  let left = slots - names.reduce((a, n) => a + target[n], 0);
  const byNeed = names.slice().sort((x, y) =>
    (served[x] + target[x]) - (served[y] + target[y]) || x.localeCompare(y));
  let k = 0;
  while (left > 0) { target[byNeed[k % byNeed.length]]++; left--; k++; }
  while (left < 0) {
    const most = byNeed.slice().reverse().find(n => target[n] > 0);
    if (!most) break;
    target[most]--; left++;
  }

  const used = {};
  names.forEach(n => { used[n] = 0; });
  const seen = new Set();
  if ((carryPair || []).length === 2) seen.add(carryPair.slice().sort().join('|'));

  const out = [];
  const warnings = [];
  let prev = (carryPair || []).slice();

  for (let w = 0; w < weekCount; w++) {
    const free = names.filter(n => used[n] < target[n] && !prev.includes(n));
    let pick = null;
    for (let x = 0; x < free.length && !pick; x++) {
      for (let y = x + 1; y < free.length && !pick; y++) {
        if (!seen.has([free[x], free[y]].sort().join('|'))) pick = [free[x], free[y]];
      }
    }
    // A constraint had to give. It is REPORTED rather than quietly relaxed:
    // somebody reading the calendar has to know which rule bent and where.
    if (!pick) {
      const relaxed = names.filter(n => used[n] < target[n]);
      pick = (free.length >= 2 ? free : relaxed).slice(0, 2);
      if (pick.length === 2) {
        warnings.push('Week ' + (w + 1) + ': no pairing satisfied every rule — '
          + pick.join(' + ') + ' repeats a pair or a consecutive week.');
      }
    }
    if (pick.length < 2) {
      warnings.push('Week ' + (w + 1) + ': not enough available technicians to staff a pair.');
      pick = (pick.concat(names.filter(n => !pick.includes(n)))).slice(0, 2);
    }
    pick.forEach(n => { used[n]++; });
    seen.add(pick.slice().sort().join('|'));
    out.push(pick);
    prev = pick;
  }
  return { pairs: out, target, used, served, warnings };
}

// ---- the property split ----------------------------------------------------

/**
 * Who covers each property for one week.
 *
 * @param {string[]} pair      two technician NAMES
 * @param {object[]} properties  [{ name, lat, lng, maintenanceTechs: [] }]
 * @param {object} techByName
 * @param {object} opts  { zeroGuard = true }
 * @returns {{ assign: {property: tech}, reasons: {property: string}, guard: null|{property, tech} }}
 */
function splitWeek(pair, properties, techByName, opts) {
  const o = opts || {};
  const [a, b] = pair;
  const assign = {};
  const reasons = {};
  const unowned = [];

  (properties || []).forEach(p => {
    const owners = (p.maintenanceTechs || []).map(clean);
    const mine = [a, b].filter(t => owners.includes(t));
    if (mine.length === 1) {
      assign[p.name] = mine[0];
      reasons[p.name] = 'assigned property';
      return;
    }
    if (mine.length === 2) {
      // Both on call and both own it (Sunset Palms is Raúl's and Emerson's).
      // Nearest takes it; it is their property either way.
      const near = nearer(p, a, b, techByName);
      assign[p.name] = near.tech;
      reasons[p.name] = 'both assigned — nearer (' + near.why + ')';
      return;
    }
    unowned.push(p);
  });

  // The leftovers, by proximity.
  //
  // BALANCE, AND WHY IT IS AN OPTION RATHER THAN A DECISION TAKEN HERE.
  // Raúl and José both live in east Austin and Angel just north of them, so
  // whichever of a pair is more central is nearer to almost every property.
  // Straight proximity gives splits of 7–1 and 6–2; run against the real
  // September and October calendars it never once produces the 4–4 those
  // calendars always have.
  //
  // `balance` assigns the leftovers in order of how strongly each one prefers a
  // technician — widest distance gap first — and stops giving to a technician
  // once they hold half the properties. Nobody's own property is ever moved;
  // only the leftovers are balanced, so the first half of the rule is intact
  // either way.
  const want = Math.ceil((properties || []).length / 2);
  const held = {};
  held[a] = Object.values(assign).filter(t => t === a).length;
  held[b] = Object.values(assign).filter(t => t === b).length;

  // DEFAULT ON, and the deviation from the letter of the rule is deliberate.
  // Arturo's own expectation for a Raúl + Carlos week is that Carlos ends up
  // with what is nearest Round Rock; under straight proximity he ends up with
  // nothing, because Raúl owns iConic Round Rock and is nearer to all seven
  // others. Balance is also the only mode that produces the 4–4 every calendar
  // he has built by hand actually has. One flag, stored on the draft, so a
  // month can be generated the other way without a deploy.
  const balance = o.balance !== false;
  const ordered = balance
    ? unowned.slice().sort((p, q) => gap(q, a, b, techByName) - gap(p, a, b, techByName))
    : unowned;

  ordered.forEach(p => {
    const near = nearer(p, a, b, techByName);
    let tech = near.tech;
    let why = 'nearer (' + near.why + ')';
    if (balance && held[tech] >= want) {
      tech = tech === a ? b : a;
      why = 'balanced — ' + near.tech + ' is nearer but already holds ' + want;
    }
    assign[p.name] = tech;
    reasons[p.name] = why;
    held[tech]++;
  });

  // The zero guard. See the note at the top of this file.
  let guard = null;
  if (o.zeroGuard !== false) {
    const counts = { [a]: 0, [b]: 0 };
    Object.values(assign).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    const empty = [a, b].find(t => !counts[t]);
    const full = [a, b].find(t => t !== empty);
    if (empty && unowned.length) {
      // Least disadvantaged: smallest ratio of their distance to the other's.
      let best = null;
      unowned.forEach(p => {
        const dEmpty = distance(techByName[empty], p);
        const dFull = distance(techByName[full], p) || 1e-9;
        const ratio = dEmpty / dFull;
        if (!best || ratio < best.ratio) best = { p, ratio };
      });
      if (best) {
        assign[best.p.name] = empty;
        reasons[best.p.name] = 'zero guard — ' + empty + ' would have had no property';
        guard = { property: best.p.name, tech: empty };
      }
    }
  }
  return { assign, reasons, guard };
}

// How strongly a property prefers one of the two — the gap between the two
// distances. A big gap is a property that clearly belongs to one of them; a
// small one is a coin toss, and those are the ones balance should move.
function gap(property, a, b, techByName) {
  return Math.abs(distance(techByName[a], property) - distance(techByName[b], property));
}

function nearer(property, a, b, techByName) {
  const da = distance(techByName[a], property);
  const db = distance(techByName[b], property);
  if (Math.abs(da - db) > 1e-9) {
    return { tech: da < db ? a : b, why: (da < db ? a : b) + ' is closer' };
  }
  // Equal distance: the north/south block is the tiebreak, and only here.
  const block = blockOf(property.name);
  return { tech: a, why: 'equal distance — ' + (block || 'no block') + ' tiebreak' };
}

// ---- the whole month -------------------------------------------------------

/**
 * @param {object} input
 *   year, month, technicians[], properties[], carryPair[], carryFrom (e.g. "October Week 5")
 * @returns the draft document stored in oncall_rotations.draft
 */
function build(input) {
  const i = input || {};
  const { pool, excluded } = poolFrom(i.technicians);
  const { weeks, carryDays, monthName } = weeksOf(i.year, i.month);
  const techByName = {};
  pool.forEach(t => { techByName[t.name] = t; });

  const carryPair = (i.carryPair || []).filter(n => techByName[n]);
  const rot = rotate(weeks.length, pool, carryPair, i);

  const out = weeks.map((w, idx) => {
    const pair = rot.pairs[idx] || [];
    const split = pair.length === 2
      ? splitWeek(pair, i.properties, techByName, i)
      : { assign: {}, reasons: {}, guard: null };
    return {
      ...w, pair,
      assign: split.assign, reasons: split.reasons, guard: split.guard,
      // Set when a human changes this week in the draft editor.
      edited: [],
    };
  });

  return {
    monthName, year: i.year, month: i.month,
    carry: {
      days: carryDays,
      pair: carryPair,
      from: i.carryFrom || null,
      note: carryDays
        ? monthName.split(' ')[0].slice(0, 3) + ' 01–' + pad2(carryDays)
          + ' (7:59am) covered by ' + (i.carryFrom || 'the previous month')
          + (carryPair.length ? ' rotation (' + carryPair.map(shortOf).join(' + ') + ')' : '')
        : null,
    },
    weeks: out,
    pool: pool.map(p => p.name),
    excluded,
    warnings: rot.warnings,
    fairness: fairness(out, carryPair, pool),
    generatedAt: new Date().toISOString(),
  };
}

const shortOf = n => clean(n).split(/\s+/)[0];

// On-call weeks per technician, with the carry-in named rather than folded in —
// "1 (+Nov 01-06 via Oct W5)" is what the hand-built calendars say, and it is
// the honest shape: that week was served, in the previous month's calendar.
function fairness(weeks, carryPair, pool) {
  const rows = (pool || []).map(t => {
    const mine = weeks.filter(w => (w.pair || []).includes(t.name));
    const carried = (carryPair || []).includes(t.name);
    return {
      technician: t.name,
      weeks: mine.length,
      carried,
      which: mine.map(w => w.label).join(', ') || '—',
    };
  });
  rows.sort((a, b) => a.technician.localeCompare(b.technician));
  // Equal once the carry-in is counted. Reported rather than asserted: an
  // uneven month is a fact about the month, not a bug to hide.
  const totals = rows.map(r => r.weeks + (r.carried ? 1 : 0));
  const even = totals.length ? Math.max(...totals) - Math.min(...totals) <= 0 : true;
  return { rows, even, spread: totals.length ? Math.max(...totals) - Math.min(...totals) : 0 };
}

// ---- manual edits ----------------------------------------------------------
//
// A draft is edited by hand before Josué, Bekah and Jay see it, and every
// change is MARKED. A reviewer has to be able to tell what the rule produced
// from what a person decided — otherwise an approval covers both without
// anybody noticing there was a difference.
function applyEdits(doc, edits, who) {
  const d = JSON.parse(JSON.stringify(doc));
  (edits || []).forEach(e => {
    const w = d.weeks.find(x => x.n === Number(e.week));
    if (!w) return;
    if (e.type === 'pair' && Array.isArray(e.pair) && e.pair.length === 2) {
      w.edited.push({ type: 'pair', from: w.pair.slice(), to: e.pair.slice(), by: who, at: new Date().toISOString() });
      w.pair = e.pair.slice();
    } else if (e.type === 'property' && e.property && e.tech) {
      if (w.assign[e.property] === e.tech) return;
      w.edited.push({ type: 'property', property: e.property, from: w.assign[e.property], to: e.tech, by: who, at: new Date().toISOString() });
      w.assign[e.property] = e.tech;
      w.reasons[e.property] = 'changed by hand';
    }
  });
  // Fairness is recomputed, never carried over: a draft whose fairness table
  // describes the version before the edit is worse than no table.
  d.fairness = fairness(d.weeks, d.carry.pair, d.pool.map(n => ({ name: n })));
  d.editedAt = new Date().toISOString();
  return d;
}

// ---- approval --------------------------------------------------------------

const STATES = ['draft', 'pending_approval', 'approved'];
const APPROVERS = ['Josue Garcia', 'Rebekah Hernandez', 'Jay Manuel'];

// Only forward, one step at a time, and an approval records WHO and WHEN.
function nextState(current, to) {
  const from = STATES.includes(current) ? current : 'draft';
  if (!STATES.includes(to)) return { ok: false, error: 'Unknown state "' + to + '"' };
  const i = STATES.indexOf(from);
  const j = STATES.indexOf(to);
  if (j === i) return { ok: false, error: 'Already ' + to };
  // Backwards is allowed only to draft: an approved calendar that needs a
  // change goes back to draft and is approved again, rather than being edited
  // under an approval somebody already gave.
  if (j < i && to !== 'draft') return { ok: false, error: 'Can only go back to draft' };
  if (j > i && j - i > 1) return { ok: false, error: 'Cannot skip ' + STATES[i + 1] };
  return { ok: true, state: to };
}

module.exports = {
  BLOCKS, blockOf, LNG_SCALE, distance, ONCALL_POSITIONS, STATES, APPROVERS, MONTHS,
  poolFrom, weeksOf, rotate, splitWeek, nearer, gap, build, fairness, applyEdits, nextState,
  clean, shortOf, ymd, md,
};
