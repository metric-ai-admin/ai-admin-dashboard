// Public SOP links for the maintenance technicians.
//
// A page with no login in front of it, so most of this file is about what it
// must refuse: a wrong token, another department, an archived document, and
// anything in a SOP body that tries to be a tag.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/sop-public.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const SECRET = 'a-test-secret-for-this-file-only';

console.log('public SOP links');

// ---- the token -----------------------------------------------------------
t('one token for the group, derived and not stored', () => {
  const tok = S.token(SECRET);
  assert.ok(/^[0-9a-f]{32}$/.test(tok));
  assert.strictEqual(tok, S.token(SECRET), 'the same secret must give the same link');
  assert.strictEqual(S.GROUP, 'maintenance-techs');
});

t('rotating the secret revokes every link at once', () => {
  assert.notStrictEqual(S.token(SECRET), S.token(SECRET + 'x'));
  assert.ok(!S.isValidToken(S.token(SECRET), SECRET + 'x'));
});

t('a missing secret produces no token and validates nothing', () => {
  // Not a predictable fallback: a default secret would make the link guessable
  // by anyone with the source.
  assert.strictEqual(S.token(''), null);
  assert.strictEqual(S.token(undefined), null);
  assert.strictEqual(S.isValidToken('f'.repeat(32), ''), false);
});

t('a wrong, malformed or empty token is refused', () => {
  assert.ok(S.isValidToken(S.token(SECRET), SECRET));
  ['', 'x', 'f'.repeat(32), 'F'.repeat(32), S.token(SECRET).slice(0, 31),
   S.token(SECRET) + 'a', null, undefined, '../etc/passwd']
    .forEach(v => assert.strictEqual(S.isValidToken(v, SECRET), false, String(v)));
});

// ---- the slug ------------------------------------------------------------
t('a slug is a slug, and nothing else is looked up', () => {
  ['equipment-warranty-management', 'move-out-inspection-process', 'a', 'a1-b2']
    .forEach(v => assert.ok(S.isSlug(v), v));
  ['', '../secrets', 'UPPER', 'has space', '-leading', 'a'.repeat(200), 'semi;colon', '%2e%2e']
    .forEach(v => assert.strictEqual(S.isSlug(v), false, JSON.stringify(v)));
});

// ---- the scope, which is the whole security story ------------------------
function fakeQuery() {
  const calls = [];
  const q = {
    eq(col, val) { calls.push(['eq', col, val]); return q; },
    in(col, vals) { calls.push(['in', col, vals]); return q; },
    calls,
  };
  return q;
}

t('the query is pinned to Maintenance, not archived, and the published statuses', () => {
  const q = fakeQuery();
  S.scope(q);
  assert.deepStrictEqual(q.calls, [
    ['eq', 'department', 'Maintenance'],
    ['eq', 'archived', false],
    ['in', 'status', S.PUBLISHED_STATUSES],
  ]);
});

t('THE STATUS LIST IS MEASURED, NOT ASSUMED', () => {
  // Checked against the live table on 2026-10-09: all 59 'Current' SOPs are in
  // Operations, and every one of Maintenance's 33 is 'Needs Review'. A page
  // filtered to Current alone would have been EMPTY. Dropping 'Needs Review'
  // from this array is the whole change once they are signed off.
  assert.deepStrictEqual(S.PUBLISHED_STATUSES, ['Current', 'Needs Review']);
  assert.ok(S.PUBLISHED_STATUSES.includes('Current'));
  assert.ok(!S.PUBLISHED_STATUSES.includes('Archived'));
});

t('only what the page renders ever reaches it', () => {
  const list = S.LIST_COLUMNS.split(',');
  const doc = S.DOC_COLUMNS.split(',');
  assert.ok(doc.includes('body_md'));
  // Internal columns must not leave the server at all.
  ['content_hash', 'source_path', 'legacy_sop_review_id', 'updated_by', 'author', 'owner']
    .forEach(c => {
      assert.ok(!list.includes(c), 'index leaks ' + c);
      assert.ok(!doc.includes(c), 'document leaks ' + c);
    });
});

t('the index READS the bodies but never SENDS them', () => {
  // It needs body_md to tell a bilingual original from an untranslated one,
  // and shipping 130 KB of SOP text to render a list of titles would be a
  // worse trade for a phone on bad signal. groupForIndex builds a new object
  // per SOP, so the body cannot ride along — this asserts that directly rather
  // than trusting the column list, which is what actually changed.
  assert.ok(S.LIST_COLUMNS.split(',').includes('body_md'),
    'the index cannot tell bilingual from untranslated without the body');
  const out = S.groupForIndex([
    { slug: 'x', title: 'X', category: 'Maintenance', body_md: 'SENTINEL-BODY-TEXT' },
  ]);
  assert.ok(!JSON.stringify(out).includes('SENTINEL-BODY-TEXT'),
    'a SOP body leaked into the index payload');
  assert.deepStrictEqual(Object.keys(out[0].sops[0]).sort(),
    ['bilingual', 'reviewed', 'slug', 'status', 'title', 'title_es', 'updated']);
});

// ---- the index -----------------------------------------------------------
const ROWS = [
  { slug: 'b-two', title: 'Boiler checks', category: 'HVAC', status: 'Current', updated_at: '2026-09-28T00:00:00Z' },
  { slug: 'a-one', title: 'Air filters', category: 'HVAC', status: 'Needs Review', updated_at: '2026-09-28T00:00:00Z' },
  { slug: 'c-three', title: 'Warranty claims', category: null, status: 'Current', updated_at: '2026-09-28T00:00:00Z' },
];

t('the index groups by category and sorts by title inside it', () => {
  const g = S.groupForIndex(ROWS);
  assert.deepStrictEqual(g.map(x => x.category), ['General', 'HVAC']);
  assert.deepStrictEqual(g[1].sops.map(x => x.title), ['Air filters', 'Boiler checks']);
});

t('a SOP with no category lands in General, not in a blank heading', () => {
  assert.strictEqual(S.groupForIndex([{ slug: 'x', title: 'X', category: '   ' }])[0].category, 'General');
});

t('the index carries the status, so an unreviewed SOP can say so', () => {
  const g = S.groupForIndex(ROWS);
  assert.strictEqual(g[1].sops.find(s => s.slug === 'a-one').status, 'Needs Review');
});

t('an empty library is an empty list, not a crash', () => {
  assert.deepStrictEqual(S.groupForIndex([]), []);
  assert.deepStrictEqual(S.groupForIndex(null), []);
});

// ---- the routes ----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

t('a bad token is a 404, never a 401', () => {
  const i = CODE.indexOf('function sopPubGuard');
  const body = CODE.slice(i, i + 700);
  assert.ok(/res\.status\(404\)\.send\('Not found'\)/.test(body));
  assert.ok(!/401|403/.test(body.replace(/429/g, '')), 'it leaks that the URL shape was right');
});

t('every public route goes through the one guard', () => {
  ["app.get('/sops/:token'", "app.get('/sops/:token/:slug'",
   "app.get('/api/sop-public/:token'", "app.get('/api/sop-public/:token/:slug'"]
    .forEach(r => {
      const i = CODE.indexOf(r);
      assert.ok(i > 0, 'missing route ' + r);
      assert.ok(/sopPubGuard\(req, res\)/.test(CODE.slice(i, i + 220)), r + ' skips the guard');
    });
});

t('the pages are noindex, no-store and rate limited', () => {
  const i = CODE.indexOf('function sopPubGuard');
  const body = CODE.slice(i, i + 700);
  assert.ok(/X-Robots-Tag', 'noindex, nofollow'/.test(body));
  assert.ok(/Cache-Control', 'no-store'/.test(body));
  assert.ok(/sopPubRateLimited/.test(body));
});

t('the public routes READ only — no write of any kind', () => {
  // Bounded on the UNSTRIPPED source, because the comment banner is the only
  // marker for where this block ends. And the write check is specific: a blunt
  // ".delete(" also matches sopPubHits.delete(k), the rate limiter tidying an
  // in-memory Map, which is not a write to anything.
  const i = SERVER.indexOf('const SOPP = require');
  const j = SERVER.indexOf('// REBRAND LEADERSHIP REVIEW');
  assert.ok(i > 0 && j > i, 'could not bound the public SOP block');
  const block = SERVER.slice(i, j);
  assert.ok(block.length > 1000 && block.length < 8000, 'block looks wrong: ' + block.length);
  // No route in it accepts anything but GET.
  ['app.post(', 'app.patch(', 'app.put(', 'app.delete(']
    .forEach(bad => assert.ok(!block.includes(bad), 'the public SOP block registers ' + bad));
  // And no table write, by the only shape one can take here.
  assert.ok(!/\.from\(['"][a-z_]+['"]\)[\s\S]{0,80}\.(insert|upsert|update|delete)\(/.test(block),
    'the public SOP block writes to a table');
});

t('the single-document route filters the slug INSIDE the scope', () => {
  // Otherwise a Maintenance-looking slug could fetch an Accounting document.
  const i = CODE.indexOf("app.get('/api/sop-public/:token/:slug'");
  const body = CODE.slice(i, i + 900);
  assert.ok(/SOPP\.scope\([\s\S]*\.eq\('slug', req\.params\.slug\)\)/.test(body),
    'the slug filter is applied outside the department/status scope');
});

t('the link route is admin only', () => {
  assert.ok(/app\.get\('\/api\/sop-public\/link', requireAuth, requireRole\('admin'\)/.test(CODE));
});

t('nothing in this feature lives under /api/sops any more', () => {
  // /api/sops/:id is registered at the top of server.js and captured
  // /api/sops/public-link as an id — see test/route-shadowing.test.js.
  assert.ok(!/\/api\/sops\/public/.test(CODE), 'a public SOP route is still under /api/sops');
});

// ---- the pages -----------------------------------------------------------
const IDX = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-index.html'), 'utf8');
const DOC = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-doc.html'), 'utf8');

t('neither page loads anything from the dashboard', () => {
  [IDX, DOC].forEach(p => {
    assert.ok(!/app\.js|styles\.css|<script src=|<link[^>]+stylesheet/.test(p),
      'the page pulls in dashboard assets');
    assert.ok(/noindex/.test(p));
  });
});

t('both pages parse', () => {
  [IDX, DOC].forEach(p => {
    const m = p.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'no script block');
    assert.doesNotThrow(() => new Function(m[1]));
  });
});

t('both escape everything they render', () => {
  // The index renders `title`, a local holding either the Spanish or the
  // English one; the document renders doc.title the same way.
  assert.ok(/var esc = function/.test(IDX) && /esc\(title\)/.test(IDX));
  assert.ok(/var esc = function/.test(DOC) && /esc\(doc\.title/.test(DOC));
  // And the category and the slug, which also come out of the database.
  assert.ok(/esc\(group\.category\)/.test(IDX));
  assert.ok(/encodeURIComponent\(s\.slug\)/.test(IDX));
});

t('THE MARKDOWN RENDERER ESCAPES BEFORE IT FORMATS', () => {
  // A SOP body is stored text. Formatting first and escaping after would let
  // a document inject a tag into a page that has no login in front of it.
  const m = DOC.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sandbox = {};
  // From `var esc` through the end of md(): the renderer depends on esc, and
  // lifting md() alone would be testing a function that cannot run.
  const src = m.slice(m.indexOf('var esc =')).replace(/\n\s*function chrome\(\)[\s\S]*$/, '');
  // window and localStorage are stubbed because the slice now includes the
  // language sniff. The output parameter is NOT called 'S': the page declares
  // its own `var S` for the UI strings and would shadow it.
  const win = { location: { search: '' } };
  const store = { getItem: () => null, setItem: () => {} };
  new Function('__OUT', 'window', 'localStorage', src + '\n__OUT.md = md;')(sandbox, win, store);
  const out = sandbox.md('# Hi <script>alert(1)</script>\n\n- **bold** and <img src=x onerror=1>\n');
  assert.ok(!/<script>/.test(out), 'a tag survived the renderer');
  assert.ok(!/<img/.test(out), 'an img tag survived the renderer');
  assert.ok(/&lt;script&gt;/.test(out), 'the text should still be readable, just escaped');
  assert.ok(/<h2>/.test(out) && /<strong>bold<\/strong>/.test(out), 'real formatting stopped working');
});

t('the document page is built to print', () => {
  assert.ok(/@media print/.test(DOC));
  assert.ok(/window\.print\(\)/.test(DOC));
  assert.ok(/page-break-after:avoid/.test(DOC), 'headings should not be orphaned across pages');
});

t('an unreviewed SOP says so on both pages', () => {
  assert.ok(/needs review/i.test(IDX));
  assert.ok(/needs review/i.test(DOC));
  assert.ok(/has not been signed off/i.test(DOC));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
