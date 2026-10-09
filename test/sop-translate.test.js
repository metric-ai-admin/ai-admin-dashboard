// Spanish SOPs for the maintenance technicians.
//
// Two things carry real risk here and most of this file is about them: a
// translation that no longer matches the English it was made from, and a
// public page that could be made to call a paid API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/sop-translate.js');
const SOPP = require('../lib/sop-public.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const EN_TITLE = 'Equipment Warranty Management';
const EN_BODY = '## Purpose\n\nTo ensure all equipment over $500 is documented.\n\n- Check `WO 22425-1`\n- File within 30 days\n';
const row = over => Object.assign({
  title: EN_TITLE, body_md: EN_BODY,
  title_es: 'Gestión de Garantías de Equipo',
  body_es: '## Propósito\n\nAsegurar que todo equipo de más de $500 esté documentado.\n\n- Revisar `WO 22425-1`\n- Archivar en 30 días\n',
  es_source_hash: T.sourceHash(EN_TITLE, EN_BODY),
}, over || {});

console.log('SOP translation');

// ---- the hash, which is the whole staleness mechanism --------------------
t('the hash covers the title AND the body', () => {
  // A SOP can be retitled without its steps changing, and the heading on the
  // printed page would then be in the wrong language.
  const a = T.sourceHash('A', 'body');
  assert.notStrictEqual(a, T.sourceHash('B', 'body'));
  assert.notStrictEqual(a, T.sourceHash('A', 'body2'));
  assert.strictEqual(a, T.sourceHash('A', 'body'));
});

t('line endings do not invalidate every translation at once', () => {
  assert.strictEqual(T.sourceHash('A', 'one\ntwo'), T.sourceHash('A', 'one\r\ntwo'));
  assert.strictEqual(T.sourceHash('A', ' body '), T.sourceHash('A', 'body'));
});

t('the title and body cannot be confused for each other', () => {
  // "AB" + "" and "A" + "B" must not hash the same.
  assert.notStrictEqual(T.sourceHash('AB', ''), T.sourceHash('A', 'B'));
});

// ---- the three states ----------------------------------------------------
t('a SOP that was never translated is MISSING, not stale', () => {
  assert.strictEqual(T.translationState(row({ body_es: null })), 'missing');
  assert.strictEqual(T.translationState(row({ body_es: '   ' })), 'missing');
  assert.strictEqual(T.translationState({}), 'missing');
});

t('a SOP whose English changed is STALE', () => {
  assert.strictEqual(T.translationState(row({ body_md: EN_BODY + '\n- One more step\n' })), 'stale');
  assert.strictEqual(T.translationState(row({ title: 'Renamed' })), 'stale');
});

t('a translation with no hash at all is treated as stale, not trusted', () => {
  assert.strictEqual(T.translationState(row({ es_source_hash: null })), 'stale');
});

t('an untouched SOP is ok', () => {
  assert.strictEqual(T.translationState(row()), 'ok');
  assert.strictEqual(T.needsTranslation(row()), false);
  assert.strictEqual(T.needsTranslation(row({ body_md: 'changed' })), true);
});

// ---- what the reader sees ------------------------------------------------
t('Spanish is shown when it is current', () => {
  const v = T.viewFor(row(), 'es');
  assert.strictEqual(v.lang, 'es');
  assert.ok(/Propósito/.test(v.body));
  assert.strictEqual(v.fallback, null);
});

t('STALE SPANISH IS NEVER SHOWN — English, with a reason', () => {
  // Showing a translation of text that no longer exists is worse than showing
  // English: the technician follows steps that were removed.
  const v = T.viewFor(row({ body_md: EN_BODY + '\n- New step\n' }), 'es');
  assert.strictEqual(v.lang, 'en');
  assert.ok(/Purpose/.test(v.body));
  assert.strictEqual(v.fallback, 'outdated');
});

// ---- documents written in both languages ---------------------------------
//
// Five of the 33 were WRITTEN bilingual, English and Spanish side by side,
// including the two longest. Three were translated anyway and came out as
// clean Spanish-only documents, which is an improvement. The other two were
// skipped, and a page telling their reader "not translated yet" would be wrong
// in the way that matters: he is looking at a document that already has his
// language in it.
const BILINGUAL = {
  title: 'Policy Vacant Unit Energy Conservation Política de Conservación de Energía en Unidades Vacantes',
  body_md: 'Purpose / Propósito\n\nThis policy ensures that vacant or make-ready apartments are managed '
    + 'in a way that conserves energy and reduces operating costs.\n\nEsta política garantiza que los '
    + 'apartamentos vacantes o en preparación sean gestionados de una manera que conserve la energía, '
    + 'reduzca los costos y mantenga la eficiencia de cada uno de los equipos del edificio para todas '
    + 'las unidades, desde el primer día hasta que el residente entregue las llaves.',
};

t('a document written in both languages is BILINGUAL, not missing', () => {
  assert.strictEqual(T.translationState(BILINGUAL), 'bilingual');
  assert.strictEqual(T.isBilingualSource(BILINGUAL.title, BILINGUAL.body_md), true);
});

t('it is not queued for translation — that would double its Spanish', () => {
  assert.strictEqual(T.needsTranslation(BILINGUAL), false);
});

t('an English-only SOP is never mistaken for bilingual', () => {
  // The separation in the real library is absolute: five documents score 31 to
  // 120 accented characters, the next scores 2, and the remaining 27 score
  // zero. These are the shapes on the English side of that gap.
  [
    { title: 'Creating Key Tags', body_md: '# Purpose\nTag every key with the unit number before filing it.' },
    { title: 'Equipment Warranty Management', body_md: 'Ensure all equipment over $500 is documented. File within 30 days.' },
    // A stray accented word or a property name does not make it bilingual.
    { title: 'Sunset Palms walkthrough', body_md: 'Check the patio and the piñata room. Jose signed off.' },
  ].forEach(r => assert.strictEqual(T.isBilingualSource(r.title, r.body_md), false,
    'wrongly called bilingual: ' + r.title));
});

t('the reader is told it is bilingual, not that it is waiting', () => {
  const v = T.viewFor(BILINGUAL, 'es');
  assert.strictEqual(v.lang, 'en');
  assert.strictEqual(v.fallback, 'bilingual');
});

t('a real translation still wins over the bilingual guess', () => {
  // Three of the five WERE translated. The stored Spanish is current, so it is
  // shown — the heuristic only speaks when there is nothing stored.
  const withEs = Object.assign({}, BILINGUAL, {
    title_es: 'Política de Conservación de Energía',
    body_es: '# Propósito\n\nEsta política garantiza...',
  });
  withEs.es_source_hash = T.sourceHash(withEs.title, withEs.body_md);
  assert.strictEqual(T.translationState(withEs), 'ok');
  assert.strictEqual(T.viewFor(withEs, 'es').lang, 'es');
});

t('an untranslated SOP falls back with a DIFFERENT reason', () => {
  // "not translated yet" and "out of date" read differently to somebody
  // standing in a plant room.
  const v = T.viewFor(row({ body_es: null }), 'es');
  assert.strictEqual(v.lang, 'en');
  assert.strictEqual(v.fallback, 'not-translated');
});

t('asking for English always gets English, never a notice', () => {
  const v = T.viewFor(row(), 'en');
  assert.strictEqual(v.lang, 'en');
  assert.strictEqual(v.fallback, null);
  assert.ok(/Purpose/.test(v.body));
});

t('no language, or an unknown one, means Spanish', () => {
  assert.strictEqual(T.viewFor(row(), undefined).lang, 'es');
  assert.strictEqual(T.viewFor(row(), 'es-MX').lang, 'es');
});

// ---- the prompt ----------------------------------------------------------
t('the prompt names the things that must not be translated', () => {
  ['AppFolio', 'Ascent at Northgate', 'Erick Frey', 'WO 22425-1', 'J2-CV-26-008772']
    .forEach(k => assert.ok(T.SYSTEM.includes(k), 'the prompt never mentions ' + k));
  // Whitespace-tolerant: the prompt is assembled from wrapped lines, so these
  // rules straddle a newline and a plain match misses them.
  const flat = T.SYSTEM.replace(/\s+/g, ' ');
  assert.ok(/do NOT convert currencies/i.test(flat));
  assert.ok(/do NOT convert imperial to metric/i.test(flat));
  assert.ok(/the same heading levels/i.test(flat), 'Markdown structure is not pinned');
  // Case-insensitive: the rule is shouted now, after one "Marcala" slipped
  // through the first run. The counterexamples matter more than the word —
  // "use usted" alone is what produced the slip.
  assert.ok(/usted/i.test(flat));
  assert.ok(/never "Marcala"/i.test(flat), 'the prompt gives no counterexample');
});

t('the reply is parsed strictly, not guessed at', () => {
  const ok = T.parseTranslation('TITLE: Gestión de Garantías\n\n## Propósito\n\nTexto.');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.title, 'Gestión de Garantías');
  assert.ok(ok.body.startsWith('## Propósito'));
});

t('a reply in the wrong shape is REFUSED, not salvaged', () => {
  // A mis-split translation silently loses the first line of the procedure.
  ['Here is the translation:\nTITLE: X\n\nbody', 'no title line at all',
   'TITLE:\n\nbody', 'TITLE: X\n\n', ''].forEach(bad => {
    const r = T.parseTranslation(bad);
    assert.strictEqual(r.ok, false, 'accepted: ' + JSON.stringify(bad.slice(0, 40)));
    assert.ok(r.error);
  });
});

// ---- the structural check ------------------------------------------------
t('a translation that dropped steps is flagged', () => {
  const w = T.structureWarnings('- one\n- two\n- three', '- uno\n- dos');
  assert.ok(w.some(x => /list items: 3 in English, 2 in Spanish/.test(x)));
});

t('a faithful translation produces no warnings', () => {
  assert.deepStrictEqual(
    T.structureWarnings('## A\n- one `X` 30\n', '## A\n- uno `X` 30\n'), []);
});

t('a changed NUMBER is flagged — that is what a technician matches on', () => {
  const w = T.structureWarnings('Over $500 within 30 days', 'Más de $500');
  assert.ok(w.some(x => /numbers/.test(x)));
});

t('headings and code spans are counted too', () => {
  assert.ok(T.structureWarnings('# A\n## B', '# A').some(x => /headings/.test(x)));
  assert.ok(T.structureWarnings('`a` `b`', '`a`').some(x => /code spans/.test(x)));
});

// ---- cost ----------------------------------------------------------------
t('a cost is reported, not a token count', () => {
  const c = T.costOf('claude-sonnet-4-6', 1e6, 1e6);
  assert.strictEqual(c, 3 + 15);
  assert.strictEqual(T.costOf('some-unknown-model', 1, 1), null);
});

// ---- the payload the page gets -------------------------------------------
t('the SERVER decides whether the Spanish is current, not the page', () => {
  const p = SOPP.docPayload(Object.assign({ slug: 'x', category: 'Maintenance', status: 'Needs Review' }, row()));
  assert.strictEqual(p.translationState, 'ok');
  assert.ok(p.es && /Propósito/.test(p.es.body));
  assert.ok(p.en && /Purpose/.test(p.en.body));
});

t('a stale row is sent with NO Spanish at all', () => {
  // Not sent-and-hidden: text the page never receives cannot be rendered by a
  // later bug.
  const p = SOPP.docPayload(Object.assign({ slug: 'x' }, row({ body_md: 'changed' })));
  assert.strictEqual(p.translationState, 'stale');
  assert.strictEqual(p.es, null);
});

t('the index carries a Spanish title per SOP, so one gap is one gap', () => {
  const g = SOPP.groupForIndex([
    { slug: 'a', title: 'A', title_es: 'Á', category: 'Maintenance' },
    { slug: 'b', title: 'B', title_es: null, category: 'Maintenance' },
  ]);
  const sops = g[0].sops;
  assert.strictEqual(sops.find(s => s.slug === 'a').title_es, 'Á');
  assert.strictEqual(sops.find(s => s.slug === 'b').title_es, null);
});

// ---- the thing that must never happen ------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const IDX = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-index.html'), 'utf8');
const DOC = fs.readFileSync(path.join(__dirname, '..', 'public', 'tools', 'sop-public-doc.html'), 'utf8');

t('THE PUBLIC ROUTES CANNOT CALL THE API', () => {
  // A GET that can trigger a paid request is a GET anybody can bill us with.
  const i = SERVER.indexOf('const SOPP = require');
  const j = SERVER.indexOf('// REBRAND LEADERSHIP REVIEW');
  const block = SERVER.slice(i, j);
  ['anthropic', 'ANTHROPIC_API_KEY', 'sop-translate', 'translate(']
    .forEach(bad => assert.ok(!block.includes(bad), 'the public SOP block references ' + bad));
});

t('only the script writes a translation', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'translate-sops.js'), 'utf8');
  assert.ok(/api\.anthropic\.com/.test(script));
  assert.ok(/body_es:/.test(script) && /es_source_hash:/.test(script));
  // Dry run by default: a script that spends money on import is a script
  // somebody runs by accident.
  assert.ok(/const WRITE = process\.argv\.includes\('--write'\)/.test(script));
  assert.ok(/DRY RUN/.test(script));
});

t('the hash stored is of the English the translation was MADE from', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'translate-sops.js'), 'utf8');
  assert.ok(/es_source_hash: T\.sourceHash\(r\.title, r\.body_md\)/.test(script),
    'the hash must come from the row that was sent, not from a re-read');
});

// ---- the pages -----------------------------------------------------------
t('Spanish is the default on both pages', () => {
  [IDX, DOC].forEach(p => {
    assert.ok(/<html lang="es">/.test(p));
    assert.ok(/var LANG = 'es';/.test(p), 'the default is not Spanish');
    assert.ok(/data-lang="es" aria-pressed="true"/.test(p), 'the Spanish button is not preselected');
  });
});

t('the choice is remembered per browser, and storage failing is survivable', () => {
  [IDX, DOC].forEach(p => {
    assert.ok(/localStorage\.setItem\('metricSopLang'/.test(p));
    assert.ok(/try \{ if \(localStorage\.getItem\('metricSopLang'\)/.test(p));
  });
});

t('the machine-translation line is on the Spanish version', () => {
  assert.ok(/Traducción automática\. Si algo no se entiende o no coincide con lo que haces/.test(DOC));
  assert.ok(/avísale a Erick/.test(DOC));
});

t('the needs-review label survives in both languages', () => {
  assert.ok(/falta revisar/.test(IDX) && /needs review/.test(IDX));
  assert.ok(/falta revisar/.test(DOC) && /needs review/.test(DOC));
});

t('the fallback says WHICH of the three reasons it was', () => {
  assert.ok(/todavía no está traducido/.test(DOC), 'no "not translated yet" message');
  assert.ok(/El texto en inglés cambió después de la traducción/.test(DOC), 'no "out of date" message');
  assert.ok(/Documento en inglés y español/.test(DOC), 'no "written in both languages" message');
  assert.ok(/translationState === 'bilingual'/.test(DOC), 'the page never checks for the bilingual state');
});

t('the index labels a bilingual SOP as such, not as untranslated', () => {
  assert.ok(/bilingual: 'inglés y español'/.test(IDX));
  assert.ok(/s\.bilingual \? t\.bilingual : t\.untranslated/.test(IDX),
    'the index shows "en inglés" for a document that already has Spanish in it');
});

t('the index reads the body to decide, and never sends it', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sop-public.js'), 'utf8');
  assert.ok(/LIST_COLUMNS = '[^']*body_md'/.test(lib), 'the index cannot tell bilingual from untranslated');
  assert.ok(/T\.isBilingualSource\(r\.title, r\.body_md\)/.test(lib));
  // groupForIndex builds a new object per SOP, so the body cannot ride along.
  const g = SOPP.groupForIndex([{ slug: 'x', title: 'X', category: 'M', body_md: 'SECRET' }]);
  assert.ok(!JSON.stringify(g).includes('SECRET'), 'the body leaked into the index payload');
});

t('an English reader gets no translation notice', () => {
  // They are looking at the source of record; there is nothing to warn about.
  const i = DOC.indexOf('en: {');
  const block = DOC.slice(i, i + 700);
  assert.ok(/machine: ''/.test(block));
  assert.ok(/notTranslated: ''/.test(block));
});

t('the Markdown renderer survived the rewrite, escaping first', () => {
  const m = DOC.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sandbox = {};
  const src = m.slice(m.indexOf('var esc =')).replace(/\n\s*function chrome\(\)[\s\S]*$/, '');
  // The slice includes the ?lang= sniff, which touches window.location. Stub
  // it rather than trim the block further: md() has to be lifted together with
  // the esc() it depends on, and hand-trimming is how a test quietly stops
  // testing the file it claims to.
  const win = { location: { search: '' } };
  const store = { getItem: () => null, setItem: () => {} };
  // NOT named 'S': the page declares its own `var S` for the UI strings, which
  // shadows the parameter, so md() ended up attached to the wrong object.
  new Function('__OUT', 'window', 'localStorage', src + '\n__OUT.md = md;')(sandbox, win, store);
  const out = sandbox.md('## Propósito\n\n- Revisar <script>alert(1)</script>\n');
  assert.ok(!/<script>/.test(out));
  assert.ok(/&lt;script&gt;/.test(out));
  assert.ok(/<h3>/.test(out) && /<li>/.test(out));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
