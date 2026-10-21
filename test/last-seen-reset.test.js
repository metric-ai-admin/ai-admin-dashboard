// Last Seen, and the password reset beside it.
//
// The log showed "no activity" for Rocío, Kara, Karla, Claudia and Bekah, and
// all five HAD signed in — between 2026-08-27 and 2026-09-24, before the login
// event was ever recorded. Read as "never signed in", that is five people
// about to have working passwords reset out from under them.
//
// So the table shows what Supabase Auth knows as well as what the log knows,
// and the reset says what it destroys before it runs.
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
const app = read('public/app.js');
const css = read('public/styles.css');
const html = read('public/index.html');

console.log('last seen, and the reset');

// ---- 1. the Role select ------------------------------------------------------

t('the select cannot grow past the card', () => {
  // A flex item will not shrink below its content, so a <select> as wide as
  // its longest option pushed the field out through the right edge.
  const at = css.indexOf('.sp-field { display: flex');
  assert.ok(at > 0, '.sp-field is gone');
  assert.match(css.slice(at, at + 220), /min-width:\s*0/);
  const inp = css.indexOf('.sp-field input, .sp-field select');
  assert.match(css.slice(inp, inp + 340), /max-width:\s*100%/);
  assert.match(css.slice(inp, inp + 340), /box-sizing:\s*border-box/);
  const cs = css.indexOf('.crm-select {');
  assert.match(css.slice(cs, cs + 340), /max-width:\s*100%/);
});

t('an option is the role name, and the tabs move below it', () => {
  // The information is not dropped — it is read just before somebody creates
  // the account, which is where it now sits.
  const acct = app.slice(app.indexOf('function acctInit()'),
    app.indexOf('async function krUploadWorkbook'));
  assert.ok(!/o\.textContent = r \+ ' — '/.test(acct), 'the option still carries the tab list');
  assert.match(acct, /o\.textContent = r;/);
  assert.match(acct, /acct-tabs/);
  assert.match(html, /id="acct-tabs"/);
});

// ---- 2. who sees Social posts -------------------------------------------------

const roles = name => {
  const m = app.match(new RegExp(name + ":\\s*\\[([^\\]]*)\\]"));
  assert.ok(m, name + ' is not in TAB_ACCESS');
  return m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
};

t('Bekah and Kara reach Social posts without losing anything', () => {
  const bekah = roles('regional_director');
  assert.ok(bekah.includes('socialposts'));
  ['maintenance', 'reports', 'leasing', 'collections', 'kpi', 'calls']
    .forEach(tb => assert.ok(bekah.includes(tb), 'regional_director lost ' + tb));
  const kara = roles('resident_success');
  assert.ok(kara.includes('socialposts'));
  ['maintenance', 'reports', 'evictions', 'leasing', 'collections', 'calls']
    .forEach(tb => assert.ok(kara.includes(tb), 'resident_success lost ' + tb));
});

t('they see every post, not only their own', () => {
  // The scoping list is what limits an agent to her own rows.
  const at = server.indexOf('const SOCIAL_OWN_ONLY_ROLES =');
  const list = server.slice(at, server.indexOf(';', at));
  assert.ok(!/regional_director|resident_success/.test(list),
    'Bekah or Kara is scoped to her own posts');
});

// ---- 3. what the table knows, and what it does not ------------------------------

t('the route reads Supabase Auth as well as the log', () => {
  const at = server.indexOf("app.get('/api/activity/last-seen'");
  const body = server.slice(at, server.indexOf("app.get('/api/activity/weekly'", at));
  assert.match(body, /auth\.admin[\s\S]{0,20}listUsers/);
  assert.match(body, /auth_last_sign_in/);
  assert.match(body, /must_change_password/);
});

t('a lookup that failed is not reported as "never signed in"', () => {
  // One is a person with no login; the other is a question nobody could ask,
  // and resetting a password is the wrong answer to the second.
  const at = server.indexOf("app.get('/api/activity/last-seen'");
  const body = server.slice(at, server.indexOf("app.get('/api/activity/weekly'", at));
  assert.match(body, /auth_known: !!a/);
  assert.match(body, /authError/);
  assert.match(app, /ACCOUNT STATE UNAVAILABLE/);
  assert.match(app, /do not read that as/);
  const cell = app.slice(app.indexOf('function acctAuthCell'),
    app.indexOf('function wireResetButtons'));
  assert.match(cell, /not known/);
});

t('must_change_password is visible', () => {
  // Bekah has carried it since a temporary password was issued and never
  // changed. Without the column, the next person to look issues a second one.
  const cell = app.slice(app.indexOf('function acctAuthCell'),
    app.indexOf('function wireResetButtons'));
  assert.match(cell, /u\.must_change_password/);
  assert.match(cell, /must change password/);
});

// ---- the reset ---------------------------------------------------------------------

const reset = app.slice(app.indexOf('function wireResetButtons'),
  app.indexOf('async function loadActivity'));

t('it uses the route that already existed', () => {
  assert.match(reset, /\/api\/auth\/admin\/temp-password/);
  const at = server.indexOf("app.post('/api/auth/admin/temp-password'");
  assert.match(server.slice(at, at + 120), /requireMetricAdmin/);
});

t('the confirmation says what it destroys', () => {
  // Four of the five people this looked useful for had working credentials
  // and simply had not been back.
  assert.match(reset, /window\.confirm/);
  assert.match(reset, /INVALIDATES the password they have now/);
});

t('the button is admin only', () => {
  assert.match(app, /const mayReset = currentUser && currentUser\.role === 'admin'/);
  assert.match(app, /mayReset \? `<td><button class="btn-sm" data-reset-pw=/);
});

t('the password is shown once and kept nowhere', () => {
  assert.match(reset, /data\.password/);
  assert.ok(!/localStorage|sessionStorage/.test(reset), 'the password touches storage');
  assert.ok(!/console\.(log|info|warn)/.test(reset), 'it could reach the console');
  assert.match(reset, /Shown once/);
  assert.match(reset, /clipboard\.writeText/);
  assert.match(reset, /could not copy/, 'a copy button that only looks like it worked');
});

t('the act is logged and the password is not', () => {
  const at = server.indexOf("app.post('/api/auth/admin/temp-password'");
  const body = server.slice(at, server.indexOf("app.post('/api/auth/admin/create-user'", at));
  const from = body.indexOf('activityLog.log');
  assert.ok(from > 0, 'the reset is not logged');
  const call = body.slice(from, body.indexOf('});', from));
  // The VALUE, not the word. The event is called temp_password_issued, so a
  // bare /password/ matches the name of the act and reports a leak that is not
  // there — a test that cries wolf gets switched off.
  assert.ok(!/(^|[^_a-z])password([^_a-z]|$)/.test(call),
    'the activity log carries the password itself');
  assert.match(call, /event: 'temp_password_issued'/, 'the act is not named');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
