// Bekah's rule, 2026-10-13. It replaces the property-by-property split.
//
// She kept the format, the fairness table and the weekday handover, and
// changed how the eight properties are divided: by GROUP, the way her old
// tracker did it, with the colours people already recognise.
//
//   RED    Sunset Palms, The Chateau, Windy Hill Apartment       -> José or Angel
//   BLUE   Hyde Park, Highlander, Ascent, iConic DT, iConic RR    -> Raúl or Emerson
//
// WHY THE RULE GOT SIMPLER RATHER THAN SMARTER. The previous version worked out
// each property from ownership, proximity and a balance pass, and produced a
// different-looking week every time. Two groups that never move are something
// four people can hold in their heads on a Saturday night, and the person who
// has run this rota for a year asked for them back.
//
// THE PAIRS ARE FIXED and alternate: Raúl + José, then Emerson + Angel. Bekah's
// reason is that it keeps the experience level even across the pair, and with
// four technicians the pairs necessarily repeat — so "no repeated pair" is
// relaxed for this scheme and said out loud here rather than quietly dropped.
// "Nobody two weeks running" still holds, and with two alternating pairs it
// holds by construction.

'use strict';

const clean = s => String(s == null ? '' : s).trim();
const norm = s => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const same = (a, b) => norm(a) === norm(b);

// The groups. Configurable: a property moves by editing this and nothing else,
// and the panel and the Excel both read the colour from here.
const GROUPS = {
  RED: {
    color: '#c0392b',
    label: 'Red',
    properties: ['Sunset Palms', 'The Chateau', 'Windy Hill Apartment'],
    // Only these two ever take the red group.
    techs: ['José Rentería', 'Angel Martinez'],
  },
  BLUE: {
    color: '#1f6feb',
    label: 'Blue',
    properties: ['Hyde Park Square', 'The Highlander', 'Ascent at Northgate',
      'iConic Downtown', 'iConic Round Rock'],
    techs: ['Raul Martinez', 'Emerson Garcia'],
  },
};

// The alternating pairs, in order. Index 0 is the pair a month opens with when
// nothing bars it.
const PAIR_CYCLE = [
  ['Raul Martinez', 'José Rentería'],
  ['Emerson Garcia', 'Angel Martinez'],
];

// Off the rotation by decision, not by roster state. Carlos is still an active
// technician on the map with properties assigned to him; he is simply not on
// call any more. Recorded with WHO decided and WHEN, because a name missing
// from a rota with no reason beside it is the first thing somebody "fixes".
const REMOVED_FROM_ONCALL = [
  { name: 'Carlos Portilla', reason: 'removed from on-call by Bekah, 10/13' },
];

// ---- the hard constraints --------------------------------------------------
//
// Checked on every generated week AND on every hand edit. The group scheme
// satisfies them on its own; they exist because a person moving one property in
// the editor can break something the rule would never have broken, and a rota
// that is quietly wrong is worse than one that argues back.
const CONSTRAINTS = [
  {
    id: 'iconic-together',
    describe: () => 'iConic Round Rock and iConic Downtown go to the same technician',
    check(assign) {
      const rr = assign['iConic Round Rock'];
      const dt = assign['iConic Downtown'];
      if (!rr || !dt || same(rr, dt)) return null;
      return 'iConic Round Rock is ' + clean(rr) + ' and iConic Downtown is ' + clean(dt)
        + ' — they go to the same technician.';
    },
  },
  {
    id: 'windy-hill',
    describe: () => 'Raúl and Emerson never have Windy Hill',
    check(assign) {
      const who = assign['Windy Hill Apartment'];
      if (!who) return null;
      const barred = ['Raul Martinez', 'Emerson Garcia'];
      if (!barred.some(b => same(b, who))) return null;
      return clean(who) + ' has Windy Hill Apartment, and Raúl and Emerson never do.';
    },
  },
];

function violations(assign) {
  return CONSTRAINTS.map(c => {
    const msg = c.check(assign || {});
    return msg ? { id: c.id, message: msg } : null;
  }).filter(Boolean);
}

// ---- the split -------------------------------------------------------------

const groupOf = property => (GROUPS.RED.properties.includes(property) ? 'RED'
  : (GROUPS.BLUE.properties.includes(property) ? 'BLUE' : null));

/**
 * Which of the pair takes which group.
 *
 * Red goes to whichever of the two is a red technician, blue to the other. If
 * the pair does not split that way — a hand-edited pairing, or a roster change
 * — it is REPORTED rather than guessed at, because a group handed to somebody
 * who is not on its list is exactly what the rule exists to prevent.
 */
function assignGroups(pair, properties) {
  const [a, b] = pair || [];
  const out = { assign: {}, groups: {}, reasons: {}, note: null };
  if (!a || !b) return out;

  const isRed = t => GROUPS.RED.techs.some(x => same(x, t));
  const isBlue = t => GROUPS.BLUE.techs.some(x => same(x, t));

  let red = null;
  let blue = null;
  if (isRed(a) && isBlue(b)) { red = a; blue = b; }
  else if (isRed(b) && isBlue(a)) { red = b; blue = a; }
  else {
    // Neither arrangement fits. Keep it deterministic and say so.
    red = isRed(a) ? a : (isRed(b) ? b : a);
    blue = red === a ? b : a;
    out.note = 'This pair does not split red/blue: '
      + clean(a) + ' and ' + clean(b) + '. Red goes to ' + clean(red)
      + ' and blue to ' + clean(blue) + ' — check it.';
  }

  out.groups = { RED: red, BLUE: blue };
  (properties || []).forEach(p => {
    const g = groupOf(p.name);
    if (!g) {
      // A property in neither group is not quietly handed to somebody.
      out.assign[p.name] = null;
      out.reasons[p.name] = 'in no group — add it to lib/oncall-groups.js';
      return;
    }
    out.assign[p.name] = g === 'RED' ? red : blue;
    out.reasons[p.name] = GROUPS[g].label + ' group';
  });
  return out;
}

// ---- the pairs -------------------------------------------------------------

/**
 * The fixed pairs for a month, alternating, continuing from whoever worked the
 * carry-in week.
 *
 * November is the case that needs this: the carry-in is Carlos + Angel, Carlos
 * is off the rotation and Angel cannot work two weeks running, so the month
 * opens with Raúl + José.
 */
function fixedPairs(weekCount, carryPair) {
  const carry = (carryPair || []).map(clean);
  // Start on the first pair that shares nobody with the carry-in week.
  let start = PAIR_CYCLE.findIndex(p => !p.some(t => carry.some(c => same(c, t))));
  if (start < 0) start = 0;   // nothing fits; reported by the caller's checks
  const out = [];
  for (let i = 0; i < weekCount; i++) {
    out.push(PAIR_CYCLE[(start + i) % PAIR_CYCLE.length].slice());
  }
  return out;
}

module.exports = {
  GROUPS, PAIR_CYCLE, REMOVED_FROM_ONCALL, CONSTRAINTS,
  groupOf, assignGroups, fixedPairs, violations, same, norm, clean,
};
