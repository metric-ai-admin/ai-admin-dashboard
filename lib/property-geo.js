// Where the eight properties are.
//
// COPIED FROM public/app.js MAP_PROPERTIES, which is where the Coverage Map
// reads them and where they have been hardcoded since the module was ported.
// They are here as well because the on-call rotation runs on the SERVER and a
// constant in a browser bundle is not reachable from it.
//
// Two copies is a thing that drifts, so test/oncall-rotation.test.js asserts
// they still agree. The right fix is a column on property_assignments; until
// somebody geocodes the addresses into the table, the test is what keeps these
// two honest.
//
// The Sidney is in MAP_PROPERTIES and NOT here: the property is in cession and
// is being hidden in AppFolio, the same reason the Code Violations export
// leaves it out.

'use strict';

const PROPERTY_GEO = {
  'Hyde Park Square':     { lat: 30.3065, lng: -97.7434, address: '206 W. 38th St, Austin, TX 78705' },
  'The Chateau':          { lat: 30.2699, lng: -97.7608, address: '1211 W. 8th St, Austin, TX 78703' },
  'The Highlander':       { lat: 30.2805, lng: -97.7652, address: '803 Tirado St, Austin, TX 78703' },
  'Ascent at Northgate':  { lat: 30.3927, lng: -97.7077, address: '9315 Northgate Blvd, Austin, TX 78758' },
  'Sunset Palms':         { lat: 30.3620, lng: -97.7355, address: '902 Romeria Drive, Austin, TX 78757' },
  'Windy Hill Apartment': { lat: 29.9897, lng: -97.8763, address: '1049 Windy Hill Road, Kyle, TX 78640' },
  'iConic Round Rock':    { lat: 30.5175, lng: -97.6947, address: '105 Gattis School Rd, Round Rock, TX 78664' },
  'iConic Downtown':      { lat: 30.2549, lng: -97.7673, address: '301 S. Burnet St, Austin, TX 78703' },
};

// property_assignments spells Windy Hill the same way the KPI does; the
// Coverage Map does not. One alias rather than a matcher, for the reason
// lib/property-aliases.js gives.
const ALIASES = { 'Windy Hill': 'Windy Hill Apartment' };

function geoFor(name) {
  const n = String(name == null ? '' : name).trim();
  return PROPERTY_GEO[n] || PROPERTY_GEO[ALIASES[n]] || null;
}

// Names are matched WITHOUT ACCENTS and without case.
//
// technicians says "José Rentería"; property_assignments says "Jose Renteria".
// Exact-string matching silently drops his ownership of Windy Hill, which is
// the same failure shape as the tenant directory's phone columns — a match that
// finds nothing looks exactly like a person who owns nothing.
const normName = s => String(s == null ? '' : s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// GROUNDS WORK IS NOT ALWAYS MAINTENANCE WORK. Arturo, 2026-10-13: a grounds
// tech also maintains the property, so both columns name an owner — EXCEPT
// Fredy Ramirez, who only does grounds and is not on the on-call rotation at
// all. He is named here rather than inferred from his position, because the
// exception is about what he does, not about what he is called in the roster.
const GROUNDS_ONLY = ['Fredy Ramirez'].map(normName);

const splitNames = v => String(v == null ? '' : v).split(',').map(x => x.trim()).filter(Boolean);

/**
 * The on-call property list: every property with a location, carrying who owns
 * it and under which column. A property with no location is REPORTED, never
 * dropped — the rotation has to cover all eight, and a silent omission would
 * leave a building with nobody on call for it.
 */
function propertiesFrom(assignments) {
  const out = [];
  const missing = [];
  (assignments || []).forEach(a => {
    const name = String(a.property || '').trim();
    if (!name) return;
    const geo = geoFor(name);
    if (!geo) { missing.push(name); return; }

    const owners = [];
    const add = (who, role) => {
      if (GROUNDS_ONLY.includes(normName(who))) return;
      const seen = owners.find(o => normName(o.name) === normName(who));
      // Maintenance outranks grounds, so a person named in both columns is
      // recorded as maintenance — that is what the tiebreak reads.
      if (seen) { if (role === 'maintenance') seen.role = 'maintenance'; return; }
      owners.push({ name: who, role });
    };
    splitNames(a.maintenance_tech).forEach(n => add(n, 'maintenance'));
    splitNames(a.grounds_tech).forEach(n => add(n, 'grounds'));

    out.push({
      name,
      lat: geo.lat, lng: geo.lng, address: geo.address,
      owners,
      // Kept for anything still reading the old shape.
      maintenanceTechs: owners.filter(o => o.role === 'maintenance').map(o => o.name),
      groundsTech: splitNames(a.grounds_tech)[0] || null,
    });
  });
  out.sort((x, y) => x.name.localeCompare(y.name));
  return { properties: out, missing };
}

module.exports = { PROPERTY_GEO, ALIASES, GROUNDS_ONLY, geoFor, propertiesFrom, normName };
