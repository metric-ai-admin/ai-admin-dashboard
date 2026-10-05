// Clicking a tab while the page is still booting.
//
// REPRODUCED TWICE by Arturo: pick a tab from the sidebar while the Morning
// Report is still generating and the tab appears selected but the content does
// not change; a second click works.
//
// It is not the Morning Report. initAuth() awaits /api/auth/me, the sidebar is
// clickable the whole time, and when that request came back the role gate
// cleared every .active and forced the first allowed tab back on screen. It
// looked like Morning because for admin the first allowed tab IS Morning, and
// Morning is the slowest thing on the page — so the override always landed
// there, always while a report was spinning.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// Match code, never the comments around it: this file's comments quote the
// symptom almost word for word.
const code = app.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const GATE = (() => {
  const i = code.indexOf('const firstAllowed = allTabBtns.find');
  assert.ok(i > 0, 'the role gate moved');
  const j = code.indexOf('$(\'#logout-btn\')', i);
  return code.slice(i, j > i ? j : i + 1200);
})();

console.log('the race itself');
t('the gate no longer forces the first allowed tab unconditionally', () => {
  assert.ok(!/if \(firstAllowed\) \{\s*\n\s*\$\$\('#tabs button'\)\.forEach/.test(GATE),
    'firstAllowed is still activated without looking at what the user picked');
  assert.ok(/const chosen = userChoseTab/.test(GATE), 'the gate does not consult the user’s choice');
});
t('a tab the user picked during boot survives', () => {
  assert.ok(/const target = chosen\s*\n?\s*\? allTabBtns\.find\(b => b\.dataset\.tab === chosen\)\s*\n?\s*: firstAllowed;/.test(GATE),
    'the chosen tab is not what gets activated');
});
t('the choice is recorded on click', () => {
  assert.ok(/userChoseTab = btn\.dataset\.tab;/.test(code), 'nothing records the choice');
  // After the submenu-collapse early return, which changes no tab.
  const i = code.indexOf('userChoseTab = btn.dataset.tab;');
  const before = code.slice(code.indexOf("btn.addEventListener('click'"), i);
  assert.ok(/return;/.test(before),
    'collapsing a submenu would count as choosing a tab');
});
t('it is declared above the function that reads it', () => {
  assert.ok(code.indexOf('let userChoseTab = null;') < code.indexOf('const chosen = userChoseTab'),
    'the reader sits above the declaration, which invites a future temporal-dead-zone bug');
});

console.log('\nchoosing is not permission');
t('a tab the role may not have is still overridden', () => {
  // Until the gate runs, the buttons for tabs this user cannot see are visible
  // and clickable. "The user picked it" cannot be enough on its own.
  assert.ok(/userChoseTab && allowed\.includes\(userChoseTab\) \? userChoseTab : null/.test(GATE),
    'a disallowed tab chosen during boot would be kept');
});
t('with no choice at all, the first allowed tab is still used', () => {
  assert.ok(/: firstAllowed;/.test(GATE), 'a fresh load would open no tab');
});
t('the gate still hides disallowed buttons', () => {
  assert.ok(/if \(!allowed\.includes\(btn\.dataset\.tab\)\) btn\.style\.display = 'none';/.test(code));
});

console.log('\nthe kept tab is loaded properly');
t('loadTab runs again for the chosen tab', () => {
  // The click already called it, but that call happened with currentUser still
  // null, so anything role-dependent inside it saw nothing.
  assert.ok(/loadTab\(target\.dataset\.tab\);/.test(GATE), 'the kept tab is never loaded with a real user');
});

console.log('\nthe Activity Logs beacon records the section the user chose');
t('the beacon fires from loadTab, so it follows the tab that actually opens', () => {
  assert.ok(/function loadTab\(tab\) \{\s*\n\s*logSectionView\(tab\);/.test(code));
});
t('the gate calls loadTab with the TARGET, not with firstAllowed', () => {
  // This is what makes the beacon correct. Were it still loadTab(firstAllowed
  // .dataset.tab), the user would be looking at Leasing and the log would say
  // Morning — a wrong row is worse than a missing one.
  assert.ok(!/loadTab\(firstAllowed\.dataset\.tab\);/.test(GATE),
    'the gate logs the tab it wanted rather than the one on screen');
});
t('the second beacon for the same section is harmless', () => {
  // The chosen tab gets loadTab twice: once from the click, once from the gate.
  // Both land in the same 30-minute bucket and the partial unique index from
  // 073 collapses them, so the duplicate costs a request and never a row.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '073_activity_log.sql'), 'utf8');
  assert.ok(/create unique index if not exists activity_log_view_uniq/.test(sql));
  assert.ok(/where event = 'view'/.test(sql));
});

console.log('\nthe Morning Report is not involved');
t('loadMorning never touches tab activation', () => {
  // Pinned because the symptom points straight at it and the next person to
  // read this will suspect it too.
  const i = code.indexOf('async function loadMorning');
  const body = code.slice(i, code.indexOf("$('#morning-refresh')", i));
  assert.ok(i > 0 && body.length > 50, 'loadMorning moved');
  assert.ok(!/classList\.(add|remove|toggle)\('active'\)/.test(body),
    'loadMorning changes which tab is active');
  assert.ok(!/loadTab\(/.test(body), 'loadMorning switches tabs');
});

console.log(`\n${pass} passing`);
