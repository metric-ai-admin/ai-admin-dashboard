// Streaming a social screenshot instead of linking into admin@'s OneDrive.
//
// The bug these guard: the stored screenshot_url is a webUrl in
// admin@metricpropertymanagement.com's PERSONAL OneDrive
// (netorgft5473895-my.sharepoint.com), so every other person who clicked it
// got "You need access" — seen on Daria's 10/27 post, true of every
// screenshot ever stored. The route streams the bytes with the app
// credentials so no folder has to be shared.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const client = read('public/social-posts.js');
const mig = read('supabase/migrations/116_social_posts_screenshot_item_id.sql');
// Comments say what must NOT happen, so they name the very things the
// assertions forbid. Stripping them means these read the code.
const strip = s => s.replace(/^\s*\/\/.*$/gm, '');

// The route body, which is what almost every assertion below is about.
const ROUTE_START = "app.get('/api/social-posts/:id/screenshot'";
const route = (() => {
  const i = server.indexOf(ROUTE_START);
  assert.ok(i > 0, 'the screenshot route is gone');
  return server.slice(i, i + 4200);
})();

console.log('social screenshot streaming');

// ---- the scoping, which is the whole point ---------------------------------

t('the route is behind requireAuth', () => {
  assert.ok(new RegExp(ROUTE_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + ", requireAuth").test(server));
});

t('it REUSES socialOwnOnly rather than re-deriving the rule', () => {
  // THE ONE THAT MATTERS. requireAuth alone lets a social_agent walk the ids
  // and pull screenshots from posts the list route deliberately hides. Two
  // copies of the rule would drift and only one of them would be fixed.
  assert.ok(/const own = socialOwnOnly\(req\);/.test(route),
    'the own-posts-only scoping is not applied');
  assert.ok(/if \(own\) q = q\.eq\('author_email'/.test(route),
    'the scope is computed but never used as a filter');
});

t('an own-only session with no email matches nothing, never everything', () => {
  // The same guard the list route uses: an empty email must narrow the query,
  // not widen it. This is the failure that opens the board to the one person
  // it was closed to.
  assert.ok(/own\.email \|\| '\\u0000no-such-login'/.test(route));
});

t('"not yours" and "not there" give the same answer', () => {
  // Two different answers would let somebody probe which ids exist on other
  // people's posts.
  assert.ok(/if \(!found\.data\) return res\.status\(404\)/.test(route));
});

// ---- the 302, which is the trap --------------------------------------------

t("the redirect is followed server-side and the browser is never sent there", () => {
  // Graph answers /content with a 302 to a pre-authenticated URL carrying NO
  // bearer token. Anyone holding it can fetch the file, so redirecting the
  // browser would re-share exactly what this route exists to stop.
  // Stripped FIRST: the comment above this code quotes `redirect: 'follow'`
  // to explain why it is pinned, so an unstripped assertion passes even when
  // the code says 'manual'.
  const body = strip(route);
  assert.ok(/redirect: 'follow'/.test(body), 'the redirect mode is not pinned');
  assert.ok(!/res\.redirect/.test(body), 'the browser is being redirected');
  assert.ok(!/@microsoft\.graph\.downloadUrl/.test(body),
    'the pre-authenticated download URL is being handed out');
});

t('the bytes are piped, with the app token on the Graph request', () => {
  assert.ok(/Authorization: 'Bearer ' \+ token/.test(route));
  assert.ok(/await r\.arrayBuffer\(\)/.test(route), 'nothing is actually streamed');
});

// ---- caching ---------------------------------------------------------------

t('the response is private and not stored', () => {
  // One agent's image fetched under their session; a shared cache holding it
  // would hand it to the next person through.
  assert.ok(/Cache-Control', 'private, no-store'/.test(route));
});

// ---- the three failure modes, each saying which one it is ------------------

t('a post whose upload failed is not reported as a missing file', () => {
  assert.ok(/the upload to SharePoint failed/.test(route));
});

t('gone from SharePoint is a 404, and Graph refusing is a 502', () => {
  // Different people have to do different things about these two.
  assert.ok(/r\.status === 404[\s\S]{0,200}moved, renamed or deleted/.test(route));
  assert.ok(/status\(502\)[\s\S]{0,120}Graph/.test(route));
});

t('a missing column asks for the migration instead of 500ing', () => {
  assert.ok(/screenshot_item_id[\s\S]{0,200}needsMigration: true/.test(route));
  assert.ok(/116_social_posts_screenshot_item_id\.sql/.test(route));
});

// ---- locating the file -----------------------------------------------------

t('the item id wins and the path is the fallback for older rows', () => {
  const fn = server.slice(server.indexOf('function socialScreenshotGraphUrl'),
    server.indexOf('function socialScreenshotGraphUrl') + 1400);
  assert.ok(/\/items\/' \+ encodeURIComponent\(id\) \+ '\/content/.test(fn), 'no id path');
  assert.ok(/SOCIAL\.weekFolder\(day\)/.test(fn), 'no path fallback for old rows');
  // The id is checked FIRST: the rebuild re-derives the folder from a date and
  // breaks on a renamed file, so it must never win over a real handle.
  assert.ok(fn.indexOf('/items/') < fn.indexOf('weekFolder'));
});

t('the fallback rebuilds the path the way the upload built it', () => {
  const up = server.slice(server.indexOf('async function socialUploadScreenshot'),
    server.indexOf('async function socialUploadScreenshot') + 1200);
  assert.ok(/SOCIAL_FOLDER \+ '\/' \+ folder \+ '\/' \+ name/.test(up));
  const fn = server.slice(server.indexOf('function socialScreenshotGraphUrl'),
    server.indexOf('function socialScreenshotGraphUrl') + 1400);
  assert.ok(/SOCIAL_FOLDER \+ '\/' \+ folder \+ '\/' \+ name/.test(fn),
    'the two no longer agree on where the file is');
});

t('the upload keeps the Graph item id instead of discarding it', () => {
  const up = server.slice(server.indexOf('async function socialUploadScreenshot'),
    server.indexOf('async function socialUploadScreenshot') + 1600);
  assert.ok(/id: j\.id \|\| null/.test(up), 'the id is still being thrown away');
  assert.ok(/screenshot_item_id: shot\.id \|\| null/.test(server), 'the id is never stored');
});

t('a post still lands if the migration has not run yet', () => {
  // Losing a link over a column that only makes the screenshot viewable would
  // be the wrong trade — the same one socialUploadScreenshot already makes.
  assert.ok(/screenshot_item_id\/\.test\(error\.message/.test(server.replace(/\s+/g, ''))
    || /\/screenshot_item_id\/\.test\(error\.message \|\| ''\)/.test(server),
    'the insert does not retry without the new column');
});

// ---- the client ------------------------------------------------------------

t('the table links to our route, not to SharePoint', () => {
  assert.ok(/href="\/api\/social-posts\/' \+ encodeURIComponent\(p\.id\) \+ '\/screenshot"/.test(client),
    'the table still links somewhere else');
  const cell = strip(client.slice(client.indexOf('<td>' + "' + (p.screenshot_url") - 400,
    client.indexOf('</tr>')));
  assert.ok(!/href="' \+ esc\(p\.screenshot_url\)/.test(cell),
    'the OneDrive webUrl is still being linked');
});

t('the row still knows a screenshot exists', () => {
  // The link is offered on name OR url, so a row that stored a name but no
  // webUrl is not shown as "none" — and the list route has to SELECT the name
  // for that to mean anything.
  assert.ok(/p\.screenshot_url \|\| p\.screenshot_name/.test(client));
  assert.ok(/screenshot_url,'\s*\+\s*'screenshot_name,created_at/.test(server)
    || /screenshot_name,created_at/.test(server),
    'screenshot_name is not in the list projection');
});

// ---- the migration ---------------------------------------------------------

t('the migration adds the column, idempotently, with no new grants', () => {
  assert.ok(/alter table social_posts add column if not exists screenshot_item_id text;/.test(mig));
  // The migration EXPLAINS why it adds no grants and no index, so the prose
  // names both — these assertions are about the statements.
  const sql = mig.replace(/^\s*--.*$/gm, '');
  assert.ok(!/\bgrant\b/i.test(sql), 'a grant appeared in a column-only migration');
  assert.ok(!/create index/i.test(sql), 'an index nobody reads');
});

t('the migration does not backfill', () => {
  // A backfill would mean a Graph call per existing row, from a migration,
  // against production — for rows the path fallback already serves.
  assert.ok(!/^\s*update\s+social_posts/im.test(mig));
});

t('/api/social-posts/feed is untouched — it goes to Friday with Jay', () => {
  const feed = server.slice(server.indexOf("app.get('/api/social-posts/feed'"),
    server.indexOf("app.get('/api/social-posts/feed'") + 1800);
  assert.ok(/screenshot: p\.screenshot_url/.test(feed),
    'the feed changed; it was explicitly left alone');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
