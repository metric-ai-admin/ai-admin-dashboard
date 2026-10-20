// Social media post links.
//
// Lyndsay asked for no duplicate links or posts, screenshots for the weekly
// report, and a daily accountability check. These guard the three ways that
// goes quietly wrong:
//
//   * two shares of one post looking like two posts, which is the duplicate
//     Katrina catches by eye and a machine should catch every time
//   * a rejection that says "duplicate" and nothing else, losing the half of
//     her answer that settles the argument
//   * a daily check reporting "all clear" from an empty roster
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/social-links.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('social media post links');

// ---- the same post, shared twice --------------------------------------------

t('two shares of one Facebook post are one post', () => {
  // The duplicate nobody catches by eye: two phones, two URLs, one post.
  const a = S.normaliseUrl('https://www.facebook.com/share/p/abc123/?mibextid=xyz');
  const b = S.normaliseUrl('https://m.facebook.com/share/p/abc123');
  assert.strictEqual(a.normalised, b.normalised);
  assert.strictEqual(a.platform, 'Facebook');
});

t('tracking parameters are dropped and the rest are sorted', () => {
  const a = S.normaliseUrl('https://nextdoor.com/p/xyz?b=2&utm_source=share&a=1#comments');
  const b = S.normaliseUrl('https://www.nextdoor.com/p/xyz/?a=1&b=2&fbclid=99');
  assert.strictEqual(a.normalised, b.normalised);
  assert.strictEqual(a.normalised, 'nextdoor.com/p/xyz?a=1&b=2');
});

t('a parameter that is part of the post is KEPT', () => {
  // Dropping everything would merge two different posts into one row and
  // reject a real post as a duplicate — worse than missing one.
  const a = S.normaliseUrl('https://facebook.com/permalink?story_fbid=111');
  const b = S.normaliseUrl('https://facebook.com/permalink?story_fbid=222');
  assert.notStrictEqual(a.normalised, b.normalised);
});

t('the original link is never rewritten', () => {
  // It is what an agent clicks to prove they posted.
  const r = S.normaliseUrl('https://m.facebook.com/share/p/abc?fbclid=1');
  assert.strictEqual(r.url, 'https://m.facebook.com/share/p/abc?fbclid=1');
});

t('rubbish is refused with a reason', () => {
  ['', '   ', 'not a link', 'javascript:alert(1)', 'ftp://x/y'].forEach(v => {
    const r = S.normaliseUrl(v);
    assert.strictEqual(r.ok, false, JSON.stringify(v));
    assert.ok(r.error, 'no reason given for ' + JSON.stringify(v));
  });
});

t('a bare domain still parses', () => {
  assert.strictEqual(S.normaliseUrl('tiktok.com/@x/video/1').platform, 'TikTok');
});

// ---- the platform ------------------------------------------------------------

t('a mismatch is refused, not silently corrected', () => {
  // Rewriting the choice would make the daily count wrong in a way nobody
  // could see.
  const r = S.platformCheck('Facebook', 'TikTok');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /looks like a TikTok link/);
});

t('an unknown host is allowed, with a warning', () => {
  const r = S.platformCheck('Facebook', null);
  assert.strictEqual(r.ok, true);
  assert.match(r.warning, /not on a platform we recognise/);
});

t('no platform is refused', () => {
  assert.strictEqual(S.platformCheck('', 'Facebook').ok, false);
  assert.strictEqual(S.platformCheck('Instagram', null).ok, false);
});

// ---- duplicates ---------------------------------------------------------------

t('a duplicate names who uploaded it and when', () => {
  // Katrina's answer is "we already have that, Rox posted it Tuesday". A bare
  // "duplicate" starts an argument; this ends one.
  const d = S.findDuplicate({ normalised: 'facebook.com/p/1' }, [
    { normalised_url: 'facebook.com/p/1', author: 'Rhoxie', created_at: '2026-10-14T10:00:00Z' },
  ]);
  assert.strictEqual(d.duplicate, true);
  assert.strictEqual(d.by, 'Rhoxie');
  assert.strictEqual(d.at, '2026-10-14');
  assert.match(d.message, /Rhoxie/);
  assert.match(d.message, /2026-10-14/);
});

t('an identical screenshot is a duplicate too', () => {
  const d = S.findDuplicate({ normalised: 'facebook.com/p/2', imageHash: 'deadbeef' }, [
    { normalised_url: 'facebook.com/p/1', image_hash: 'deadbeef', author: 'Katie', created_at: '2026-10-15T09:00:00Z' },
  ]);
  assert.strictEqual(d.duplicate, true);
  assert.match(d.reason, /screenshot/);
});

t('a missing author or date still produces a usable sentence', () => {
  const d = S.findDuplicate({ normalised: 'x' }, [{ normalised_url: 'x' }]);
  assert.strictEqual(d.duplicate, true);
  assert.match(d.message, /somebody/);
  assert.match(d.message, /an earlier date/);
});

t('a new post is not a duplicate', () => {
  const d = S.findDuplicate({ normalised: 'facebook.com/p/new', imageHash: 'abc' }, [
    { normalised_url: 'facebook.com/p/old', image_hash: 'zzz' },
  ]);
  assert.strictEqual(d.duplicate, false);
  assert.strictEqual(d.message, null);
});

t('no screenshot never matches a row that has one', () => {
  const d = S.findDuplicate({ normalised: 'facebook.com/p/new' }, [
    { normalised_url: 'facebook.com/p/old', image_hash: null },
  ]);
  assert.strictEqual(d.duplicate, false);
});

t('the exact hash is the file, not the name', () => {
  const a = S.imageHash(Buffer.from('same bytes'));
  const b = S.imageHash(Buffer.from('same bytes'));
  const c = S.imageHash(Buffer.from('other bytes'));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(S.imageHash(null), null);
});

t('the near-duplicate check is declared MISSING, not faked', () => {
  // A "perceptual" hash over raw file bytes is a worse exact hash wearing the
  // name. It needs an image decoder this project does not have, and the flag
  // is what lets the screen say so instead of implying it works.
  assert.strictEqual(S.PERCEPTUAL_AVAILABLE, false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'social-links.js'), 'utf8');
  assert.ok(!/dhash|phash|perceptualHash\s*\(/i.test(src.replace(/\/\/.*$/gm, '')),
    'something is pretending to be a perceptual hash');
});

// ---- the daily check ----------------------------------------------------------

t('an empty roster answers "not known", never "all clear"', () => {
  const r = S.dailyCheck([{ author: 'A', created_at: '2026-10-20T10:00:00Z' }], [], '2026-10-20');
  assert.strictEqual(r.known, false);
  assert.match(r.note, /not something this can answer/);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.total, 1);
});

t('with a roster it names who is missing', () => {
  const r = S.dailyCheck(
    [{ author: 'Rhoxie', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Rhoxie', expected: 1 }, { name: 'Katrina', expected: 1 }],
    '2026-10-20');
  assert.strictEqual(r.known, true);
  assert.deepStrictEqual(r.posted.map(p => p.name), ['Rhoxie']);
  assert.deepStrictEqual(r.missing.map(p => p.name), ['Katrina']);
});

t('one post against an expectation of two is still missing', () => {
  const r = S.dailyCheck(
    [{ author: 'Rhoxie', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Rhoxie', expected: 2 }], '2026-10-20');
  assert.deepStrictEqual(r.missing.map(p => p.name), ['Rhoxie']);
  assert.strictEqual(r.missing[0].posts, 1);
  assert.strictEqual(r.missing[0].expected, 2);
});

t('somebody not on the roster is reported, not dropped', () => {
  // A roster that is out of date must not lose a real post.
  const r = S.dailyCheck(
    [{ author: 'Someone New', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Rhoxie', expected: 1 }], '2026-10-20');
  assert.deepStrictEqual(r.notOnRoster, ['Someone New']);
  assert.strictEqual(r.total, 1);
});

t('posted_on wins over the upload day', () => {
  const r = S.dailyCheck(
    [{ author: 'A', posted_on: '2026-10-19', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'A', expected: 1 }], '2026-10-19');
  assert.strictEqual(r.total, 1, 'a post made yesterday counts for yesterday');
});

// ---- a roster with no target yet -----------------------------------------------
//
// Bekah confirmed WHO posts; Lyndsay has not said HOW MANY. The table's old
// default of 1 would have answered that question on her behalf.

t('a person with no target is never reported missing', () => {
  const r = S.dailyCheck([], [{ name: 'Oscar', expected: null }], '2026-10-20');
  assert.deepStrictEqual(r.missing, [], 'short of a number nobody chose');
  assert.deepStrictEqual(r.noTarget.map(p => p.name), ['Oscar']);
  assert.strictEqual(r.noTarget[0].posts, 0);
  assert.strictEqual(r.targetsSet, false);
  assert.match(r.note, /has not been chosen/);
});

t('no target is not success either', () => {
  // Landing in `posted` would read as "Oscar is up to date" on a day he
  // posted nothing. Neither bucket is the answer; noTarget is.
  const r = S.dailyCheck([], [{ name: 'Oscar', expected: null }], '2026-10-20');
  assert.deepStrictEqual(r.posted.map(p => p.name), []);
});

t('expected 0 and expected "" are also "not set", not "nothing expected"', () => {
  ['', 0, undefined].forEach(v => {
    const r = S.dailyCheck([], [{ name: 'Yeni', expected: v }], '2026-10-20');
    assert.deepStrictEqual(r.missing, [], JSON.stringify(v));
    assert.deepStrictEqual(r.noTarget.map(p => p.name), ['Yeni'], JSON.stringify(v));
  });
});

t('one person with a target and one without are reported apart', () => {
  const r = S.dailyCheck([], [
    { name: 'Sammy', expected: 2 }, { name: 'Daria', expected: null },
  ], '2026-10-20');
  assert.deepStrictEqual(r.missing.map(p => p.name), ['Sammy']);
  assert.deepStrictEqual(r.noTarget.map(p => p.name), ['Daria']);
  assert.strictEqual(r.targetsSet, false);
});

t('targetsSet is true only when every target is a number', () => {
  const r = S.dailyCheck([], [{ name: 'Sammy', expected: 1 }], '2026-10-20');
  assert.strictEqual(r.targetsSet, true);
  assert.strictEqual(r.note, null);
  assert.deepStrictEqual(r.noTarget, []);
});

// ---- matching the person, not the spelling ---------------------------------------

t('the login matches even when the name is spelled differently', () => {
  // "Rocío" in dashboard_users, "Rocio" in the roster. On the name alone she
  // posts and the check still calls her missing — silently.
  const r = S.dailyCheck(
    [{ author: 'Rocío Hunsberger', author_email: 'rocio@metric.internal',
       created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Rocio', email: 'rocio@metric.internal', expected: 1 }],
    '2026-10-20');
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.posted.map(p => p.name), ['Rocio']);
  assert.strictEqual(r.posted[0].matchedBy, 'login');
});

t('a matched login does not also appear as somebody not on the roster', () => {
  // The display name differs, so the "extra" sweep must not file the same
  // post a second time under the spelling from the session.
  const r = S.dailyCheck(
    [{ author: 'Rocío Hunsberger', author_email: 'rocio@metric.internal',
       created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Rocio', email: 'rocio@metric.internal', expected: 1 }],
    '2026-10-20');
  assert.deepStrictEqual(r.notOnRoster, []);
  assert.strictEqual(r.posted.length, 1, 'counted once, not twice');
});

t('without an email it still matches on the name, and says so', () => {
  // Four of the five have no account. Name matching is all there is for them.
  const r = S.dailyCheck(
    [{ author: 'Oscar', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Oscar', email: null, expected: 1 }], '2026-10-20');
  assert.deepStrictEqual(r.posted.map(p => p.name), ['Oscar']);
  assert.strictEqual(r.posted[0].matchedBy, 'name');
});

t('a roster email nobody posted under falls back to the name, not to zero', () => {
  const r = S.dailyCheck(
    [{ author: 'Sammy', created_at: '2026-10-20T10:00:00Z' }],
    [{ name: 'Sammy', email: 'sammy@metric.internal', expected: 1 }], '2026-10-20');
  assert.deepStrictEqual(r.missing, [], 'posted under a name, email not on the post');
  assert.strictEqual(r.posted[0].matchedBy, 'name');
});

t('the screen cannot print ALL IN off a roster with no targets', () => {
  // The failure this guards: five agents loaded, no daily number from Lyndsay,
  // nobody posts, `missing` is empty — and the old branch read that as
  // "everyone on the roster posted".
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'social-posts.js'), 'utf8');
  const at = js.indexOf('ALL IN');
  assert.ok(at > 0, 'the branch is gone');
  assert.match(js.slice(Math.max(0, at - 260), at), /c\.targetsSet/,
    'ALL IN is not gated on the targets being set');
  assert.match(js, /NO DAILY TARGET/, 'the no-target case is not shown at all');
});

// ---- the week folder -----------------------------------------------------------

t('the week folder matches the tracker Katie keeps', () => {
  // "Week of MM.DD.YY", Monday-based. Two different week shapes in one system
  // is how a report stops matching the other.
  assert.strictEqual(S.weekFolder('2026-10-20'), 'Week of 10.19.26');
  assert.strictEqual(S.weekFolder('2026-10-25'), 'Week of 10.19.26', 'Sunday belongs to its Monday');
  assert.strictEqual(S.weekFolder('2026-10-19'), 'Week of 10.19.26');
  assert.strictEqual(S.weekFolder('2026-10-26'), 'Week of 10.26.26');
  assert.strictEqual(S.weekFolder('nonsense'), null);
});

// ---- the routes ------------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('the author comes from the session, never the form', () => {
  const at = server.indexOf("app.post('/api/social-posts'");
  assert.ok(at > 0, 'the route is not there');
  const body = server.slice(at, server.indexOf("app.get('/api/social-posts'", at));
  assert.match(body, /req\.user && \(req\.user\.name \|\| req\.user\.email\)/);
  assert.ok(!/author:\s*req\.body/.test(body), 'the form can set the author');
});

t('a failed screenshot upload does not lose the post', () => {
  // The link is what Lyndsay asked for; losing it because SharePoint was slow
  // would be the wrong trade.
  const at = server.indexOf('async function socialUploadScreenshot');
  const body = server.slice(at, server.indexOf("app.post('/api/social-posts'", at));
  assert.match(body, /return \{ url: null, name, error: e\.message \}/);
  assert.ok(!/throw/.test(body.slice(body.indexOf('catch (e)'))), 'it rethrows');
});

t('the feed says whether a date is the post or the upload', () => {
  // So a weekly grid cannot file an upload as a post on the wrong day.
  const at = server.indexOf("app.get('/api/social-posts/feed'");
  assert.ok(at > 0);
  const body = server.slice(at, at + 2200);
  assert.match(body, /dateIs: p\.posted_on \? 'posted' : 'uploaded'/);
});

// ---- the leasing agents' access ---------------------------------------------------
//
// social_agent is Sammy, Oscar, Yeni and Daria: the form and their own
// history. Hiding tabs hides buttons, so these guard the server side.

t('a scoped role is filtered on the server, not just in the tab list', () => {
  const at = server.indexOf("app.get('/api/social-posts'");
  const body = server.slice(at, server.indexOf("app.get('/api/social-posts/feed'", at));
  assert.match(body, /socialOwnOnly\(req\)/, 'the day view is not scoped');
  assert.match(body, /\.eq\('author_email'/, 'scoped by something other than the login');
});

t('the feed is scoped too', () => {
  // It is Jay's tracker, but anyone signed in can call it — an unscoped feed
  // hands back exactly what the screen withholds.
  const at = server.indexOf("app.get('/api/social-posts/feed'");
  const body = server.slice(at, at + 2600);
  assert.match(body, /socialOwnOnly\(req\)/);
  assert.match(body, /\.eq\('author_email'/);
});

t('a scoped session with no email sees nothing, not everything', () => {
  const at = server.indexOf('function socialOwnOnly');
  const body = server.slice(at, server.indexOf("app.post('/api/social-posts'", at));
  assert.match(body, /email: email \|\| null/);
  const view = server.slice(server.indexOf("app.get('/api/social-posts'"));
  assert.match(view.slice(0, 2000), /no-such-login/,
    'an empty email must narrow the query to nothing, never drop the filter');
});

t('scoping is opt-in by role, so a new role cannot silently lose its view', () => {
  const at = server.indexOf('const SOCIAL_OWN_ONLY_ROLES');
  assert.ok(at > 0);
  assert.match(server.slice(at, at + 200), /\['social_agent'\]/);
});

t('a scoped agent is not shown her four colleagues as missing', () => {
  // Her own posts filtered against the whole roster would report the other
  // four short on every screen she opens.
  const at = server.indexOf("app.get('/api/social-posts'");
  const body = server.slice(at, server.indexOf("app.get('/api/social-posts/feed'", at));
  assert.match(body, /roster4/);
  assert.match(body, /dailyCheck\(posts\.data \|\| \[\], roster4, day\)/);
});

t('social_agent gets exactly one tab, and it is not Marketing', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = app.match(/social_agent:\s*\[([^\]]*)\]/);
  assert.ok(m, 'the role is not in TAB_ACCESS');
  const tabs = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(tabs, ['socialposts']);
});

t('the form has its own tab, so no role has to open Marketing to reach it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('id="tab-socialposts"');
  assert.ok(at > 0, 'the section does not exist');
  const section = html.slice(at, html.indexOf('</section>', at));
  assert.match(section, /id="sp-form"/, 'the form is not in it');
  assert.ok(html.indexOf('data-tab="socialposts"') > 0, 'no nav button');
  // And it is NOT still sitting inside Marketing.
  const mk = html.indexOf('id="tab-marketing"');
  assert.ok(html.slice(mk, html.indexOf('</section>', mk)).indexOf('id="sp-form"') < 0,
    'the form is still inside the Marketing tab');
});

t('a scoped agent does not get the link into Jay\'s ops dashboard', () => {
  // The link sits outside the tab gate and is kept for every role, which was
  // written when every role was staff with a dashboard of their own. The
  // leasing agents are not.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /NO_OPS_LINK_ROLES\s*=\s*\['social_agent'\]/);
  assert.match(app, /NO_OPS_LINK_ROLES\.includes\(currentUser\.role\)/);
  assert.match(app, /getElementById\('ops-dashboard-link'\)/);
});

t('the screen says whose posts it is showing', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'social-posts.js'), 'utf8');
  assert.match(js, /scope === 'own'/);
  assert.match(js, /your posts only/);
});

// ---- creating an account ------------------------------------------------------------

t('creating a user writes both halves, or neither', () => {
  // A Supabase Auth user with no dashboard_users row is turned away at login;
  // a row with no Auth user cannot sign in at all. Done by hand, forgetting
  // the second half is the normal outcome.
  const at = server.indexOf("app.post('/api/auth/admin/create-user'");
  assert.ok(at > 0, 'the route is not there');
  const body = server.slice(at, server.indexOf("app.post('/api/auth/change-password'", at));
  assert.match(body, /auth\.admin\.createUser/);
  assert.match(body, /from\('dashboard_users'\)\.insert/);
  assert.match(body, /auth\.admin\.deleteUser/, 'a failed insert leaves half an account');
  assert.match(body, /email_confirm: true/, 'no inbox to confirm from');
  assert.match(body, /must_change_password: true/);
});

t('creating a user never overwrites an existing login', () => {
  const at = server.indexOf("app.post('/api/auth/admin/create-user'");
  const body = server.slice(at, server.indexOf("app.post('/api/auth/change-password'", at));
  assert.match(body, /status\(409\)/);
  assert.match(body, /requireMetricAdmin/);
});

t('the new password is returned once and never logged', () => {
  const at = server.indexOf("app.post('/api/auth/admin/create-user'");
  const body = server.slice(at, server.indexOf("app.post('/api/auth/change-password'", at));
  // The log CALL only — a wider window reaches the response below it, which
  // does carry the password, once, on purpose.
  const from = body.indexOf('activityLog.log');
  assert.ok(from > 0, 'the act is not logged at all');
  const log = body.slice(from, body.indexOf('});', from));
  assert.ok(!/password/i.test(log), 'the activity log carries the password');
  assert.match(body, /detail: username \+ ' as ' \+ role/);
});

// ---- the Create user form -----------------------------------------------------------
//
// It exists so the temporary password has somewhere to go that is not a chat
// window. These guard the two ways that intent is lost.

const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const acct = appjs.slice(appjs.indexOf('function acctInit()'),
  appjs.indexOf('async function loadActivity()'));

t('the form exists, admin only, and starts hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('id="acct-card"');
  assert.ok(at > 0, 'the card is not there');
  assert.match(html.slice(at, at + 120), /hidden/, 'the card is visible before the role is known');
  assert.ok(acct.length > 200, 'acctInit is not there');
  assert.match(acct, /currentUser\?\.role !== 'admin'/);
  // Inside the Activity tab, which is where "who has access" belongs.
  const sec = html.indexOf('id="tab-activity"');
  assert.ok(at > sec && at < html.indexOf('</section>', sec), 'the card is not in the Activity tab');
});

t('the password is shown once and kept nowhere', () => {
  assert.match(acct, /data\.password/, 'the password is never shown');
  // Not stashed anywhere it could outlive the screen.
  assert.ok(!/localStorage|sessionStorage/.test(acct), 'the password touches storage');
  assert.ok(!/console\.(log|info|warn)/.test(acct), 'the password could reach the console');
  // A second create must clear the first one off the screen first.
  assert.match(acct, /out\.innerHTML = '';/);
  assert.match(acct, /Shown once/);
});

t('the copy button says when it could not copy', () => {
  // A button that looks like it worked is worse than no button.
  assert.match(acct, /clipboard\.writeText/);
  assert.match(acct, /could not copy/);
});

t('the role picker offers only roles the app knows', () => {
  // A role typed by hand produces an account that signs in and sees nothing.
  assert.match(acct, /Object\.keys\(TAB_ACCESS\)/);
});

t('Katie\'s workbook is not touched by any of this', () => {
  const at = server.indexOf('SOCIAL MEDIA POST LINKS');
  const block = server.slice(at, server.indexOf('// GET /api/maintenance/open-work-orders', at));
  assert.ok(!/Facebook Links All Sites|FACEBOOK_LINKS/i.test(block));
  assert.match(block, /KATIE'S WORKBOOK IS NOT TOUCHED/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
