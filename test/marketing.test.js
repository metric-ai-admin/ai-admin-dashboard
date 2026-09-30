// Marketing Phase 1: who sees the directory, who can change it, and what a
// stored link is allowed to be.
//
// The role question is the one that needed care. Katrina is the reason this
// exists, and she was a bd_agent — but so are Katie and Rhoxie, and the
// directory is not theirs. Widening bd_agent would have handed it to all three
// silently, so marketing_bd_agent is a new role that must be a strict superset
// of what Katrina already had.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const server = read('server.js');

// eslint-disable-next-line no-new-func
const TAB_ACCESS = new Function(
  app.slice(app.indexOf('const TAB_ACCESS'), app.indexOf('let currentUser')) + 'return TAB_ACCESS;')();

console.log('who sees the Marketing tab');
t('admin, ceo and marketing_bd_agent — and nobody else', () => {
  const withTab = Object.entries(TAB_ACCESS)
    .filter(([, tabs]) => tabs.includes('marketing')).map(([role]) => role).sort();
  assert.deepStrictEqual(withTab, ['admin', 'ceo', 'marketing_bd_agent']);
});
t('Katie and Rhoxie, who are bd_agent, do NOT', () => {
  // The whole reason for a separate role. They share Katrina's old one.
  assert.ok(!TAB_ACCESS.bd_agent.includes('marketing'),
    'bd_agent was widened, which gives Marketing to Katie and Rhoxie too');
});
t('Katrina keeps everything she had — the new role is a superset', () => {
  // A role change that quietly drops an existing tab is worse than no change.
  TAB_ACCESS.bd_agent.forEach(tab =>
    assert.ok(TAB_ACCESS.marketing_bd_agent.includes(tab),
      `marketing_bd_agent lost ${tab}, which bd_agent had`));
  assert.ok(TAB_ACCESS.marketing_bd_agent.includes('crm'), 'she lost the BD CRM');
  assert.ok(TAB_ACCESS.marketing_bd_agent.includes('marketing'));
});
t('the tab exists in the sidebar and has a section to open', () => {
  assert.ok(/data-tab="marketing"/.test(html), 'no sidebar button');
  assert.ok(/id="tab-marketing"/.test(html), 'no section — the button would open nothing');
  assert.ok(/if \(tab === 'marketing'\) loadMarketing\(\);/.test(app), 'nothing loads it');
});

console.log('\nwho can change a link');
t('reading takes one of the three roles', () => {
  const i = server.indexOf("app.get('/api/marketing'");
  assert.ok(i > 0, 'the read route is gone');
  assert.ok(/requireAuth, requireRole\(\.\.\.MARKETING_ROLES\)/.test(server.slice(i, i + 120)));
  assert.ok(/const MARKETING_ROLES = \['admin', 'ceo', 'marketing_bd_agent'\]/.test(server),
    'the server role list does not match the tab list');
});
t('writing is admin only', () => {
  const i = server.indexOf("app.put('/api/marketing/:property'");
  assert.ok(i > 0, 'the write route is gone');
  assert.ok(/requireAuth, requireRole\('admin'\)/.test(server.slice(i, i + 120)),
    'someone other than an admin can rewrite the directory');
});

console.log('\nwhat a stored link may be');
// eslint-disable-next-line no-new-func
const clean = new Function(
  server.slice(server.indexOf('function marketingCleanUrl('),
    server.indexOf("app.get('/api/marketing'")) + 'return marketingCleanUrl;')();
t('http and https are kept', () => {
  assert.strictEqual(clean('https://www.facebook.com/x/'), 'https://www.facebook.com/x/');
  assert.strictEqual(clean(' http://example.com '), 'http://example.com/');
});
t('empty clears the link', () => {
  [null, undefined, '', '   '].forEach(v => assert.strictEqual(clean(v), null, String(v)));
});
t('anything that is not an http(s) URL is REJECTED, not stored', () => {
  // These are rendered as anchors, so a javascript: URL here is a script
  // someone clicks on inside an authenticated dashboard.
  ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd',
   'not a url', 'www.facebook.com/x', '//evil.example.com',
  ].forEach(v => assert.strictEqual(clean(v), undefined, v));
});
t('a rejected link answers 400 rather than being dropped in silence', () => {
  const i = server.indexOf("app.put('/api/marketing/:property'");
  const body = server.slice(i, i + 2200);
  assert.ok(/clean === undefined/.test(body) && /res\.status\(400\)/.test(body));
});

console.log('\nverified means somebody looked');
t('changing a link clears its own tick', () => {
  // A confirmation belongs to the URL that was confirmed. Carrying it across an
  // edit would mark something nobody has seen as checked.
  const i = server.indexOf("app.put('/api/marketing/:property'");
  const body = server.slice(i, i + 2200);
  assert.ok(/patch\[k \+ '_verified'\] = false;/.test(body),
    'editing a link keeps its verified tick');
});
t('the UI shows the unverified state, it does not hide it', () => {
  assert.ok(/unverified/.test(app), 'nothing marks a link unverified');
  assert.ok(/badge-green/.test(app) && /badge-gray/.test(app), 'verified and unverified look the same');
});

console.log('\nlinks leave the dashboard safely');
t('every social link opens in a new tab with rel set', () => {
  const i = app.indexOf('function mktCell(');
  const body = app.slice(i, i + 1800);
  assert.ok(/target="_blank" rel="noopener noreferrer"/.test(body),
    'a link opens in this tab, or can reach window.opener');
});
t('nothing is framed', () => {
  assert.ok(!/<iframe[^>]*mkt|mkt[^\n]*iframe/i.test(app + html), 'a property site is being framed');
});

console.log('\nnothing else was touched');
t("Erick's Command Center is untouched by this", () => {
  const cc = read('public/command-center.js');
  assert.ok(!/marketing|property_marketing/i.test(cc),
    'command-center.js now mentions marketing — it was meant to be left alone');
});
t("the EOD's Maintenance section is still there", () => {
  assert.ok(/eodSectionHtml\('🔧', 'Maintenance'/.test(server),
    'the EOD Maintenance section is gone or renamed');
});

console.log('\nthe seed matches what the footers said');
t('the corporate accounts live on their own row, not on eight', () => {
  const seed = read('scripts/seed-property-marketing.js');
  // Repeating @metricpm across eight rows would claim eight TikTok accounts.
  // Counting literal URLs, not the key — the row builder mentions it too.
  const tiktoks = (seed.match(/tiktok:\s*'https/g) || []).length;
  const instas = (seed.match(/instagram:\s*'https/g) || []).length;
  assert.strictEqual(tiktoks, 1, `a TikTok URL is written on ${tiktoks} rows — there is one company account`);
  assert.strictEqual(instas, 1, `an Instagram URL is written on ${instas} rows — only the corporate one was found`);
  assert.ok(/\(corporate\)/.test(seed), 'there is no corporate row');
  // And it is the corporate row that carries them.
  const i = seed.indexOf("property: 'Metric Property Management (corporate)'");
  assert.ok(i > 0 && /tiktok:\s*'https/.test(seed.slice(i, i + 500)),
    'the corporate row does not carry the TikTok account');
});
t('the two iConic properties get DIFFERENT Google listings', () => {
  const seed = read('scripts/seed-property-marketing.js');
  assert.ok(/property: 'iConic Downtown'[\s\S]{0,400}google: G\.burnet/.test(seed),
    'Downtown is not on the Burnet St listing');
  assert.ok(/property: 'iConic Round Rock'[\s\S]{0,400}google: G\.gattis/.test(seed),
    'Round Rock is not on the Gattis School Rd listing');
});
t('Ascent is stored unverified, with the disagreement written down', () => {
  const seed = read('scripts/seed-property-marketing.js');
  const i = seed.indexOf("property: 'Ascent at Northgate'");
  const body = seed.slice(i, i + 700);
  assert.ok(/google_verified: false/.test(body), 'a disputed listing is marked verified');
  assert.ok(/address mismatch/.test(body), 'the mismatch is not stated on the row');
});

console.log(`\n${pass} passing`);
