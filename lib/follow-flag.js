// "Following" = a follow-up FLAG on the message. Nothing is moved, nothing is
// filed, nothing is deleted (Lyndsay via Arturo, 2026-10-08).
//
// WHY THIS IS NOT AN OUTLOOK RULE. Graph's messageRuleActions can assign
// categories, copy, delete, forward, redirect, mark as read, set importance,
// move and stop processing. THERE IS NO FLAG ACTION. So a server-side Outlook
// rule cannot do the one thing that was asked for, and substituting a category
// would be answering a different request without saying so. The "rule" is
// therefore a pass over the mailbox that sets the flag itself — run once over
// the last 90 days, and on a schedule after that.
//
// THREE RULES, AND ONLY THREE. The measurement pass on 2026-10-08 showed that
// "eviction", "writ" and "PTO" as loose words return EOD reports, Slab SOP
// mail and vacation advertising — searching "eviction" returned twelve
// messages with none of them carrying the word in a subject. These three
// patterns are the shapes the real mail actually has.

'use strict';

const norm = s => String(s || '').trim().toLowerCase();
const subjectOf = m => (m && m.subject) || '';

const RULES = [
  {
    key: 'court-filing',
    label: 'Court e-filing acknowledgement',
    // "Fw: Filing Submitted for Case: 120519758; ; Envelope Number: 120519758"
    // The envelope alternative is kept because the two do not always travel
    // together — a later notice on the same case may carry only one.
    test: s => /\bfiling submitted for case\b/i.test(s) || /\benvelope number\b/i.test(s),
  },
  {
    key: 'mtd-evictions',
    label: 'AppFolio "MTD Evictions Filed" report',
    test: s => /\bmtd evictions filed\b/i.test(s),
  },
  {
    key: 'leave-request',
    label: 'Leave request',
    // BOTH conditions, deliberately. "Leave |" is the prefix the request form
    // emits, and requiring "leave request" as well stops a subject that merely
    // begins with the word Leave — "Leave | Policy update", "Leave | FYI" —
    // from being followed as though somebody had asked for days off.
    test: s => /^\s*leave\s*\|/i.test(s) && /\bleave request\b/i.test(s),
  },
];

// Which rule a subject matches, or null. First match wins; a message cannot be
// followed twice and the report should name one reason, not a list.
function ruleFor(message) {
  const s = subjectOf(message);
  for (const r of RULES) if (r.test(s)) return r.key;
  return null;
}

// Already flagged? Then leave it alone. Re-flagging an already-flagged message
// is a write that changes nothing and would be counted as work done.
const isFlagged = m => norm(m && m.flag && m.flag.flagStatus) === 'flagged';

function plan(messages, folder, acc) {
  const a = acc || { scanned: 0, toFlag: [], alreadyFlagged: 0, byRule: {}, byFolder: {}, subjects: {} };
  for (const m of messages || []) {
    a.scanned++;
    const rule = ruleFor(m);
    if (!rule) continue;
    if (isFlagged(m)) { a.alreadyFlagged++; continue; }
    const row = {
      id: m.id,
      rule,
      folder: folder || '(unknown)',
      subject: subjectOf(m),
      from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '(none)',
      received: String(m.receivedDateTime || '').slice(0, 10),
    };
    a.toFlag.push(row);
    a.byRule[rule] = (a.byRule[rule] || 0) + 1;
    a.byFolder[rule + ' / ' + row.folder] = (a.byFolder[rule + ' / ' + row.folder] || 0) + 1;
    // Every subject, per rule, not a sample. Three narrow rules over ninety
    // days is a short list, and the whole point of the dry run is to read it
    // before anything is written.
    (a.subjects[rule] = a.subjects[rule] || []).push(
      row.received + '  ' + row.folder + '  ' + row.from + '  ' + row.subject);
  }
  return a;
}

module.exports = { RULES, ruleFor, isFlagged, plan, subjectOf, norm };
