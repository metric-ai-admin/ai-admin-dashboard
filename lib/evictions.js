// Evictions, from Occupancy Custom Fields.
//
// WHY THIS IS NOT READ OFF THE DELINQUENCY REPORT. delinquency_as_of does not
// return the eviction columns — they come back blank on every row — so
// needToFile could only ever be zero on our side while Katie read 13 for the
// same week. The stage lives in Occupancy Custom Fields, which is the report
// her "tenant custom fields" tab is built from.
//
// WHAT COUNTS AS "IN PROCESS" IS A DECISION, NOT A FACT.
//
// Her figure counts every delinquent resident carrying ANY Eviction Status.
// On the 2026-10-12 export that is 34, and 32 of the 120 residents with a
// status are marked "EHO Signed / Good Standing" — people keeping to a payment
// agreement, who are not being evicted in any ordinary sense. Excluding them
// gives 2.
//
// Both numbers are defensible and they are four days apart in meaning, so the
// rule is a setting rather than something buried in a conditional. It defaults
// to HERS, because the report's job is to replace hers without an owner
// noticing a change, and the EHO count travels separately so Kara can see
// exactly what the choice is worth before making it.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// Statuses that mean "on an agreement and keeping to it". Matched loosely
// because the spelling varies in the data: "EHO Signed/Good Standing" with and
// without a space around the slash.
const EHO_RE = /eho|good\s*standing/i;

// 'all' — every resident with an Eviction Status set. Lyndsay's figure.
// 'excluding-eho' — the same, minus those on a payment agreement.
const MODES = ['all', 'excluding-eho'];
const DEFAULT_MODE = 'all';

function mode(raw) {
  const m = clean(raw).toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

const isEho = status => EHO_RE.test(clean(status));
const hasStage = status => clean(status) !== '';
// "Need To Refile" is the same queue as "Need To File Eviction" — a stage
// spelled two ways would split one queue into two.
const needsFiling = status => /need\s*to\s*(re)?file/i.test(clean(status));

// Column names this report might use for the stage and the resident.
//
// NOT GUESSED ONE AT A TIME. The first wiring read `eviction_status` and
// nothing else, so a report calling it anything else produced a silent zero
// that looked exactly like "nobody is in eviction". Which name was found is
// reported, so the next person does not have to find out by elimination.
const STATUS_FIELDS = ['eviction status', 'eviction stage', 'eviction'];
const NAME_FIELDS = ['tenant name', 'name', 'tenant', 'occupant name', 'resident name'];
const PROPERTY_FIELDS = ['property id', 'property name', 'property'];

// MATCHED ON THE NORMALISED NAME, not on an exact string.
//
// The first version listed snake_case spellings — eviction_status,
// eviction_stage, evictionstatus — and found none of them on 827 rows. These
// are CUSTOM FIELDS, and the report returns them under their human labels:
// "Eviction Status", with a capital and a space. No amount of guessing more
// snake_case variants would have reached it, and each guess costs a deploy and
// a round trip.
//
// So every key is normalised the same way the candidate is — lowercased, runs
// of non-alphanumerics collapsed to one space — and "Eviction Status",
// "eviction_status", "EvictionStatus" and "Eviction  Status" all land on the
// same answer. This is also why property_id was never going to resolve: it is
// "Property ID" on these rows.
const normKey = s => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The first candidate present on these rows, returned as the ACTUAL key so the
// caller can read it, or null.
//
// Scans every row rather than the first: these reports omit a column entirely
// on rows where it is empty, and the column being looked for is the one set on
// a minority.
function pickField(rows, candidates) {
  const wanted = (candidates || []).map(normKey);
  const seen = new Map();          // normalised -> the real key
  (rows || []).forEach(r => {
    if (!r || typeof r !== 'object') return;
    Object.keys(r).forEach(k => { if (!seen.has(normKey(k))) seen.set(normKey(k), k); });
  });
  for (const w of wanted) if (seen.has(w)) return seen.get(w);
  // Second pass with the separators removed entirely, so "EvictionStatus"
  // reaches "eviction status". camelCase carries no non-alphanumeric for the
  // first pass to collapse, and a key that differs only by the absence of a
  // space is the same column by any reading.
  const squashed = new Map();
  seen.forEach((real, n) => { squashed.set(n.replace(/ /g, ''), real); });
  for (const w of wanted) {
    const k = w.replace(/ /g, '');
    if (squashed.has(k)) return squashed.get(k);
  }
  return null;
}

// Count per property from the custom-fields rows, WITH A TALLY OF WHAT
// HAPPENED TO EVERY ROW.
//
// `resolve` turns a row into a property NAME: these rows carry Property ID and
// no name, so the caller passes lib/appfolio-properties.resolveProperty.
//
// `isDelinquent` is optional and is how her rule is reproduced exactly: she
// counts only residents who are ALSO on the delinquency sheet. Without it,
// every resident with a stage counts, which is a larger and different number.
//
// A zero here has four possible causes and they need different fixes: the
// store is empty, the stage column is called something else, the property id
// did not resolve, or nobody with a stage is on the delinquency sheet. A bare
// 0 cannot be told apart from "nobody is being evicted", which is the one
// reading that needs no action — so the counts travel with the result.
function countFrom(rows, opts) {
  const o = opts || {};
  const m = mode(o.mode);
  const statusField = o.statusField || pickField(rows, STATUS_FIELDS);
  const nameField = o.nameField || pickField(rows, NAME_FIELDS);
  const propertyField = o.propertyField || pickField(rows, PROPERTY_FIELDS);
  // `resolveValue` turns the raw cell into a property NAME — a property id
  // needs translating and a name does not, and only the caller knows the map.
  const resolveValue = o.resolveValue || (v => clean(v));
  const resolve = o.resolve
    || (r => resolveValue(propertyField ? r[propertyField] : (r.property_name || r.property)));
  const name = o.name || (r => clean(nameField ? r[nameField] : (r.tenant_name || r.name)));
  const status = o.status || (r => clean(statusField ? r[statusField] : r.eviction_status));
  const isDelinquent = o.isDelinquent || null;

  const out = {};
  const stats = {
    rows: (rows || []).length,
    statusField, nameField, propertyField,
    withStage: 0, unresolvedProperty: 0, notDelinquent: 0, counted: 0,
  };
  const bucket = p => {
    if (!out[p]) out[p] = { evictionsInProcess: 0, needToFile: 0, evictionsEho: 0 };
    return out[p];
  };

  (rows || []).forEach(r => {
    const st = status(r);
    if (!hasStage(st)) return;
    stats.withStage++;
    const p = resolve(r);
    if (!p) { stats.unresolvedProperty++; return; }
    if (isDelinquent && !isDelinquent(name(r), p)) { stats.notDelinquent++; return; }
    stats.counted++;
    const b = bucket(p);
    // The EHO slice is counted whichever mode is in force: the line exists so
    // somebody can see what the choice is worth, and it cannot do that if it
    // disappears under one of the two options.
    if (isEho(st)) b.evictionsEho++;
    if (m === 'excluding-eho' && isEho(st)) return;
    b.evictionsInProcess++;
    if (needsFiling(st)) b.needToFile++;
  });
  Object.defineProperty(out, '__stats', { value: stats, enumerable: false });
  return out;
}

// What to say about a tally, in words, or null when there is nothing to say.
function diagnose(stats) {
  if (!stats) return null;
  if (!stats.rows) return 'the Occupancy Custom Fields store is empty — sync it';
  if (!stats.statusField) {
    return 'no eviction-status column on those rows (looked for '
      + STATUS_FIELDS.join(', ') + ') — the report calls it something else';
  }
  if (!stats.withStage) {
    return stats.rows + ' rows, none with a value in "' + stats.statusField + '"';
  }
  if (!stats.counted) {
    const why = [];
    if (stats.unresolvedProperty) why.push(stats.unresolvedProperty + ' had a property id with no name in the map');
    if (stats.notDelinquent) why.push(stats.notDelinquent + ' are not on the delinquency sheet');
    return stats.withStage + ' rows carry a stage but none counted: ' + (why.join('; ') || 'reason unclear');
  }
  return null;
}

module.exports = { MODES, DEFAULT_MODE, STATUS_FIELDS, NAME_FIELDS, PROPERTY_FIELDS, normKey,
  mode, isEho, hasStage, needsFiling, pickField, countFrom, diagnose, clean };
