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

t('Katie\'s workbook is not touched by any of this', () => {
  const at = server.indexOf('SOCIAL MEDIA POST LINKS');
  const block = server.slice(at, server.indexOf('// GET /api/maintenance/open-work-orders', at));
  assert.ok(!/Facebook Links All Sites|FACEBOOK_LINKS/i.test(block));
  assert.match(block, /KATIE'S WORKBOOK IS NOT TOUCHED/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
