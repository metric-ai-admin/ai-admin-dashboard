// Katrina files the leasing agents' links for them.
//
// Jay, 2026-10-26: the agents stop uploading their own posts. Katie chases
// them in the WhatsApp group, Katrina enters the links. So the person pressing
// the button stops being the person the post belongs to, and three things that
// all read `author` have to keep working:
//
//   the daily check  counts posts per agent, matching roster to post on email
//   the duplicate    names who posted it and when
//   Rocío's view     is filtered to author_email = her own login
//
// Which is why the author stays the AGENT and the uploader goes in its own
// column. Filing Katrina as the author would have taken a post off the agent's
// daily count and out of Rocío's history at the same time — two silent
// failures from one convenience.
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
const script = read('public/social-posts.js');
const html = read('public/index.html');
const SOCIAL = require('../lib/social-links.js');

const codeOf = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');
const sCode = codeOf(server);

// The resolver, lifted out of server.js and run for real.
const resolver = (() => {
  const a = server.indexOf('const SOCIAL_UPLOAD_FOR_OTHERS_ROLES');
  const b = server.indexOf('\n}\n', server.indexOf('function socialResolveAuthor')) + 3;
  assert.ok(a > 0 && b > a, 'the resolver moved');
  const code = server.slice(a, b) + '\nreturn { socialResolveAuthor, socialMayUploadForOthers };';
  return new Function('SOCIAL', code)({ clean: s => String(s == null ? '' : s).trim() });
})();

const ROSTER = [
  { person: 'Sammy', email: 'sammy@metric.internal', active: true },
  { person: 'Oscar', email: 'oscar@metric.internal', active: true },
  { person: 'Rocio', email: 'rocio@metric.internal', active: true },
];
const as = (role, posted_by) => ({ user: { role }, body: posted_by ? { posted_by } : {} });

console.log('social posts — uploading for an agent');

// ---- who may, and who may not -----------------------------------------------------

t('Katrina may file a post for an agent', () => {
  const r = resolver.socialResolveAuthor(as('marketing_bd_agent', 'Sammy'), ROSTER);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.person.person, 'Sammy');
  assert.strictEqual(r.person.email, 'sammy@metric.internal');
});

t('an admin may too', () => {
  assert.strictEqual(resolver.socialResolveAuthor(as('admin', 'Oscar'), ROSTER).ok, true);
});

t('KATIE CANNOT — she uploads, but only as herself', () => {
  // She keeps the tab and the upload. What she does not get is the selector.
  const r = resolver.socialResolveAuthor(as('leasing_bd', 'Sammy'), ROSTER);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
});

t('an agent cannot file under another agent', () => {
  const r = resolver.socialResolveAuthor(as('social_agent', 'Rocio'), ROSTER);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
  const r2 = resolver.socialResolveAuthor(as('collections_leasing', 'Sammy'), ROSTER);
  assert.strictEqual(r2.ok, false);
});

t('IT REFUSES RATHER THAN FALLING BACK TO THE SENDER', () => {
  // The failure that would be invisible: quietly ignoring posted_by files the
  // post under the uploader's own name, the form says "Added", and the agent's
  // weekly count is short with nothing to explain it.
  const r = resolver.socialResolveAuthor(as('social_agent', 'Rocio'), ROSTER);
  assert.strictEqual(r.ok, false, 'posted_by was silently ignored');
  assert.ok(!('person' in r), 'it resolved to somebody anyway');
});

t('everybody can still upload as themselves', () => {
  ['social_agent', 'leasing_bd', 'collections_leasing', 'marketing_bd_agent', 'admin']
    .forEach(role => {
      const r = resolver.socialResolveAuthor(as(role), ROSTER);
      assert.strictEqual(r.ok, true, role + ' cannot upload at all');
      assert.strictEqual(r.person, null, role + ' got an author it did not ask for');
    });
});

// ---- the name has to be real ---------------------------------------------------------

t('a name not on the active roster is refused', () => {
  const r = resolver.socialResolveAuthor(as('marketing_bd_agent', 'Bekah'), ROSTER);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

t('an email works as well as a name', () => {
  const r = resolver.socialResolveAuthor(as('marketing_bd_agent', 'rocio@metric.internal'), ROSTER);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.person.person, 'Rocio');
});

t('the roster is matched case-insensitively, but not loosely', () => {
  assert.strictEqual(resolver.socialResolveAuthor(as('admin', 'sammy'), ROSTER).ok, true);
  // Not a prefix, not a fuzzy match: free text is how "Rocío" and "Rocio"
  // became two people on the daily check in the first place.
  assert.strictEqual(resolver.socialResolveAuthor(as('admin', 'Sam'), ROSTER).ok, false);
});

t('only ACTIVE roster rows can be filed against', () => {
  const withLeaver = ROSTER.concat([{ person: 'Claudia', email: 'claudia@metric.internal', active: false }]);
  // The route filters active before calling the resolver; this asserts the
  // filter is there rather than that the resolver re-does it.
  const at = sCode.indexOf("from('social_post_roster')");
  assert.ok(at > 0, 'the route no longer reads the roster');
  const near = sCode.slice(at, at + 400);
  assert.match(near, /r\.active !== false/, 'the route does not filter to active agents');
  assert.ok(withLeaver.length === 4);
});

// ---- the author is the agent, the uploader is recorded ----------------------------------

// server.js has several `const row = {`; this anchors on a field unique to the
// social post one, so the assertions below read the block they mean.
const socialRowBody = (() => {
  const anchor = sCode.indexOf('normalised_url: link.normalised');
  assert.ok(anchor > 0, 'the social post row moved');
  const at = sCode.lastIndexOf('const row = {', anchor);
  return sCode.slice(at, sCode.indexOf('};', anchor));
})();

t('the row files the AGENT as author and the uploader separately', () => {
  const body = socialRowBody;
  assert.match(body, /^\s*author,\s*$/m, 'author is not the resolved agent');
  assert.match(body, /author_email: authorEmail/, 'author_email is not the agent\'s');
  assert.match(body, /uploaded_by: who/, 'the uploader is not recorded');
  assert.match(body, /uploaded_by_email: \(req\.user && req\.user\.email\) \|\| null/);
});

t('the uploader is recorded on a self-upload too', () => {
  // Always set, so "who entered this" has one answer rather than a null that
  // has to be read as "the same person, probably".
  assert.ok(!/uploaded_by:.*\?/.test(socialRowBody), 'the uploader is set conditionally');
});

t('the day\'s list reads the new columns', () => {
  // A column left out of a projection is invisible in exactly the way a column
  // nobody writes is — this screen has been bitten by that before.
  // The projection spans two lines joined with a +, so take a window from its
  // first column rather than hunting for a closing paren that is not there.
  const at = sCode.indexOf("'id,url,platform,property,author");
  assert.ok(at > 0, 'the list projection moved');
  const sel = sCode.slice(at, at + 260);
  assert.ok(/uploaded_by/.test(sel) && /uploaded_by_email/.test(sel),
    'the list query does not read the uploader');
});

// ---- the daily count still lands on the agent -------------------------------------------

t('A POST FILED BY KATRINA COUNTS FOR THE AGENT', () => {
  // The whole reason the author stays the agent. dailyCheck matches roster to
  // post on author_email, so nothing in it had to change.
  const day = '2026-10-26';
  const posts = [{
    author: 'Sammy', author_email: 'sammy@metric.internal',
    uploaded_by: 'Katrina Marie Lopez', uploaded_by_email: 'katrina@metric.internal',
    posted_on: day,
  }];
  const check = SOCIAL.dailyCheck(posts, [
    { name: 'Sammy', email: 'sammy@metric.internal', expected: 1 },
    { name: 'Oscar', email: 'oscar@metric.internal', expected: 1 },
  ], day);
  const sammy = check.posted.concat(check.missing, check.noTarget || [])
    .find(r => r.name === 'Sammy');
  assert.strictEqual(sammy.posts, 1, 'the post did not count for Sammy');
  assert.strictEqual(sammy.matchedBy, 'login');
  // And Katrina is not invented as a sixth person who posted today.
  assert.deepStrictEqual((check.extra || []).map(e => e.name), []);
});

t('Rocío still sees a post Katrina filed for her', () => {
  // Her view is filtered to author_email = her own login. Filing Katrina as
  // the author would have taken it out of her history silently.
  const at = sCode.indexOf('function socialOwnOnly');
  assert.ok(at > 0);
  assert.match(sCode, /pq\.eq\('author_email', own\.email/,
    'the own-posts filter no longer uses author_email');
  // The author written for a filed post is the agent's email, so it matches.
  const r = resolver.socialResolveAuthor(as('marketing_bd_agent', 'Rocio'), ROSTER);
  assert.strictEqual(r.person.email, 'rocio@metric.internal');
});

// ---- the screen -----------------------------------------------------------------------

t('the selector is hidden unless the server says otherwise', () => {
  // Attribute order is not the point; the tag carrying both is.
  const tag = (html.match(/<label[^>]*id="sp-for-field"[^>]*>/) || [''])[0];
  assert.ok(tag, 'the Posted by field is gone from the form');
  assert.match(tag, /class="[^"]*hidden[^"]*"/, 'the field is not hidden by default');
  assert.match(script, /spData\.mayUploadForOthers/, 'the client does not ask the server');
  assert.match(script, /field\.classList\.add\('hidden'\)/);
});

t('the server decides, and POST re-checks it', () => {
  // Hiding the control is a courtesy. The refusal is the lock.
  assert.match(sCode, /mayUploadForOthers: socialMayUploadForOthers\(req\)/,
    'the GET route does not tell the client');
  assert.match(sCode, /socialResolveAuthor\(req, activeRoster\)/,
    'POST does not re-resolve the author');
  assert.match(sCode, /if \(!forWhom\.ok\) return res\.status\(forWhom\.status\)/,
    'POST does not refuse a bad posted_by');
});

t('a hidden selector cannot submit a stale name', () => {
  const at = script.indexOf('function spRenderUploadFor');
  const body = script.slice(at, at + 1200);
  assert.match(body, /sel\.value = ''/, 'hiding the field leaves its value behind');
});

t('the agent stays selected between uploads', () => {
  // Katrina enters several links for one person. A selector that returns to
  // "Me" after each files the next one against the wrong person, with no error
  // — uploading as yourself is always allowed.
  assert.match(script, /const keepFor = \(document\.getElementById\('sp-for'\)/,
    'the selection is lost on reset');
  assert.match(script, /if \(selAfter && keepFor\) selAfter\.value = keepFor/);
});

t('the list shows the uploader only when it differs', () => {
  const at = script.indexOf('const spUploader');
  assert.ok(at > 0, 'the uploader rule is gone');
  const body = script.slice(at, at + 600);
  assert.match(body, /a === u \? '' : by/, 'it does not compare on the login');
  assert.match(script, /uploaded by '/, 'the list never prints the uploader');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
