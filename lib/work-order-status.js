// What a work order's status MEANS. One place, because four screens were each
// deciding it for themselves and all four were wrong in the same way.
//
// THE BUG THIS CAME FROM. Every screen used:
//
//     s === 'completed' || s === 'cancelled' || s === 'canceled'
//
// AppFolio also returns "Completed No Need To Bill" — 113 rows of it in
// wo_completed on 2026-10-05 — and that exact-match test calls every one of
// them OPEN. On top of that the sync only ever asks for open work orders, so a
// work order that closes stops coming back and keeps its last open status for
// ever. Together those put 436 work orders on Erick's Command Center where 95
// were genuinely open.
//
// THREE STATES, not two. "Unknown — not in feed" is neither open nor closed: it
// is a work order that stopped being reported and that we cannot say anything
// else about. Counting it as open overstates the work; counting it as closed
// claims something we do not know; hiding it loses it. It gets its own line.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkOrderStatus = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The exact string written when a work order leaves the feed without ever
  // appearing as closed. A sentinel rather than a null, so the row still says
  // what happened to it when somebody reads it in the table.
  var UNKNOWN = 'Unknown — not in feed';

  // Prefix, not equality. "Completed", "Completed No Need To Bill", "Complete",
  // "Canceled", "Cancelled" are all closed. Equality is what missed the second
  // one for as long as this table has existed.
  var CLOSED_RE = /^\s*(complet|cancel)/i;

  // Finished in the field, not yet billed. These are OPEN — the money has not
  // been collected and the Billable Labor Report exists for exactly them — but
  // they are not work anybody still has to go and do. Mixed in with the rest
  // they inflate Erick's board with jobs his techs have already finished, so
  // every screen counts them as a subset of open and shows them apart.
  //
  // Note for anyone reading the old probe: scripts/probe-work-order-statuses.js
  // concluded these statuses were ABSENT from the work_order report. It was
  // wrong, and the reason matters — the sync only ever asked for six status
  // codes, so a status it did not ask for came back with no rows and looked
  // like a status that does not exist. The 2026-10-05 sweep across all codes
  // found them.
  var AWAITING_BILLING_RE = /^\s*(work done|ready to bill)/i;

  function isAwaitingBilling(status) {
    if (isUnknown(status) || isClosed(status)) return false;
    return AWAITING_BILLING_RE.test(String(status == null ? '' : status));
  }
  // Open work that still needs someone on site.
  function isFieldWork(status) {
    return isOpen(status) && !isAwaitingBilling(status);
  }

  function isUnknown(status) {
    return String(status == null ? '' : status).trim() === UNKNOWN;
  }
  function isClosed(status) {
    if (isUnknown(status)) return false;
    return CLOSED_RE.test(String(status == null ? '' : status));
  }
  // Open means genuinely open: not closed, and not a row we have lost track of.
  function isOpen(status) {
    return !isClosed(status) && !isUnknown(status);
  }

  // Counts for a screen, in one pass, so no caller has to remember that three
  // states exist.
  function tally(rows, statusOf) {
    var get = statusOf || function (r) { return r && r.status; };
    // open + closed + unknown === total, always. awaitingBilling and fieldWork
    // are a SPLIT OF open, not extra buckets — adding them to the total would
    // count the same work order twice.
    var out = { open: 0, closed: 0, unknown: 0, total: 0, awaitingBilling: 0, fieldWork: 0 };
    (rows || []).forEach(function (r) {
      out.total++;
      var s = get(r);
      if (isUnknown(s)) out.unknown++;
      else if (isClosed(s)) out.closed++;
      else {
        out.open++;
        if (isAwaitingBilling(s)) out.awaitingBilling++; else out.fieldWork++;
      }
    });
    return out;
  }

  return { UNKNOWN: UNKNOWN, CLOSED_RE: CLOSED_RE, AWAITING_BILLING_RE: AWAITING_BILLING_RE,
    isClosed: isClosed, isOpen: isOpen, isUnknown: isUnknown,
    isAwaitingBilling: isAwaitingBilling, isFieldWork: isFieldWork, tally: tally };
}));
