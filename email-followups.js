// Email Follow-Up Tracker — the rules, with no I/O.
//
// Lyndsay writes "*follow up needed" in the subject of something she sends or
// forwards. It stays on her EOD every day until someone replies, or until she
// writes in the same thread WITHOUT the tag. Requested 2026-09-15 — the same
// day she tagged the only live example, still unanswered.
//
// Pure functions, same as vacancy-rules.js and weekly-brief.js: Graph calls and
// Supabase writes live in server.js, and everything that can be got wrong lives
// here where a test can reach it.
//
// WHAT THE REAL MAILBOX LOOKS LIKE, checked read-only before any of this was
// written. Every rule below exists because of one of these:
//
//   * Three tagged messages in 18,356 sent. This is a list that is usually
//     empty, not a dashboard.
//   * The tag is NOT a prefix — the 2026-09-15 subject carries it at character
//     84 of 101, after a "Fw:".
//   * She writes it more than one way. The two 2024 examples say
//     "**follow up **" — double asterisk, space before the closing pair.
//   * Replies INHERIT the tag in their subject. Sixteen messages in the mailbox
//     match "*follow" and most are replies quoting the subject. So the tag
//     alone never means "a new follow-up": where the message came from decides.

'use strict';

// The tag, in every form seen and the obvious near-misses.
//
// Anchored on one or more asterisks so ordinary prose about following up does
// not match — a search for "follow up needed" alone returns "Following up
// regarding our loan" and "tasks following Andrea", both real subjects in this
// mailbox. The asterisk is what makes it a deliberate mark.
const TAG_RE = /\*+\s*follow[\s-]*up\b(?:[\s-]*needed)?\s*\**/i;

// Does this subject carry the tag? Returns the matched text verbatim, so
// tag_matched records the form she actually used and a fourth variant shows up
// in a query instead of a bug report.
function matchTag(subject) {
  const m = TAG_RE.exec(String(subject || ''));
  return m ? m[0].trim() : null;
}
const hasTag = subject => matchTag(subject) !== null;

// ---- auto-replies and bounces ---------------------------------------------
//
// An out-of-office is not an answer. Neither is a bounce. Treating one as a
// reply would close a follow-up the moment the recipient went on holiday —
// exactly when it most needs to stay open.

const AUTO_SUBJECT_RE = /^\s*(automatic reply|auto\s*:|auto-reply|out of office|undeliverable|delivery status notification|returned mail|mail delivery)/i;
const AUTO_SENDER_RE = /^(postmaster|mailer-daemon|mail-daemon|noreply|no-reply|donotreply|do-not-reply|bounce|bounces)[@+.]|@(bounce|bounces)\./i;

// Headers that say "a machine sent this". Names are compared case-insensitively
// because header casing is not guaranteed by anyone.
function headerValue(headers, name) {
  const want = String(name).toLowerCase();
  for (const h of headers || []) {
    if (String(h && h.name || '').toLowerCase() === want) return String(h.value || '');
  }
  return null;
}

function isAutoReply(msg) {
  const subject = String(msg && msg.subject || '');
  if (AUTO_SUBJECT_RE.test(subject)) return true;

  const from = String(msg && msg.from && msg.from.emailAddress && msg.from.emailAddress.address || '');
  if (AUTO_SENDER_RE.test(from)) return true;

  const h = msg && msg.internetMessageHeaders;
  // RFC 3834. "auto-replied" and "auto-generated" both count; "no" does not,
  // and a human reply carries no such header at all.
  const autoSubmitted = headerValue(h, 'Auto-Submitted');
  if (autoSubmitted && !/^\s*no\s*$/i.test(autoSubmitted)) return true;

  // Exchange sets this on OOF replies even when Auto-Submitted is absent.
  if (headerValue(h, 'X-Auto-Response-Suppress')) return true;
  if (/^\s*(bulk|auto_reply|junk)\s*$/i.test(headerValue(h, 'Precedence') || '')) return true;
  if (headerValue(h, 'X-Autoreply') || headerValue(h, 'X-Autorespond')) return true;

  return false;
}

// ---- who sent what ---------------------------------------------------------

const addressOf = msg =>
  String(msg && msg.from && msg.from.emailAddress && msg.from.emailAddress.address || '').toLowerCase();
const isFrom = (msg, mailbox) => addressOf(msg) === String(mailbox || '').toLowerCase();

// The instant a message belongs at. Sent mail carries sentDateTime; received
// mail is ordered by when it arrived, and one of the two is always present.
const instantOf = msg => String((msg && (msg.sentDateTime || msg.receivedDateTime)) || '');

// ---- the two closing rules -------------------------------------------------

/**
 * Has this follow-up been answered or dropped?
 *
 * @param {object} o
 * @param {string} o.mailbox     the address that owns the follow-up (hers)
 * @param {string} o.taggedAt    when the tagged message was sent
 * @param {object[]} o.messages  every message in the conversation
 * @returns {{status:'open'}|{status:'replied'|'resolved', reason:string, by:string|null, at:string}}
 *
 * Only messages AFTER the tagged one count. Everything already in the thread
 * when she tagged it is, by definition, what she was not satisfied with.
 *
 * (a) someone else wrote  -> replied
 * (b) SHE wrote again without the tag -> resolved
 *
 * Her own reply that still carries the tag closes nothing. That is the common
 * case, not a curiosity: replying in a thread inherits the subject, so the tag
 * comes along, and reading that as "she wrote again" would close a follow-up
 * the moment she chased it a second time — the opposite of what she asked for.
 *
 * When both happen, the EARLIER one wins: the follow-up ended when it ended.
 */
function classifyThread(o) {
  const mailbox = o.mailbox;
  const taggedAt = String(o.taggedAt || '');
  const events = [];

  for (const m of o.messages || []) {
    const at = instantOf(m);
    if (!at || at <= taggedAt) continue;

    if (!isFrom(m, mailbox)) {
      // A machine answering is not an answer.
      if (isAutoReply(m)) continue;
      events.push({ status: 'replied', reason: 'reply', by: addressOf(m) || null, at });
      continue;
    }
    // Hers. Only an UNtagged message means she considers it handled.
    if (!hasTag(m.subject)) {
      events.push({ status: 'resolved', reason: 'untagged_message', by: mailbox, at });
    }
  }

  if (!events.length) return { status: 'open' };
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events[0];
}

// ---- the scan --------------------------------------------------------------

/**
 * The tagged messages in a batch of sent mail.
 *
 * One entry per CONVERSATION, keeping the most recent tagged message: tagging a
 * thread again means "still waiting, as of now", so the day count restarts
 * rather than the EOD showing the same subject twice.
 */
function taggedFromSent(messages, mailbox) {
  const byConversation = new Map();
  for (const m of messages || []) {
    const tag = matchTag(m && m.subject);
    if (!tag) continue;
    // Belt and braces: this is Sent Items, but a shared mailbox can hold mail
    // sent by someone else, and only hers is hers to chase.
    if (mailbox && addressOf(m) && !isFrom(m, mailbox)) continue;
    const key = String(m.conversationId || '');
    if (!key) continue;
    const at = instantOf(m);
    const prev = byConversation.get(key);
    if (prev && instantOf(prev.raw) >= at) continue;
    byConversation.set(key, {
      raw: m,
      conversation_id: key,
      message_id: String(m.id || ''),
      subject: String(m.subject || ''),
      tag_matched: tag,
      sent_at: at,
      recipients: recipientsOf(m),
    });
  }
  return [...byConversation.values()].map(({ raw, ...row }) => row);
}

// Real names where Outlook has them, addresses otherwise. Shown unmasked in the
// EOD, which goes only to Lyndsay — deliberately not in the Morning Report,
// which goes to the High Ops group chat.
function recipientsOf(msg) {
  const out = [];
  for (const list of [msg && msg.toRecipients, msg && msg.ccRecipients]) {
    for (const r of list || []) {
      const e = r && r.emailAddress;
      if (!e) continue;
      const label = String(e.name || '').trim() || String(e.address || '').trim();
      if (label && !out.includes(label)) out.push(label);
    }
  }
  return out;
}

// ---- display ---------------------------------------------------------------

// Whole days between the tag and now. Floored, so something sent this morning
// reads "0d" rather than claiming a day that has not passed.
function daysWaiting(sentAt, nowMs) {
  const t = Date.parse(sentAt);
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor(((nowMs === undefined ? Date.now() : nowMs) - t) / 86400000));
}

// Amber at 3 days, red at 7. A follow-up sent yesterday is not a problem yet.
function severityFor(days) {
  if (days === null) return 'grey';
  if (days >= 7) return 'red';
  if (days >= 3) return 'amber';
  return 'green';
}

/**
 * How far back the scan looks.
 *
 * 30 days on the very first run so the backlog is picked up — specifically the
 * 2026-09-15 message, which is the only one live. 14 after that, because a
 * shorter window is cheaper and anything older has either been answered or is
 * already in the table.
 *
 * "First run" is "the table holds nothing for this mailbox", which is also why
 * resolved rows are kept: emptying the table would silently turn the next run
 * back into a backfill.
 */
function scanWindowDays(existingRowCount) {
  return Number(existingRowCount) > 0 ? 14 : 30;
}

module.exports = {
  TAG_RE, matchTag, hasTag,
  isAutoReply, headerValue,
  classifyThread, taggedFromSent, recipientsOf,
  daysWaiting, severityFor, scanWindowDays,
};
