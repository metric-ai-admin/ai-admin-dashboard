// Routes that can never be reached, because an earlier one eats them.
//
// Express matches in REGISTRATION ORDER. A literal segment registered after a
// parameterised one at the same depth is captured by it and the handler never
// runs. The symptom is not a 404 from the router — it is the WRONG handler
// answering, which is why it reads as a bug in the feature instead of a bug in
// the routing table.
//
// It has now happened twice in one day:
//
//   GET /api/sops/public-link   eaten by GET /api/sops/:id, registered twelve
//                               thousand lines earlier. Answered "SOP not
//                               found" — a real 404 from a real handler.
//   GET /api/sop-public/link    eaten by GET /api/sop-public/:token, thirty
//                               lines earlier, while fixing the first one.
//
// So this scans the whole table rather than pinning one URL.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LINES = SERVER.split('\n');

// Every app.<verb>('<path>' in registration order.
const ROUTE_RE = /^\s*app\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/;
const routes = [];
LINES.forEach((l, i) => {
  const m = ROUTE_RE.exec(l);
  if (m) routes.push({ line: i + 1, method: m[1].toUpperCase(), path: m[2] });
});

console.log('route shadowing');

t('the scanner still finds the routes (a silent zero would pass everything)', () => {
  assert.ok(routes.length > 150, 'only found ' + routes.length + ' routes');
});

// Does `earlier` capture the concrete path `later`? Same method, same number of
// segments, and every segment either identical or a parameter in `earlier`.
function captures(earlier, later) {
  if (earlier.method !== later.method && earlier.method !== 'ALL') return false;
  const a = earlier.path.split('/').filter(Boolean);
  const b = later.path.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  let usedParam = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) { usedParam = true; continue; }
    if (a[i] !== b[i]) return false;
  }
  // Only interesting when a parameter did the capturing AND the later route
  // has a literal where the earlier has the parameter — two identical literal
  // paths are a duplicate, not a shadow, and that is a different test.
  if (!usedParam) return false;
  return a.some((seg, i) => seg.startsWith(':') && !b[i].startsWith(':'));
}

// A detector that has never detected anything is not evidence. Both real bugs
// are replayed through the rule, along with the shapes it must NOT flag.
t('the detector catches both bugs that actually happened', () => {
  const R = (m, p) => ({ method: m, path: p });
  assert.strictEqual(captures(R('GET', '/api/sops/:id'), R('GET', '/api/sops/public-link')), true,
    'it would not have caught the bug Arturo hit');
  assert.strictEqual(captures(R('GET', '/api/sop-public/:token'), R('GET', '/api/sop-public/link')), true,
    'it would not have caught the one introduced while fixing it');
});

t('and it does not cry wolf', () => {
  const R = (m, p) => ({ method: m, path: p });
  // The fix: the literal registered first is not eaten by the parameter after it.
  assert.strictEqual(captures(R('GET', '/api/sop-public/link'), R('GET', '/api/sop-public/:token')), false);
  // Different depth, different method, and two parameters are all fine.
  assert.strictEqual(captures(R('GET', '/api/sops/:id'), R('GET', '/api/sops/public/abc')), false);
  assert.strictEqual(captures(R('POST', '/api/sops/:id'), R('GET', '/api/sops/public-link')), false);
  assert.strictEqual(captures(R('GET', '/api/x/:a'), R('GET', '/api/x/:b')), false);
});

t('NO ROUTE IS UNREACHABLE BEHIND AN EARLIER PARAMETERISED ONE', () => {
  const shadowed = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (captures(routes[j], routes[i])) {
        shadowed.push(`${routes[i].method} ${routes[i].path} (server.js:${routes[i].line})`
          + `  is eaten by  ${routes[j].method} ${routes[j].path} (server.js:${routes[j].line})`);
        break;
      }
    }
  }
  assert.deepStrictEqual(shadowed, [],
    'these routes can never be reached:\n   ' + shadowed.join('\n   '));
});

// ---- the two that actually broke -----------------------------------------
const find = (method, p) => routes.find(r => r.method === method && r.path === p);

t('GET /api/sop-public/link exists, and nothing earlier can capture it', () => {
  const link = find('GET', '/api/sop-public/link');
  assert.ok(link, 'the admin link route is gone');
  const earlier = routes.filter(r => r.line < link.line && captures(r, link));
  assert.deepStrictEqual(earlier.map(r => r.path), [],
    'something registered earlier eats it: ' + earlier.map(r => r.path).join(', '));
});

t('it is registered BEFORE the token routes it shares a prefix with', () => {
  const link = find('GET', '/api/sop-public/link');
  const tok = find('GET', '/api/sop-public/:token');
  assert.ok(tok, 'the token route is gone');
  assert.ok(link.line < tok.line,
    'the link route is below /api/sop-public/:token and would be read as a token');
});

t('the public SOP family left /api/sops entirely', () => {
  // /api/sops/:id is registered at the top of the file and would capture any
  // single-segment literal added under /api/sops, forever.
  const stragglers = routes.filter(r => /^\/api\/sops\/public/.test(r.path));
  assert.deepStrictEqual(stragglers.map(r => r.path), [],
    'still under /api/sops, where /api/sops/:id can eat it');
  assert.ok(find('GET', '/api/sop-public/:token'));
  assert.ok(find('GET', '/api/sop-public/:token/:slug'));
});

t('the pages ask for the paths the server actually serves', () => {
  // A moved route and a page still calling the old one is a working server and
  // a blank page, which is harder to spot than a 500.
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-index.html'), 'utf8');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-doc.html'), 'utf8');
  assert.ok(idx.includes("'/api/sop-public/' + TOKEN"), 'the index calls the old path');
  assert.ok(doc.includes("'/api/sop-public/' + TOKEN + '/' + SLUG"), 'the document calls the old path');
  [idx, doc].forEach(p => assert.ok(!/\/api\/sops\/public/.test(p), 'a page still calls /api/sops/public'));
});

t('the admin link route is still admin only after the move', () => {
  const link = find('GET', '/api/sop-public/link');
  const src = LINES[link.line - 1];
  assert.ok(/requireAuth, requireRole\('admin'\)/.test(src), 'the move dropped its guard: ' + src.trim());
});

t('it answers with a url built from the group token', () => {
  const i = SERVER.indexOf("app.get('/api/sop-public/link'");
  const body = SERVER.slice(i, i + 700);
  assert.ok(/SOPP\.token\(SOP_PUBLIC_SECRET\)/.test(body), 'the url is not derived from the secret');
  assert.ok(/\/sops\/\$\{SOPP\.token\(SOP_PUBLIC_SECRET\)\}/.test(body),
    'the url does not point at the public page');
  assert.ok(/SOP_PUBLIC_SECRET is not set/.test(body),
    'with no secret it should say so rather than hand out a broken link');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
