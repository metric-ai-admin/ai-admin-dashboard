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
const numbers = s => (String(s || '').match(/\$?\d[\d.,]*\s?%?/g) || []).map(x => x.trim());

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
