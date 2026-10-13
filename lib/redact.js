// Things that must not reach the High Ops group chat.
//
// The Morning Report is pasted into a room, so every line in it is read by
// people who were not the intended audience of the email it describes. Arturo
// has been editing two of these out by hand every morning before sending.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// ---- banking details in an email preview -----------------------------------
//
// A vendor or owner emails an account and routing number, Graph puts the first
// 200 characters in bodyPreview, and the preview goes into the chat:
//
//   "Account number: 736386207 Routing number: 322271627"
//
// LABEL PLUS DIGITS, both required. A long number on its own is a work order,
// an invoice, a parcel ID or a phone number, and blanking every preview that
// contains six digits would blank most of them — a redaction that fires too
// often gets switched off. A label on its own ("please send your account
// number") is a request, not a disclosure, and stays readable.
const BANK_LABEL = new RegExp([
  'account\\s*(?:number|no\\.?|#)',
  'acct\\.?\\s*(?:number|no\\.?|#)?',
  'routing\\s*(?:number|no\\.?|#|transit)?',
  'aba\\s*(?:number|no\\.?|#)?',
  'iban', 'swift\\s*(?:code)?', 'sort\\s*code',
  'card\\s*(?:number|no\\.?|#)',
  'cvv|cvc',
  'wire\\s*(?:instructions|details|info)',
  'bank\\s*(?:account|details|info)',
].join('|'), 'i');

// Six or more digits in a row, allowing the spaces and dashes people type into
// account numbers. Six because the shortest real account numbers run to six;
// four would catch every year and dollar amount.
const LONG_NUMBER = /\d(?:[\s-]?\d){5,}/;

const BANKING_PLACEHOLDER = 'Banking details (see email)';

// Does this text disclose banking details?
function hasBankingDetails(text) {
  const t = clean(text);
  if (!t) return false;
  if (!BANK_LABEL.test(t)) return false;
  return LONG_NUMBER.test(t);
}

// The preview, or the placeholder in its place.
//
// REPLACES THE WHOLE PREVIEW rather than masking the digits. A masked number
// still shows the sentence around it, and the sentence is usually the part
// that says whose account it is. The subject and sender stay, so the row is
// still actionable — somebody can open the email.
function safePreview(text) {
  return hasBankingDetails(text) ? BANKING_PLACEHOLDER : clean(text);
}

// ---- Lyndsay's own all-day events ------------------------------------------
//
// Her personal all-day events — a trip, a day off — are hers. The report needs
// to say she is unreachable; it does not need to say where she is, and the
// title usually says exactly that.
//
// ONLY HER OWN. An all-day event she organises or owns is personal; a company
// all-day event on the Office Calendar is the company's and is shown as it
// always was. That distinction is mrOwnsAllDay's, not this module's — this
// just supplies the wording once, so the report and anything built on it
// cannot phrase it differently.
const OUT_OF_OFFICE = 'Lyndsay out of office — limited availability';

// A meeting-shaped all-day event is still a meeting.
//
// Some all-day entries are real commitments with other people — a conference
// she is speaking at, an all-day offsite with attendees. Hiding the title of
// something the room is also attending would make the report less useful, not
// more private. Attendees are the test: a trip has none.
function isPersonalAllDay(m) {
  if (!m || !m.allDay) return false;
  const attendees = Array.isArray(m.attendees) ? m.attendees.length
    : (typeof m.attendeeCount === 'number' ? m.attendeeCount : 0);
  return attendees === 0;
}

// ---- pending items that name an open gap ----------------------------------
//
// Arturo's Pending Items is pasted into the room too. Some titles announce a
// security gap to everyone, including whoever might use it. The task is not
// hidden — the room should know the work exists — but it is renamed to
// something that says what is being worked on without saying what is open,
// and its notes are dropped.
const OPS_REWRITES = [
  { match: /lyndsay.*(mailbox|email).*(incident|security|unauthor)|(?:mailbox|email).*incident.*lyndsay|security.*incident.*(mailbox|email)/i,
    as: 'Email security follow-up' },
];

// The title to show for a pending item, and whether its note may be shown.
//
// Returns { item, showNote }. A rewritten item never shows its note: the note
// is where the detail is, and the detail is the thing being withheld.
function opsTitle(item) {
  const t = clean(item);
  const hit = OPS_REWRITES.find(r => r.match.test(t));
  return hit ? { item: hit.as, showNote: false } : { item: t, showNote: true };
}

module.exports = {
  BANKING_PLACEHOLDER, OUT_OF_OFFICE, OPS_REWRITES,
  hasBankingDetails, safePreview, isPersonalAllDay, opsTitle, clean,
};
