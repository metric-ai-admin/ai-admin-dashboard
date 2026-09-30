// The sidebar link out to Jay's Ops Dashboard.
//
// Three things it has to be, and one it must not: visible to EVERY role, a new
// tab, and a single copy of the address — and never an iframe. Jay's dashboard
// is a separate site with its own login; framing it would either break on his
// session or drag us into his auth, and nothing on his side should have to
// change for this link to work.
//
// The role check is the one that needs a running page rather than a grep. The
// sidebar hides a whole nav-group when none of its TABS is visible for the
// user, so a link sitting in Operations disappears for maintenance, accounting,
// leasing, bd_agent and collections_agent unless the group check counts links
// too. That is invisible in the markup and only shows up when the page renders
// as one of those roles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const root = p => path.join(__dirname, '..', p);
const html = fs.readFileSync(root('public/index.html'), 'utf8');
const appJs = fs.readFileSync(root('public/app.js'), 'utf8');
const css = fs.readFileSync(root('public/styles.css'), 'utf8');

const URL_RE = /mpm-dashboard-server\.onrender\.com/g;

console.log('the address lives in one place');
t('exactly one copy of the URL in the whole front end', () => {
  const copies = [html, appJs, css].join('\n').match(URL_RE) || [];
  assert.strictEqual(copies.length, 1,
    `the Ops Dashboard URL appears ${copies.length} times — it is meant to be one constant`);
  assert.ok(/const OPS_DASHBOARD_URL = 'https:\/\/mpm-dashboard-server\.onrender\.com\/';/.test(appJs),
    'the copy that exists is not the named constant');
});
t('the markup carries no hardcoded href', () => {
  // The anchor gets its href from the constant, so the two can never disagree.
  assert.ok(!URL_RE.test(html), 'index.html hardcodes the address');
});

console.log('\nit opens a new tab, and never a frame');
t('target=_blank with rel=noopener noreferrer', () => {
  const a = /<a[^>]*id="ops-dashboard-link"[^>]*>/.exec(html);
  assert.ok(a, 'the Ops Dashboard anchor is gone');
  assert.ok(/target="_blank"/.test(a[0]), 'it would open in this tab');
  assert.ok(/rel="noopener noreferrer"/.test(a[0]), 'rel is missing — the new tab could reach window.opener');
});
t('nothing frames it', () => {
  assert.ok(!/<iframe[^>]*mpm-dashboard-server/i.test(html), 'it is being framed');
  assert.ok(!/OPS_DASHBOARD_URL[^\n]*iframe|iframe[^\n]*OPS_DASHBOARD_URL/i.test(appJs),
    'app.js puts the Ops Dashboard in an iframe');
});

console.log('\nit sits at the end of Operations and looks like the rest');
t('last item in the Operations group', () => {
  const group = /<div class="nav-group">\s*<div class="nav-group-label">Operations<\/div>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(group, 'the Operations group is gone');
  const items = [...group[1].matchAll(/<(button|a)\b[^>]*>/g)].map(m => m[0]);
  assert.ok(/id="ops-dashboard-link"/.test(items[items.length - 1]),
    'the Ops Dashboard link is not the last item in Operations');
});
t('same icon markup and styling hook as the tabs', () => {
  const a = /<a[^>]*id="ops-dashboard-link"[^>]*>\s*<span class="nav-ico">/.exec(html);
  assert.ok(a, 'it does not carry a .nav-ico span like every other sidebar item');
  assert.ok(/\.sidebar-nav button, \.sidebar-nav a\.nav-link \{/.test(css),
    'a.nav-link does not share the tab button styling');
  assert.ok(/\.sidebar-nav a\.nav-link:hover|a\.nav-link:hover/.test(css), 'no hover state');
});

// ---------------------------------------------------------------------------
// The part that needs the page to actually render.
console.log('\nevery role sees it — including the ones with no Operations tabs');

function renderAs(role) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  // Only the sidebar pieces app.js touches are exercised; the rest of the
  // bundle needs the network. TAB_ACCESS and the two gate blocks are lifted
  // out of the shipped file so this tests what ships.
  const tabAccess = new window.Function(
    appJs.slice(appJs.indexOf('const TAB_ACCESS'), appJs.indexOf('let currentUser')) + 'return TAB_ACCESS;')();
  const allowed = (tabAccess[role] || []);
  window.document.querySelectorAll('#tabs button[data-tab]').forEach(btn => {
    if (!allowed.includes(btn.dataset.tab)) btn.style.display = 'none';
  });
  // The group-visibility rule, verbatim from app.js.
  const groupRule = appJs.slice(appJs.indexOf("$$('#tabs .nav-group')"), appJs.indexOf('// Activate first allowed tab'));
  assert.ok(/a\.nav-link/.test(groupRule),
    'the nav-group visibility rule does not count links, so Operations collapses for some roles');
  window.document.querySelectorAll('#tabs .nav-group').forEach(group => {
    const anyVisible = [...group.querySelectorAll('button[data-tab], a.nav-link')]
      .some(b => b.style.display !== 'none');
    group.style.display = anyVisible ? '' : 'none';
  });
  const link = window.document.getElementById('ops-dashboard-link');
  const group = link.closest('.nav-group');
  return { linkHidden: link.style.display === 'none', groupHidden: group.style.display === 'none' };
}

const ROLES = ['admin', 'ceo', 'operations', 'maintenance', 'bd_agent', 'regional_director',
  'resident_success', 'collections_leasing', 'collections_agent', 'accounting', 'leasing',
  'leasing_bd', 'evictions_agent'];

t('the link is visible for all 13 roles', () => {
  ROLES.forEach(role => {
    const r = renderAs(role);
    assert.strictEqual(r.linkHidden, false, `${role}: the link itself is hidden`);
    assert.strictEqual(r.groupHidden, false,
      `${role}: the Operations group collapsed, hiding the link — this role has no Operations tabs`);
  });
});
t('a role with NO Operations tabs still keeps the group', () => {
  // The regression this guards: maintenance (Erick) has only the Maintenance
  // tab, so every Operations button is hidden for him.
  ['maintenance', 'accounting', 'leasing', 'bd_agent', 'collections_agent'].forEach(role => {
    assert.strictEqual(renderAs(role).groupHidden, false, role);
  });
});
t('an unknown role does not lose it either', () => {
  assert.deepStrictEqual(renderAs('some_new_role'), { linkHidden: false, groupHidden: false });
});

console.log(`\n${pass} passing`);
