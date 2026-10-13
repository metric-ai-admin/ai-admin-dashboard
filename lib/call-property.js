// Which property a call was about — as a choice from a list, not as free text.
//
// THE COLUMN WAS A TEXT BOX. The grader was asked for "the property discussed,
// or 'Unidentified'", and over 1,896 calls it produced 352 distinct answers:
// street addresses, buildings we do not manage, former properties, "Multiple
// Metric Properties", and a long tail of spellings that appear exactly once.
// Normalising it on 2026-10-13 mapped 293 rows and left 1,462, 995 of them
// "Unidentified". That is not a data-cleaning problem. A free-text field asked
// of a model will be answered in free text, and no amount of tidying
// afterwards changes what the question was.
//
// So the question changes: eight properties, plus two answers that are
// honest rather than missing.
//
//   Not property-specific   a vendor, a wrong number, a general enquiry. The
//                           call HAD no property and saying so is correct.
//   Unknown                 the call had one and the transcript did not say
//                           which. Still a real answer, and the one the
//                           resident match can sometimes fill in later.
//
// Those two are deliberately kept apart. Folding them together would hide the
// difference between "there is nothing to find" and "there is something to
// find and we have not found it", and only the second is worth any more work.
//
// NOTHING OUTSIDE THE LIST IS STORED. A model answer is mapped onto it through
// the same alias table the normalisation uses, and anything that will not map
// becomes "Unknown" — because a value the reports cannot group is worth less
// than an admission.

'use strict';

const PA = require('./property-aliases.js');

const NOT_SPECIFIC = 'Not property-specific';
const UNKNOWN = 'Unknown';

// The closed list, in the order the prompt presents it.
const CHOICES = PA.CANONICAL.concat([NOT_SPECIFIC, UNKNOWN]);

// Where a stored property came from. Written to call_grades.property_source so
// a value the resident match derived is never mistaken for one the model heard
// on the call — they have different error modes and a reader comparing a
// property report against a transcript needs to know which they are looking at.
const SOURCE = {
  GRADER: 'grader',
  MATCH: 'resident_match',
  // The 2026-10-13 pass over the names the model had already produced.
  NORMALISED: 'normalised',
};

const clean = s => String(s == null ? '' : s).trim();

// What the prompt tells the model. Built from the list so the two cannot drift:
// a property added to lib/property-aliases.js appears here on the next build of
// call-grade-prompt.json and nowhere else has to be edited.
function promptBlock() {
  return [
    '- "property_name" is a CHOICE FROM A CLOSED LIST. Return one of these exact',
    '  strings and nothing else — not an address, not a building we do not manage,',
    '  not a variation on the spelling, not two of them joined:',
    '',
  ].concat(PA.CANONICAL.map(p => '      "' + p + '"')).concat([
    '      "' + NOT_SPECIFIC + '"',
    '      "' + UNKNOWN + '"',
    '',
    '  "' + NOT_SPECIFIC + '" is for a call that is not about one of our properties at',
    '  all: a vendor, a wrong number, a general question, an internal call.',
    '',
    '  "' + UNKNOWN + '" is for a call that IS about a property where the transcript does',
    '  not say which one. Use it freely. A guess from an area code, a street name or',
    '  the kind of problem described is worse than "' + UNKNOWN + '", because a wrong',
    '  property reads exactly like a right one and nobody checks it again.',
    '',
    '  If the caller names a building that is not on the list — a former property, a',
    '  competitor, an address — the answer is "' + NOT_SPECIFIC + '" if the call is not',
    '  ours to handle, and "' + UNKNOWN + '" if it is.',
  ]).join('\n');
}

// A model answer, forced onto the list.
//
// Tried in order: an exact choice, then the alias table (so "Windy Hill" and
// "Iconic Round Rock" still land), then Unknown. The alias table's own refusals
// — "Unidentified", "not a Metric property", street addresses — fall through to
// Unknown rather than being invented into a property.
function fromGrader(raw) {
  const v = clean(raw);
  if (!v) return UNKNOWN;
  const exact = CHOICES.find(c => c.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  // "Unidentified" was the old prompt's word for the same thing.
  if (/^unidentified$/i.test(v)) return UNKNOWN;
  return PA.canonical(v) || UNKNOWN;
}

// Is this a stored value the resident match should try to fill in?
//
// "Not property-specific" is NOT one of them: it is a finished answer, and
// overwriting it with the property of whoever happens to own the phone number
// would turn a correct "this was a vendor" into a wrong attribution.
function needsProperty(value) {
  const v = clean(value);
  if (!v) return true;
  if (v === NOT_SPECIFIC) return false;
  if (v === UNKNOWN || /^unidentified/i.test(v)) return true;
  // Anything that does not map is an old free-text value and still open.
  return !PA.canonical(v);
}

module.exports = {
  CHOICES, CANONICAL: PA.CANONICAL, NOT_SPECIFIC, UNKNOWN, SOURCE,
  promptBlock, fromGrader, needsProperty, clean,
};
