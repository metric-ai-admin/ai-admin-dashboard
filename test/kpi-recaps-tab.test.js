// The KPI Recaps review tab.
//
// The drafts had existed in Supabase since 2026-09-23 with no way to look at
// them. The risk in building the screen is the opposite of the risk in building
// the generator: a review UI that makes approval feel like sending. So most of
// what is pinned here is what the screen does NOT do.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const server = read('server.js');
const stripComments = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// eslint-disable-next-line no-new-func
const TAB_ACCESS = new Function(
  app.slice(app.indexOf('const TAB_ACCESS'), app.indexOf('let currentUser')) + 'return TAB_ACCESS;')();

console.log('nothing here sends email');
t('the dashboard has no send route for a recap, disabled or otherwise', () => {
  // Not "off" — absent. If one ever appears this test should be the thing that
  // makes somebody argue for it out loud.
  assert.ok(!/kpi-recaps\/:id\/send|kpiRecapSend|sendRecap/i.test(server),
    'a send path for KPI recaps now exists in the server');
  assert.ok(!/krc[A-Za-z]*[Ss]end/.test(app), 'the tab has a send function');
});
t('approve writes status, who and when — and nothing else', () => {
  const i = server.indexOf("app.post('/api/kpi-recaps/:id/approve'");
  assert.ok(i > 0, 'the approve route is gone');
  const body = server.slice(i, i + 1400);
  assert.ok(/status: 'approved'/.test(body));
  assert.ok(/approved_by: actorName\(req\)/.test(body) && /approved_at:/.test(body));
  assert.ok(!/sendMail/i.test(body), 'approving reaches Graph sendMail');
  assert.ok(/sent: false/.test(body), 'the response no longer states that nothing was sent');
});
t('the screen SAYS approving does not send, in those words', () => {
  // The whole point. A button called Approve, next to an email, reads as Send
  // unless something says otherwise.
  assert.ok(/Approving does not send anything — sending is not enabled yet/.test(app),
    'the required sentence is not on the approve control');
  assert.ok(/Nothing here sends email/i.test(html), 'the tab has no banner saying so');
});
t('the success toast repeats the server, it does not say "Saved"', () => {
  const i = app.indexOf('async function krcApprove(');
  const body = app.slice(i, i + 700);
  assert.ok(/toast\(d\.note \|\|/.test(body),
    'the toast invents its own wording instead of repeating what the server said');
  assert.ok(/Nothing was sent/.test(body));
});

console.log('\nwho can see it and who can approve');
t('only admin and ceo have the tab', () => {
  const withTab = Object.entries(TAB_ACCESS)
    .filter(([, tabs]) => tabs.includes('kpirecaps')).map(([role]) => role).sort();
  assert.deepStrictEqual(withTab, ['admin', 'ceo']);
});
t('every other role is excluded, named one by one', () => {
  ['operations', 'maintenance', 'bd_agent', 'leasing_bd', 'accounting', 'regional_director',
   'resident_success', 'collections_leasing', 'evictions_agent', 'marketing_bd_agent',
  ].forEach(role => {
    if (!TAB_ACCESS[role]) return;
    assert.ok(!TAB_ACCESS[role].includes('kpirecaps'), `${role} can see the KPI recaps`);
  });
});
t('the server gates all three read/approve routes on the same two roles', () => {
  // The tab list is not the lock. These are meeting transcripts with named
  // people in them and partner email addresses.
  assert.ok(/const KPI_RECAP_ROLES = \['admin', 'ceo'\]/.test(server),
    'the server role list does not match the tab list');
  ["app.get('/api/kpi-recaps/:id'", "app.get('/api/kpi-recaps'",
   "app.post('/api/kpi-recaps/:id/approve'"].forEach(route => {
    const i = server.indexOf(route);
    assert.ok(i > 0, `${route} is gone`);
    assert.ok(/requireAuth, requireRole\(\.\.\.KPI_RECAP_ROLES\)/.test(server.slice(i, i + 130)),
      `${route} is not gated on admin+ceo`);
  });
});
t('generating drafts stayed admin-only — only reading was widened', () => {
  const i = server.indexOf("app.post('/api/kpi-recaps/run-now'");
  assert.ok(/requireMetricAdmin/.test(server.slice(i, i + 120)),
    'run-now was widened too, which was not asked for');
});

console.log('\nthe sidebar');
const GROUPS = html.split('<div class="nav-group">').slice(1).map(chunk => {
  const b = chunk.split('</nav>')[0];
  return {
    label: (/<div class="nav-group-label">([^<]+)<\/div>/.exec(b) || [])[1]?.trim(),
    tabs: [...b.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]),
  };
});
t('it sits in Reports, and has a section to open', () => {
  const g = GROUPS.find(x => x.tabs.includes('kpirecaps'));
  assert.ok(g, 'the button is in no nav-group');
  assert.strictEqual(g.label, 'Reports');
  assert.ok(/id="tab-kpirecaps"/.test(html), 'the button would open nothing');
  assert.ok(/if \(tab === 'kpirecaps'\) loadKpiRecaps\(\);/.test(app), 'nothing loads it');
});
t('putting it there changes no group visibility for anyone', () => {
  // The empty-group rule is the trap. Reports already contains tabs that admin
  // and ceo both have, so this button cannot be the reason a group appears or
  // disappears for any role.
  const reports = GROUPS.find(x => x.label === 'Reports');
  const others = reports.tabs.filter(x => x !== 'kpirecaps');
  ['admin', 'ceo'].forEach(role => {
    assert.ok(others.some(tab => TAB_ACCESS[role].includes(tab)),
      `Reports was empty for ${role} before this tab — adding it changes what they see`);
  });
  Object.entries(TAB_ACCESS).forEach(([role, tabs]) => {
    if (role === 'admin' || role === 'ceo') return;
    assert.ok(!tabs.includes('kpirecaps'), `${role} would newly see the Reports group`);
  });
});

console.log('\nwhat the detail view shows');
t('the list is newest meeting first, not whatever order the API returned', () => {
  const i = app.indexOf('function krcRenderList(');
  const body = app.slice(i, i + 1200);
  assert.ok(/String\(b\.meeting_date \|\| ''\)\.localeCompare\(String\(a\.meeting_date \|\| ''\)\)/.test(body),
    'the list does not sort by meeting date descending');
});
t('all five statuses render, including the ones nobody has hit yet', () => {
  const i = app.indexOf('const KRC_STATUS');
  const map = new Function(app.slice(i, app.indexOf('async function loadKpiRecaps')) + 'return KRC_STATUS;')();
  assert.deepStrictEqual(Object.keys(map).sort(),
    ['approved', 'draft', 'failed', 'sent', 'skipped'],
    'a status in the table CHECK constraint would render as "unknown"');
});
t('the held-back names carry their reason, not just the word "excluded"', () => {
  const i = app.indexOf('function krcRenderDetail(');
  const body = app.slice(i, i + 1400);
  assert.ok(/pending Lyndsay's confirmation/.test(body),
    'the exclusions do not say why they are excluded');
});
t('the email is shown as subject, To and body', () => {
  const i = app.indexOf('function krcRenderDetail(');
  const body = app.slice(i, i + 3000);
  ['email_subject', 'email_body'].forEach(f =>
    assert.ok(body.includes(f), `the detail view does not render ${f}`));
  assert.ok(/final_to && r\.final_to\.length \? r\.final_to : r\.proposed_to/.test(body),
    'the To line ignores final_to, so an approved recap shows the wrong recipients');
});
t('the transcript is collapsed, because it is the attachment', () => {
  const i = app.indexOf('function krcRenderDetail(');
  const body = app.slice(i, i + 3400);
  assert.ok(/<details/.test(body), 'the transcript is not in a collapsible panel');
  assert.ok(/transcript_text/.test(body));
});
t('the transcript comes from the single-recap route, not the list', () => {
  // Fifty transcripts to render one collapsed panel would be megabytes a load.
  const list = server.slice(server.indexOf("app.get('/api/kpi-recaps'"), server.indexOf("app.post('/api/kpi-recaps/run-now'"));
  assert.ok(!/transcript_text/.test(list), 'the list endpoint now ships every transcript');
  const one = server.slice(server.indexOf("app.get('/api/kpi-recaps/:id'"), server.indexOf("app.get('/api/kpi-recaps'"));
  assert.ok(/transcript_text/.test(one), 'the detail route does not return the transcript');
});

console.log('\nnothing else was touched');
t('no other tab changed hands', () => {
  // Marketing's rules were settled two commits ago and are not this tab's business.
  const marketing = Object.entries(TAB_ACCESS)
    .filter(([, tabs]) => tabs.includes('marketing')).map(([r]) => r).sort();
  assert.deepStrictEqual(marketing, ['admin', 'ceo', 'marketing_bd_agent']);
  assert.ok(!TAB_ACCESS.ceo.includes('calls'), 'the Call Analyzer moved');
});
t('the escaping helper is used on every value that reaches the DOM', () => {
  const i = app.indexOf('function krcRenderDetail(');
  const body = stripComments(app.slice(i, i + 3400));
  // email_body is server-built HTML and is inserted as HTML on purpose; every
  // other field is a string from Graph or from a partner's invitation.
  ['r.email_subject', 'r.subject', 'r.status', 'r.transcript_text'].forEach(f =>
    assert.ok(new RegExp('esc\\(' + f.replace('.', '\\.')).test(body),
      `${f} reaches the DOM unescaped`));
});

console.log(`\n${pass} passing`);
