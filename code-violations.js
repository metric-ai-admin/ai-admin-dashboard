// =====================================================================
// Code Violations Tracker — rules, per Jay Manuel's build spec.
//
// Pure functions, no I/O, same as vacancy-rules.js / weekly-brief.js.
//
// THE GRAIN IS ONE ROW PER CITED DEFICIENCY, NOT PER WORK ORDER. This is the
// rule everything else follows from. Case Number and Work Order both repeat —
// in the 09/17 workbook, 67 deficiencies sit across 24 work orders, and WO
// 22882-1 alone carries three separate citations at three addresses. Neither
// column is a key, so `deficiencyKey()` builds the stable composite Jay
// specified instead.
//
// AND IT IS WHY THIS IS NOT A SYNCED REPORT. Jay's saved report was probed
// live on 2026-09-23: the bare UUID answers 400 "Id is not a valid report",
// the joined_reports path answers 404. Saved-report UUIDs are unreachable from
// Reports API v2 (the same finding recorded against tenant_tickler). Unlike
// tenant_tickler there is no base report to fall back to, because work_order
// returns one row per work order — the wrong grain by definition. So the
// tracker is a Supabase table fed by import and by hand.
//
// ---------------------------------------------------------------------
// THE THREE OPEN QUESTIONS, ANSWERED BY JAY 2026-09-23.
//
//   1. WHO MAY SET "Closed by Code Compliance"?  Jay and Bekah only.
//      Enforced on the route, not here, because it is an authorisation
//      question rather than a rule about the data. Erick (role 'maintenance')
//      can move a row through every other status but not this one — it is the
//      status that gets reported to a city, so it needs the two people who
//      talk to the city. It is still never auto-mapped, and the table records
//      closed_by/closed_at, so the claim always has a name behind it.
//
//      WORTH KNOWING: Jay's role in dashboard_users is `admin`, not a role of
//      his own, so the gate is admin + regional_director — which also admits
//      Arturo and Lyndsay. Narrowing it to literally two people needs a named
//      allowlist like CALL_ANALYZER_USERS; say the word and it is one line.
//
//   2. DOES THIS REPLACE THE WORKBOOK?  Yes. Jay maintains the tracker in the
//      dashboard from here on; there is no mirror mode and nothing writes back
//      to Excel. The importer stays because it is how the existing 67 rows get
//      in once, and because being idempotent costs nothing — but after the
//      seed it is not expected to run again. `source` therefore defaults to
//      'manual' now rather than 'excel'.
//
//   3. WHERE DO CITY NOTICES AND COMPLETION PHOTOS LIVE?  As links, one for
//      the city notice and one for the completion photo. Links rather than
//      uploads on purpose: the documents already exist somewhere — an AppFolio
//      work-order photo, the city's portal, SharePoint — and copying them here
//      would make a second copy that has to be kept in step with the first. A
//      link points at the original and cannot go stale in that particular way.
//      validateLink() below keeps them to http(s) only.
//
// =====================================================================

// Exactly seven, enforced. Anything else is a data error, not a new status.
const STATUSES = [
  'Pending',
  'Assigned - No Activity',
  'Assigned - In Progress',
  'Assigned - Reassignment Needed',
  'Completed - No Need to Bill',
  'Completed by Maintenance',
  'Closed by Code Compliance',
];

// Every one appears in the UI even at zero. A property with no violations is a
// fact worth showing; a property missing from the list looks like an oversight.
//
// The Sidney came out 2026-09-23 — Metric no longer manages it. Note that it
// was ALREADY in METRIC_EXCLUDED_PROPERTY_FRAGMENTS in server.js, so every
// other module had stopped counting it while this list still named it. That is
// why buildTracker now takes isExcludedProperty and filters this list through
// it: two hand-maintained lists of the same thing drift, and this one drifted.
const PROPERTIES = [
  'Ascent at Northgate', 'Sunset Palms', 'Windy Hill Apartment',
  'iConic Round Rock', 'iConic Downtown', 'The Chateau', 'The Highlander',
  'Hyde Park Square',
];

const OPEN_STATUSES = STATUSES.filter(s => !/^Completed|^Closed/.test(s));

const clean = s => String(s == null ? '' : s).trim();
const lower = s => clean(s).toLowerCase();

// Accepts 2026-04-28 and 04/28/2026; anything else is not a date.
function isoDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// "Installation (Sec. 605.1) - Three electrical disconnect boxes…" → "605.1".
// Part of the composite key, so two citations under different sections at the
// same address stay two rows.
function codeSection(description) {
  const m = clean(description).match(/\bSec(?:tion)?\.?\s*([0-9][0-9A-Za-z.\-()]*)/i);
  return m ? m[1].replace(/[.)]+$/, '') : '';
}

// FNV-1a, 32-bit, hex. Not cryptographic and does not need to be: this is an
// identity for a row, not a secret. Deterministic across processes and short
// enough to read in a URL, which a UUID over the same fields would not be.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The stable composite key: case number + work order + building/unit + code
 * section — plus the deficiency text.
 *
 * THE FIFTH FIELD IS AN ADDITION TO JAY'S SPEC, forced by the data. Run against
 * the 09/17 workbook, the four fields Jay named collide on a real pair:
 *
 *   2026-072495 CV | 22872-1 | 1830 W Rundberg Ln - BLDG 03 | Sec. 304.13
 *     "Deteriorated roof hatch wood frame at building 3."
 *     "Multiple window frames at building 3 are deteriorated on the front side."
 *
 * Two separate citations, same case, same work order, same building, same code
 * section. With a four-part key one of them silently overwrites the other on
 * import — a cited deficiency disappearing from a compliance tracker, which is
 * the one failure this module cannot have. The text is what distinguishes them,
 * so the text is in the key.
 *
 * THE COST, worth knowing: editing a description creates a new row rather than
 * updating the old one. That is the right way round for a tracker whose text is
 * transcribed verbatim from AppFolio citations and rarely retyped, but it is a
 * trade-off Jay should confirm.
 *
 * Normalised (case, whitespace) so a retyped address does not fork a row, and
 * prefixed with the property so a collision across properties stays visibly
 * wrong rather than silently merging two buildings.
 */
function deficiencyKey(row = {}) {
  const parts = [
    row.case_number, row.work_order, row.address_unit,
    row.code_section || codeSection(row.deficiency_description),
    row.deficiency_description,
  ].map(p => lower(p).replace(/\s+/g, ' '));
  return `${lower(row.property_name).replace(/\s+/g, ' ')}:${hash32(parts.join('|'))}`;
}

/**
 * AppFolio status → one of the seven. Per Jay:
 *   Estimate Requested / New            → Pending
 *   Assigned, no logged activity        → Assigned - No Activity
 *   Assigned with activity / Scheduled /
 *   Waiting                             → Assigned - In Progress
 *   Work Done / Completed               → Completed by Maintenance
 *   Closed by Code Compliance           → NEVER auto-mapped; humans only
 *
 * Returns null when nothing maps, so the caller keeps whatever a person last
 * set rather than overwriting it with a guess.
 */
function mapAppfolioStatus(appfolioStatus, { hasActivity = false } = {}) {
  const s = lower(appfolioStatus);
  if (!s) return null;
  // Checked first: "Completed No Need To Bill" also matches /complete/, and it
  // is its own status in the seven.
  if (/no need to bill/.test(s)) return 'Completed - No Need to Bill';
  if (/estimate requested|^new$/.test(s)) return 'Pending';
  if (/work done|complete/.test(s)) return 'Completed by Maintenance';
  if (/scheduled|waiting/.test(s)) return 'Assigned - In Progress';
  if (/assigned/.test(s)) return hasActivity ? 'Assigned - In Progress' : 'Assigned - No Activity';
  // "Closed by Code Compliance" lands here on purpose. A city closing a case is
  // a statement about the city's records, and nothing in AppFolio can know it.
  return null;
}

// Text that claims the work is done. Used to spot a claim with nothing behind
// it — see unverifiedClosure.
const CLAIMS_DONE = /\b(complete[d]?|done|resolved|closed|finished|cleared|repaired|fixed)\b/i;
// …unless it is explicitly the opposite.
const DENIES_DONE = /\b(not|never|un)(\s|-)?(complete|done|resolved|closed|finished|cleared)/i;

/**
 * Jay's flag: "Completed by Maintenance + bill raised same minute + no field
 * record" = unverified closure, human review required before anything is
 * reported to the city or an owner.
 *
 * Each of the three on its own is ordinary. Together they describe a row that
 * was marked finished and billed in one action with nothing recorded between
 * them — which is exactly what a closure looks like when the work was not
 * checked. This returns a reason, never a judgement: somebody still has to go
 * and look.
 *
 * `sameMinute` is deliberately a parameter rather than something derived here.
 * The completion and billing timestamps live in AppFolio, not in the workbook,
 * and inventing the comparison from dates alone would produce a flag that
 * cannot be traced back to anything.
 */
function unverifiedClosure(row = {}, { completedAt = null, billedAt = null } = {}) {
  const status = clean(row.status);
  if (!/^Completed/.test(status)) return { flagged: false, reason: '' };

  const reasons = [];

  if (completedAt && billedAt) {
    const gap = Math.abs(new Date(billedAt) - new Date(completedAt));
    if (Number.isFinite(gap) && gap < 60000) reasons.push('billed within a minute of being marked complete');
  }

  const record = [row.completed_items, row.maintenance_remarks, row.progress_notes]
    .map(clean).filter(Boolean).join(' ');
  if (!record || /^none( yet)?\.?$/i.test(clean(row.completed_items) || '')) {
    reasons.push('no field record of the work');
  }

  // A note that says "closed" while the completed-items column says "None yet"
  // is the paperwork disagreeing with itself.
  const notes = clean(row.progress_notes);
  if (notes && CLAIMS_DONE.test(notes) && !DENIES_DONE.test(notes) && !clean(row.completed_items)) {
    reasons.push('notes claim completion but nothing is recorded as completed');
  }

  return { flagged: reasons.length > 0, reason: reasons.join('; ') };
}

// A city deadline that has passed, on a row that is still open. A completed or
// closed row is not "late" — the deadline stopped mattering when it was done.
function pastDeadline(row = {}, today) {
  const due = isoDate(row.due_date);
  if (!due) return false;
  if (!OPEN_STATUSES.includes(clean(row.status))) return false;
  return due < (today || new Date().toISOString().slice(0, 10));
}

/**
 * Everything the tracker view needs, computed once.
 * @param {object[]} rows   code_violations rows
 * @param {object} opts     today (YYYY-MM-DD), filters {property,status,category,month,year}
 */
function buildTracker(rows = [], opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const f = opts.filters || {};
  // Injected by server.js so the single exclusion list stays single. Without it
  // the property list here is the only authority, which is how The Sidney went
  // on being counted after everything else had dropped it.
  const isExcluded = opts.isExcludedProperty || (() => false);
  const properties = PROPERTIES.filter(p => !isExcluded(p));

  const decorated = rows.map(r => {
    const due = isoDate(r.due_date);
    const defDate = isoDate(r.deficiency_date);
    return {
      ...r,
      due_date: due,
      deficiency_date: defDate,
      code_section: clean(r.code_section) || codeSection(r.deficiency_description),
      pastDeadline: pastDeadline({ ...r, due_date: due }, today),
      // Month and year are derived from the deficiency date rather than stored,
      // so a row cannot disagree with itself the way a spreadsheet column can.
      month: defDate ? Number(defDate.slice(5, 7)) : null,
      year: defDate ? Number(defDate.slice(0, 4)) : null,
    };
  });

  const match = r =>
    (!f.property || r.property_name === f.property)
    && (!f.status || r.status === f.status)
    && (!f.category || r.category === f.category)
    && (!f.month || r.month === Number(f.month))
    && (!f.year || r.year === Number(f.year));

  const filtered = decorated.filter(match)
    .sort((a, b) =>
      (a.property_name || '').localeCompare(b.property_name || '')
      || (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1)
      || String(a.due_date).localeCompare(String(b.due_date))
      || String(a.deficiency_date).localeCompare(String(b.deficiency_date)));

  // Summary counts every status, including the zeros — a status showing 0 is
  // information, and omitting it makes the total impossible to check by eye.
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  filtered.forEach(r => { if (byStatus[r.status] !== undefined) byStatus[r.status]++; });

  // Every property appears, at zero if it has nothing.
  const byProperty = properties.map(name => {
    const own = filtered.filter(r => r.property_name === name);
    return {
      property: name,
      total: own.length,
      open: own.filter(r => OPEN_STATUSES.includes(r.status)).length,
      pastDeadline: own.filter(r => r.pastDeadline).length,
      unverified: own.filter(r => r.unverified_closure).length,
      byStatus: Object.fromEntries(STATUSES.map(s => [s, own.filter(r => r.status === s).length])),
    };
  });

  // Rows whose property is not one of the nine — a typo or a new property, and
  // either way something a person should see rather than have silently dropped.
  const unknownProperties = [...new Set(
    filtered.filter(r => !properties.includes(r.property_name)).map(r => r.property_name))];

  return {
    rows: filtered,
    today,
    summary: {
      total: filtered.length,
      byStatus,
      open: filtered.filter(r => OPEN_STATUSES.includes(r.status)).length,
      pastDeadline: filtered.filter(r => r.pastDeadline).length,
      unverified: filtered.filter(r => r.unverified_closure).length,
    },
    byProperty,
    unknownProperties,
    // Drives the filter dropdowns from the data rather than a hard-coded list,
    // so a new category appears without a code change.
    facets: {
      properties,
      statuses: STATUSES,
      categories: [...new Set(decorated.map(r => clean(r.category)).filter(Boolean))].sort(),
      years: [...new Set(decorated.map(r => r.year).filter(Boolean))].sort((a, b) => b - a),
    },
  };
}

/**
 * Evidence links. http(s) only — a javascript: or data: URL in a field that is
 * rendered as an anchor is a script waiting to be clicked, and no legitimate
 * city notice or photo is ever anything else. Returns null for blank, so
 * clearing a link works the same way as never setting one.
 */
function validateLink(v) {
  const s = clean(v);
  if (!s) return { ok: true, url: null };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'Not a valid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Links must start with http:// or https://' };
  return { ok: true, url: u.href };
}

/**
 * Normalise one workbook row into the table's shape, computing the key and the
 * flag. Rejects rather than coerces an unknown status: the seven are enforced,
 * and quietly mapping an eighth would hide a data problem.
 */
function normaliseImportRow(raw = {}, opts = {}) {
  const row = {
    property_name: clean(raw.property_name),
    case_number: clean(raw.case_number) || null,
    work_order: clean(raw.work_order) || null,
    address_unit: clean(raw.address_unit) || null,
    code_section: codeSection(raw.deficiency_description) || null,
    deficiency_date: isoDate(raw.deficiency_date),
    deficiency_description: clean(raw.deficiency_description) || null,
    category: clean(raw.category) || null,
    status: clean(raw.status),
    due_date: isoDate(raw.due_date),
    notice_date: isoDate(raw.notice_date),
    pending_items: clean(raw.pending_items) || null,
    completed_items: clean(raw.completed_items) || null,
    maintenance_remarks: clean(raw.maintenance_remarks) || null,
    client_vendor_remarks: clean(raw.client_vendor_remarks) || null,
    progress_notes: clean(raw.progress_notes) || null,
    city_notice_url: null,
    completion_photo_url: null,
    source: opts.source || 'excel',
  };

  for (const field of ['city_notice_url', 'completion_photo_url']) {
    const link = validateLink(raw[field]);
    if (!link.ok) return { ok: false, error: `${field}: ${link.error}` };
    row[field] = link.url;
  }

  if (!row.property_name) return { ok: false, error: 'Missing property name' };
  if (!STATUSES.includes(row.status)) {
    return { ok: false, error: `Unknown status "${row.status || '(blank)'}" — must be one of the seven` };
  }

  row.deficiency_key = deficiencyKey(row);
  const flag = unverifiedClosure(row, opts.timestamps || {});
  row.unverified_closure = flag.flagged;
  row.unverified_reason = flag.reason || null;
  return { ok: true, row };
}

/**
 * Decide what an import may write to a row that already exists.
 *
 * THE BUG THIS REPLACES. The import upserted the whole normalised row, status
 * included, so re-running the workbook overwrote every status a person had set
 * and stamped updated_by with the importer's name. There was no trace that the
 * manual value had ever existed.
 *
 * THE RULE. A row is "held" once somebody has set its status through the PATCH
 * route, which records status_set_at. For a held row the person's status stays,
 * and a DIFFERENT incoming status is parked in pending_import_status for them
 * to accept or reject. For every other row the import writes as before — the
 * workbook is still the source for the rows nobody has touched, and locking it
 * out of those would break the thing the import is for.
 *
 * SCOPE. Status is what Jay asked for, and status is what gets the accept /
 * reject treatment. But the same upsert also overwrites pending_items,
 * progress_notes and due_date, which are equally hand-edited, so on a held row
 * those are preserved too when the person has filled them in — silently losing
 * Bekah's notes while advertising that we had fixed the overwrite would be
 * worse than the original bug. They are preserved, not staged: there is no
 * meaningful "accept the spreadsheet's version of a free-text note".
 *
 * Pure: takes the stored row and the incoming row, returns the patch to write.
 * No clock of its own — `now` is passed in.
 */
const IMPORT_PRESERVED_FIELDS = ['pending_items', 'progress_notes', 'due_date'];

function resolveImportRow(stored, incoming, { now = new Date().toISOString(), source = 'excel' } = {}) {
  // Unknown row: nothing to protect.
  if (!stored) return { row: { ...incoming }, flagged: false, preserved: [] };

  const held = !!stored.status_set_at;
  if (!held) {
    // Never touched by a person. The workbook wins, which is the default that
    // keeps the import useful. Any stale pending flag is cleared.
    return {
      row: { ...incoming, pending_import_status: null, pending_import_at: null, pending_import_source: null },
      flagged: false,
      preserved: [],
    };
  }

  const row = { ...incoming };

  // The human's status stands.
  row.status = stored.status;
  row.status_set_by = stored.status_set_by;
  row.status_set_at = stored.status_set_at;
  // closed_by / closed_at belong to the manual close and must not be reverted
  // to whatever the spreadsheet carried.
  row.closed_by = stored.closed_by;
  row.closed_at = stored.closed_at;

  // Hand-entered free text and the city's deadline, kept where the person has
  // actually filled them in. An empty manual field takes the import's value.
  const preserved = [];
  for (const field of IMPORT_PRESERVED_FIELDS) {
    const manual = stored[field];
    if (manual !== null && manual !== undefined && String(manual).trim() !== ''
      && String(manual) !== String(incoming[field] == null ? '' : incoming[field])) {
      row[field] = manual;
      preserved.push(field);
    }
  }

  const incomingStatus = clean(incoming.status);
  const disagrees = !!incomingStatus && incomingStatus !== clean(stored.status);
  if (disagrees) {
    row.pending_import_status = incomingStatus;
    row.pending_import_at = now;
    row.pending_import_source = source;
  } else {
    // The spreadsheet has caught up with the person; nothing left to decide.
    row.pending_import_status = null;
    row.pending_import_at = null;
    row.pending_import_source = null;
  }

  return { row, flagged: disagrees, preserved };
}

/**
 * Apply a person's answer to a parked status.
 *
 * 'keep'  — the manual status stands; the parked value is discarded.
 * 'sync'  — the spreadsheet's value becomes the status, and it becomes the new
 *           manually-held value. Deliberately: someone chose it, so a later
 *           import must not silently overwrite it either.
 */
function resolveConflict(stored, decision, { by = 'Dashboard', now = new Date().toISOString() } = {}) {
  if (!stored || !stored.pending_import_status) {
    return { ok: false, error: 'That row has no import to resolve.' };
  }
  if (decision === 'keep') {
    return {
      ok: true,
      patch: {
        pending_import_status: null, pending_import_at: null, pending_import_source: null,
        updated_at: now, updated_by: by,
      },
    };
  }
  if (decision === 'sync') {
    const next = stored.pending_import_status;
    if (!STATUSES.includes(next)) {
      return { ok: false, error: `"${next}" is not one of the seven statuses.` };
    }
    return {
      ok: true,
      status: next,
      patch: {
        status: next,
        status_set_by: by, status_set_at: now,
        pending_import_status: null, pending_import_at: null, pending_import_source: null,
        updated_at: now, updated_by: by,
      },
    };
  }
  return { ok: false, error: 'Decision must be "keep" or "sync".' };
}

module.exports = {
  resolveImportRow, resolveConflict, IMPORT_PRESERVED_FIELDS,
  STATUSES, PROPERTIES, OPEN_STATUSES,
  isoDate, codeSection, hash32, deficiencyKey,
  mapAppfolioStatus, unverifiedClosure, pastDeadline, validateLink,
  buildTracker, normaliseImportRow,
};
