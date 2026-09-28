// SOP Library v2 — access, review scheduling, search and rendering.
//
// The rendering tests carry the most weight. These 708 documents come from an
// export nobody has audited, they will be readable by every employee, and the
// renderer is the only thing standing between "somebody pasted HTML into a
// Slab post in 2023" and a stored-XSS hole on an internal page.
const assert = require('assert');
const S = require('../sop-library.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const DEPTS = [
  { name: 'Operations', read_roles: ['admin', 'regional_director', 'maintenance'], edit_roles: ['admin', 'regional_director'] },
  { name: 'Human Resources', read_roles: ['admin', 'regional_director'], edit_roles: ['admin'] },
  { name: 'Maintenance', read_roles: ['admin', 'maintenance'], edit_roles: ['admin', 'maintenance'] },
];

console.log('access');
t('a role reads only what its department grants', () => {
  assert.strictEqual(S.canRead('maintenance', 'Operations', DEPTS), true);
  assert.strictEqual(S.canRead('maintenance', 'Human Resources', DEPTS), false);
});
t('reading is not editing', () => {
  assert.strictEqual(S.canRead('maintenance', 'Operations', DEPTS), true);
  assert.strictEqual(S.canEdit('maintenance', 'Operations', DEPTS), false);
  assert.strictEqual(S.canEdit('maintenance', 'Maintenance', DEPTS), true);
});
t('HR stays closed to everyone but admin and the regional director', () => {
  ['maintenance', 'accounting', 'leasing_bd', 'bd_agent', 'evictions_agent'].forEach(r =>
    assert.strictEqual(S.canRead(r, 'Human Resources', DEPTS), false, r));
});
t('admin reads and edits everywhere', () => {
  DEPTS.forEach(d => {
    assert.strictEqual(S.canRead('admin', d.name, DEPTS), true, d.name);
    assert.strictEqual(S.canEdit('admin', d.name, DEPTS), true, d.name);
  });
});
t('an unknown department is denied, not defaulted open', () => {
  assert.strictEqual(S.canRead('maintenance', 'Legal', DEPTS), false);
  assert.strictEqual(S.canEdit('maintenance', 'Legal', DEPTS), false);
});
t('a missing role is denied', () => {
  [undefined, null, '', 'nonsense'].forEach(r =>
    assert.strictEqual(S.canRead(r, 'Operations', DEPTS), false, String(r)));
});
t('the readable set drives the query, not the UI', () => {
  assert.deepStrictEqual(S.readableDepartments('maintenance', DEPTS).sort(), ['Maintenance', 'Operations']);
  assert.deepStrictEqual(S.readableDepartments('admin', DEPTS).length, 3);
  assert.deepStrictEqual(S.readableDepartments('evictions_agent', DEPTS), []);
});

console.log('\nreview scheduling');
t('next review is the review date plus the interval', () => {
  assert.strictEqual(S.nextReviewDate('2026-09-28T10:00:00Z', 90), '2026-12-27');
  assert.strictEqual(S.nextReviewDate('2026-09-28', 365), '2027-09-28');
});
t('no interval means no date — unscheduled is not due today', () => {
  [null, undefined, 0, -30, 'soon'].forEach(v =>
    assert.strictEqual(S.nextReviewDate('2026-09-28', v), null, String(v)));
});
t('overdue, due soon and ok are measured against a passed-in today', () => {
  const today = '2026-09-28';
  assert.strictEqual(S.reviewState({ next_review_at: '2026-09-01' }, today).state, 'overdue');
  assert.strictEqual(S.reviewState({ next_review_at: '2026-10-05' }, today).state, 'due-soon');
  assert.strictEqual(S.reviewState({ next_review_at: '2026-12-01' }, today).state, 'ok');
});
t('due today is due soon, not overdue', () => {
  const r = S.reviewState({ next_review_at: '2026-09-28' }, '2026-09-28');
  assert.strictEqual(r.overdue, false);
  assert.strictEqual(r.dueSoon, true);
  assert.strictEqual(r.days, 0);
});
t('a document with no schedule is never overdue', () => {
  const r = S.reviewState({ next_review_at: null }, '2026-09-28');
  assert.strictEqual(r.state, 'unscheduled');
  assert.strictEqual(r.overdue, false);
});
t('marking reviewed records who, when and the next date', () => {
  const p = S.markReviewed({ review_interval_days: 90, status: 'Current' },
    { by: 'Jay Manuel', at: '2026-09-28T12:00:00.000Z' });
  assert.strictEqual(p.last_reviewed_by, 'Jay Manuel');
  assert.strictEqual(p.next_review_at, '2026-12-27');
  assert.strictEqual(p.updated_by, 'Jay Manuel');
});
t('reviewing clears Needs Review but does not resurrect Outdated or Archived', () => {
  // Reading a document does not make it accurate, and an archived procedure
  // must not come back to life because somebody clicked a button.
  assert.strictEqual(S.markReviewed({ status: 'Needs Review', review_interval_days: 90 }, { by: 'x' }).status, 'Current');
  assert.strictEqual(S.markReviewed({ status: 'Outdated', review_interval_days: 90 }, { by: 'x' }).status, undefined);
  assert.strictEqual(S.markReviewed({ status: 'Archived', review_interval_days: 90 }, { by: 'x' }).status, undefined);
});
t('marking an unscheduled document reviewed leaves it unscheduled', () => {
  const p = S.markReviewed({ status: 'Current', review_interval_days: null }, { by: 'x', at: '2026-09-28T12:00:00.000Z' });
  assert.strictEqual(p.next_review_at, null);
  assert.strictEqual(p.last_reviewed_at, '2026-09-28T12:00:00.000Z');
});

console.log('\nsearch');
const doc = { title: 'Filing Evictions (Texas eFile Process)', category: 'Collections', tags: ['legal', 'texas'], body_md: 'Go to the county portal and upload the petition.' };
t('matches on title, category, tags and body', () => {
  ['evictions', 'collections', 'texas', 'petition'].forEach(q =>
    assert.strictEqual(S.matches(doc, q), true, q));
});
t('all terms must match, not any', () => {
  assert.strictEqual(S.matches(doc, 'evictions petition'), true);
  assert.strictEqual(S.matches(doc, 'evictions plumbing'), false);
});
t('an empty query matches everything', () => {
  assert.strictEqual(S.matches(doc, ''), true);
  assert.strictEqual(S.matches(doc, '   '), true);
});
t('case and spacing do not matter', () => {
  assert.strictEqual(S.matches(doc, '  TEXAS   eFile '), true);
});

console.log('\nmarkdown — safety first');
t('raw HTML is escaped, never rendered', () => {
  const h = S.renderMarkdown('<script>alert(1)</script>');
  assert.ok(!/<script>/.test(h), h);
  assert.ok(/&lt;script&gt;/.test(h));
});
t('an img tag in the source cannot become an img tag in the output', () => {
  const h = S.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/.test(h), h);
});
t('a javascript: link is stripped to its label', () => {
  const h = S.renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!/href/.test(h), h);
  assert.ok(/click/.test(h));
});
t('a data: image is refused and reported, not silently dropped', () => {
  const h = S.renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)');
  assert.ok(!/<img/.test(h), h);
  assert.ok(/sop-broken/.test(h));
});
t('a title attribute cannot break out of the href', () => {
  const h = S.renderMarkdown('[a](https://x.com "onmouseover=alert(1)")');
  assert.ok(/href="https:\/\/x\.com"/.test(h), h);
  assert.ok(!/onmouseover/.test(h), h);
});

console.log('\nmarkdown — the corpus');
t('headings, bold, italic', () => {
  const h = S.renderMarkdown('# Title\n\nSome **bold** and *slanted* text.');
  assert.ok(/<h1>Title<\/h1>/.test(h));
  assert.ok(/<strong>bold<\/strong>/.test(h));
  assert.ok(/<em>slanted<\/em>/.test(h));
});
t('both kinds of list', () => {
  assert.ok(/<ul>\n<li>a<\/li>/.test(S.renderMarkdown('- a\n- b')));
  assert.ok(/<ol>\n<li>first<\/li>/.test(S.renderMarkdown('1. first\n2. second')));
});
t('blockquotes, which Slab uses heavily for steps', () => {
  const h = S.renderMarkdown('> Go to the portal\n> Click Accounting');
  assert.ok(/<blockquote>/.test(h) && /<\/blockquote>/.test(h));
});
t('pipe tables render as tables — 22 articles use them', () => {
  const h = S.renderMarkdown('| Step | Who |\n|---|---|\n| Post fees | Accounting |');
  assert.ok(/<table class="sop-table">/.test(h), h);
  assert.ok(/<th>Step<\/th><th>Who<\/th>/.test(h), h);
  assert.ok(/<td>Post fees<\/td>/.test(h), h);
  assert.ok(!/---/.test(h), 'the separator row leaked into the output');
});
t('a table closes when the prose resumes', () => {
  const h = S.renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.');
  assert.ok(/<\/table>/.test(h));
  assert.ok(h.indexOf('</table>') < h.indexOf('After.'));
});
t('external links open in a new tab, safely', () => {
  const h = S.renderMarkdown('[portal](https://metric.myresman.com/)');
  assert.ok(/rel="noopener noreferrer"/.test(h), h);
});
t('a rehosted asset path resolves to the serving route', () => {
  const h = S.renderMarkdown('![shot](sop-assets/abc123.png)');
  assert.ok(/src="\/api\/sop\/assets\/abc123\.png"/.test(h), h);
});
t('an expiring Slab URL still renders until it is rehosted', () => {
  const h = S.renderMarkdown('![x](https://slabstatic.com/prod/uploads/a/b.png?jwt=eyJ.abc.def)');
  assert.ok(/<img src="https:\/\/slabstatic\.com/.test(h), h);
});
t('empty input is empty output, not a crash', () => {
  ['', null, undefined].forEach(v => assert.strictEqual(S.renderMarkdown(v), ''));
});

console.log('\nexcerpts');
t('markup is stripped for the list row', () => {
  const e = S.excerpt('# Head\n\nSome **text** with [a link](http://x).');
  assert.ok(!/[#*[\]]/.test(e), e);
  assert.ok(/a link/.test(e));
});
t('long text is cut on a word boundary with an ellipsis', () => {
  const e = S.excerpt('word '.repeat(80), 60);
  assert.ok(e.length <= 62, String(e.length));
  assert.ok(e.endsWith('…'));
});
t('an empty body gives an empty excerpt', () => {
  assert.strictEqual(S.excerpt(''), '');
});

console.log(`\n${pass} passing`);
