// The occupancy goal for each property.
//
// WHY THIS IS A LIB AND NOT A CONST IN server.js ANY MORE. It was a const in
// server.js, so anything outside that file — a preview script, a test — could
// not reach it and had to be handed a goal function from outside. The Kara
// brief preview was handed one that returned null, and the preview rendered
// with no occupancy goals at all: no property was red, while the footer still
// said "occupancy below the property goal". The brief that actually went out
// was fine, which is the worst version of that bug — a preview that disagrees
// with the email is worse than no preview, because it is believed.
//
// So the goals live here, both callers require the same table, and a test can
// run the real one.
//
// These match the Goal Board's GOAL_OVERRIDE in
// public/tools/weekly_leasing_goal_board.html: iConic 92%, Windy Hill 90%,
// everything else the 85% default. If those two ever drift apart, two screens
// disagree about whether a property is hitting its target.

'use strict';

const LEASING_GOAL_PCT = {
  'ascent at northgate': 85,
  'windy hill apartment': 90,
  'the highlander': 85,
  'sunset palms': 85,
  'the chateau': 85,
  'hyde park square': 85,
  'the sidney': 85,
  'iconic round rock': 92,
  'iconic downtown': 92,
  'live with metric': 85,
};

const LEASING_GOAL_DEFAULT = 85;

// A PERCENTAGE, 0-100. The brief works in fractions and divides by 100 at the
// boundary; keeping this one in percent matches the Goal Board and the spec
// the numbers were written from.
function leasingGoalPct(name) {
  const k = String(name || '').trim().toLowerCase();
  if (LEASING_GOAL_PCT[k] != null) return LEASING_GOAL_PCT[k];
  for (const key of Object.keys(LEASING_GOAL_PCT)) {
    if (k.includes(key)) return LEASING_GOAL_PCT[key];
  }
  return LEASING_GOAL_DEFAULT;
}

// The same thing as a fraction, which is what the brief compares against.
// Having both here means neither caller has to remember which one it holds.
const leasingGoalFraction = name => leasingGoalPct(name) / 100;

module.exports = {
  LEASING_GOAL_PCT, LEASING_GOAL_DEFAULT, leasingGoalPct, leasingGoalFraction,
};
