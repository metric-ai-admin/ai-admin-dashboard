// Two changes Lyndsay asked for on 2026-10-08:
//
//   1. Zach's link stops working — 404 on the page and on every API route —
//      WITHOUT deleting a word he wrote. His reviews, his ranking and his two
//      name ideas stay visible in the dashboard tab.
//   2. Her own read-only link shows all three reviewers side by side instead
//      of an editable page with nothing selected in it.
//
// The first is the one worth testing hard: "revoke" and "erase" are one
// careless edit apart, and the careless edit is the obvious one — taking him
// out of REBRAND_PEOPLE, which is also the column list the dashboard renders.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const page = read(path.join('public', 'tools', 'rebrand-review.html'));
const strip = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const code = strip(server);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// ---- run the real token functions, not a copy of them --------------------
// Lifted out of server.js and evaluated with a fixed secret, so these assert
// what the code DOES rather than what it looks like.
function loadTokenLogic() {
  const grab = (from, to) => {
    const i = server.indexOf(from);
    const j = server.indexOf(to, i);
    assert.ok(i >= 0 && j > i, 'could not find ' + from);
    return server.slice(i, j);
  };
  const src = grab("const REBRAND_PEOPLE =", "// Rate limit, per token, in memory.");
  const sandbox = {};
  new Function('S', 'process', 'require', src
    + '\nS.REBRAND_PEOPLE=REBRAND_PEOPLE; S.REBRAND_REVOKED=REBRAND_REVOKED;'
    + 'S.REBRAND_READONLY=REBRAND_READONLY; S.rebrandToken=rebrandToken;'
    + 'S.rebrandPersonFor=rebrandPersonFor; S.rebrandIsTest=rebrandIsTest;'
    + 'S.rebrandWriteRefusal=rebrandWriteRefusal;'
  )(sandbox, { env: { REBRAND_REVIEW_SECRET: 'test-secret-for-this-file-only' } }, require);
  return sandbox;
}
const R = loadTokenLogic();

console.log('rebrand — Zach revoked, Lyndsay read-only');

// ---- 1. the door is shut -------------------------------------------------
t("Zach's token no longer resolves to anybody", () => {
  const tok = R.rebrandToken('Zach');
  assert.ok(/^[0-9a-f]{32}$/.test(tok), 'the token should still be derivable');
  assert.strictEqual(R.rebrandPersonFor(tok), null, 'his token still opens the review');
});

t('a revoked token is indistinguishable from an invented one', () => {
  // Both null — so rebrandGuard answers 404 for each, and the holder of a dead
  // link is not told it used to be real.
  assert.strictEqual(R.rebrandPersonFor(R.rebrandToken('Zach')), null);
  assert.strictEqual(R.rebrandPersonFor('f'.repeat(32)), null);
  assert.strictEqual(R.rebrandPersonFor('not-a-token'), null);
  assert.strictEqual(R.rebrandPersonFor(''), null);
});

t('revoking Zach did not break anyone else', () => {
  ['Kara', 'Bekah', 'Lyndsay', 'Test'].forEach(p =>
    assert.strictEqual(R.rebrandPersonFor(R.rebrandToken(p)), p, p + ' lost their link'));
});

t('one 404 for the page and the API, because it is one function', () => {
  // rebrandGuard is what every route calls, and it is the only caller of
  // rebrandPersonFor — so revocation cannot be live on one route and not another.
  const guard = code.slice(code.indexOf('function rebrandGuard'), code.indexOf('function rebrandGuard') + 500);
  assert.ok(/rebrandPersonFor\(req\.params\.token\)/.test(guard));
  const callers = (code.match(/rebrandPersonFor\(/g) || []).length;
  assert.strictEqual(callers, 2, 'rebrandPersonFor is called ' + callers
    + ' times (expected its definition plus rebrandGuard) — a second path could bypass revocation');
  ['/review/:token', '/api/review/:token/docs'].forEach(r =>
    assert.ok(code.includes(r), 'route ' + r + ' vanished'));
});

// ---- 2. nothing he wrote is touched --------------------------------------
t('Zach is STILL in REBRAND_PEOPLE — this is what keeps his answers on screen', () => {
  assert.ok(R.REBRAND_PEOPLE.includes('Zach'),
    'removing him from REBRAND_PEOPLE also removes his column from the dashboard tab');
  assert.ok(R.REBRAND_REVOKED.has('Zach'));
});

t('the dashboard tab still lists him as a reviewer', () => {
  // /api/rebrand/responses sends `people` as the column list. It filters out
  // read-only and test people — and must NOT filter out revoked ones.
  const i = code.indexOf("app.get('/api/rebrand/responses'");
  const body = code.slice(i, i + 1200);
  const m = /people: REBRAND_PEOPLE\.filter\(([^)]*)\)/.exec(body);
  assert.ok(m, 'the responses route no longer sends a people list');
  assert.ok(!/REVOKED/.test(m[1]), 'revoked reviewers are being filtered out of the tab');
  // And prove it with the real list.
  const shown = R.REBRAND_PEOPLE.filter(p => !R.REBRAND_READONLY.has(p) && !R.rebrandIsTest(p));
  assert.ok(shown.includes('Zach'), 'Zach is not in the tab column list');
});

t('nothing added a delete of his rows', () => {
  // The only delete against rebrand_review is the test-answer cleanup, and it
  // is scoped to the test/ prefix.
  const deletes = code.match(/from\('rebrand_review'\)\s*\.delete\(\)[^;]*/g) || [];
  deletes.forEach(d => assert.ok(/REBRAND_TEST_PREFIX|\.eq\('path', storedPath\)/.test(d),
    'an unscoped delete against rebrand_review: ' + d.slice(0, 120)));
  assert.ok(!/zach/i.test(code.replace(/REBRAND_REVOKED = new Set\(\['Zach'\]\)/, '')
    .match(/from\('rebrand_review'\)[\s\S]{0,300}/g || []) ?.join('') || ''),
    'a query singles Zach out by name');
});

t('the links page offers no URL for a revoked link', () => {
  const i = code.indexOf("app.get('/api/rebrand/links'");
  const body = code.slice(i, i + 900);
  assert.ok(/revoked,/.test(body), 'the links list does not say which are revoked');
  assert.ok(/url: revoked \? null :/.test(body),
    'a revoked link still prints a working-looking URL that answers 404');
});

t('his token is still derivable, so revocation is reversible', () => {
  // Deleting him from REBRAND_PEOPLE would change nothing about the secret,
  // but keeping the entry means un-revoking is one line and his old link works
  // again — which matters if this turns out to be a mistake.
  assert.strictEqual(R.rebrandToken('Zach'), R.rebrandToken('zach'),
    'tokens are case-insensitive on the person, as they always were');
});

// ---- 3. Lyndsay's read-only view -----------------------------------------
const pageJs = (() => {
  const blocks = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(b => b[1]);
  assert.ok(blocks.length >= 1, 'no script block in the page');
  return blocks.join('\n');
})();

t('the page still parses', () => {
  [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((b, i) =>
    assert.doesNotThrow(() => new Function(b[1]), 'script block ' + i));
});

t('the page lists all three reviewers, Zach included', () => {
  assert.ok(/const people=\["Zach","Kara","Bekah"\]/.test(pageJs),
    'Zach was dropped from the page, which would hide his answers from Lyndsay');
});

t('a read-only link renders a document, not a disabled form', () => {
  assert.ok(/function roPanelHTML\(/.test(pageJs), 'no read-only panel renderer');
  const mp = pageJs.slice(pageJs.indexOf('function mountPanel('), pageJs.indexOf('function mountPanel(') + 300);
  assert.ok(/if\(readOnly\)\{[\s\S]*roPanelHTML/.test(mp),
    'mountPanel still builds the editable panel for a read-only link');
});

t('it shows EVERY reviewer side by side, not just one', () => {
  const fn = pageJs.slice(pageJs.indexOf('function roPanelHTML('), pageJs.indexOf('function mountPanel('));
  assert.ok(/people\.map\(p=>roColumn\(/.test(fn), 'it does not iterate the reviewers');
  assert.ok(/ro-grid/.test(fn));
});

t('the panels are remounted once the server says the link is read-only', () => {
  // They are built at boot, BEFORE that answer arrives. Without the remount,
  // Lyndsay gets the editable shell with nothing selected — the original bug.
  assert.ok(/if\(readOnly\)\{\s*document\.querySelectorAll\("section \.fb-slot"\)\.forEach\(mountPanel\);\s*renderFinalForms\(\);\s*\}/.test(pageJs),
    'nothing remounts the panels after readOnly is known');
});

t('rankings and the final comparison are read-only too', () => {
  const rank = pageJs.slice(pageJs.indexOf('function renderRankingForms('), pageJs.indexOf('function renderRankingForms(') + 1200);
  assert.ok(/if\(readOnly\)\{/.test(rank), 'rankings still render as disabled selects');
  const fin = pageJs.slice(pageJs.indexOf('function renderFinalForms('), pageJs.indexOf('function renderFinalForms(') + 900);
  assert.ok(/if\(readOnly\)\{/.test(fin), 'the final comparison still renders as disabled textareas');
});

t('the read-only view escapes everything it prints', () => {
  const fn = pageJs.slice(pageJs.indexOf('function roColumn('), pageJs.indexOf('function roPanelHTML('));
  // Reviewer prose goes through nl2br (which escapes first); labels through esc.
  assert.ok(/nl2br\(d\[k\]\)/.test(fn), 'answer text is not escaped');
  assert.ok(/esc\(person\)/.test(fn));
  assert.ok(!/\$\{d\[k\]\}/.test(fn), 'raw interpolation of stored text');
});

t('read-only still writes nothing — the server refusal is unchanged', () => {
  assert.ok(/if \(REBRAND_READONLY\.has\(person\)\) return res\.status\(403\)/.test(code),
    'the read-only write refusal was lost');
  assert.ok(/if\(readOnly\) return;/.test(pageJs), 'queue() no longer bails on a read-only link');
});

t('a reviewer still gets the editable page', () => {
  // The read-only branch must not have swallowed the normal path.
  assert.ok(/function panelHTML\(target,name,modeKind\)/.test(pageJs));
  assert.ok(/choosePerson\(panel,want,false\)/.test(pageJs));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
