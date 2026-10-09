#!/usr/bin/env node
//
// Compare one translated SOP against its English original. READ ONLY.
//
//   node scripts/check-sop-translation.js <slug> [--full]
//   node scripts/check-sop-translation.js --all
//
// Answers the only question that matters about a machine translation nobody
// will proofread end to end: did anything GO MISSING. Structure counts,
// numbers, headings and list items are compared item by item; --full prints
// both texts side by side.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const T = require('../lib/sop-translate.js');
const SOPP = require('../lib/sop-public.js');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const ARG = process.argv.slice(2).filter(a => !a.startsWith('--'));
const FULL = process.argv.includes('--full');
const ALL = process.argv.includes('--all');

// Is this English text actually bilingual already? Two independent signals,
// because either alone is noise: Spanish-only characters, and Spanish function
// words that do not appear in English technical writing.
const ES_CHARS = /[áéíóúñ¿¡Á-Ú]/g;
const ES_WORDS = /\b(?:el|la|los|las|del|para|con|por|que|una|este|esta|debe|será|deberá|si|cuando|todos|cada)\b/gi;
function bilingualScore(text) {
  const t = String(text || '');
  const words = (t.match(/\b\w+\b/g) || []).length || 1;
  return {
    accents: (t.match(ES_CHARS) || []).length,
    esWords: (t.match(ES_WORDS) || []).length,
    esWordRate: (t.match(ES_WORDS) || []).length / words,
    words,
  };
}

const headings = s => (String(s || '').match(/^#{1,6}\s+(.*)$/gm) || []).map(h => h.replace(/^#+\s*/, '').trim());
const bullets = s => (String(s || '').match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm) || []).map(b => b.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim());
// Trailing punctuation stripped: "$300," and "$300 " are the same figure, and
// reporting one as lost and the other as invented is noise that hides a real
// difference.
const numbers = s => (String(s || '').match(/\$?\d[\d.,]*\s?%?/g) || [])
  .map(x => x.trim().replace(/[.,]+$/, ''));

function tally(a) {
  const m = new Map();
  a.forEach(x => m.set(x, (m.get(x) || 0) + 1));
  return m;
}
// Numbers present in English and absent from Spanish, counted. The reverse too:
// a number the translation INVENTED is as bad as one it dropped.
function numberDiff(en, es) {
  const A = tally(numbers(en)), B = tally(numbers(es));
  const lost = [], added = [];
  A.forEach((n, k) => { const b = B.get(k) || 0; if (b < n) lost.push(k + ' ×' + (n - b)); });
  B.forEach((n, k) => { const a = A.get(k) || 0; if (a < n) added.push(k + ' ×' + (n - a)); });
  return { lost, added };
}

// Informal "tu" forms in a document that is meant to be "usted" throughout.
//
// One slipped through the first run — "Marcala" in the 7-Day Turn Process.
// Worth checking by machine rather than by eye: it is the kind of thing that
// reads fine until a technician notices the SOP is talking down to him.
//
// SUBJECT-AWARE, because several of these verb forms are also the ordinary
// indicative for "usted" and for the third person. "Usted arma un carrito e
// INGRESA una orden" is correct Spanish agreeing with usted; "El residente
// INGRESA por la puerta" is third person. Only a verb with no subject before
// it in its own sentence is an imperative, and only an imperative can be the
// informal one.
const TU_FORMS = /\b(?:m[aá]rcal[ao]|h[aá]zlo|haz|rev[ií]sal[ao]|ponl[ao]|dile|av[ií]sale|an[oó]talo|ch[eé]calo|aseg[uú]rate|debes|tienes que|puedes|recuerda|usa|revisa|ingresa|anota|verifica)\b/gi;

// A subject standing before the verb in the same sentence: a pronoun, a
// determiner followed by a noun, or a NAME. After the verb it is an object
// ("Revise la lista") and says nothing about the subject, which is why
// position matters.
//
// Three more false positives came out of the live library and are handled
// below: "Karla revisa la lista" (a person as subject), "solo se anota" and
// "Si se verifica que..." (impersonal se). A Spanish imperative never takes a
// proclitic se — it is enclitic, "anotalo" — so se immediately before the verb
// rules an order out on its own.
const SUBJECT_BEFORE = /\b(?:usted(?:es)?|[ée]l|ella|ellos|ellas|nosotros|qui[eé]n(?:es)?|el|la|los|las|un|una|unos|unas|su|sus|este|esta|estos|estas|ese|esa|cada|todo|todos|toda|todas)\s+\S/i;

// The sentence a position falls in. Split on sentence punctuation, newlines and
// list markers, because a SOP is mostly fragments rather than prose.
function sentenceAround(text, index) {
  const before = String(text).slice(0, index);
  const after = String(text).slice(index);
  const startAt = Math.max(
    before.lastIndexOf('.'), before.lastIndexOf(':'), before.lastIndexOf(';'),
    before.lastIndexOf('\n'), before.lastIndexOf('—'), before.lastIndexOf('*')
  ) + 1;
  const endRel = after.search(/[.;:\n]/);
  return { prefix: before.slice(startAt), whole: before.slice(startAt) + (endRel < 0 ? after : after.slice(0, endRel)) };
}

function registerWarnings(es) {
  const text = String(es || '');
  const out = [];
  const re = new RegExp(TU_FORMS.source, 'gi');
  let m;
  while ((m = re.exec(text))) {
    const { prefix, whole } = sentenceAround(text, m.index);
    // A subject before it means indicative, not an order.
    if (SUBJECT_BEFORE.test(prefix)) continue;
    // Impersonal or passive se: "se anota", "si se verifica".
    if (/\bse\s*$/i.test(prefix)) continue;
    // A proper name as the subject: "Karla revisa la lista".
    if (/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+$/.test(prefix) && !/^[\s*>#-]*$/.test(prefix.replace(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+$/, ''))) continue;
    if (/^\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+$/.test(prefix)) continue;
    out.push({ word: m[0].toLowerCase(), sentence: whole.trim().replace(/\s+/g, ' ').slice(0, 110) });
  }
  // One entry per distinct word; the sentence is what makes it checkable.
  const seen = new Set();
  return out.filter(x => (seen.has(x.word) ? false : seen.add(x.word)));
}

function report(row) {
  const en = row.body_md || '', es = row.body_es || '';
  const be = bilingualScore(en);
  console.log('\n' + '='.repeat(74));
  console.log(row.slug);
  console.log('  EN title: ' + row.title);
  console.log('  ES title: ' + (row.title_es || '(none)'));
  console.log('  state   : ' + T.translationState(row));
  console.log('  size    : EN ' + en.length + '  ES ' + es.length
    + '   ratio ' + (en.length ? (es.length / en.length).toFixed(2) : '—'));

  console.log('\n  IS THE ENGLISH ALREADY BILINGUAL?');
  console.log('    accented chars in EN body : ' + be.accents);
  console.log('    Spanish function words    : ' + be.esWords + '  (' + (be.esWordRate * 100).toFixed(1) + '% of words)');
  const likely = be.accents > 15 && be.esWordRate > 0.03;
  console.log('    verdict                   : ' + (likely ? 'YES — the English column already contains Spanish'
    : 'no — it reads as English only'));

  const hEn = headings(en), hEs = headings(es);
  const bEn = bullets(en), bEs = bullets(es);
  console.log('\n  STRUCTURE   headings ' + hEn.length + ' / ' + hEs.length
    + '    bullets ' + bEn.length + ' / ' + bEs.length);

  const tu = registerWarnings(es);
  console.log('  REGISTER    informal "tu" forms: ' + (tu.length ? tu.map(x => x.word).join(', ') + '   <-- should be "usted"' : 'none'));
  tu.forEach(x => console.log('                "' + x.sentence + '"'));

  const nd = numberDiff(en, es);
  console.log('  NUMBERS     lost from the translation: ' + (nd.lost.length ? nd.lost.join(', ') : 'none'));
  console.log('              invented by it           : ' + (nd.added.length ? nd.added.join(', ') : 'none'));

  // If the English is bilingual, half its headings ARE the Spanish ones, so a
  // 2:1 ratio is the expected result rather than a loss. Say which it is.
  if (likely && hEn.length >= hEs.length * 1.6) {
    console.log('\n  => the 2:1 counts are explained by the English already being bilingual:');
    console.log('     the Spanish version has one of each heading, not half of them.');
  }

  if (hEn.length !== hEs.length) {
    console.log('\n  HEADINGS, in order:');
    const n = Math.max(hEn.length, hEs.length);
    for (let i = 0; i < n; i++) {
      console.log('    ' + String(i + 1).padStart(2) + '  EN: ' + (hEn[i] || '—').slice(0, 58));
      console.log('        ES: ' + (hEs[i] || '—').slice(0, 58));
    }
  }
  if (FULL) {
    console.log('\n  --- ENGLISH ---\n' + en);
    console.log('\n  --- SPANISH ---\n' + es);
  }
}

(async () => {
  const cols = 'slug,title,body_md,title_es,body_es,es_source_hash';
  const { data, error } = await SOPP.scope(db.from('sop_documents').select(cols));
  if (error) throw new Error(error.message);
  const rows = data || [];
  const want = ALL ? rows : rows.filter(r => ARG.some(a => r.slug === a || r.slug.startsWith(a)));
  if (!want.length) {
    console.error('No match. Slugs:');
    rows.forEach(r => console.error('   ' + r.slug));
    process.exit(2);
  }
  want.forEach(report);
})().catch(e => { console.error(e.message); process.exit(1); });
