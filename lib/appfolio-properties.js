// AppFolio property ids, and the names everything else in this dashboard uses.
//
// WHY THIS EXISTS. Katie's workbook changed on 2026-10-12: four of its tabs
// now carry "Property ID" where they used to carry a property name — guest
// card inquiries, labor, MTD Labor and tenant custom fields — and Lyndsay's
// page builds its tabs off those numbers. A number is not a property to
// anything else here, so without a translation the comparison grew columns
// called "1703" and "26" sitting beside the real ones, each holding a slice of
// a real property's figures.
//
// WHERE THESE CAME FROM. Not typed from a list somebody remembered: read on
// 2026-10-12 out of the rows this dashboard had already synced, where each id
// travels next to its own name. Every one of the nine agreed across every
// table that carried it — leasing_occupancy, leasing_leads, leasing_showings,
// leasing_applications, leasing_lease_history and maintenance_work_orders —
// and no id mapped to two names. scripts/check-property-ids.js re-runs that
// check against live data.
//
// 1703 = Ascent and 1725 = Windy Hill were already known from other reports
// and both came out the same way here, which is the part that makes the other
// seven worth trusting.
// ALL SIXTEEN, not only the nine her workbook carries. The other seven are
// properties this dashboard syncs and her report does not cover — The Sidney
// in cession, two corporate entities, a one-off address, and the three that
// EXCLUDED_PROPERTIES / OUT_OF_SCOPE already drop from the report. They are
// here so that an id arriving from anywhere resolves to a name and the
// report's own exclusion lists decide whether it counts. Translating and
// excluding are different jobs, and a map that only knew nine would have made
// the eighth an "unknown id" question every week.
const BY_ID = {
  26: 'iConic Downtown',
  27: 'iConic Round Rock',
  38: 'The Sidney',
  43: 'Lily Pad Lane',
  44: 'Metric Property Management of Texas LLC',
  1465: 'Live With Metric',
  1466: '513 Wolf Ridge Georgetown, TX 78628',
  1703: 'Ascent at Northgate',
  1725: 'Windy Hill Apartment',
  1792: 'Brazos Lofts',
  1795: 'Sunset Palms',
  1812: 'The Chateau',
  1885: 'Hyde Park Square',
  1924: 'The Highlander',
  1925: '17th Street',
  1926: 'Cedar and Sage',
};

const VERIFIED_ON = '2026-10-12';

const clean = s => String(s == null ? '' : s).trim();

// Is this cell a bare AppFolio property id rather than a name?
//
// Digits only. A property whose NAME is a number would break this, and none
// is; a unit number reaching here would be a bug upstream and is better caught
// as an unknown id than silently accepted as a property.
const looksLikeId = v => /^\d+$/.test(clean(v));

function nameForId(id) {
  const k = clean(id);
  return Object.prototype.hasOwnProperty.call(BY_ID, k) ? BY_ID[k] : null;
}

// A property cell from any of her sheets, as a name.
//
// Handles the three shapes her workbook uses:
//   "Ascent at Northgate"                          a plain name
//   "Ascent at Northgate - 9315 Northgate Blvd …"  name with the address
//   "1703"                                          the id, new on 2026-10-12
//
// Returns null for anything it cannot place — a header string that leaked into
// the data, a blank, an id we have never seen. NULL IS THE POINT: the old
// behaviour was to accept whatever was in the cell, which is how "Property ID"
// and "1703" became properties with their own columns. A row that cannot be
// attributed must be dropped and counted, never guessed at.
function resolveProperty(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (looksLikeId(raw)) return nameForId(raw);
  // "Name - Address" → the part before the first " - ".
  const i = raw.indexOf(' - ');
  const name = i === -1 ? raw : raw.slice(0, i).trim();
  if (!name) return null;
  // Header text and totals rows reach here when a sheet's header row moves.
  if (/^(property|property name|property id|total|totals)$/i.test(name)) return null;
  return name;
}

// Every id that is not in the map, so a new property shows up as a question
// rather than as a missing column somebody notices three weeks later.
function unknownIds(values) {
  const seen = new Set();
  (values || []).forEach(v => {
    const raw = clean(v);
    if (looksLikeId(raw) && !nameForId(raw)) seen.add(raw);
  });
  return [...seen].sort((a, b) => Number(a) - Number(b));
}

module.exports = { BY_ID, VERIFIED_ON, nameForId, resolveProperty, looksLikeId, unknownIds, clean };
