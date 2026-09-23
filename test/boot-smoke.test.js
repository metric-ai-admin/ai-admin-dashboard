// Boot smoke test — loads the real index.html and the real front-end scripts in
// a real DOM and asserts the page comes up clean.
//
// WHY THIS EXISTS. On 2026-09-23 a deploy removed Arturo's Asana board but left
// `wireAsanaEditing('default')` behind. That call runs at MODULE LEVEL, so
// `ASANA_BOARDS['default'].sel` threw a TypeError partway down app.js — and
// every line after it never ran, including the `initAuth()` call near the end.
// The sidebar name stayed on "Loading…", the Sync All Data button never
// appeared, and the Call Analyzer was never defined. Three unrelated-looking
// bug reports, one dead reference.
//
// Nothing caught it. `node --check` only parses, and every other suite here
// tests pure Node modules that never touch the browser bundle. This is the
// missing layer: it executes the bundle.
//
// WHAT IT DOES NOT DO. It is a smoke test, not a UI test. It does not click
// anything, assert on rendered content, or talk to Supabase. Every network call
// is stubbed. If it passes, the page BOOTS — not that any feature works.
//
// Browser APIs jsdom lacks (matchMedia, IntersectionObserver, scrollTo) are
// stubbed because their absence is an artefact of the test environment. NOTHING
// from the application is stubbed: an app function that is missing must fail.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = path.join(PUBLIC, 'index.html');

// The scripts index.html loads, in document order. Read from the HTML rather
// than hard-coded, so a script added to the page is covered without anyone
// remembering to update this list.
function pageScripts(html) {
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)]
    .map(m => m[1].split('?')[0])
    .filter(src => !/^https?:/.test(src));
}

// ---- Boot ------------------------------------------------------------------

function boot({ user = { userId: 'u1', email: 'arturo@metric.internal', username: 'arturo',
  name: 'Arturo Mendoza', role: 'admin', agentName: null, callAnalyzer: true, vacancy: true } } = {}) {

  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = pageScripts(html);

  const errors = [];

  // jsdom runs the page's scripts on this process, so an uncaught error inside
  // the app reaches Node and would kill the test with a raw stack. Captured
  // here instead, so a real failure is REPORTED by the assertion below rather
  // than crashing the runner — the difference between "this test found a bug"
  // and "this test is broken".
  process.on('uncaughtException', e => errors.push({ kind: 'uncaught', message: e.message, stack: e.stack }));
  process.on('unhandledRejection', e => errors.push({ kind: 'unhandledrejection', message: String(e && e.message || e), stack: e && e.stack }));

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push({ kind: 'uncaught', message: e.message, stack: e.stack }));
  virtualConsole.on('error', (...args) => errors.push({ kind: 'console.error', message: args.map(String).join(' ') }));

  // Scripts stripped from the markup and injected below instead, so each one
  // runs in a known order and a failure can be attributed to a named file.
  const stripped = html.replace(/<script\s+src="[^"]+"[^>]*><\/script>/g, '');

  const dom = new JSDOM(stripped, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://dashboard.test/',
    virtualConsole,
  });
  const { window } = dom;

  window.addEventListener('unhandledrejection', e =>
    errors.push({ kind: 'unhandledrejection', message: String(e.reason && e.reason.message || e.reason) }));

  // ---- Environment stubs, browser-level only ----
  window.matchMedia = window.matchMedia || (q => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }));
  window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  if (window.Element) window.Element.prototype.scrollIntoView = function () {};

  // Every request answered locally. /api/auth/me carries the session the boot
  // path needs; everything else returns a shape broad enough that a caller
  // destructuring it does not throw for a reason the test invented.
  // An EMPTY ARRAY carrying the named keys as properties. Callers in this
  // codebase read responses both ways — some do `data.filter(...)`, others
  // `const { grades } = await api(...)` — and a stub that satisfies only one
  // shape fails the other for a reason the test invented rather than found.
  const EMPTY = Object.assign([], { ok: true, tasks: [], grades: [], calls: [], users: [],
    rows: [], data: [], results: [], items: [], projects: [], sops: [], flags: [],
    occupancy: [], watchlist: [], byProperty: [], cards: [], summary: {},
    facets: { properties: [], statuses: [], categories: [], years: [] },
    counts: {}, week: {}, horizon: {}, moveIns: [], moveOuts: [], tours: [], expirations: [] });

  const seen = [];
  window.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = u.includes('/api/auth/me') ? { user } : EMPTY;
    return {
      ok: true, status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
      blob: async () => ({}),
    };
  };

  // ---- Run the scripts, one at a time ----
  const ran = [];
  for (const src of scripts) {
    const file = path.join(PUBLIC, src);
    if (!fs.existsSync(file)) { errors.push({ kind: 'missing', message: `index.html loads ${src}, which does not exist` }); continue; }
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(file, 'utf8');
    // A throw inside an injected script surfaces through the virtual console as
    // a jsdomError, the same way a real uncaught error would.
    window.document.body.appendChild(el);
    ran.push(src);
  }

  return { window, errors, scripts, ran, seen, close: () => dom.window.close() };
}

// One boot shared by the assertions below: it is the expensive part, and every
// check is a read.
const b = boot();

// A classic script's top-level `let`/`const` land in the global LEXICAL scope,
// not on `window` — so `window.currentUser` is undefined even when the variable
// is set. Reading them has to go through the window's own evaluator. Function
// DECLARATIONS do become window properties, which is why those are read off the window.
const peek = expr => b.window.eval(`(typeof ${expr} === "undefined") ? undefined : ${expr}`);

const settle = () => new Promise(r => setTimeout(r, 0));

// initAuth() is async and already in flight by the time the scripts finish.
// Waiting for the value rather than guessing a delay: a fixed sleep is either
// flaky or slower than it needs to be.
async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await settle(); }
  return false;
}

(async () => {
  const w = b.window;
  const err = b.errors;
  await waitFor(() => peek("currentUser"));

  console.log('scripts');
  t('index.html lists the scripts this test expects to cover', () => {
    assert.ok(b.scripts.includes('app.js'), 'app.js not listed in index.html');
    assert.ok(b.scripts.length >= 4, `only ${b.scripts.length} local scripts found`);
  });
  t('every script index.html loads exists on disk', () => {
    const missing = err.filter(e => e.kind === 'missing');
    assert.strictEqual(missing.length, 0, missing.map(m => m.message).join('; '));
  });
  t('all of them ran', () => {
    assert.deepStrictEqual(b.ran, b.scripts);
  });

  console.log('console');
  // THE ASSERTION THIS FILE EXISTS FOR.
  t('the page boots with no uncaught errors', () => {
    const fatal = err.filter(e => e.kind !== 'missing');
    assert.strictEqual(fatal.length, 0,
      '\n' + fatal.map(e => `  [${e.kind}] ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 4).join('\n') : ''}`).join('\n'));
  });

  console.log('boot completed');
  // A module-level throw does not announce itself — it just stops the file. The
  // only way to know the END of app.js ran is to check something only the end
  // does. initAuth() is the last call in the file.
  t('initAuth() ran — currentUser is populated', () => {
    const u = peek('currentUser');
    assert.ok(u, 'currentUser is not set: initAuth() never completed');
    assert.strictEqual(u.name, 'Arturo Mendoza');
  });
  t('the sidebar shows the signed-in name, not the placeholder', () => {
    const name = w.document.querySelector('.brand-name')?.textContent;
    assert.strictEqual(name, 'Arturo Mendoza', `brand-name reads ${JSON.stringify(name)}`);
  });
  t('/api/auth/me was actually called', () => {
    assert.ok(b.seen.some(u => u.includes('/api/auth/me')), 'nothing requested the session');
  });

  console.log('late definitions');
  // Each of these is defined in a different region of app.js. A throw anywhere
  // leaves the ones below it undefined, so together they cover the file.
  const LATE = ['initAuth', 'loadTab', 'loadMaintenance', 'loadCallAnalyzer', 'loadRegional',
    'loadBrief', 'loadCodeViolations', 'loadSyncStatus', 'svgSetFlag', 'wireAsanaEditing'];
  LATE.forEach(fn => t(`${fn}() is defined`, () => {
    assert.strictEqual(typeof w[fn], 'function', `${fn} is ${typeof w[fn]} — app.js stopped before it`);
  }));

  console.log('sidebar');
  t('the Sync All Data button exists and is revealed for an admin', () => {
    const btn = w.document.getElementById('sync-all-btn');
    assert.ok(btn, '#sync-all-btn is missing from the page');
    assert.strictEqual(btn.hidden, false, 'button is present but still hidden — loadSyncStatus() did not run');
  });
  t('an admin sees every tab their role allows', () => {
    const visible = [...w.document.querySelectorAll('#tabs button[data-tab]')]
      .filter(x => x.style.display !== 'none').map(x => x.dataset.tab);
    ['maintenance', 'collections', 'evictions', 'leasing', 'kpi', 'calls', 'crm'].forEach(tab =>
      assert.ok(visible.includes(tab), `${tab} tab is hidden for an admin`));
  });
  t('a tab button exists for every tab the access list grants', () => {
    const inDom = new Set([...w.document.querySelectorAll('#tabs button[data-tab]')].map(x => x.dataset.tab));
    // Reading TAB_ACCESS out of the booted window rather than duplicating it.
    const granted = new Set(Object.values(peek('TAB_ACCESS') || {}).flat());
    const orphans = [...granted].filter(tab => !inDom.has(tab));
    assert.strictEqual(orphans.length, 0, `access granted to tabs with no button: ${orphans.join(', ')}`);
  });
  t('every tab button has a matching section', () => {
    const missing = [...w.document.querySelectorAll('#tabs button[data-tab]')]
      .map(x => x.dataset.tab)
      .filter(tab => !w.document.getElementById('tab-' + tab));
    assert.strictEqual(missing.length, 0, `buttons with no section: ${missing.join(', ')}`);
  });

  console.log('markup');
  t('no duplicate element ids — a second one never renders', () => {
    const counts = {};
    [...w.document.querySelectorAll('[id]')].forEach(el => { counts[el.id] = (counts[el.id] || 0) + 1; });
    const dupes = Object.entries(counts).filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
    assert.strictEqual(dupes.length, 0, dupes.join(', '));
  });

  console.log(`\n${pass} passing`);
})()
  .catch(err => {
    console.error('\nboot smoke test FAILED:\n', (err && err.stack) || err);
    process.exitCode = 1;
  })
  .finally(() => {
    // jsdom keeps timers and a requestAnimationFrame loop alive, and the app
    // sets intervals of its own. Closing in a finally rather than after the last
    // assertion: on a FAILURE the old placement was skipped, so the process hung
    // and the runner reported a timeout instead of the assertion that failed.
    try { b.close(); } catch { /* already gone */ }
    setImmediate(() => process.exit(process.exitCode || 0));
  });
