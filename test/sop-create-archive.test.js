// Creating and archiving SOPs from the dashboard.
//
// The library replaced Slab, which means it is now the only copy. Two things
// follow from that and most of this file is about them:
//
//   Nothing may be deleted. Archiving keeps the document and its versions and
//   drops it out of the active list; an SOP that stopped applying is a record
//   of how the company used to work.
//
//   A document's history must start at version 1. The edit route writes the
//   PREVIOUS body on every change, so a document created without a version 1
//   would have its original text exist nowhere the moment somebody edited it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../sop-library.js');
const ACTS = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const CREATE = server.slice(server.indexOf("app.post('/api/sop/documents', requireAuth"),
  server.indexOf("app.post('/api/sop/documents/:id/archive'"));
const ARCHIVE = server.slice(server.indexOf("app.post('/api/sop/documents/:id/archive'"),
  server.indexOf("app.patch('/api/sop/documents/:id'"));

// Mirrors the real table: Operations is editable by operations, HR by nobody
// but admin.
const DEPARTMENTS = [
  { name: 'Operations', read_roles: ['operations', 'maintenance'], edit_roles: ['operations'] },
  { name: 'Human Resources', read_roles: [], edit_roles: [] },
  { name: 'Maintenance', read_roles: ['maintenance'], edit_roles: ['maintenance'] },
];

// ---- who may write where ----------------------------------------------------
t('Operations may write in Operations and nowhere else', () => {
  assert.deepStrictEqual(L.editableDepartments('operations', DEPARTMENTS), ['Operations']);
});

t('Human Resources stays admin-only', () => {
  assert.ok(!L.editableDepartments('operations', DEPARTMENTS).includes('Human Resources'));
  assert.ok(!L.editableDepartments('maintenance', DEPARTMENTS).includes('Human Resources'));
  assert.ok(L.editableDepartments('admin', DEPARTMENTS).includes('Human Resources'));
  assert.strictEqual(L.canEdit('operations', 'Human Resources', DEPARTMENTS), false);
});

t('reading a department is not writing it', () => {
  // Maintenance reads Operations and must not be able to create there.
  assert.ok(L.readableDepartments('maintenance', DEPARTMENTS).includes('Operations'));
  assert.ok(!L.editableDepartments('maintenance', DEPARTMENTS).includes('Operations'));
});

t('a role with no departments gets an empty list, not everything', () => {
  assert.deepStrictEqual(L.editableDepartments('bd_agent', DEPARTMENTS), []);
  assert.deepStrictEqual(L.editableDepartments(undefined, DEPARTMENTS), []);
  assert.deepStrictEqual(L.editableDepartments('operations', []), []);
});

// ---- slugs ------------------------------------------------------------------
t('two SOPs with the same title do not collide', () => {
  const taken = new Set(['move-out-process']);
  assert.strictEqual(L.uniqueSlug('Move-Out Process', taken), 'move-out-process-2');
  taken.add('move-out-process-2');
  assert.strictEqual(L.uniqueSlug('Move-Out Process', taken), 'move-out-process-3');
});

t('a title with nothing slug-able still produces one', () => {
  assert.strictEqual(L.uniqueSlug('???', new Set()), 'sop');
  assert.strictEqual(L.uniqueSlug('', new Set()), 'sop');
});

t('a very long title is cut rather than refused', () => {
  assert.ok(L.uniqueSlug('x'.repeat(400), new Set()).length <= 80);
});

// ---- create -----------------------------------------------------------------
t('the create route checks canEdit on the department asked for', () => {
  assert.ok(/sopLib\.canEdit\(req\.user\?\.role, department, departments\)/.test(CREATE));
  assert.ok(/You cannot create SOPs in that department/.test(CREATE));
  // And the department must exist at all.
  assert.ok(/departments\.some\(d => d\.name === department\)/.test(CREATE));
});

t('version 1 is written with the document', () => {
  assert.ok(/from\('sop_versions'\)\.insert\(\{[\s\S]{0,200}version: 1/.test(CREATE),
    'without it the original text is gone the first time anyone edits');
});

t('a document is not thrown away because its history could not start', () => {
  // The body is still on the document, so refusing the whole create would lose
  // more than it protects — but it is reported, not swallowed.
  assert.ok(/versionError = vErr\.message/.test(CREATE));
  assert.ok(/console\.error\('\[sop\] version 1 not recorded/.test(CREATE));
  assert.ok(/versionError/.test(appjs), 'and the page says so');
});

t("a hand-written SOP is not marked as something the importer may replace", () => {
  assert.ok(/source: 'dashboard'/.test(CREATE),
    "the Slab importer matches on source to decide what it can overwrite");
});

t('a title is required and bounded', () => {
  assert.ok(/A title is required/.test(CREATE));
  assert.ok(/title\.length > 300/.test(CREATE));
});

t('an unknown status cannot be smuggled in', () => {
  assert.ok(/sopLib\.STATUSES\.includes\(b\.status\) \? b\.status : 'Current'/.test(CREATE));
});

t('the review interval is validated the same way as on edit', () => {
  assert.ok(/Review interval must be a positive number of days/.test(CREATE));
  assert.ok(/sopLib\.nextReviewDate/.test(CREATE));
});

// ---- archive ----------------------------------------------------------------
t('archiving is a flag, never a delete', () => {
  assert.ok(!/\.delete\(/.test(ARCHIVE), 'the archive route deletes');
  assert.ok(/archived,/.test(ARCHIVE));
});

t('admin and the department editors may archive, nobody else', () => {
  assert.ok(/sopLib\.canEdit\(req\.user\?\.role, doc\.department, departments\)/.test(ARCHIVE));
  assert.ok(/You can read this department but not edit it/.test(ARCHIVE));
});

t('a bare post archives and {archived:false} restores', () => {
  assert.ok(/req\.body\.archived === false \? false : true/.test(ARCHIVE));
});

t('restoring does not leave a visible document labelled Archived', () => {
  assert.ok(/status: archived \? 'Archived' : \(doc\.status === 'Archived' \? 'Current' : doc\.status\)/
    .test(ARCHIVE), 'status and archived are two views of one fact');
});

t('the list hides archived unless asked, which is a server filter', () => {
  const list = server.slice(server.indexOf("app.get('/api/sop/documents'"),
    server.indexOf("app.get('/api/sop/documents/:id'"));
  assert.ok(/req\.query\.archived !== 'true'/.test(list));
  assert.ok(/qs\.set\('archived', 'true'\)/.test(appjs), 'and the checkbox sets it');
  assert.ok(/slFilters\.archived = e\.target\.checked; loadSopLibrary\(\)/.test(appjs),
    'it must re-fetch, not re-render: the rows were never sent');
});

// ---- the page ---------------------------------------------------------------
t('the New SOP button exists and is hidden from people who cannot write', () => {
  assert.ok(/id="sl-new"[^>]*class="btn btn-sm hidden"/.test(html), 'it must start hidden');
  assert.ok(/btn\.classList\.toggle\('hidden', !slEditable\(\)\.length\)/.test(appjs));
});

t('the form offers only the departments this person can edit', () => {
  assert.ok(/\(slData\.departments \|\| \[\]\)\.filter\(d => d\.canEdit\)/.test(appjs));
  assert.ok(/Only the departments you can edit are listed/.test(appjs));
});

t('the Show archived checkbox is on the page', () => {
  assert.ok(/id="sl-archived"/.test(html));
});

t('archiving asks first, and says what it does', () => {
  const fn = appjs.slice(appjs.indexOf('async function slArchive'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/confirm\(/.test(body));
  assert.ok(/stays in the library with its full history/.test(body),
    'the word "archive" reads like "delete" to most people');
});

t('every value the form sends is escaped where it is rendered back', () => {
  const fn = appjs.slice(appjs.indexOf('function slNewForm'));
  const body = fn.slice(0, fn.indexOf('function slCloseNewForm'));
  const interps = body.match(/\$\{[^}]*\}/g) || [];
  interps.forEach(x => assert.ok(/slEsc\(|depts\.map\(|\.join\(/.test(x),
    'unescaped interpolation: ' + x));
});

// ---- activity logs ----------------------------------------------------------
t('create, edit and archive each have a name', () => {
  const must = [
    ['POST', '/api/sop/documents', 'Created an SOP'],
    ['PATCH', '/api/sop/documents/abc', 'Edited SOP document'],
    ['POST', '/api/sop/documents/abc/archive', 'Archived or restored an SOP'],
  ];
  for (const [m, p, label] of must) {
    const d = ACTS.describe(m, p);
    assert.ok(d && d.label, 'uncatalogued: ' + m + ' ' + p);
    assert.strictEqual(d.label, label);
    assert.strictEqual(d.entity, 'sop');
    assert.ok(!d.system, 'a person did this');
  }
});

t('they land under the SOP Library section', () => {
  assert.strictEqual(ACTS.sectionLabel('sop'), 'SOP Library');
});


// ---- numbered lists pasted from Slab ---------------------------------------
//
// Slab's export puts a blank line between list items. Closing the list on
// sight of one gave every item its own <ol>, so a numbered procedure rendered
// as a column of "1." all the way down.
t('a spaced numbered list is one list, numbered through', () => {
  const html = L.renderMarkdown('1. First\n\n2. Second\n\n3. Third\n');
  assert.strictEqual((html.match(/<ol/g) || []).length, 1, html);
  assert.strictEqual((html.match(/<li>/g) || []).length, 3, html);
});

t('"1. 1. 1." in the source still renders 1, 2, 3', () => {
  // Which is the whole point of an <ol>: the browser numbers it.
  const html = L.renderMarkdown('1. a\n\n1. b\n\n1. c\n');
  assert.strictEqual((html.match(/<ol/g) || []).length, 1);
  assert.ok(!/start=/.test(html), 'a list starting at 1 needs no start attribute');
});

t('a list that starts at another number keeps it', () => {
  assert.ok(/<ol start="4">/.test(L.renderMarkdown('4. Fourth\n\n5. Fifth\n')));
});

t('spaced bullets are one list too', () => {
  const html = L.renderMarkdown('- a\n\n- b\n');
  assert.strictEqual((html.match(/<ul/g) || []).length, 1, html);
});

t('a paragraph between items DOES end the list', () => {
  const html = L.renderMarkdown('1. a\n\nSome prose.\n\n1. b\n');
  assert.strictEqual((html.match(/<ol/g) || []).length, 2, html);
  assert.ok(/<p>Some prose\.<\/p>/.test(html));
});

t('a bulleted list after a numbered one is not merged into it', () => {
  const html = L.renderMarkdown('1. a\n\n- b\n');
  assert.strictEqual((html.match(/<ol/g) || []).length, 1, html);
  assert.strictEqual((html.match(/<ul/g) || []).length, 1, html);
});

t('a list at the end of the document is closed', () => {
  const html = L.renderMarkdown('1. a\n\n2. b');
  assert.strictEqual((html.match(/<\/ol>/g) || []).length, 1, html);
});

// ---- the count -------------------------------------------------------------
t('the list is counted by the database, not measured off the array', () => {
  const list = server.slice(server.indexOf("app.get('/api/sop/documents'"),
    server.indexOf("app.post('/api/sop/documents', requireAuth"));
  assert.ok(/select\('\*', \{ count: 'exact' \}\)/.test(list));
  assert.ok(/\.range\(from, from \+ PAGE - 1\)/.test(list), 'and read in pages');
  // Comments stripped: the note on that query explains the fix by naming the
  // limit it replaced, and an assertion matching my own prose would pass or
  // fail on how the comment is worded.
  assert.ok(!/\.limit\(2000\)/.test(list.replace(/^\s*\/\/.*$/gm, '')),
    'the bare limit is gone');
});

t('a list that could not be read in full says so', () => {
  const list = server.slice(server.indexOf("app.get('/api/sop/documents'"),
    server.indexOf("app.post('/api/sop/documents', requireAuth"));
  assert.ok(/const truncated = total !== null && all\.length < total/.test(list));
  assert.ok(/truncated,/.test(list), 'and it reaches the page');
  assert.ok(/list truncated \u2014 not all SOPs are shown/.test(appjs),
    'a library that silently stops listing SOPs is worse than one that says it cannot');
});

// ---- owner ------------------------------------------------------------------
t('owner is editable, and sits with the fields people look for it in', () => {
  const fn = appjs.slice(appjs.indexOf('function slEditForm'));
  const body = fn.slice(0, fn.indexOf('const back = () =>'));
  assert.ok(/name="owner"/.test(body));
  // Next to Category, not third in the Status/Interval row where it was missed.
  assert.ok(body.indexOf('name="category"') < body.indexOf('name="owner"'));
  assert.ok(body.indexOf('name="owner"') < body.indexOf('name="status"'));
  assert.ok(/owner: f\.get\('owner'\)/.test(fn), 'and it is sent on save');
});

t('the server accepts an owner change and can clear it', () => {
  const patch = server.slice(server.indexOf("app.patch('/api/sop/documents/:id'"));
  assert.ok(/if \(b\.owner !== undefined\) patch\.owner = String\(b\.owner \|\| ''\)\.trim\(\) \|\| null;/
    .test(patch));
});
console.log(`\n${pass} passing`);
