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
const STATUS_FIELDS = ['eviction_status', 'eviction_stage', 'evictionstatus', 'status'];
const NAME_FIELDS = ['tenant_name', 'name', 'tenant', 'occupant_name', 'resident_name'];

// The first field present on these rows, or null.
function pickField(rows, candidates) {
  const sample = (rows || []).find(r => r && typeof r === 'object');
  if (!sample) return null;
  const present = candidates.find(c => Object.prototype.hasOwnProperty.call(sample, c));
  if (present) return present;
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
  const resolve = o.resolve || (r => clean(r.property_name));
  const name = o.name || (r => clean(nameField ? r[nameField] : (r.tenant_name || r.name)));
  const status = o.status || (r => clean(statusField ? r[statusField] : r.eviction_status));
  const isDelinquent = o.isDelinquent || null;

  const out = {};
  const stats = {
    rows: (rows || []).length,
    statusField, nameField,
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

module.exports = { MODES, DEFAULT_MODE, STATUS_FIELDS, NAME_FIELDS,
  mode, isEho, hasStage, needsFiling, pickField, countFrom, diagnose, clean };
