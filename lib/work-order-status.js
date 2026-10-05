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
    var out = { open: 0, closed: 0, unknown: 0, total: 0 };
    (rows || []).forEach(function (r) {
      out.total++;
      var s = get(r);
      if (isUnknown(s)) out.unknown++;
      else if (isClosed(s)) out.closed++;
      else out.open++;
    });
    return out;
  }

  return { UNKNOWN: UNKNOWN, CLOSED_RE: CLOSED_RE, isClosed: isClosed, isOpen: isOpen, isUnknown: isUnknown, tally: tally };
}));
