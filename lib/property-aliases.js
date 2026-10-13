// Turning what a call transcript called a property into the property's name.
//
// call_grades.property_name is written by the grading model from what it heard
// on the call, and on 2026-10-13 it held 300+ distinct values across 1,847
// rows. 995 are "Unidentified". The rest run from the obvious — "Windy Hill",
// "Highlander", "Iconic Round Rock" — through transcription artifacts
// ("Ascend at Northgate", "Accent at Northgate", "Asana at Northgate") to
// things no rule should touch: street addresses, former properties
// ("Brazos Lofts (no longer managed)"), and buildings that are not ours
// ("Ventura North (not a Metric property)").
//
// SO THIS IS DELIBERATELY CONSERVATIVE. It maps a value only when the match is
// not a judgement call, and leaves everything else alone. A fuzzy matcher
// would clean up the list and quietly file somebody else's building under one
// of ours, which is worse than the mess it replaced: a wrong attribution looks
// exactly like a right one.
//
// Anything it will not map stays as it is and is REPORTED, so the size of the
// remaining problem is visible rather than hidden behind a tidy column.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// Lowercase, punctuation out, runs of space collapsed.
const norm = s => clean(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// The canonical names, as the KPI report spells them.
const CANONICAL = [
  'Ascent at Northgate', 'Hyde Park Square', 'Sunset Palms', 'The Chateau',
  'The Highlander', 'Windy Hill Apartment', 'iConic Downtown', 'iConic Round Rock',
];

// Exact normalised forms that map to a canonical name.
//
// A LIST, NOT A PATTERN. Every entry here is a spelling somebody has actually
// produced, read off the live data. A regex like /ascen[dt]/ would also catch
// "Ascension", "Ascent Apartments in Dallas" and whatever the model invents
// next week, and nobody would notice until a number moved.
const ALIASES = {
  // Windy Hill — the user named three; the data has more.
  'windy hill': 'Windy Hill Apartment',
  'windy hills': 'Windy Hill Apartment',
  'windy hill apartments': 'Windy Hill Apartment',
  'windy hills apartments': 'Windy Hill Apartment',
  'windy hill apartment': 'Windy Hill Apartment',
  'windy hill kyle': 'Windy Hill Apartment',
  'windy hills kyle tx': 'Windy Hill Apartment',
  'windy hill buda': 'Windy Hill Apartment',
  'windy hill terrace': 'Windy Hill Apartment',
  'wind hill': 'Windy Hill Apartment',
  'windhill': 'Windy Hill Apartment',

  // Ascent at Northgate.
  'ascent': 'Ascent at Northgate',
  'ascend': 'Ascent at Northgate',
  'ascent at northgate': 'Ascent at Northgate',
  'ascend at northgate': 'Ascent at Northgate',
  'the ascent at northgate': 'Ascent at Northgate',
  'ascent at the northgate': 'Ascent at Northgate',
  'ascend at the northgate': 'Ascent at Northgate',
  'ascent northgate': 'Ascent at Northgate',
  'ascent at north gate': 'Ascent at Northgate',
  'ascent at the north gate': 'Ascent at Northgate',
  'ascent at north': 'Ascent at Northgate',
  'accent at northgate': 'Ascent at Northgate',
  'accent on northgate': 'Ascent at Northgate',

  // The Highlander.
  'highlander': 'The Highlander',
  'the highlander': 'The Highlander',
  'highlanders': 'The Highlander',
  'highlander apartments': 'The Highlander',
  'highlander apartment': 'The Highlander',

  // iConic.
  'iconic round rock': 'iConic Round Rock',
  'iconic at round rock': 'iConic Round Rock',
  'the iconic round rock': 'iConic Round Rock',
  'iconic downtown': 'iConic Downtown',
  'iconic at downtown': 'iConic Downtown',
  'icon downtown': 'iConic Downtown',
  'icon at downtown': 'iConic Downtown',
  'icon at round rock': 'iConic Round Rock',

  // The Chateau.
  'chateau': 'The Chateau',
  'the chateau': 'The Chateau',
  'chateau apartments': 'The Chateau',

  // Hyde Park Square. The last three were named by Arturo on 2026-10-13 off
  // the dry run's "left alone" list. "Hyde Apartments" is the one a rule would
  // never have reached on its own — it shares one word with the property — and
  // it is here because a person who knows the portfolio read it, not because a
  // matcher scored it. Hyde Park Square is the only Hyde Park property we
  // manage, which is what makes the bare "Hyde Park" unambiguous.
  'hyde park square': 'Hyde Park Square',
  'hyde park square apartments': 'Hyde Park Square',
  'high park square': 'Hyde Park Square',
  'hyde park': 'Hyde Park Square',
  'hyde apartments': 'Hyde Park Square',

  // Sunset Palms.
  'sunset palms': 'Sunset Palms',
  'sunset palms apartments': 'Sunset Palms',
};

// Values that must NEVER be mapped, however much they look like a property.
//
// "Unidentified" is an answer: the model could not tell, and turning that into
// a property name would invent data. The rest are buildings that are not ours
// or no longer ours, and the transcript says so.
const NEVER = [
  /^unidentified/i, /not a metric property/i, /no longer managed/i,
  /^multiple/i, /unconfirmed/i, /^\s*$/,
];

// The canonical name for a raw value, or null to leave it alone.
function canonical(raw) {
  const v = clean(raw);
  if (!v) return null;
  if (NEVER.some(re => re.test(v))) return null;
  const n = norm(v);
  // Already canonical.
  const exact = CANONICAL.find(c => norm(c) === n);
  if (exact) return exact;
  return ALIASES[n] || null;
}

// What a rewrite would do to a set of rows, without doing it.
//
// Returns the mapping it is confident about and the values it is leaving
// alone, because the second list is the finding: a tidy column that still has
// 900 unmapped values has not been fixed, it has been made harder to see.
function plan(rows, opts) {
  const o = opts || {};
  const field = o.field || 'property_name';
  const counts = new Map();
  (rows || []).forEach(r => {
    const v = clean(r[field]) || '(empty)';
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  const change = [], keep = [];
  counts.forEach((n, v) => {
    const to = canonical(v);
    if (to && to !== v) change.push({ from: v, to, rows: n });
    else keep.push({ value: v, rows: n, canonical: !!to });
  });
  change.sort((a, b) => b.rows - a.rows || a.from.localeCompare(b.from));
  keep.sort((a, b) => b.rows - a.rows);
  return {
    distinct: counts.size,
    rows: (rows || []).length,
    change,
    rowsChanged: change.reduce((a, c) => a + c.rows, 0),
    keep,
    rowsKept: keep.reduce((a, c) => a + c.rows, 0),
    unmappedDistinct: keep.filter(k => !k.canonical).length,
  };
}

module.exports = { CANONICAL, ALIASES, NEVER, norm, canonical, plan, clean };
