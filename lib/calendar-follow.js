// "Calendar invites to follow" — a READ-ONLY list of invitations on Lyndsay's
// calendar that she probably wants to mark Follow, and has not yet.
//
// WHY A LIST AND NOT AN AUTOMATION. Microsoft Graph cannot send a Follow
// response: the responseStatus enum is none | organizer | tentativelyAccepted |
// accepted | declined | notResponded, in v1.0 and in beta alike, and the event
// actions are accept / tentativelyAccept / decline. Follow is a client feature
// of new Outlook for Windows and Outlook on the web. The nearest automatable
// thing is tentativelyAccept, which tells a COURT that she might attend — not a
// decision a keyword rule should be making. So this finds them and she clicks.
//
// Nothing here writes. There is no accept, no response, no edit.
//
// HOW A FOLLOWED INVITE LOOKS. Outlook prefixes the attendee's copy of the
// subject with "Following: ". That is how the already-done ones are excluded —
// measured on the live calendar 2026-10-08, where 8 of 20 hearings carried it.

'use strict';

const norm = s => String(s || '').trim().toLowerCase();
const subjectOf = e => (e && e.subject) || '';
const organizerOf = e =>
  (e && e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.address)
  || (e && typeof e.organizer === 'string' ? e.organizer : '') || '';

const COLLECTIONS = 'collections@livewithmetric.com';

// Travis and Williamson county numbering, both shapes seen on the calendar:
//   J1-CV-26-004707  J2-CV-26-008772  J3-EV-26-001524  J5-CV-26-282997
//   1JC-26-3567
// The case number is the reliable signal. Subjects say "InPerson Hearing",
// "Virtual/Zoom Hearing", "VIRTUAL HEARING", "PHONE Hearing" — and one says
// no hearing word at all ("In-PERSON - 1JC-26-3570 - ...").
const CASE_RE = /\b(?:J[1-5]-(?:CV|EV)-\d{2}-\d{3,7}|\d?JC-\d{2}-\d{3,6})\b/i;

const WOP_RE = /\bWOP\b|\bwrits?\s+of\s+possession\b/i;

// PTO, in the shapes the calendar actually uses: "PTO - Katie", "PTO - Katrina",
// "JAY - PTO". Case-SENSITIVE on the acronym so it does not fire inside a word.
// The other phrasings are the ones people type.
const PTO_RE = /\bPTO\b/;
const AWAY_RE = /\b(?:time[\s-]?off|days?\s+off|vacation|sick\s+(?:day|leave)|leave\s+request|out\s+of\s+office|OOO)\b|\boff\s*$/i;

const FOLLOWING_RE = /^\s*following:\s*/i;

// Properties, so a rebuilt label can keep the one piece of context that is not
// a person. Longest first, so "iConic Round Rock" wins over "iConic".
const PROPERTIES = [
  'Ascent at Northgate', 'iConic Round Rock', 'iConic Downtown', 'Hyde Park Square',
  'Windy Hill Apartment', 'Windy Hill', 'The Highlander', 'Sunset Palms', 'The Chateau',
  'The Sidney', 'Cedar and Sage', 'A Place 2 Stay', 'Brazos Lofts', 'Lily Pad Lane',
  'Hyde Park', 'Ascent',
];

const isFollowing = e => FOLLOWING_RE.test(subjectOf(e));

// Which bucket, or null. Order matters and is not arbitrary.
//
// The away test runs BEFORE the organizer test on purpose. Collections organises
// the hearings AND its own team's time off — "Rocio off" is a real entry from
// that address — so "organised by collections" alone would file a day off as a
// court date.
function categorize(event) {
  const s = subjectOf(event);
  if (CASE_RE.test(s)) return 'hearing';
  if (WOP_RE.test(s)) return 'wop';
  if (PTO_RE.test(s) || AWAY_RE.test(s)) return 'pto';
  if (norm(organizerOf(event)) === COLLECTIONS) return 'hearing';
  return null;
}

// ---- labels ---------------------------------------------------------------
//
// A hearing or writ subject carries a RESIDENT'S NAME, and this list is read in
// a dashboard and counted in a report. Rather than redact — which leaks
// whatever the pattern fails to catch — the label is REBUILT from the parts
// that are known to be safe: the kind of appearance, the case number and the
// property. Anything unrecognised is simply never copied, so there is nothing
// for a bad regex to miss.
function caseNumber(subject) {
  const m = CASE_RE.exec(String(subject || ''));
  return m ? m[0].toUpperCase() : null;
}

function propertyIn(subject) {
  const s = String(subject || '');
  for (const p of PROPERTIES) {
    if (new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s)) return p;
  }
  return null;
}

function hearingKind(subject) {
  const s = String(subject || '');
  const bits = [];
  if (/\breset\b/i.test(s)) bits.push('Reset');
  if (WOP_RE.test(s)) bits.push('Writ of possession');
  else if (/\bin[-\s]?person\b/i.test(s)) bits.push('In person');
  else if (/\b(virtual|zoom|video)\b/i.test(s)) bits.push('Virtual');
  else if (/\bphone\b/i.test(s)) bits.push('Phone');
  if (/\btrial\b/i.test(s)) bits.push('trial');
  else if (!WOP_RE.test(s)) bits.push('hearing');
  return bits.join(' ') || 'Hearing';
}

// The safe label for one event.
//
// PTO keeps its subject: those name COLLEAGUES, and knowing whose day off it is
// is the entire content of the invitation.
function label(event) {
  const s = subjectOf(event).replace(FOLLOWING_RE, '');
  const cat = categorize(event);
  if (cat === 'pto') return s.trim();
  const parts = [hearingKind(s)];
  const c = caseNumber(s);
  if (c) parts.push(c);
  const p = propertyIn(s);
  if (p) parts.push(p);
  return parts.join(' · ');
}

// ---- the list -------------------------------------------------------------

// `showAs` and `responseStatus.response` answer different questions and both are
// reported: showAs is how the time looks on her calendar, responseStatus is what
// the organizer was told. A Followed invite reads free + tentativelyAccepted,
// which is exactly why neither alone is a reliable "has she dealt with this".
function statusOf(event) {
  const r = event && event.responseStatus && event.responseStatus.response;
  return {
    showAs: (event && event.showAs) || null,
    response: r || null,
  };
}

// Returns the invitations worth showing, newest start first.
//
// Excluded: anything already Following, anything cancelled, and anything she
// organised herself — she cannot follow her own meeting.
function pick(events, opts) {
  const o = opts || {};
  const me = norm(o.mailbox || '');
  const out = [];
  for (const e of events || []) {
    if (!e || e.isCancelled) continue;
    if (isFollowing(e)) continue;
    if (e.isOrganizer) continue;
    if (me && norm(organizerOf(e)) === me) continue;
    const category = categorize(e);
    if (!category) continue;
    out.push({
      id: e.id || null,
      category,
      label: label(e),
      start: (e.start && (e.start.dateTime || e.start)) || null,
      isAllDay: !!e.isAllDay,
      organizer: organizerOf(e) || '(none)',
      status: statusOf(e),
      webLink: e.webLink || null,
    });
  }
  out.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  return out;
}

// The ones that MATCH but are already marked Following.
//
// Reported because "nothing waiting" and "this list is broken" look identical
// on screen, and the difference matters: on 2026-10-08 the list correctly
// showed no hearings, and the only way to tell that from a silent failure was
// to go and read the calendar. Saying "4 hearings already Following" answers it
// at a glance.
function alreadyFollowingSummary(events, opts) {
  const o = opts || {};
  const me = norm(o.mailbox || '');
  const byCategory = {};
  let total = 0;
  for (const e of events || []) {
    if (!e || e.isCancelled || e.isOrganizer) continue;
    if (me && norm(organizerOf(e)) === me) continue;
    if (!isFollowing(e)) continue;
    const c = categorize(e);
    if (!c) continue;
    byCategory[c] = (byCategory[c] || 0) + 1;
    total++;
  }
  return { total, byCategory };
}

function summarize(items) {
  const byCategory = {};
  (items || []).forEach(i => { byCategory[i.category] = (byCategory[i.category] || 0) + 1; });
  return { total: (items || []).length, byCategory };
}

module.exports = {
  COLLECTIONS, CASE_RE, WOP_RE, PTO_RE, AWAY_RE, FOLLOWING_RE, PROPERTIES,
  norm, subjectOf, organizerOf, isFollowing, categorize,
  caseNumber, propertyIn, hearingKind, label, statusOf, pick, summarize,
  alreadyFollowingSummary,
};
