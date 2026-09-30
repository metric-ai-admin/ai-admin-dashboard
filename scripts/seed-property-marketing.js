#!/usr/bin/env node
//
// Seed the marketing directory with what the property sites actually say.
//
//   node scripts/seed-property-marketing.js            # dry run
//   node scripts/seed-property-marketing.js --write
//
// Idempotent: an upsert on `property`, so re-running changes nothing. It does
// NOT clear anything a human has since edited — the columns it writes are the
// ones it owns, and verified flags it only ever sets to what is stated below.
//
// EVERY LINK HERE WAS READ FROM A FOOTER on 2026-09-30. Nothing was searched
// for, guessed, or inferred from a property name. Where a site linked nothing,
// the column is empty and stays empty.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SITE_ICONIC = 'https://liveaticonicroundrock.com/';

// Google links as the sites wrote them, with the HTML entity decoded. The long
// google.com/maps URLs carry the address in the path, which is what made it
// possible to tell the two iConic listings apart.
//
// Four sites used a maps.app.goo.gl shortener. Those are resolved here to the
// full URL they redirect to — SAME LISTING, spelled out. A short link hides the
// address, which is exactly the thing this table exists to let someone check,
// and it dies if Google retires the shortener. Each was followed on 2026-09-30
// and the address it landed on is written beside it.
const G = {
  ascent: 'https://www.google.com/maps/place/1830+W+Rundberg+Ln,+Austin,+TX+78758,+USA/@30.3720342,-97.717256,17z',
  // was https://maps.app.goo.gl/SuD8jKcqQuLhoETy8
  hyde: 'https://www.google.com/maps/place/206+W+38th+St,+Austin,+TX+78705,+USA/@30.3015689,-97.7372584,17z',
  // was https://maps.app.goo.gl/vWN74GggcGpvgWbi6
  sunset: 'https://www.google.com/maps/place/902+Romeria+Dr,+Austin,+TX+78757,+USA/@30.3311579,-97.7275091,17z',
  // was https://maps.app.goo.gl/Lx9KTHtoy2oFjKDs9
  chateau: 'https://www.google.com/maps/place/1211+W+8th+St,+Austin,+TX+78703,+USA/@30.2747355,-97.756878,17z',
  // was https://maps.app.goo.gl/BcHUt2RwLF448ajn7
  highlander: 'https://www.google.com/maps/place/803+Tirado+St,+Austin,+TX+78752,+USA/@30.323141,-97.711793,17z',
  windy: 'https://www.google.com/maps/place/1049+Windy+Hill+Rd,+Kyle,+TX+78640,+USA/@30.0327286,-97.8334518,17z',
  burnet: 'https://www.google.com/maps/place/301+S+Burnet+St,+Round+Rock,+TX+78664,+USA/@30.5073564,-97.6767913,17z',
  gattis: 'https://www.google.com/maps/place/105+Gattis+School+Rd,+Round+Rock,+TX+78664,+USA/@30.4933985,-97.6774964,17z',
};

const ROWS = [
  {
    property: 'Ascent at Northgate',
    website: 'https://ascentnorthgate.com/',
    facebook: 'https://www.facebook.com/ascentnorthgateapts/',
    google: G.ascent,
    // Unverified on purpose: the site links Rundberg, AppFolio and the bank
    // both say Northgate Blvd. Stated, not resolved.
    google_verified: false,
    // The only row that is asking someone to do something.
    note_kind: 'warn',
    note: 'address mismatch — site links 1830 W Rundberg Ln, AppFolio has 9315 Northgate Blvd. Confirm with Katrina.',
  },
  { property: 'Hyde Park Square', website: 'https://liveathydeparksquare.com/',
    facebook: 'https://www.facebook.com/profile.php?id=100090604045778', google: G.hyde },
  { property: 'Sunset Palms', website: 'https://liveatsunsetpalms.com/',
    facebook: 'https://www.facebook.com/profile.php?id=100090593546621', google: G.sunset },
  { property: 'The Chateau', website: 'https://liveatthechateau.com/',
    facebook: 'https://www.facebook.com/profile.php?id=100090602605902', google: G.chateau },
  { property: 'The Highlander', website: 'https://liveatthehighlander.com/',
    facebook: 'https://www.facebook.com/profile.php?id=100090675832798', google: G.highlander },
  { property: 'Windy Hill Apartment', website: 'https://liveatwindyhill.com/',
    facebook: 'https://www.facebook.com/WindyHillApartments/', google: G.windy },
  {
    // The two iConic properties share one site and one Facebook page. Their
    // Google listings differ, and which is which comes from AppFolio's Rent
    // Roll, not from the names: "Downtown" is the Burnet St address.
    property: 'iConic Downtown',
    website: SITE_ICONIC,
    facebook: 'https://www.facebook.com/profile.php?id=61550968910244',
    google: G.burnet,
    google_verified: true,
    note: 'shares a site and a Facebook page with iConic Round Rock. Google listing confirmed by address (301 S Burnet St, AppFolio Rent Roll).',
  },
  {
    property: 'iConic Round Rock',
    website: SITE_ICONIC,
    facebook: 'https://www.facebook.com/profile.php?id=61550968910244',
    google: G.gattis,
    google_verified: true,
    note: 'shares a site and a Facebook page with iConic Downtown. Google listing confirmed by address (105 Gattis School Rd, AppFolio Rent Roll).',
  },
  {
    // One row, because there is one account. Putting @metricpm on eight
    // property rows would say there are eight TikToks.
    property: 'Metric Property Management (corporate)',
    tiktok: 'https://www.tiktok.com/@metricpm',
    instagram: 'https://www.instagram.com/metric_property_management/',
    note: 'company accounts, linked from every property site. Properties keep these columns empty until they have their own.',
  },
];

const FLAGS = ['website_verified', 'facebook_verified', 'instagram_verified', 'tiktok_verified', 'google_verified'];

function toRow(r) {
  const out = {
    property: r.property,
    website: r.website || null,
    facebook: r.facebook || null,
    instagram: r.instagram || null,
    tiktok: r.tiktok || null,
    google: r.google || null,
    note: r.note || null,
    // 'info' explains something; 'warn' means a person still has to act. The
    // default is 'info' so a note added later cannot accidentally raise an
    // alarm nobody meant to raise.
    note_kind: r.note ? (r.note_kind || 'info') : null,
    source: 'footer scrape',
    updated_by: 'seed 2026-09-30',
    updated_at: new Date().toISOString(),
  };
  FLAGS.forEach(f => { out[f] = r[f] === true; });
  // The websites came from Katrina herself, so they are confirmed.
  if (out.website) out.website_verified = true;
  return out;
}

(async () => {
  const write = process.argv.includes('--write');
  const rows = ROWS.map(toRow);

  console.log(`${rows.length} row(s) — 8 properties + 1 corporate\n`);
  console.log('property                               site  fb  ig  tt  goog  verified');
  rows.forEach(r => console.log('  ' + r.property.padEnd(38)
    + ['website', 'facebook', 'instagram', 'tiktok', 'google'].map(k => (r[k] ? ' ✓' : ' ·').padEnd(k === 'website' ? 6 : 4)).join('')
    + '  ' + FLAGS.filter(f => r[f]).map(f => f.replace('_verified', '')).join(',')));
  const notes = rows.filter(r => r.note);
  if (notes.length) {
    console.log('\nnotes:');
    notes.forEach(r => console.log('  ' + r.property + ' — ' + r.note));
  }

  if (!write) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }
  if (!process.env.SUPABASE_URL) { console.error('SUPABASE_URL is not set.'); process.exit(2); }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const before = await db.from('property_marketing').select('property', { count: 'exact', head: true });
  if (before.error) {
    console.error('\nproperty_marketing: ' + before.error.message);
    console.error('Run migration 070 first.');
    process.exit(2);
  }
  console.log(`\nrows already there: ${before.count}`);

  const { error } = await db.from('property_marketing').upsert(rows, { onConflict: 'property' });
  if (error) { console.error('upsert failed: ' + error.message); process.exit(1); }

  const { data: after } = await db.from('property_marketing')
    .select('property,website,facebook,instagram,tiktok,google,google_verified,website_verified,note')
    .order('property');
  console.log(`\nwritten. rows now: ${after.length}`);
  after.forEach(r => console.log('  ' + r.property.padEnd(38)
    + (r.website ? 'site ' : '     ') + (r.facebook ? 'fb ' : '   ')
    + (r.instagram ? 'ig ' : '   ') + (r.tiktok ? 'tt ' : '   ')
    + (r.google ? 'goog' : '    ') + (r.google_verified ? '  [google verified]' : '')));
})().catch(e => { console.error('failed: ' + e.message); process.exitCode = 1; });
