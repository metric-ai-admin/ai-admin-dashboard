#!/usr/bin/env node
//
// Three posts so Arturo can look at the screen, and one command to remove
// them again.
//
//   node scripts/seed-social-posts-demo.js            # DRY RUN
//   node scripts/seed-social-posts-demo.js --write
//   node scripts/seed-social-posts-demo.js --remove
//
// EVERY ROW IS MARKED. author is "DEMO — delete me" and the note says so, so
// nobody mistakes one for a real post and --remove can find them without a
// list of ids to keep somewhere. Demo data that cannot be told apart from real
// data is how a demo becomes permanent.
//
// The links point at example.invalid, which cannot resolve, so nothing here
// can be mistaken for a real post somebody made.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const SOCIAL = require('../lib/social-links.js');

const WRITE = process.argv.includes('--write');
const REMOVE = process.argv.includes('--remove');

const DEMO_AUTHOR = 'DEMO — delete me';
const DEMO_NOTE = 'Demo row created to review the screen. Safe to delete.';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pad = (s, w) => String(s).padEnd(w);

// One of each platform, so the screen shows all three. The third is dated
// yesterday so the daily view has something to leave out of today.
const DEMO = [
  { url: 'https://www.facebook.com/share/p/demo-ascent-001/?mibextid=demo',
    platform: 'Facebook', property: 'Ascent at Northgate', posted_on: 0 },
  { url: 'https://www.tiktok.com/@metricpm/video/7000000000000000001',
    platform: 'TikTok', property: 'Hyde Park Square', posted_on: 0 },
  { url: 'https://nextdoor.com/p/demo-chateau-003?utm_source=share',
    platform: 'Nextdoor', property: 'The Chateau', posted_on: 1 },
];

function dayCT(offset) {
  const d = new Date(Date.now() - (offset || 0) * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

(async () => {
  if (REMOVE) {
    const { data, error } = await db.from('social_posts')
      .delete().eq('author', DEMO_AUTHOR).select('id,url');
    if (error) throw new Error(error.message);
    console.log('removed ' + (data || []).length + ' demo row(s).');
    const { count } = await db.from('social_posts').select('*', { count: 'exact', head: true });
    console.log('social_posts now holds ' + count + ' row(s).');
    if (count > 0) {
      console.log('Those are REAL posts — nothing marked DEMO is left.');
    }
    return;
  }

  const rows = DEMO.map(d => {
    const link = SOCIAL.normaliseUrl(d.url);
    if (!link.ok) throw new Error(d.url + ': ' + link.error);
    const check = SOCIAL.platformCheck(d.platform, link.platform);
    if (!check.ok) throw new Error(d.url + ': ' + check.error);
    return {
      url: link.url,
      normalised_url: link.normalised,
      platform: d.platform,
      property: d.property,
      author: DEMO_AUTHOR,
      author_email: null,
      posted_on: dayCT(d.posted_on),
      screenshot_url: null,
      screenshot_name: null,
      image_hash: null,
      note: DEMO_NOTE,
    };
  });

  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — demo social posts\n');
  rows.forEach(r => console.log('   ' + pad(r.platform, 10) + pad(r.property, 22)
    + pad(r.posted_on, 12) + r.normalised_url));
  console.log('\n   author: ' + JSON.stringify(DEMO_AUTHOR)
    + '  — this is what --remove matches on');
  console.log('   no screenshots: the upload path needs a real file and a browser,');
  console.log('   and inventing a SharePoint link would show a screenshot that is not there.');

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  const { data, error } = await db.from('social_posts').insert(rows).select('id,url');
  if (error) throw new Error(error.message);
  console.log('\nstored ' + (data || []).length + ' demo row(s).');
  console.log('Remove them with:  node scripts/seed-social-posts-demo.js --remove');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
