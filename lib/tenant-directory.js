// What of the Tenant Directory reaches the disk, and how a phone number is
// read off it.
//
// WHY THIS IS ITS OWN FILE. The first projection was a whitelist of column
// names — tenant_name, property_name, unit, phone, mobile — written from what
// the columns were assumed to be called. It synced 411 rows and produced ZERO
// phone numbers, because the report does not call them `phone` and `mobile`,
// and a whitelist cannot report what it threw away. The guess was in two
// places at once (here and in the readers), so it could be wrong twice and
// look consistent.
//
// SO THE RULE IS INVERTED, with one exception that matters:
//
//   DROP always wins.   Date of birth, SSN, email, emergency contact and
//                       balance go, under every spelling, and a new column
//                       that matches one of those patterns goes too. This is
//                       checked FIRST and nothing can override it — the same
//                       shape as lib/safe-print.js, where HARD_PERSONAL beats
//                       SAFE_NAME, and for the same reason: the dangerous
//                       answer must not depend on a list staying complete.
//   KEEP by meaning.    The identifying columns by name, plus ANY column whose
//                       name looks like a phone. That is what the match needs
//                       and it is the thing we got wrong by naming it.
//
// A phone number is not sensitive in the way a birthdate is: it is the key the
// Collections match is built on, and a resident's number is already on the
// delinquency report, the tickler and the rent roll. A birthdate is on none of
// them and has no use here at all.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// Dropped under every spelling, before anything else is considered.
//
// `balance` is in here because the directory's copy is a second, stale answer
// to a question delinquency_kpi already answers — two numbers that disagree is
// worse than one.
const DROP = [
  // `\bdob\b` does NOT match "tenant_dob": an underscore is a word character,
  // so \b never fires between them. The boundary has to be written out.
  /date[_\s-]*of[_\s-]*birth|birth[_\s-]*date|(?:^|[^a-z])dob(?:$|[^a-z])|(?:^|[^a-z])age(?:$|[^a-z])/i,
  /ssn|social[_\s-]*security|tax[_\s-]*id/i,
  /e[-_\s]*mail/i,
  /emergency/i,
  /balance|amount|owed|rent\b|deposit/i,
];

// Kept by name: who and where.
const KEEP = [
  /^tenant[_\s-]*name$|^name$|^resident[_\s-]*name$/i,
  /^property([_\s-]*name)?$/i,
  /^property[_\s-]*id$/i,
  /^unit([_\s-]*(name|number|id))?$/i,
  /^(tenant[_\s-]*)?status$/i,
  /^occupancy[_\s-]*id$/i,
];

// Kept by meaning: anything that looks like a phone number's column.
//
// `contact` is deliberately NOT in here. "Emergency contact" is dropped above,
// but "contact_name" and "contact_notes" are not phone numbers and would be
// kept by a looser pattern — the point of this file is to stop guessing in the
// permissive direction.
const PHONE = /phone|mobile|cell|tel$|tel[_\s-]/i;

function isDropped(key) { return DROP.some(re => re.test(key)); }
function isPhoneColumn(key) { return !isDropped(key) && PHONE.test(key); }
function isKept(key) {
  if (isDropped(key)) return false;
  return KEEP.some(re => re.test(key)) || PHONE.test(key);
}

// One number per entry, from a field that may hold several.
//
// delinquency_kpi puts them all in `phone_numbers` separated by commas, and
// the directory may do the same. A field read whole matches nothing: a
// two-number cell is not a phone number, it is two.
function splitNumbers(v) {
  return String(v == null ? '' : v)
    .split(/[,;/|]| and /i)
    .map(s => clean(s))
    .filter(Boolean);
}

// Every number on a row, from whatever the phone columns are called. This is
// the ONE place that decides, so the projection and the readers cannot drift
// apart again.
function phonesOfRow(row) {
  const out = [];
  Object.keys(row || {}).forEach(k => {
    if (!isPhoneColumn(k)) return;
    const v = row[k];
    if (typeof v !== 'string' && typeof v !== 'number') return;
    splitNumbers(v).forEach(p => { if (!out.includes(p)) out.push(p); });
  });
  return out;
}

// The row as it is stored.
//
// The phone columns are kept UNDER THEIR OWN NAMES — whatever those turn out
// to be — and `phones` is added as the flat list the match reads. Keeping both
// means the next person can see what the report actually returned instead of
// trusting that this file split it correctly.
function project(row) {
  const out = {};
  Object.keys(row || {}).forEach(k => { if (isKept(k)) out[k] = row[k]; });
  out.phones = phonesOfRow(row);
  return out;
}

// Reading an identifying field off a row without insisting on its spelling.
//
// The projection keeps these columns UNDER THEIR OWN NAMES, so "Tenant Name"
// survives as "Tenant Name". A reader that asks for `tenant_name` finds
// nothing — which is the same class of bug as the phone columns, one field
// over, and it would make every shared number look unshared.
function fieldOf(row, re) {
  const k = Object.keys(row || {}).find(key => re.test(key) && clean(row[key]));
  return k ? clean(row[k]) : '';
}

const nameOf = r => fieldOf(r, /^(tenant[_\s-]*name|name|resident[_\s-]*name)$/i);
const propertyOf = r => fieldOf(r, /^property([_\s-]*name)?$/i);
const unitOf = r => fieldOf(r, /^unit([_\s-]*(name|number))?$/i);

module.exports = {
  fieldOf, nameOf, propertyOf, unitOf,
  DROP, KEEP, PHONE, isDropped, isKept, isPhoneColumn, splitNumbers, phonesOfRow, project, clean,
};
