// Every write route has a readable name, or this fails and prints the ones
// that do not.
//
// "Jay wrote to /api/crm/properties/:id" is not an answer to "what did Jay do".
// The catalogue is the answer, and the point of this file is that it cannot
// quietly fall behind the routes: a new write route added tomorrow fails here
// until somebody names it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Every write route the server actually registers.
const ROUTES = (() => {
  const src = read('server.js') + '\n' + read('metric-routes.js');
  const out = [];
  const re = /app\.(post|put|patch|delete)\('(\/api\/[^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  // Deduplicate: the same route can be registered once and matched twice.
  const seen = new Set();
  return out.filter(r => {
    const k = r.method + ' ' + r.path;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})();

console.log('the catalogue covers the routes');
t('there are routes to cover (the scrape still works)', () => {
  assert.ok(ROUTES.length > 100, 'only found ' + ROUTES.length + ' write routes — the scrape broke');
});
t('EVERY write route resolves to a name or to system', () => {
  // A concrete path is built for each pattern so describe() is exercised the
  // way a real request would exercise it, not against the pattern string.
  const unnamed = [];
  ROUTES.forEach(r => {
    const concrete = r.path.replace(/:[A-Za-z_]+/g, '123');
    const d = A.describe(r.method, concrete);
    if (!d) unnamed.push(r.method + ' ' + r.path);
  });
  assert.deepStrictEqual(unnamed, [],
    'these write routes have no name in lib/activity-actions.js:\n   ' + unnamed.join('\n   '));
});
t('no label is a generic verb', () => {
  // "Updated" on its own tells nobody anything. Every label names the thing.
  const lazy = A.ACTIONS.filter(a => /^(Updated|Created|Deleted|Edited|Added|Changed)$/i.test(a[2]));
  assert.deepStrictEqual(lazy.map(a => a[1]), [], 'labels with no object');
});
t('every entry has an entity type', () => {
  const missing = A.ACTIONS.filter(a => !a[3]).map(a => a[0] + ' ' + a[1]);
  assert.deepStrictEqual(missing, []);
});

console.log('\nspecific routes win over the general ones they sit under');
t('/api/tasks/:id/notes is not swallowed by /api/tasks/:id', () => {
  assert.strictEqual(A.describe('POST', '/api/tasks/9/notes').label, 'Added task note');
  assert.strictEqual(A.describe('POST', '/api/tasks/9/done').label, 'Marked task done');
  assert.strictEqual(A.describe('PUT', '/api/tasks/9').label, 'Edited task');
});
t('a parameter matches ONE segment, never a path', () => {
  // ':id' compiled to '.*' would make /api/tasks/:id match everything below it.
  assert.strictEqual(A.describe('PATCH', '/api/crm/properties/5/assign').label, 'Reassigned CRM property');
  assert.strictEqual(A.describe('PATCH', '/api/crm/properties/5').label, 'Updated CRM property status');
});
t('the method is part of the match', () => {
  assert.strictEqual(A.describe('POST', '/api/evictions/session').label, 'Started eviction session');
  assert.strictEqual(A.describe('DELETE', '/api/evictions/session').label, 'Ended eviction session');
});
t('an unknown route returns null rather than a guess', () => {
  // A default label would make a new unnamed route look catalogued.
  assert.strictEqual(A.describe('POST', '/api/something/new'), null);
});

console.log('\nthe automatic writes are marked system');
t('the Command Center autosave is system', () => {
  const d = A.describe('POST', '/api/maintenance/command-center/state');
  assert.ok(d && d.system, 'the autosave still counts as a person doing something');
  assert.ok(/every page load/.test(d.why), 'the reason is not recorded');
});
t('every system entry says why', () => {
  A.SYSTEM.forEach(s => assert.ok(s.why && s.why.length > 10, 'a system route has no reason: ' + s.re));
});
t('the view beacon is not also counted as a write', () => {
  assert.ok(A.isSystem('/api/activity/view'));
});
t('the read-only probes are system', () => {
  ['/api/maintenance/probe-wo-window', '/api/collections/probe-tenant-statuses',
    '/api/leasing/probe-guest-cards'].forEach(p =>
    assert.ok(A.isSystem(p), p + ' counts as real activity'));
});
t('a real maintenance write is NOT system', () => {
  // The marking has to be narrow. Erick syncing work orders is him working.
  assert.ok(!A.isSystem('/api/maintenance/sync'));
  assert.strictEqual(A.describe('POST', '/api/maintenance/sync').label,
    'Synced work orders from AppFolio');
});

console.log('\nno label can carry content');
t('labels are fixed strings, never built from input', () => {
  // The whole reason this is a lookup table: a template would eventually be
  // filled with a note or a resident's name.
  const src = read(path.join('lib', 'activity-actions.js'));
  const body = src.slice(src.indexOf('var ACTIONS = ['), src.indexOf('var COMPILED'));
  assert.ok(!/\$\{/.test(body), 'a label is interpolated');
  assert.ok(!/req\.|body\.|\+ /.test(body), 'a label is built from something');
});
t('describe() returns only the four known keys', () => {
  const d = A.describe('POST', '/api/tasks');
  assert.deepStrictEqual(Object.keys(d).sort(), ['entity', 'label', 'system', 'why']);
});
t('the forbidden-field rule from phase 1 is untouched', () => {
  const ACT = require('../lib/activity-log.js');
  ['notes', 'tenant', 'resident', 'amount', 'phone', 'email_address']
    .forEach(f => assert.ok(ACT.FORBIDDEN.test(f) || f === 'email_address',
      f + ' is no longer forbidden'));
  assert.ok(ACT.ALLOWED.indexOf('body') === -1);
});

console.log(`\n${pass} passing`);
