// KPI RR Automation — the rules, with no I/O.
//
// After each Round Rock KPI meeting (ICRR / ICDT) the recording and transcript
// go to the Round Rock partners. Asked for by Lyndsay 2026-09-16.
//
// DRAFT MODE. Nothing here sends anything. It composes; a human approves in the
// dashboard; sending is a separate, currently-disabled step. AUTO_SEND stays
// false until Lyndsay has confirmed the recipient list against a real draft.
//
// WHAT THE TENANT ACTUALLY DOES, verified read-only on 2026-09-29:
//
//   * The whole recurring series shares ONE onlineMeeting, because the join URL
//     is fixed. /transcripts and /recordings therefore return all twenty past
//     occurrences at once. Picking "the last meeting" means picking from that
//     list, not fetching one meeting.
//   * contentCorrelationId pairs a transcript with the recording OF THE SAME
//     CALL. Pairing by createdDateTime would work most days and break the day
//     someone stops and restarts a recording.
//   * The organizer is officecalendar@metricpropertymanagement.com, not
//     Lyndsay — which is why this needed its own Teams application access
//     policy, and why nothing here assumes she organizes anything.

'use strict';

// Off until Lyndsay confirms the recipients against a real draft. The flag is
// here, in the module, rather than in an env var: turning it on should be a
// commit someone reviews, not a value someone types into a dashboard at 6pm.
const AUTO_SEND = false;

// The AI summary is OFF.
//
// Lyndsay asked for the recording and the transcript. The summary was my
// addition, and it is not a neutral one: the 2026-09-23 recap it produced
// discussed a cash shortfall, the balance on hand against an upcoming tax bill,
// and an investor look-back document — accurate, and written by a model, going
// verbatim to people outside the company. Whether that is wanted is hers to
// decide, not a default to inherit. Turning it on is a one-line change here,
// reviewed, and the draft is unaffected other than losing the section.
const INCLUDE_SUMMARY = false;

// Held back pending Lyndsay's confirmation.
//
// Both appear as display names in the invitation, neither is in dashboard_users,
// and both SPEAK in the 2026-09-23 transcript alongside the external partners —
// so they are probably on the Round Rock side. "Probably" is not enough to put
// a recording in someone's inbox, so they are excluded and the exclusion is
// recorded on the draft where it can be seen and undone.
const PENDING_CONFIRMATION = ['janae rapps', 'amber lackey'];

// Internal: never a recipient. Matched on domain, so a new colleague is covered
// without anyone remembering to add them.
const INTERNAL_DOMAINS = ['metricpropertymanagement.com', 'livewithmetric.com', 'metric.internal'];

// Which meetings this applies to. The subject is stable but not unique —
// "KPI THSI", "KPI TRIGILD" and "Ascent at Northgate KPI" live in the same
// calendar and belong to other partners — so the series id is the real key and
// the subject is the fallback for an occurrence that arrives without one.
const RR_SUBJECT_RE = /\b(ICRR|ICDT)\b/i;

function isRoundRockMeeting(event, seriesIds) {
  if (!event) return false;
  const series = String(event.seriesMasterId || '');
  if (series && (seriesIds || []).indexOf(series) >= 0) return true;
  return RR_SUBJECT_RE.test(String(event.subject || ''));
}

const domainOf = addr => String(addr || '').toLowerCase().split('@')[1] || '';
const isInternal = addr => INTERNAL_DOMAINS.indexOf(domainOf(addr)) >= 0;

/**
 * Who the draft proposes to write to, and who is held back.
 *
 * Deduplicated on the ADDRESS, lowercased: Lyndsay appears twice in the real
 * invitation, and the two entries are not string-identical.
 */
function recipientsFrom(event) {
  const proposed = [];
  const excluded = [];
  const seen = new Set();
  for (const a of (event && event.attendees) || []) {
    const e = (a && a.emailAddress) || {};
    const addr = String(e.address || '').trim();
    const name = String(e.name || '').trim();
    const key = addr.toLowerCase();
    if (!addr || seen.has(key)) continue;
    seen.add(key);
    if (isInternal(addr)) continue;                    // colleagues, silently
    const entry = { name: name || addr, address: addr };
    if (PENDING_CONFIRMATION.indexOf(name.toLowerCase()) >= 0) excluded.push(entry);
    else proposed.push(entry);
  }
  return { proposed, excluded };
}

/**
 * The artifacts for one occurrence.
 *
 * `transcripts` and `recordings` are the full lists Graph returns for the
 * series. Returns the newest transcript at or before `onOrBefore` (or the
 * newest overall) together with the recording of the SAME call.
 */
function artifactsFor(transcripts, recordings, onOrBefore) {
  const byNewest = (a, b) => String(b.createdDateTime || '').localeCompare(String(a.createdDateTime || ''));
  const eligible = (transcripts || [])
    .filter(t => !onOrBefore || String(t.createdDateTime || '') <= onOrBefore)
    .sort(byNewest);
  const transcript = eligible[0] || null;
  if (!transcript) return { transcript: null, recording: null };
  const recording = (recordings || []).find(r =>
    r && transcript.contentCorrelationId && r.contentCorrelationId === transcript.contentCorrelationId) || null;
  return { transcript, recording };
}

// The occurrences a scan has not drafted yet, newest first.
//
// ONE BY DEFAULT, and that matters: the series returns all twenty past
// occurrences at once, so a first run against an empty table would otherwise
// draft twenty months of meetings and put them all in front of Arturo. The
// feature is "after each meeting", so the default is the most recent one that
// has no draft yet. The limit is a parameter for a deliberate backfill, not
// something a routine run reaches for.
function pendingOccurrences(transcripts, existingKeys, limit) {
  const have = new Set(existingKeys || []);
  return (transcripts || [])
    .filter(t => t && t.contentCorrelationId && !have.has(t.contentCorrelationId))
    .sort((a, b) => String(b.createdDateTime || '').localeCompare(String(a.createdDateTime || '')))
    .slice(0, limit === undefined ? 1 : limit);
}

// ---- the draft -------------------------------------------------------------

const fmtDate = iso => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso || '') : d.toISOString().slice(0, 10);
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The draft email. Plain, short, and honest about what is attached.
 *
 * The recording is a LINK, never an attachment: half an hour of Teams is
 * hundreds of megabytes and Exchange would refuse it. The transcript is small
 * enough to attach as text, and the summary carries the substance for anyone
 * who will not open either.
 */
function composeDraft(o) {
  const date = fmtDate(o.meetingDate);
  // "transcript", not "recording & transcript". The transcript is the thing
  // actually delivered; the recording is offered on request, and a subject line
  // promising it would be read as "it is in here" before the body says it is
  // not.
  const subject = `${o.subject || 'KPI meeting'} — transcript (${date})`;

  const lines = [];
  lines.push('<p>Hi all,</p>');
  lines.push(`<p>Thank you for joining the ${esc(o.subject || 'KPI meeting')} on ${esc(date)}.</p>`);

  if (o.summary) {
    lines.push('<p><b>Summary</b></p>');
    lines.push(`<div>${o.summary}</div>`);
  }
  // "Available on request", not a link.
  //
  // What Graph returns is a Graph API URL, which needs an access token — a
  // partner clicking it gets a 401, not a video. Turning it into something they
  // can open means creating an external sharing link in SharePoint, and that is
  // a tenant setting nobody has asked to change. So the draft says what is
  // true: the recording exists and they can ask for it. The Graph URL is still
  // stored on the row, for whoever fetches it.
  // One sentence covering both, so the email does not announce a recording
  // "below" and then offer it on request two lines later.
  if (o.transcriptAttached && o.recordingUrl) {
    lines.push('<p>The transcript is attached and the recording is available on request.</p>');
  } else if (o.transcriptAttached) {
    lines.push('<p>The transcript is attached. No recording is available for this meeting.</p>');
  } else if (o.recordingUrl) {
    lines.push('<p>The recording is available on request. No transcript is available for this meeting.</p>');
  } else {
    lines.push('<p>Neither a recording nor a transcript is available for this meeting.</p>');
  }
  lines.push('<p>Best regards,<br>Metric Property Management</p>');

  return { subject, body: lines.join('\n') };
}

module.exports = {
  AUTO_SEND, INCLUDE_SUMMARY, PENDING_CONFIRMATION, INTERNAL_DOMAINS, RR_SUBJECT_RE,
  isRoundRockMeeting, isInternal, domainOf,
  recipientsFrom, artifactsFor, pendingOccurrences,
  composeDraft, fmtDate,
};
