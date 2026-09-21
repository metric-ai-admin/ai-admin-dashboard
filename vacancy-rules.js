// =====================================================================
// Unit Vacancy Posting — rules engine.
//
// Decides which units should be REMOVED from AppFolio website/internet
// postings and which should be ADDED, from the unit_vacancy report.
//
// Pure functions, no I/O, no server or network dependencies: the caller
// passes rows in and gets a decision out. That is deliberate. This codebase
// has twice shipped a model doing arithmetic and twice had to take it back
// (call-grading scores off by ±20; the Collections "decreased" section
// listing accounts whose balance had gone UP). These rules are entirely
// deterministic, so they live in code where they can be unit-tested.
//
// The one genuinely fuzzy input — the free-text `description` — is handled
// by an explicit keyword list, and anything it cannot classify is surfaced
// for a human rather than guessed at. See classifyDescription.
//
// Spec confirmed with Lyndsay via Arturo, 2026-09-21.
// =====================================================================

// Rule 1 — never post these, whatever else is true of them.
const RENTED_STATUSES = ['Vacant-Rented', 'Notice-Rented'];

// Rule 1 — description indicates the unit is not ready.
//
// Tuned against every non-blank description in the 2026-09-21 pull (24 of 157
// units had one at all, 22 of which were genuinely not-ready). Lyndsay's
// examples were "model unit" and "do not rent", but the real text is almost
// all free-form maintenance: "Needs Condensor - otherwise ready - $2000",
// "Severe Pest Infestation", "No electricity cause the city removed the meter".
//
// This list WILL drift as people write new notes. That is why an unmatched
// description does not mean "ready" — it means "ask a human" (needsReview).
const NOT_READY_KEYWORDS = [
  'model unit', 'do not rent', 'reno unit', 'renovation', 'down/burn', 'down unit',
  'burned', 'burn unit', 'heavy turn', 'needs', 'missing', 'broken', 'no electricity',
  'power needs', 'power issue', 'pest', 'hvac', 'leak', 'lifting', 'pending cleaning',
  'will be ready', 'boarded', 'not ready', 'replacement', 'replaced',
];

/**
 * Classify a free-text description.
 *   'ready'  — no description at all; nothing to act on.
 *   'not_ready' — matched a keyword; excluded from posting decisions.
 *   'review' — has text we could not classify; held out and shown to a human.
 *
 * A unit we cannot classify is deliberately held OUT of the ranking entirely:
 * it is neither added nor removed. Posting a unit that turns out to be
 * uninhabitable is far worse than leaving a posting alone for a day.
 */
function classifyDescription(description) {
  const d = String(description || '').trim().toLowerCase();
  if (!d) return 'ready';
  return NOT_READY_KEYWORDS.some(k => d.includes(k)) ? 'not_ready' : 'review';
}

const isPosted = row => row.posted_to_website === 'Yes' || row.posted_to_internet === 'Yes';

/**
 * Floor plan key. `unit_type` is the floor plan, but 16 of 157 units had it
 * blank in the first real pull, and a single catch-all blank bucket would
 * group a studio with a 3-bed. Falls back to bed_and_bath ("2/1.00"), which
 * is populated for most of them, then to a marker that keeps them separate
 * from genuinely-typed units.
 */
function floorPlanKey(row, normalize) {
  const type = String(row.unit_type || '').trim();
  if (type) return normalize ? normalize(type) : type;
  const bb = String(row.bed_and_bath || '').trim();
  if (bb) return `${bb} (by bed/bath)`;
  return '(unspecified)';
}

/**
 * Optional normalizer that collapses per-floor variants of one layout.
 *
 * AppFolio's unit_type encodes the floor at some properties: Windy Hill has
 * "One Bedroom / One Bath 1st Floor", "… 2nd Floor" and "… 3rd Floor" for what
 * is one floor plan. Left alone, the 3-per-floor-plan cap allows NINE postings
 * there instead of three.
 *
 * OPEN QUESTION with Lyndsay as of 2026-09-21 — is a floor plan the unit_type
 * verbatim, or the layout regardless of floor? Not enabled by default, because
 * turning it on takes Windy Hill's one-bedrooms from 3 over cap to 13 and would
 * quietly multiply the removals. Pass it as `floorPlanNormalizer` (or set
 * VACANCY_COLLAPSE_FLOORS=true at the route) once she decides.
 */
const collapseFloorVariants = type =>
  String(type || '').replace(/\s*\b(\d+(st|nd|rd|th)|ground|basement|top)\s+floor\b/i, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Rule 3 — priority tier. Lower is better.
 *   1  Rent Ready = Yes AND Ready For Showing On is in the past
 *   2  Rent Ready = Yes (any/!no showing date)
 *   3  Ready For Showing On in the past, Rent Ready = No
 *   4  everything else
 */
function priorityTier(row, today) {
  const rentReady = row.rent_ready === 'Yes';
  const showing = row.ready_for_showing_on || null;
  const showable = !!showing && showing < today;
  if (rentReady && showable) return 1;
  if (rentReady) return 2;
  if (showable) return 3;
  return 4;
}

// Tiebreaker — earliest Ready For Showing On first, BLANKS LAST (no confirmed
// showing date is the weakest signal, confirmed 2026-09-21). unit_id breaks
// the remaining ties so the output is stable between runs; an unstable order
// would silently change which units get removed.
function compareRows(a, b, today) {
  const t = priorityTier(a, today) - priorityTier(b, today);
  if (t !== 0) return t;
  const da = a.ready_for_showing_on || '';
  const db = b.ready_for_showing_on || '';
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? -1 : 1;
  }
  // Stability bias, filling a gap the spec leaves open. When two units are
  // identical on every ranking signal, prefer the one that is ALREADY posted.
  //
  // This is not cosmetic. At Windy Hill all 16 one-bedroom units are tier 1,
  // Rent Ready, and share the same 2026-01-15 showing date, so the order was
  // decided purely by unit_id — which meant recommending that a posted unit be
  // pulled and two equally-ranked unposted ones put up in its place, for no
  // gain. Churning live listings between indistinguishable units costs real
  // marketing continuity. Ties now leave the current state alone.
  const pa = isPosted(a), pb = isPosted(b);
  if (pa !== pb) return pa ? -1 : 1;
  return String(a.unit_id || '').localeCompare(String(b.unit_id || ''), undefined, { numeric: true });
}

const MAX_PER_FLOOR_PLAN = 3;

/**
 * Run the rules.
 *
 * @param {Array<object>} rows   unit_vacancy report rows.
 * @param {object}  opts
 * @param {string}  opts.today            YYYY-MM-DD, Central date.
 * @param {Function} opts.isExcludedProperty  (propertyName) => boolean. Injected
 *        rather than imported so there is ONE exclusion list in the codebase
 *        (server.js's propertyIsExcluded) and this module stays dependency-free.
 * @param {number}  [opts.maxPerFloorPlan]
 *
 * @returns {{remove, add, needsReview, excluded, groups, stats}}
 *   remove — currently posted, ranked outside the top N. These are the unit_ids
 *            the Realm-X prompt will carry.
 *   add    — not currently posted, ranked inside the top N.
 */
function analyzeVacancy(rows, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const isExcludedProperty = opts.isExcludedProperty || (() => false);
  const cap = opts.maxPerFloorPlan || MAX_PER_FLOOR_PLAN;

  const excluded = [];   // dropped before ranking, with the reason
  const needsReview = [];
  const pool = [];

  for (const row of rows || []) {
    const property = row.property_name || row.property || '';
    if (isExcludedProperty(property)) {
      excluded.push({ ...row, _reason: 'Property excluded (inactive/sold/not managed)' });
      continue;
    }
    if (RENTED_STATUSES.includes(String(row.unit_status || ''))) {
      excluded.push({ ...row, _reason: `Unit status is ${row.unit_status}` });
      continue;
    }
    const desc = classifyDescription(row.description);
    if (desc === 'not_ready') {
      excluded.push({ ...row, _reason: `Description indicates not ready: "${String(row.description).trim()}"` });
      continue;
    }
    if (desc === 'review') {
      // Held out of the ranking on purpose — see classifyDescription.
      needsReview.push({ ...row, _reason: `Description could not be classified: "${String(row.description).trim()}"`, _posted: isPosted(row) });
      continue;
    }
    pool.push(row);
  }

  // Group by property + floor plan, rank, then split at the cap.
  const groups = new Map();
  for (const row of pool) {
    const key = `${row.property_name || row.property || '?'}||${floorPlanKey(row, opts.floorPlanNormalizer)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const remove = [];
  const add = [];
  const groupSummaries = [];

  for (const [key, members] of groups) {
    const [property, floorPlan] = key.split('||');
    const ranked = [...members].sort((a, b) => compareRows(a, b, today));
    const keep = ranked.slice(0, cap);
    const rest = ranked.slice(cap);

    for (const row of keep) {
      // Should be posted. If it is not, it is an ADD candidate.
      if (!isPosted(row)) add.push({ ...row, _property: property, _floorPlan: floorPlan, _tier: priorityTier(row, today) });
    }
    for (const row of rest) {
      // Should not be posted. Only act if it actually IS posted — an unposted
      // unit outside the top N is already correct and needs no action (rule 1).
      if (isPosted(row)) remove.push({ ...row, _property: property, _floorPlan: floorPlan, _tier: priorityTier(row, today) });
    }

    groupSummaries.push({
      property, floorPlan,
      total: ranked.length,
      posted: ranked.filter(isPosted).length,
      keeping: keep.length,
      overCap: rest.length,
    });
  }

  // Stable, human-readable ordering for the UI and the ID list.
  const byPlace = (a, b) => (a._property || '').localeCompare(b._property || '')
    || (a._floorPlan || '').localeCompare(b._floorPlan || '')
    || compareRows(a, b, today);
  remove.sort(byPlace);
  add.sort(byPlace);
  groupSummaries.sort((a, b) => a.property.localeCompare(b.property) || a.floorPlan.localeCompare(b.floorPlan));

  return {
    remove,
    add,
    needsReview,
    excluded,
    groups: groupSummaries,
    stats: {
      today,
      inputRows: (rows || []).length,
      excluded: excluded.length,
      needsReview: needsReview.length,
      ranked: pool.length,
      floorPlanGroups: groupSummaries.length,
      remove: remove.length,
      add: add.length,
      currentlyPosted: (rows || []).filter(isPosted).length,
    },
  };
}

/** Rule 4 — comma-separated numeric unit IDs, nothing else. */
const removalIdList = result => result.remove.map(r => r.unit_id).join(',');

/** Rule 5 — the exact text pasted into Realm-X. */
const realmXPrompt = result => `Bulk remove the following unit IDs: ${removalIdList(result)}. Click confirm.`;

module.exports = {
  analyzeVacancy,
  classifyDescription,
  floorPlanKey,
  collapseFloorVariants,
  priorityTier,
  compareRows,
  removalIdList,
  realmXPrompt,
  isPosted,
  RENTED_STATUSES,
  NOT_READY_KEYWORDS,
  MAX_PER_FLOOR_PLAN,
};
