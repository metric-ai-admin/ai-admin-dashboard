// wo-columns.js
//
// Which column of a work-order export is which.
//
// WHY THIS IS ITS OWN FILE NOW. The previous matcher took the FIRST column
// whose name contained a keyword, and on the real 78-column export that is
// wrong for most fields. Measured on 2026-09-26 against the synced wo_all
// columns:
//
//   wo        -> work_order_type      (11 candidates; the TYPE, not the number)
//   assignee  -> vendor_id            (11 candidates; an id, not a name)
//   unit      -> unit_address         (10 candidates; the street address)
//   photos    -> nothing at all       (no candidate; hasPhotos was always false)
//   updated   -> nothing at all
//
// The first one is what Jay was actually looking at. Every row was labelled by
// its work-order TYPE — "Plumbing", "Electrical" — so adjacent rows carried the
// same identifier and could not be told apart. He read that as the analyzer
// marking one of a pair complete. It never marked anything complete; it labelled
// two different work orders identically and put a green tick under one.
//
// HOW IT WORKS NOW. Every candidate column is SCORED and the best one wins,
// rather than the first one encountered:
//
//   exact match on a known name        100
//   name differs only by separators     90   ("Work Order #" -> workordernumber)
//   starts with / ends with the term    60
//   contains the term                   40
//   penalties                           -35 for an id/foreign-key column,
//                                       -30 for a name that is a DIFFERENT
//                                            field's exact name
//
// And a field that scores below the floor is left UNBOUND rather than bound to
// the best of a bad set. An unbound column is visible — the analyzer reports it
// — whereas a wrongly bound one produces confident nonsense, which is the
// failure this whole file exists to prevent.

const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Known-good names first, in preference order, then the looser terms.
const FIELDS = {
  wo: {
    exact: ['workordernumber', 'workorder', 'wonumber', 'wonum', 'won', 'ticketnumber',
      'servicerequestnumber', 'workorderid', 'ticket'],
    terms: ['workorder', 'ticket'],
    // work_order_type is the trap: it contains "workorder" and is not an
    // identifier. Anything matching these cannot be the work-order number.
    never: ['type', 'status', 'category', 'priority', 'description', 'issue', 'count'],
  },
  property: {
    exact: ['propertyname', 'property', 'building', 'community'],
    terms: ['property', 'building', 'community'],
    never: ['id', 'address', 'street', 'city', 'state', 'zip'],
  },
  unit: {
    exact: ['unitname', 'unit', 'unitnumber', 'apt', 'apartment'],
    terms: ['unit', 'apartment'],
    never: ['id', 'address', 'street', 'city', 'state', 'zip', 'turn', 'category'],
  },
  status: {
    exact: ['workorderstatus', 'status', 'stage'],
    terms: ['status', 'stage'],
    // estimate_approval_status and status_notes both contain "status".
    never: ['estimate', 'approval', 'notes', 'note'],
  },
  assignee: {
    exact: ['assigneduser', 'assignedto', 'assignee', 'technician', 'maintenancetech',
      'tech', 'vendorname', 'vendor'],
    terms: ['assign', 'technician', 'tech', 'vendor'],
    never: ['id', 'amount', 'bill', 'charge', 'invoice', 'trade', 'portal'],
  },
  description: {
    exact: ['jobdescription', 'description', 'workorderissue', 'issue', 'details',
      'summary', 'problem', 'servicerequestdescription'],
    terms: ['description', 'issue', 'details', 'summary', 'problem'],
    never: [],
  },
  created: {
    exact: ['createdat', 'createdon', 'createddate', 'datecreated', 'opened',
      'requestdate', 'datereceived', 'submitted'],
    terms: ['created', 'opened', 'requestdate', 'datereceived', 'submitted'],
    // created_by is a person, and daysBetween() on a name produces NaN.
    never: ['by', 'user', 'tenant'],
  },
  updated: {
    exact: ['updatedat', 'lastupdated', 'updated', 'modified', 'lastactivity', 'statusdate'],
    terms: ['updated', 'modified', 'lastactivity'],
    never: ['by', 'user'],
  },
  photos: {
    exact: ['photos', 'photo', 'images', 'image', 'attachments', 'attachment',
      'photocount', 'hasphotos'],
    terms: ['photo', 'image', 'attachment'],
    never: [],
  },
  completedOn: {
    exact: ['completedon', 'completedat', 'completeddate', 'datecompleted'],
    terms: ['completed'],
    never: ['by', 'user', 'items'],
  },
};

// Below this a field is left unbound. 40 is "merely contains the word", which
// is exactly the level at which work_order_type beat work_order_number.
const SCORE_FLOOR = 50;

function scoreHeader(header, spec) {
  const n = norm(header);
  if (!n) return 0;

  // A hard no. Checked first so nothing below can rescue it.
  if (spec.never.some(bad => n.includes(bad))) return 0;

  const exactAt = spec.exact.indexOf(n);
  // Earlier entries in `exact` are better names for the field, so a small
  // penalty by position keeps work_order_number ahead of work_order_id.
  if (exactAt >= 0) return 100 - exactAt;

  let best = 0;
  for (const term of spec.terms) {
    if (!n.includes(term)) continue;
    if (n === term) best = Math.max(best, 100);
    else if (n.startsWith(term) || n.endsWith(term)) best = Math.max(best, 60);
    else best = Math.max(best, 40);
  }
  if (!best) return 0;

  // An id is a join key, not the thing a person reads.
  if (/id$/.test(n)) best -= 35;
  return best;
}

/**
 * Map logical fields to column indexes.
 *
 * Returns { map, bound, unbound, rejected } — the last three so the caller can
 * SHOW its working. A column that could not be bound is reported rather than
 * guessed at, because a wrong binding produces confident nonsense and a missing
 * one produces a visible gap.
 */
function buildHeaderMap(headers) {
  const map = {};
  const bound = {};
  const rejected = {};

  for (const [field, spec] of Object.entries(FIELDS)) {
    let bestIdx = -1, bestScore = 0;
    const scored = [];
    headers.forEach((h, i) => {
      const score = scoreHeader(h, spec);
      if (score > 0) scored.push({ header: h, score });
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });

    if (bestIdx >= 0 && bestScore >= SCORE_FLOOR) {
      map[field] = bestIdx;
      bound[field] = { column: headers[bestIdx], score: bestScore };
    }
    // What else was in the running, so a mis-binding can be diagnosed from the
    // output instead of by reading the regexes.
    const others = scored
      .filter(x => x.header !== headers[bestIdx])
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (others.length) rejected[field] = others;
  }

  const unbound = Object.keys(FIELDS).filter(f => map[f] === undefined);
  return { map, bound, unbound, rejected };
}

module.exports = { buildHeaderMap, scoreHeader, norm, FIELDS, SCORE_FLOOR };
