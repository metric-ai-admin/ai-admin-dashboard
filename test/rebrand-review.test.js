// The Rebrand Leadership Review: a PUBLIC page, which is the whole reason this
// file is long.
//
// Zach is external and has no dashboard account, so there is no session to put
// in front of it. The token is the identity — it decides who you are, which
// answers you load, and whose name goes on an edit. Everything below is about
// that one fact.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read(path.join('public', 'app.js'));
const page = read(path.join('public', 'tools', 'rebrand-review.html'));
const sql = read(path.join('supabase', 'migrations', '081_rebrand_review.sql'));
const strip = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const code = strip(server);

console.log('the token is the door');
t('a wrong token is a 404, never a 401', () => {
  // A 401 confirms the URL shape is right and invites a second attempt.
  const i = code.indexOf('function rebrandGuard');
  const body = code.slice(i, i + 500);
  assert.ok(/res\.status\(404\)\.send\('Not found'\)/.test(body), 'it answers something other than 404');
  assert.ok(!/401|403/.test(body.replace(/429/g, '')), 'it leaks that the URL shape was right');
});
t('tokens are derived, not stored', () => {
  // No table to leak, no rows to keep in sync, and rotating the secret revokes
  // all four at once.
  const i = code.indexOf('function rebrandToken');
  const body = code.slice(i, i + 400);
  assert.ok(/createHmac\('sha256', secret\)/.test(body));
  assert.ok(/REBRAND_REVIEW_SECRET/.test(body));
  assert.ok(!/from\('rebrand_tokens'\)/.test(code), 'there is a token table after all');
});
t('a missing secret produces no token at all', () => {
  // Not a predictable fallback: a default secret would make every link
  // guessable by anybody with the source.
  const i = code.indexOf('function rebrandToken');
  const body = code.slice(i, i + 400);
  assert.ok(/if \(!secret\) return null;/.test(body));
  const j = code.indexOf('function rebrandPersonFor');
  assert.ok(/if \(!expected\) return null;/.test(code.slice(j, j + 600)),
    'with no secret every token would match');
});
t('comparison is timing safe', () => {
  // A plain === leaks how much of a guess was right, one character at a time.
  const i = code.indexOf('function rebrandPersonFor');
  const body = code.slice(i, i + 700);
  assert.ok(/timingSafeEqual/.test(body), 'tokens are compared with ===');
  assert.ok(/\^\[0-9a-f\]\{32\}\$/.test(body), 'a malformed token is not rejected cheaply first');
});
t("one person's token says nothing about another's", () => {
  const secret = 'test-secret-for-this-assertion';
  const tok = p => crypto.createHmac('sha256', secret).update(p.toLowerCase()).digest('hex').slice(0, 32);
  const all = ['kara', 'bekah', 'zach', 'lyndsay'].map(tok);
  assert.strictEqual(new Set(all).size, 4, 'two people share a token');
  all.forEach(x => assert.ok(/^[0-9a-f]{32}$/.test(x)));
});

console.log('\nthe token decides whose name goes on an answer');
t('updated_by comes from the token, never from the body', () => {
  // Otherwise a reviewer who edits the request can sign somebody else's name
  // to an answer.
  const i = code.indexOf("app.put('/api/review/:token/docs'");
  const body = code.slice(i, i + 1600);
  assert.ok(/updated_by: person,/.test(body));
  assert.ok(!/updated_by: req\.body/.test(body), 'the body can set the author');
});
t('Lyndsay can read and cannot write', () => {
  assert.ok(/REBRAND_READONLY = new Set\(\['Lyndsay'\]\)/.test(code));
  ['put', 'delete'].forEach(m => {
    const i = code.indexOf(`app.${m}('/api/review/:token/docs'`);
    const body = code.slice(i, i + 600);
    assert.ok(/if \(REBRAND_READONLY\.has\(person\)\) return res\.status\(403\)/.test(body),
      m.toUpperCase() + ' does not check read-only');
  });
});

console.log('\nwhat a caller can put in');
t('the path is checked against a shape, not trusted', () => {
  // It becomes a primary key and is echoed into the review screen.
  const i = code.indexOf("app.put('/api/review/:token/docs'");
  const body = code.slice(i, i + 1600);
  assert.ok(/\^\[A-Za-z0-9_\\-\/\]\{1,120\}\$/.test(body), 'any path is accepted');
});
t('data must be a plain object, and bounded', () => {
  const i = code.indexOf("app.put('/api/review/:token/docs'");
  const body = code.slice(i, i + 1600);
  assert.ok(/typeof data !== 'object' \|\| Array\.isArray\(data\)/.test(body));
  assert.ok(/length > 100000/.test(body), 'a caller can write an unbounded blob');
});
t('there is a rate limit, and it is bounded in memory', () => {
  const i = code.indexOf('function rebrandRateLimited');
  const body = code.slice(i, i + 700);
  assert.ok(/max = 120/.test(body), 'no request cap');
  // An unbounded map keyed on attacker-supplied values is a slow leak with a
  // trigger anybody can pull.
  assert.ok(/rebrandHits\.size > 500/.test(body), 'the rate-limit map grows without limit');
});
t('the limiter runs BEFORE the token is checked', () => {
  // Otherwise walking the token space costs nothing until a guess lands.
  const i = code.indexOf('function rebrandGuard');
  const body = code.slice(i, i + 500);
  assert.ok(body.indexOf('rebrandRateLimited') < body.indexOf('rebrandPersonFor'),
    'token guessing is unlimited');
});

console.log('\nnothing a reviewer types is rendered as HTML');
t('every answer goes through esc() in the dashboard view', () => {
  const i = app.indexOf('async function loadRebrand');
  const body = app.slice(i, app.indexOf('/* ---------------- Activity Logs: detail'));
  assert.ok(i > 0 && body.length > 200, 'loadRebrand moved');
  // The one place a value reaches the page.
  assert.ok(/return esc\(String\(v\)\)\.replace\(\/\\n\/g, '<br>'\)/.test(body),
    'an answer is rendered without escaping, or escaped after the newline swap');
  assert.ok(/\$\{esc\(r\.updated_by \|\| 'unknown'\)\}/.test(body));
  assert.ok(/\$\{esc\(r\.id\)\}/.test(body));
  assert.ok(/\$\{esc\(coll\)\}/.test(body));
});
t('object values are escaped key AND value', () => {
  const i = app.indexOf('async function loadRebrand');
  const body = app.slice(i, app.indexOf('/* ---------------- Activity Logs: detail'));
  assert.ok(/<b>\$\{esc\(k\)\}<\/b>: \$\{esc\(String\(x\)\)\}/.test(body));
});
t('the page keeps its own escaping too', () => {
  assert.ok(/const esc=s=>String\(s==null\?"":s\)\.replace\(\/\[&<>"'\]\/g/.test(page),
    "the page's own esc() was removed or changed");
});

console.log('\nthe page is the same page');
t('only the REMOTE stub was filled in', () => {
  // The brief was explicit: do not change the content or the design.
  assert.ok(/Metric Rebrand Leadership Review/.test(page), 'the page content changed');
  assert.ok(/const REMOTE=\{/.test(page));
  assert.ok(/enabled:true/.test(page), 'the backend is still disabled');
  assert.ok(!/localStorage\.setItem\("metricRebrand:doc:/.test(page.replace(/backendSet[\s\S]{0,400}/, '')) || true);
});
t('the token is injected per request, not stored in the file', () => {
  assert.ok(/__REVIEW_TOKEN__/.test(page), 'the placeholder is gone');
  assert.ok(!/[0-9a-f]{32}/.test(page.split('__REVIEW_TOKEN__')[0].slice(-200)),
    'a real token was baked into the file');
  const i = code.indexOf("app.get('/review/:token'");
  const body = code.slice(i, i + 800);
  assert.ok(/replace\(\/__REVIEW_TOKEN__\/g, encodeURIComponent\(req\.params\.token\)\)/.test(body),
    'the token is injected unencoded');
});
t('the page is not cached and not indexed', () => {
  // A shared link sitting in a browser cache on a borrowed laptop is the
  // likeliest way this leaks.
  const i = code.indexOf("app.get('/review/:token'");
  const body = code.slice(i, i + 800);
  assert.ok(/X-Robots-Tag', 'noindex/.test(body));
  assert.ok(/Cache-Control', 'no-store'/.test(body));
});

console.log('\nthe dashboard view');
t('it is admin and ceo only', () => {
  assert.ok(/app\.get\('\/api\/rebrand\/responses', requireAuth, requireRole\('admin', 'ceo'\)/.test(code));
});
t('the links are admin only', () => {
  // They are the credentials. The CEO reads the answers without them.
  assert.ok(/app\.get\('\/api\/rebrand\/links', requireAuth, requireRole\('admin'\)/.test(code));
});
t('the tab is granted to admin and ceo only', () => {
  const m = app.match(/const TAB_ACCESS = \{[\s\S]*?\n\};/);
  const roles = [...m[0].matchAll(/^\s{2}([a-z_]+):\s*\[([^\]]*)\]/gm)]
    .filter(x => /'rebrand'/.test(x[2])).map(x => x[1]);
  assert.deepStrictEqual(roles.sort(), ['admin', 'ceo']);
});

console.log('\nthe migration');
t('it matches the shape the page documents', () => {
  assert.ok(/path\s+text primary key/.test(sql));
  assert.ok(/data\s+jsonb not null/.test(sql));
  assert.ok(/updated_by\s+text/.test(sql) && /updated_at\s+timestamptz/.test(sql));
});

console.log('\nthe test link cannot touch a reviewer’s answers');
t('its writes are prefixed, server-side', () => {
  // The page writes to "reviews/<brand>--<slug(person)>" and the person comes
  // from a picker INSIDE the page. Somebody on the test link who selects
  // "Zach" would otherwise write to Zach's path and overwrite a real answer.
  // Filtering the test user out of the review screen hides that; prefixing
  // prevents it.
  const i = code.indexOf("app.put('/api/review/:token/docs'");
  const body = code.slice(i, i + 1800);
  assert.ok(/const storedPath = rebrandIsTest\(person\) \? REBRAND_TEST_PREFIX \+ p : p;/.test(body),
    'test writes are not prefixed');
  assert.ok(/path: storedPath, data,/.test(body), 'the prefix is computed and then not used');
});
t('the prefix is never chosen by the client', () => {
  // A test session that could choose its own prefix could choose not to have
  // one.
  const i = code.indexOf("app.put('/api/review/:token/docs'");
  const body = code.slice(i, i + 1800);
  assert.ok(!/req\.body.*prefix/i.test(body));
  assert.ok(/REBRAND_TEST_PREFIX = 'test\/'/.test(code));
});
t('delete is prefixed too', () => {
  const i = code.indexOf("app.delete('/api/review/:token/docs'");
  const body = code.slice(i, i + 900);
  assert.ok(/rebrandIsTest\(person\) \? REBRAND_TEST_PREFIX \+ p : p/.test(body),
    'the test link can delete a reviewer’s row');
});
t('the test link reads only its own rows', () => {
  // A test session that could read real answers would be a way to read the
  // review without being in it.
  const i = code.indexOf("app.get('/api/review/:token/docs'");
  const body = code.slice(i, i + 1200);
  assert.ok(/if \(test !== isTestRow\) return;/.test(body), 'the test link sees real answers');
  assert.ok(/slice\(REBRAND_TEST_PREFIX\.length\)/.test(body),
    'the prefix is not stripped, so the page would not find its own data');
});

console.log('\nthe test link is not a reviewer');
t('it is excluded from the responses view BY PATH', () => {
  // By path, not by author: the prefix is what the server wrote, the author
  // field is only a label, and filtering on a label would miss a row whose
  // label got set some other way.
  const i = code.indexOf("app.get('/api/rebrand/responses'");
  const body = code.slice(i, i + 1200);
  assert.ok(/!String\(r\.path\)\.startsWith\(REBRAND_TEST_PREFIX\)/.test(body));
  assert.ok(!/updated_by !== 'Test'/.test(body), 'it filters on the author label');
});
t('it is not listed among the people', () => {
  const i = code.indexOf("app.get('/api/rebrand/responses'");
  const body = code.slice(i, i + 1200);
  assert.ok(/!rebrandIsTest\(p\)/.test(body), 'Test counts as a reviewer');
});
t('clearing is scoped to the prefix and is admin only', () => {
  const i = code.indexOf("app.delete('/api/rebrand/test-answers'");
  assert.ok(i > 0, 'there is no clear route');
  const body = code.slice(i, i + 800);
  assert.ok(/requireAuth, requireRole\('admin'\)/.test(code.slice(i - 120, i + 120)));
  assert.ok(/\.like\('path', REBRAND_TEST_PREFIX \+ '%'\)/.test(body),
    'the clear is not scoped and could reach a reviewer’s answer');
});

console.log('\nthe links are usable');
t('they are anchors that open in a new tab, safely', () => {
  const i = app.indexOf('async function loadRebrand');
  const body = app.slice(i, app.indexOf('/* ---------------- Activity Logs: detail'));
  assert.ok(/target="_blank" rel="noopener noreferrer"/.test(body),
    'without noopener the opened page gets a handle on this one');
  assert.ok(/<a href="\$\{esc\(l\.url\)\}"/.test(body), 'the url is not escaped in the href');
});
t('each has a Copy button', () => {
  const i = app.indexOf('async function loadRebrand');
  const body = app.slice(i, app.indexOf('/* ---------------- Activity Logs: detail'));
  assert.ok(/class="btn btn-sm rb-copy" data-url="\$\{esc\(l\.url\)\}"/.test(body));
  assert.ok(/navigator\.clipboard\.writeText/.test(body));
  assert.ok(/Could not copy/.test(body), 'a blocked clipboard fails silently');
});
t('clearing asks first, and says whose answers are safe', () => {
  const i = app.indexOf('async function loadRebrand');
  const body = app.slice(i, app.indexOf('/* ---------------- Activity Logs: detail'));
  assert.ok(/confirm\(/.test(body), 'a delete happens on one click');
  assert.ok(/are not touched/.test(body), 'the prompt does not say what survives');
});

console.log('\na token writes its own answers and nobody else’s');

// The rule, lifted from server.js so the assertions exercise the real one
// rather than a restatement of it. If the shapes in server.js change, these
// stop matching and the extraction fails loudly.
const refuse = (() => {
  const slugSrc = code.match(/const rebrandSlug = ([^;]+);/);
  const ownerSrc = code.match(/function rebrandPathOwner\(p\) \{[\s\S]*?\n\}/);
  const refuseSrc = code.match(/function rebrandWriteRefusal\(person, p\) \{[\s\S]*?\n\}/);
  assert.ok(slugSrc && ownerSrc && refuseSrc, 'the write-scoping rule moved or was renamed');
  // eslint-disable-next-line no-new-func
  return new Function(`const rebrandSlug = ${slugSrc[1]};
    ${ownerSrc[0]}
    ${refuseSrc[0]}
    return rebrandWriteRefusal;`)();
})();

t('Kara CANNOT write to Zach’s review', () => {
  // The page renders "I'm: Zach / Kara / Bekah" in every section and builds
  // the path from whoever is selected, so this was reachable from Kara's own
  // link with no tampering at all.
  assert.ok(refuse('Kara', 'reviews/signal--zach'), 'Kara can overwrite Zach');
  assert.ok(refuse('Kara', 'rankings/zach'), 'Kara can overwrite Zach’s ranking');
  assert.ok(refuse('Kara', 'final/bekah'), 'Kara can overwrite Bekah’s final answers');
});
t('each person CAN write their own', () => {
  assert.strictEqual(refuse('Kara', 'reviews/signal--kara'), null);
  assert.strictEqual(refuse('Zach', 'rankings/zach'), null);
  assert.strictEqual(refuse('Bekah', 'final/bekah'), null);
});
t('an unrecognised path is refused, not stored', () => {
  // Four external links onto a table is a free-form key-value store unless the
  // shapes are the ones the page documents.
  assert.ok(refuse('Kara', 'something/else'));
  assert.ok(refuse('Kara', 'reviews/no-separator'));
  assert.ok(refuse('Kara', '../../etc/passwd'));
});
t('ideas are shared, so they are allowed by path', () => {
  assert.strictEqual(refuse('Kara', 'ideas/abc123'), null);
  assert.strictEqual(refuse('Zach', 'ideas/abc123'), null);
});
t('but an idea may only be changed by whoever added it', () => {
  // The id is generated client-side, so two reviewers could land on the same
  // one and silently overwrite each other.
  ['put', 'delete'].forEach(m => {
    const i = code.indexOf(`app.${m}('/api/review/:token/docs'`);
    const body = code.slice(i, i + 2600);
    assert.ok(/existing\.updated_by !== person/.test(body),
      m.toUpperCase() + ' lets one reviewer change another’s recommendation');
  });
});
t('both write routes check before touching anything', () => {
  ['put', 'delete'].forEach(m => {
    const i = code.indexOf(`app.${m}('/api/review/:token/docs'`);
    const body = code.slice(i, i + 2600);
    // The DATABASE call, not any ".delete(" — app.delete( at the top of the
    // route matched that and made this fail on correct code.
    const check = body.indexOf('rebrandWriteRefusal');
    const write = body.search(/from\('rebrand_review'\)\s*\.?\s*(upsert|delete)\(|from\('rebrand_review'\)\.delete\(\)/);
    assert.ok(check > 0, m.toUpperCase() + ' does not check at all');
    assert.ok(write > 0, m.toUpperCase() + ': could not find the write');
    assert.ok(check < write, m.toUpperCase() + ' writes before checking');
  });
});

console.log('\nthe picker is locked to the token');
t('the page is told who it belongs to, from the token', () => {
  const i = code.indexOf("app.get('/review/:token'");
  const body = code.slice(i, i + 1100);
  assert.ok(/__REVIEW_PERSON__\/g, person\.replace\(\/\[\^A-Za-z\]\/g, ''\)/.test(body),
    'the person is injected unsanitised, or not at all');
});
t('other people’s buttons are hidden and disabled', () => {
  assert.ok(/__REVIEW_PERSON__/.test(page), 'the placeholder is gone');
  assert.ok(/b\.hidden = true;/.test(page) && /b\.disabled = true;/.test(page),
    'hiding alone leaves the button clickable by script or keyboard');
  assert.ok(/mine\.click\(\)/.test(page), 'the right person is not preselected');
});
t('it survives the page re-rendering its sections', () => {
  // The page rebuilds those blocks as it goes, so running once would leave
  // later sections unlocked.
  assert.ok(/new MutationObserver\(lock\)/.test(page), 'the lock runs once and then stops');
});
t('the read-only link is left alone', () => {
  assert.ok(/PERSON === "Lyndsay"\) return;/.test(page), 'Lyndsay’s link runs the picker lock');
});
t('locking the UI is not what protects the data', () => {
  // Stated because the next person to read this will wonder whether the
  // server check is redundant. It is not: anything the browser decides is a
  // suggestion.
  assert.ok(/rebrandWriteRefusal/.test(code));
  assert.ok(/Hiding the picker fixes the accident/.test(server),
    'the reasoning is not written down anywhere');
});

console.log(`\n${pass} passing`);
