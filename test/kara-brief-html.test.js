// The brief as an email somebody can forward.
//
// The first version was the plain-text layout inside one <pre> block. It reads
// correctly when opened and collapses into a single paragraph the moment it is
// forwarded — Outlook drops the tag on reply and forward — and a fixed-width
// block has nowhere to go on a phone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kara-brief.js');
const H = require('../lib/kara-brief-html.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const prop = (over) => Object.assign({
  name: 'Windy Hill Apartment', units: 72, occupied: 40, occupancyPct: 40 / 72, goalPct: 0.90,
  rentableUnits: 49, rentableOccupied: 40, rentableOccupancyPct: 40 / 49,
  rentableNote: 'excludes Building 3',
  preleased: 2, applicationsPending: 1, applicationOldestDays: 9,
  makeReadyOpen: 1, makeReadyOldestDays: 14,
  staleMakeReadies: 39, staleMakeReadyOldest: 490,
  staleApplications: 1, staleApplicationOldest: 89,
  moveInsExpected: 0, moveOutsExpected: 1, notices: 0,
  delinquency: 6293.79, monthlyRent: 100800,
}, over || {});

const BRIEF = K.build({
  properties: [
    prop(),
    // Genuinely green: inside every threshold. The first version left the
    // 9-day application and the 14-day make-ready on it, so it was red and
    // there was no "Everything else" section to find.
    prop({ name: 'Hyde Park Square', occupancyPct: 0.92, goalPct: 0.85, delinquency: 1000,
      applicationsPending: 1, applicationOldestDays: 1,
      makeReadyOpen: 0, makeReadyOldestDays: null,
      rentableOccupancyPct: null, staleMakeReadies: 0, staleApplications: 0 }),
  ],
  portfolio: { units: 397, occupied: 279, occupancyPct: 279 / 397, preleased: 4,
    applicationsPending: 12, makeReadyOpen: 3, moveInsExpected: 2, moveOutsExpected: 1,
    notices: 10, delinquency: 64479.44, monthlyRent: 555000 },
  thresholds: [{ property: '*', delinquency_over: 5000, make_ready_days: 7, application_days: 3 }],
  freshness: { asOf: '2026-10-13 (Central)',
    lines: [{ source: 'delinquency_kpi', ok: false, note: 'last synced 2026-10-12, not this morning' }] },
});
const HTML = H.renderHtml(BRIEF, { testMode: true });
const TEXT = K.render(BRIEF, { testMode: true });

console.log('kara brief, as email html');

// ---- what forwarding breaks ------------------------------------------------

t('there is no <pre> anywhere', () => {
  // THE BUG. Outlook drops it on forward and the whole brief becomes one
  // paragraph.
  assert.ok(!/<pre/i.test(HTML), 'the layout still depends on a <pre> block');
});

t('nothing depends on a stylesheet surviving the trip', () => {
  assert.ok(!/<style/i.test(HTML), 'there is a <style> block');
  assert.ok(!/<link/i.test(HTML), 'there is a stylesheet link');
  assert.ok(!/class=/i.test(HTML), 'a class has nothing to resolve against in mail');
});

t('every table is laid out inline and marked presentational', () => {
  const tables = (HTML.match(/<table/g) || []).length;
  assert.ok(tables >= 4, 'only found ' + tables + ' tables');
  assert.strictEqual((HTML.match(/role="presentation"/g) || []).length, tables,
    'a layout table without role=presentation is read aloud as data by a screen reader');
  assert.ok(/cellpadding="0" cellspacing="0" border="0"/.test(HTML),
    'Outlook adds its own spacing without these');
});

t('it fits a phone: one fluid column, nothing fixed', () => {
  assert.ok(/max-width:680px/.test(HTML), 'there is no width cap for a desktop client');
  const fixed = (HTML.match(/(?<!max-)width:\s*\d+px/g) || []);
  assert.deepStrictEqual(fixed, [], 'fixed widths force a horizontal scroll: ' + fixed.join(', '));
  const sizes = (HTML.match(/font-size:(\d+)px/g) || []).map(s => Number(s.match(/\d+/)[0]));
  assert.ok(Math.min(...sizes) >= 12, 'something is smaller than 12px');
});

// ---- the shape she asked for -----------------------------------------------

t('each section has its heading', () => {
  ['Needs attention', 'Everything else', 'Portfolio total', 'Records to clean up in AppFolio']
    .forEach(s => assert.ok(HTML.includes(s), 'missing section: ' + s));
});

t('a property is a block with its name in bold', () => {
  assert.ok(/font-weight:700[^>]*>Windy Hill Apartment</.test(HTML),
    'the property name is not bold');
});

t('the red flags are a list, in red', () => {
  const at = HTML.indexOf('Windy Hill Apartment');
  const block = HTML.slice(at, at + 1400);
  assert.ok(/<ul/.test(block) && /<li/.test(block), 'the flags are not a list');
  assert.ok(new RegExp('<li[^>]*color:' + H.RED).test(block), 'the flags are not red');
  assert.ok(/occupancy 55\.6% against a 90\.0% goal/.test(block));
});

t('a property that is not red has no flag list', () => {
  const at = HTML.indexOf('Hyde Park Square');
  const block = HTML.slice(at, at + 900);
  assert.ok(!/<li/.test(block), 'a green property grew a bullet list');
});

t('the numbers are a two-column table, label and value', () => {
  const at = HTML.indexOf('Windy Hill Apartment');
  const block = HTML.slice(at, HTML.indexOf('Hyde Park Square'));
  ['Occupancy', 'Rentable occupancy', 'Signed, not moved in', 'Applications pending',
    'Make-readies open', 'Move-ins this week', 'Move-outs this week', 'Notices',
    'Delinquency'].forEach(l => assert.ok(block.includes('>' + l + '<'), 'missing row: ' + l));
  // Two cells per row, not three.
  const rows = block.slice(block.indexOf('<table')).split('<tr>').slice(1, 5);
  rows.forEach(r => assert.strictEqual((r.match(/<td/g) || []).length, 2,
    'a row has ' + (r.match(/<td/g) || []).length + ' cells'));
});

t('the rentable line shows only where a building is excluded', () => {
  const hp = HTML.slice(HTML.indexOf('Hyde Park Square'), HTML.indexOf('Portfolio total'));
  assert.ok(!/Rentable occupancy/.test(hp), 'it would be the same number twice');
});

t('delinquency carries the share of rent beside the dollars', () => {
  assert.ok(/\$6,294/.test(HTML));
  assert.ok(/6\.2% of \$100,800 monthly rent/.test(HTML));
});

t('the freshness block is at the top and shouts when a sync missed', () => {
  assert.ok(HTML.indexOf('Data as of') < HTML.indexOf('Needs attention'),
    'the data age is below the numbers, where it reads as a footnote');
  assert.ok(/did not run/.test(HTML));
  assert.ok(/delinquency_kpi/.test(HTML));
});

t('no graphics, no emoji', () => {
  assert.ok(!/<img/i.test(HTML), 'she asked for numbers');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(HTML));
});

t('values reach the page escaped', () => {
  const nasty = K.build({
    thresholds: [], properties: [prop({ name: 'A & B <script>alert(1)</script>' })],
  });
  const out = H.renderHtml(nasty, {});
  assert.ok(!/<script>/.test(out), 'a property name reached the page as markup');
  assert.ok(/&amp;/.test(out) && /&lt;script&gt;/.test(out));
});

// ---- the message ------------------------------------------------------------

const MIME = H.buildMime({
  from: 'support@livewithmetric.com', to: 'support@livewithmetric.com',
  subject: 'Metric — Morning Numbers', text: TEXT, html: HTML,
});

t('it is multipart/alternative with both parts', () => {
  assert.ok(/Content-Type: multipart\/alternative; boundary="/.test(MIME));
  assert.deepStrictEqual(MIME.match(/Content-Type: text\/[a-z]+/g),
    ['Content-Type: text/plain', 'Content-Type: text/html']);
});

t('text comes FIRST, so html is the part that shows', () => {
  // A client renders the LAST part it understands. The other order makes the
  // plain text the one everybody sees.
  assert.ok(MIME.indexOf('text/plain') < MIME.indexOf('text/html'));
});

t('the headers use CRLF, and the boundary closes', () => {
  // A bare LF in a header is how a message ends up unparsed.
  assert.ok(/\r\n/.test(MIME));
  assert.ok(!/[^\r]\n/.test(MIME.split('\r\n').join('')), 'a bare LF survived');
  const b = MIME.match(/boundary="([^"]+)"/)[1];
  assert.strictEqual((MIME.match(new RegExp('--' + b + '--', 'g')) || []).length, 1,
    'the final boundary is missing or doubled');
});

t('the boundary cannot occur inside either part', () => {
  const b = MIME.match(/boundary="([^"]+)"/)[1];
  assert.ok(!TEXT.includes(b) && !HTML.includes(b));
  // Base64 bodies cannot contain it either, which is the real guarantee.
  assert.ok(/Content-Transfer-Encoding: base64/.test(MIME));
});

t('the subject survives an em dash', () => {
  assert.ok(/Subject: =\?utf-8\?B\?/.test(MIME), 'a raw em dash arrives as mojibake');
  const enc = MIME.match(/Subject: =\?utf-8\?B\?([^?]+)\?=/)[1];
  assert.strictEqual(Buffer.from(enc, 'base64').toString('utf8'), 'Metric — Morning Numbers');
});

t('the plain part decodes back to real line breaks', () => {
  // The whole point of keeping it: somebody reading without HTML gets a
  // readable brief, not one paragraph.
  const part = MIME.split('Content-Type: text/plain')[1];
  const body = part.split('\r\n\r\n')[1].split('\r\n--')[0];
  const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.ok(decoded.split('\n').length > 20, 'the text part is one line');
  assert.ok(/NEEDS ATTENTION/.test(decoded));
});

t('no recipient, or no sender, is refused rather than sent to nobody', () => {
  assert.throws(() => H.buildMime({ from: 'a@b.c', to: '', text: 'x', html: 'y' }), /recipient/);
  assert.throws(() => H.buildMime({ to: 'a@b.c', text: 'x', html: 'y' }), /sender/);
});

// ---- the wiring --------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

t('the sender posts raw MIME, not a JSON body', () => {
  const at = server.indexOf('async function briefSendMail');
  const fn = server.slice(at, at + 1200);
  assert.ok(/KARA_BRIEF_HTML\.buildMime/.test(fn), 'it builds the message inline again');
  assert.ok(/'Content-Type': 'text\/plain'/.test(fn), 'the raw-MIME send needs text/plain');
  assert.ok(!/contentType: 'HTML'/.test(fn), 'it is back on the JSON body, which takes one type');
});

t('both parts are rendered and both are passed on', () => {
  assert.ok(/html: KARA_BRIEF_HTML\.renderHtml\(brief, o\)/.test(server));
  assert.ok(/briefSendMail\(KARA_BRIEF_TEST_TO, '\[TEST\] Metric — Morning Numbers', text, html\)/.test(server));
  assert.ok(/briefSendMail\(KARA_BRIEF_TO\.join\(','\), 'Metric — Morning Numbers', text, html\)/.test(server));
});

t('server.js does not reach for a crypto namespace it never bound', () => {
  // It destructures { randomUUID, timingSafeEqual }, so `crypto.randomBytes`
  // was undefined — the same fault as "AFP is not defined", one day later.
  assert.ok(!/[^.\w]crypto\.randomBytes/.test(server));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
