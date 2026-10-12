// AppFolio custom fields, which arrive nested inside one column.
//
// occupancy_custom_fields returns five columns — custom_fields, occupancy_id,
// property_id, tenant_name, unit_id — and everything Katie's "tenant custom
// fields" tab shows as its own column lives inside the first one. That is why
// looking for "Eviction Status" among the keys found nothing: it was never a
// key, it was a value inside a value.
//
// THE SHAPE IS NOT ASSUMED. AppFolio has returned custom fields three ways
// across its reports — an array of {name, value} objects, a plain object
// keyed by name, and a JSON string holding either — so this reads all three
// and says which one it found. Guessing one and getting a silent empty result
// is how the last two rounds of this went.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// What the nested column is: 'array' | 'object' | 'json' | 'empty' | 'unknown'.
function shapeOf(value) {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return 'empty';
    if (s[0] === '[' || s[0] === '{') return 'json';
  }
  return 'unknown';
}

// The keys an entry object uses for its name and its value. Checked rather
// than assumed: name/label/field_name and value/field_value/val have all been
// seen in AppFolio payloads.
const NAME_KEYS = ['name', 'label', 'field_name', 'custom_field_name', 'key', 'title'];
const VALUE_KEYS = ['value', 'field_value', 'custom_field_value', 'val', 'data'];

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
};

// One row's custom fields, as [{name, value}].
//
// Returns [] for anything it cannot read — never throws. A malformed cell on
// one row must not take down a report over 827 of them.
function parse(value) {
  const shape = shapeOf(value);
  if (shape === 'empty' || shape === 'unknown') return [];

  let v = value;
  if (shape === 'json') {
    try { v = JSON.parse(value); } catch (e) { return []; }
  }

  if (Array.isArray(v)) {
    return v.map(entry => {
      if (entry && typeof entry === 'object') {
        const n = pick(entry, NAME_KEYS);
        const val = pick(entry, VALUE_KEYS);
        // An object with exactly one key and no name/value pair is itself a
        // {name: value} pair — a shape AppFolio uses for single fields.
        if (n === undefined && val === undefined) {
          const keys = Object.keys(entry);
          if (keys.length === 1) return { name: clean(keys[0]), value: entry[keys[0]] };
          return null;
        }
        return { name: clean(n), value: val };
      }
      return null;
    }).filter(x => x && x.name);
  }

  if (v && typeof v === 'object') {
    return Object.keys(v).map(k => ({ name: clean(k), value: v[k] }));
  }
  return [];
}

// The row with its custom fields raised to top-level keys.
//
// NON-DESTRUCTIVE: the original columns win. A custom field called
// "property_id" must not overwrite the real one, and a report that lets its
// own contents rename its structure is unreadable.
function flatten(row, opts) {
  const o = opts || {};
  const column = o.column || 'custom_fields';
  const out = Object.assign({}, row || {});
  parse((row || {})[column]).forEach(({ name, value }) => {
    if (!name) return;
    if (Object.prototype.hasOwnProperty.call(out, name)) return;
    out[name] = value;
  });
  return out;
}

const flattenAll = (rows, opts) => (rows || []).map(r => flatten(r, opts));

// Every distinct field name across the rows, with how many carry a value.
// NAMES AND COUNTS ONLY — no value is ever returned, because this is what a
// diagnostic needs and the values are residents' court dates and payments.
function fieldCounts(rows, opts) {
  const o = opts || {};
  const column = o.column || 'custom_fields';
  const counts = new Map();
  (rows || []).forEach(r => {
    parse((r || {})[column]).forEach(({ name, value }) => {
      if (!name) return;
      if (!counts.has(name)) counts.set(name, { present: 0, filled: 0 });
      const c = counts.get(name);
      c.present++;
      if (clean(value)) c.filled++;
    });
  });
  return [...counts.entries()]
    .map(([name, c]) => ({ name, present: c.present, filled: c.filled }))
    .sort((a, b) => b.filled - a.filled || a.name.localeCompare(b.name));
}

// What shape the column has across the rows, and which keys the entries use.
// For a diagnostic to report rather than for anything to branch on.
function describe(rows, opts) {
  const o = opts || {};
  const column = o.column || 'custom_fields';
  const shapes = {};
  const entryKeys = new Set();
  let entries = 0;
  (rows || []).forEach(r => {
    const raw = (r || {})[column];
    const s = shapeOf(raw);
    shapes[s] = (shapes[s] || 0) + 1;
    let v = raw;
    if (s === 'json') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
    if (Array.isArray(v)) {
      v.forEach(e => {
        if (e && typeof e === 'object') {
          entries++;
          Object.keys(e).forEach(k => entryKeys.add(k));
        }
      });
    } else if (v && typeof v === 'object') {
      entries += Object.keys(v).length;
    }
  });
  return { column, shapes, entries, entryKeys: [...entryKeys].sort() };
}

module.exports = {
  NAME_KEYS, VALUE_KEYS,
  shapeOf, parse, flatten, flattenAll, fieldCounts, describe, clean,
};
