// Social media post links: one row per post, no duplicates.
//
// Lyndsay asked for three things — no duplicate links or posts, screenshots
// kept for the weekly report, and a daily accountability check. This is the
// first: the link, and knowing it has not been posted before.
//
// WHAT IT REPLACES. Agents publish on their own Facebook, TikTok and Nextdoor
// pages, send the link to a WhatsApp group, Katrina eyeballs it for
// duplicates, and Katie copies it into a workbook. The eyeballing is the part
// a machine does better and the part that silently fails when the group is
// busy.
//
// A REJECTED DUPLICATE SAYS WHO AND WHEN. That is what Katrina does today —
// "we already have that one, Rox posted it Tuesday" — and a bare "duplicate"
// loses the half of her answer that settles the argument.

'use strict';

const crypto = require('crypto');

const clean = s => String(s == null ? '' : s).trim();

const PLATFORMS = ['Facebook', 'TikTok', 'Nextdoor'];

// Tracking and session noise. Two people sharing the same post from two
// phones produce different URLs that are the same post, which is exactly the
// duplicate nobody catches by eye.
const JUNK_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^igshid$/i, /^gclid$/i, /^mibextid$/i, /^rdid$/i,
  /^share_url$/i, /^_rdr$/i, /^ref$/i, /^refsrc$/i, /^__tn__$/i, /^__cft__/i,
  /^is_from_webapp$/i, /^sender_device$/i, /^web_id$/i, /^lang$/i,
];

const HOST_ALIASES = {
  'm.facebook.com': 'facebook.com',
  'web.facebook.com': 'facebook.com',
  'www.facebook.com': 'facebook.com',
  'fb.watch': 'facebook.com',
  'www.tiktok.com': 'tiktok.com',
  'vm.tiktok.com': 'tiktok.com',
  'www.nextdoor.com': 'nextdoor.com',
  'nextdoor.co.uk': 'nextdoor.com',
};

const PLATFORM_BY_HOST = {
  'facebook.com': 'Facebook',
  'tiktok.com': 'TikTok',
  'nextdoor.com': 'Nextdoor',
};

/**
 * The comparable form of a URL.
 *
 * NOT A CORRECTION. The original is stored and shown; this is the key the
 * unique index sits on. A normaliser that overwrote the link would lose the
 * one thing an agent can click to prove they posted.
 *
 * @returns {{ok: boolean, url: string|null, normalised: string|null,
 *            host: string|null, platform: string|null, error: string|null}}
 */
function normaliseUrl(raw) {
  const text = clean(raw);
  if (!text) return fail('a link is required');
  // ONLY PREFIX WHEN THERE IS NO SCHEME AT ALL. Testing for http:// and
  // prefixing everything else turned "ftp://x/y" into "https://ftp://x/y" —
  // a perfectly valid https URL with a host called "ftp" — so the protocol
  // check below never saw it and rubbish was accepted as a post.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  let u;
  try {
    u = new URL(hasScheme ? text : 'https://' + text);
  } catch (e) {
    return fail('that is not a link');
  }
  if (!/^https?:$/i.test(u.protocol)) return fail('only http and https links');
  if (!u.hostname || u.hostname.indexOf('.') < 0) return fail('that is not a link');

  const host = HOST_ALIASES[u.hostname.toLowerCase()] || u.hostname.toLowerCase();

  // Query parameters: drop the junk, keep the rest, and SORT, so the same
  // post shared twice with the parameters in a different order is one row.
  const keep = [];
  u.searchParams.forEach((v, k) => {
    if (!JUNK_PARAMS.some(re => re.test(k))) keep.push([k, v]);
  });
  keep.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const query = keep.map(([k, v]) => k + '=' + v).join('&');

  // The fragment is never part of which post this is.
  const path = u.pathname.replace(/\/+$/, '') || '/';

  return {
    ok: true,
    url: text,
    normalised: host + path + (query ? '?' + query : ''),
    host,
    platform: PLATFORM_BY_HOST[host] || null,
    error: null,
  };
}

function fail(error) {
  return { ok: false, url: null, normalised: null, host: null, platform: null, error };
}

/**
 * Does the link's host agree with the platform the agent picked?
 *
 * A MISMATCH IS REPORTED, NOT CORRECTED. A TikTok link filed under Facebook is
 * either a slip or a platform we have not met, and silently rewriting the
 * choice would make the daily count wrong in a way nobody could see.
 */
function platformCheck(chosen, detected) {
  const c = clean(chosen);
  if (!PLATFORMS.includes(c)) return { ok: false, error: 'pick a platform' };
  if (!detected) {
    return { ok: true, warning: 'that link is not on a platform we recognise — filed as ' + c };
  }
  if (detected !== c) {
    return { ok: false, error: 'that looks like a ' + detected + ' link, not ' + c };
  }
  return { ok: true, warning: null };
}

// The bytes, exactly. Two uploads of the same file are the same screenshot.
function imageHash(buffer) {
  if (!buffer || !buffer.length) return null;
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// A PERCEPTUAL HASH IS NOT BUILT. It needs an image decoder and this project
// has none — no sharp, no jimp — and a "perceptual" hash computed over raw
// file bytes is just a worse exact hash wearing the name. So exact matching
// blocks, and near-duplicate detection waits for a decoder somebody decides
// to add. Saying it warns when it cannot would be worse than not having it.
const PERCEPTUAL_AVAILABLE = false;

/**
 * Is this post already here?
 *
 * @param {object} candidate  { normalised, imageHash }
 * @param {object[]} existing rows with normalised_url, image_hash, author, created_at
 * @returns {{duplicate: boolean, by: string|null, at: string|null,
 *            reason: string|null, message: string|null}}
 */
function findDuplicate(candidate, existing) {
  const rows = existing || [];
  const byUrl = rows.find(r => clean(r.normalised_url)
    && clean(r.normalised_url) === clean(candidate.normalised));
  if (byUrl) return describeDuplicate(byUrl, 'the same link');

  if (candidate.imageHash) {
    const byImage = rows.find(r => clean(r.image_hash) === clean(candidate.imageHash));
    if (byImage) return describeDuplicate(byImage, 'the same screenshot');
  }
  return { duplicate: false, by: null, at: null, reason: null, message: null };
}

function describeDuplicate(row, reason) {
  const by = clean(row.author) || null;
  const at = clean(row.created_at) ? String(row.created_at).slice(0, 10) : null;
  // WHO AND WHEN, because that is the half of Katrina's answer that settles
  // it. "Duplicate" alone starts an argument; "Rox posted it on the 14th"
  // ends one.
  const who = by || 'somebody';
  const when = at || 'an earlier date';
  return {
    duplicate: true,
    by,
    at,
    reason,
    message: 'Already here — ' + reason + ', uploaded by ' + who + ' on ' + when + '.',
  };
}

/**
 * Who posted today and who did not.
 *
 * NOBODY EXPECTED IS NOBODY MISSING. If the roster is empty the answer is "we
 * do not know who was supposed to post", never "everybody is up to date" — a
 * check that reports success from an empty list is the most expensive kind of
 * quiet.
 *
 * @param {object[]} posts     rows for the day
 * @param {object[]} roster    [{ name, expected }] — expected posts per day
 * @param {string} dayCT
 */
function dailyCheck(posts, roster, dayCT) {
  const day = clean(dayCT).slice(0, 10);
  const mine = (posts || []).filter(p => clean(p.posted_on).slice(0, 10) === day
    || clean(p.created_at).slice(0, 10) === day);

  const counts = {};
  mine.forEach(p => {
    const a = clean(p.author) || '(unknown)';
    counts[a] = (counts[a] || 0) + 1;
  });

  if (!(roster || []).length) {
    return {
      day,
      known: false,
      note: 'No roster is configured, so who was expected to post today is not '
        + 'something this can answer. ' + mine.length + ' post(s) were uploaded.',
      posted: Object.entries(counts).map(([name, n]) => ({ name, posts: n })),
      missing: [],
      total: mine.length,
    };
  }

  const posted = [];
  const missing = [];
  (roster || []).forEach(r => {
    const name = clean(r.name);
    const want = Number(r.expected) > 0 ? Number(r.expected) : 1;
    const got = counts[name] || 0;
    (got >= want ? posted : missing).push({ name, posts: got, expected: want });
  });

  // Somebody who posted and is not on the roster. Not an error — a roster
  // that is out of date — and dropping them would lose a real post.
  const extra = Object.keys(counts)
    .filter(n => !(roster || []).some(r => clean(r.name) === n))
    .map(n => ({ name: n, posts: counts[n], expected: null }));

  return {
    day,
    known: true,
    note: null,
    posted: posted.concat(extra),
    missing,
    total: mine.length,
    notOnRoster: extra.map(e => e.name),
  };
}

// The week a screenshot belongs to, as a SharePoint folder name. Monday-based,
// because the tracker Katie keeps is "Week of MM.DD.YY" and two different week
// shapes in one system is how a report stops matching the other.
function weekFolder(dayCT) {
  const d = new Date(clean(dayCT).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7;            // Monday = 0
  const monday = new Date(d.getTime() - dow * 86400000);
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  const yy = String(monday.getUTCFullYear()).slice(2);
  return 'Week of ' + mm + '.' + dd + '.' + yy;
}

module.exports = {
  PLATFORMS, JUNK_PARAMS, HOST_ALIASES, PLATFORM_BY_HOST, PERCEPTUAL_AVAILABLE,
  normaliseUrl, platformCheck, imageHash, findDuplicate, dailyCheck, weekFolder, clean,
};
