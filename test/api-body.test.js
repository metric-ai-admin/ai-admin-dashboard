// api()'s body handling.
//
// Bekah could not save a note on the Collections Decision Queue on 2026-09-25:
// "key and a valid action are required". The note WAS in the body — but api()
// sent it with no Content-Type, express.json() therefore did not parse it, and
// req.body arrived as {}. The route was right to complain; it never saw the data.
//
// Four call sites had the same shape, including two shipped the day before for
// Lyndsay's policy-review flag and coaching reviews. Neither had ever been
// clicked in a browser — they were verified at the database layer, which is
// precisely the layer this bug is not in.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// Pull apiBody out of the bundle rather than reimplementing it.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('function apiBody(opts) {');
const end = src.indexOf('\n}\n', start) + 3;
assert.ok(start > 0, 'apiBody not found in public/app.js');
// eslint-disable-next-line no-new-func
const apiBody = new Function('FormData', 'Blob', 'URLSearchParams', 'ArrayBuffer',
  src.slice(start, end) + '\nreturn apiBody;')(
  globalThis.FormData, globalThis.Blob, globalThis.URLSearchParams, globalThis.ArrayBuffer);

const ct = o => Object.entries((o && o.headers) || {}).find(([k]) => k.toLowerCase() === 'content-type');

console.log('objects');
t('a plain object is stringified and gets the header', () => {
  const o = apiBody({ method: 'POST', body: { key: 'k1', action: 'note', note: 'hello' } });
  assert.strictEqual(o.body, '{"key":"k1","action":"note","note":"hello"}');
  assert.deepStrictEqual(ct(o), ['Content-Type', 'application/json']);
});
t('the exact shape the decision queue sends now round-trips', () => {
  const o = apiBody({ method: 'POST', body: { key: 'abc', action: 'note', note: 'Karla called' } });
  const parsed = JSON.parse(o.body);
  assert.strictEqual(parsed.key, 'abc');
  assert.strictEqual(parsed.action, 'note');
  assert.strictEqual(parsed.note, 'Karla called');
});

console.log('\nstrings');
t('an already-stringified body is not double-encoded', () => {
  const o = apiBody({ method: 'POST', body: JSON.stringify({ a: 1 }) });
  assert.strictEqual(o.body, '{"a":1}');
  assert.deepStrictEqual(JSON.parse(o.body), { a: 1 });
});
t('a stringified body still gets the header it was missing', () => {
  const o = apiBody({ method: 'POST', body: JSON.stringify({ unit_ids: [1, 2] }) });
  assert.deepStrictEqual(ct(o), ['Content-Type', 'application/json']);
});

console.log('\nheaders already set');
t('an explicit Content-Type is left alone', () => {
  const o = apiBody({ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'raw' });
  assert.deepStrictEqual(ct(o), ['Content-Type', 'text/plain']);
});
t('a lowercase content-type counts as set', () => {
  const o = apiBody({ method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'a,b' });
  assert.strictEqual(Object.keys(o.headers).filter(k => k.toLowerCase() === 'content-type').length, 1);
});
t('other headers survive', () => {
  const o = apiBody({ method: 'POST', headers: { 'x-metric-key': 'k' }, body: { a: 1 } });
  assert.strictEqual(o.headers['x-metric-key'], 'k');
  assert.deepStrictEqual(ct(o), ['Content-Type', 'application/json']);
});

console.log('\nbodies that must NOT be touched');
t('FormData passes through untouched — the browser sets its own boundary', () => {
  if (typeof FormData === 'undefined') { console.log('      (no FormData in this runtime, skipped)'); return; }
  const fd = new FormData();
  const o = apiBody({ method: 'POST', body: fd });
  assert.strictEqual(o.body, fd);
  assert.strictEqual(ct(o), undefined, 'setting Content-Type on FormData breaks the upload');
});
t('URLSearchParams passes through untouched', () => {
  const u = new URLSearchParams({ a: '1' });
  const o = apiBody({ method: 'POST', body: u });
  assert.strictEqual(o.body, u);
  assert.strictEqual(ct(o), undefined);
});

console.log('\nno body');
t('a GET with no body is unchanged', () => {
  const o = apiBody({ method: 'GET' });
  assert.deepStrictEqual(o, { method: 'GET' });
});
t('undefined opts survives', () => {
  assert.strictEqual(apiBody(undefined), undefined);
});
t('an explicitly null body is not stringified into "null"', () => {
  const o = apiBody({ method: 'POST', body: null });
  assert.strictEqual(o.body, null);
});

console.log('\ncall sites');
t('no POST/PATCH/DELETE in app.js sends a body the server cannot parse', () => {
  // Every such call now goes through api(), which normalises. What this guards
  // is a call site using fetch() DIRECTLY with a JSON body and no header —
  // the same bug, routed around the fix.
  const bad = [];
  const re = /fetch\((['"`][^'"`]*\/api\/[^'"`]*['"`])\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const opts = m[2];
    if (!/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(opts)) continue;
    if (!/body\s*:/.test(opts)) continue;
    if (/Content-Type/i.test(opts)) continue;
    if (/FormData|new Blob|URLSearchParams/.test(opts)) continue;
    // body: someVariable — follow it back far enough to see whether it was
    // built as FormData. /api/crm/import and import-costar both do this, and
    // they are correct: the browser must set its own multipart boundary.
    const varName = (opts.match(/body\s*:\s*([A-Za-z_$][\w$]*)/) || [])[1];
    if (varName) {
      const before = src.slice(Math.max(0, m.index - 1200), m.index);
      const decl = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*new\\s+(FormData|URLSearchParams|Blob)`);
      if (decl.test(before)) continue;
    }
    bad.push(m[1]);
  }
  assert.deepStrictEqual(bad, [], 'raw fetch() with a JSON body and no Content-Type: ' + bad.join(', '));
});

console.log(`\n${pass} passing`);
