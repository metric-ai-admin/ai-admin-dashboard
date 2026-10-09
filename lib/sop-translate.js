// Spanish SOPs for the maintenance technicians — the rules, with no I/O.
//
// Pure, same as vacancy-rules.js and weekly-brief.js: the prompt, the hash and
// the staleness test live here where a test can reach them, and the API call
// and the writes live in scripts/translate-sops.js.
//
// THE TRANSLATION IS NEVER MADE DURING A VISIT. The public pages read
// sop_documents.body_es and nothing else; a GET that can call a paid API is a
// GET anybody can bill us with. The script writes, the page reads.

'use strict';

const crypto = require('crypto');

// What a translation is OF.
//
// The title and the body together, because a SOP can be retitled without its
// steps changing and the heading on the printed page would then be in the
// wrong language. Normalised line endings so a file saved on Windows does not
// invalidate every translation at once.
function sourceHash(title, body) {
  const norm = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
  return crypto.createHash('sha256')
    .update(norm(title) + '\n\u0000\n' + norm(body))
    .digest('hex');
}

// Some of the SOPs were WRITTEN bilingual: English and Spanish side by side in
// the same document, heading by heading. Five of the 33, including the two
// longest. Translating one produces a Spanish version of a document that is
// already half Spanish, so they are left alone — and a page that then says
// "not translated yet" is wrong in a way that matters: the reader is looking
// at a document that already has his language in it.
//
// MEASURED, NOT GUESSED. Across all 33 the separation is absolute: five score
// 31 to 120 accented characters and 7.2% to 12.2% Spanish function words, the
// next one scores 2 and 0.1%, and the remaining 27 score zero. Any threshold
// between those two clusters gives the same answer, which is why a heuristic
// is safe here and would not be on a borderline distribution.
const ES_CHARS = /[áéíóúñ¿¡Á-Ú]/g;
const ES_WORDS = /\b(?:el|la|los|las|del|para|con|por|que|una|este|esta|debe|será|deberá|cuando|todos|cada|sobre|desde|hasta)\b/gi;
function isBilingualSource(title, body) {
  const t = String(title || '') + '\n' + String(body || '');
  const words = (t.match(/\b[\wáéíóúñ]+\b/gi) || []).length;
  if (!words) return false;
  const accents = (t.match(ES_CHARS) || []).length;
  const rate = (t.match(ES_WORDS) || []).length / words;
  // THE RATE IS THE SIGNAL; the accent count only guards against an English
  // document that happens to contain a Spanish brand or street name.
  //
  // Measured over all 33: the five bilingual ones score 7.13% to 12.16%, the
  // next one scores 0.13% and the other 27 score zero. A 3% line sits in a gap
  // twenty times wider than it needs to be. An absolute accent threshold was
  // tried first and rejected — it is biased against SHORT bilingual documents,
  // which score the same rate but accumulate fewer accented characters.
  return rate > 0.03 && accents > 3;
}

// Is the stored Spanish still a translation of the English that is there now?
//
// Three different answers, and they are not the same thing:
//   'missing'  never translated
//   'stale'    translated, but the English has changed since
//   'ok'       current
function translationState(row) {
  const r = row || {};
  if (!r.body_es || !String(r.body_es).trim()) {
    // Checked BEFORE 'missing': a document written in both languages is not
    // waiting for a translation.
    return isBilingualSource(r.title, r.body_md) ? 'bilingual' : 'missing';
  }
  if (!r.es_source_hash) return 'stale';         // translated before hashes existed
  return r.es_source_hash === sourceHash(r.title, r.body_md) ? 'ok' : 'stale';
}

// A bilingual original needs nothing: translating it would double its Spanish.
const needsTranslation = row => {
  const s = translationState(row);
  return s !== 'ok' && s !== 'bilingual';
};

// What the page should show: Spanish when it is current, English otherwise,
// and always a reason when it falls back so the reader is not left wondering
// which language they are looking at.
function viewFor(row, lang) {
  const r = row || {};
  const state = translationState(r);
  const wantEs = String(lang || 'es').toLowerCase().startsWith('es');
  if (!wantEs) return { lang: 'en', title: r.title, body: r.body_md, state, fallback: null };
  if (state === 'ok') return { lang: 'es', title: r.title_es, body: r.body_es, state, fallback: null };
  return {
    lang: 'en',
    title: r.title,
    body: r.body_md,
    state,
    // Three cases, and they read differently to somebody standing in a plant
    // room: it was never translated, it went out of date, or it already has
    // Spanish in it and there is nothing to wait for.
    fallback: state === 'bilingual' ? 'bilingual'
      : state === 'missing' ? 'not-translated' : 'outdated',
  };
}

// ---- the prompt -----------------------------------------------------------
//
// Written as rules rather than as a request, because the failure that matters
// is not a clumsy sentence — it is a translated part number, a converted
// measurement or a reformatted list that a technician then cannot match
// against the thing in his hand.
const SYSTEM = [
  'You translate maintenance standard operating procedures from English into',
  'Latin American Spanish, for apartment maintenance technicians in Austin, Texas.',
  '',
  'Return ONLY the translation. No preamble, no notes, no explanation of choices.',
  '',
  'KEEP EXACTLY AS THEY APPEAR IN THE ENGLISH, untranslated and unaltered:',
  '  - Proper names of people and companies (Erick Frey, Metric Property Management).',
  '  - Product, software and brand names (AppFolio, SimpleVoIP, WebWork, Asana, Teams).',
  '  - Property names (Ascent at Northgate, Hyde Park Square, iConic Downtown).',
  '  - All numbers, amounts, dates, percentages and units of measure. Do NOT convert',
  '    currencies, do NOT convert imperial to metric, do NOT reformat dates.',
  '  - Unit and work-order codes (3-216, WO 22425-1, J2-CV-26-008772), model and part',
  '    numbers, and anything that looks like an identifier.',
  '  - Tool, part and material names with no settled Spanish equivalent. When a term',
  '    is commonly said in English on site, keep the English and put a short Spanish',
  '    gloss in parentheses the first time it appears.',
  '',
  'FORMAT: return Markdown with EXACTLY the same structure as the English —',
  'the same heading levels, the same list markers, the same order, the same',
  'number of items, the same code spans and tables. Translate the text inside',
  'the structure and change nothing else.',
  '',
  'TONE: plain, direct, instructional. Short sentences. This is read on a phone,',
  'often in a hurry, by somebody doing the job right now.',
  '',
  'USE "USTED" THROUGHOUT, in every single instruction, with no exceptions.',
  'Write "Marque", "Revise", "Ingrese", "Asegurese" — never "Marcala", "Revisa",',
  '"Ingresa" or "Asegurate". One informal verb in a document otherwise addressed',
  'formally reads as the procedure talking down to the technician.',
].join('\n');

function userPrompt(title, body) {
  return 'Translate this standard operating procedure.\n\n'
    + 'Return the translated TITLE on the first line, prefixed exactly with "TITLE: ",\n'
    + 'then a blank line, then the translated body in Markdown.\n\n'
    + '--- TITLE ---\n' + String(title || '') + '\n\n'
    + '--- BODY ---\n' + String(body || '');
}

// Pull the title and body back out. The model is asked for one shape; this
// accepts it and refuses anything else rather than guessing, because a
// mis-split translation silently loses the first line of the procedure.
function parseTranslation(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  const m = /^TITLE:[ \t]*(.+)$/m.exec(raw);
  if (!m || raw.indexOf(m[0]) !== 0) {
    return { ok: false, error: 'the reply did not start with a TITLE: line' };
  }
  const title = m[1].trim();
  const body = raw.slice(m[0].length).replace(/^\n+/, '');
  if (!title) return { ok: false, error: 'empty title' };
  if (!body.trim()) return { ok: false, error: 'empty body' };
  return { ok: true, title, body };
}

// A cheap structural check before anything is stored. It cannot tell whether
// the Spanish is GOOD, but it can tell when the shape was not preserved — and
// a translation that dropped half the steps is worse than no translation.
function structureWarnings(en, es) {
  const count = (s, re) => (String(s || '').match(re) || []).length;
  const out = [];
  const pairs = [
    ['headings', /^#{1,6}\s+/gm],
    ['list items', /^\s*(?:[-*+]|\d+[.)])\s+/gm],
    ['tables rows', /^\s*\|.*\|\s*$/gm],
    ['code spans', /`[^`\n]+`/g],
  ];
  pairs.forEach(([what, re]) => {
    const a = count(en, re), b = count(es, re);
    if (a !== b) out.push(`${what}: ${a} in English, ${b} in Spanish`);
  });
  // Numbers are the thing a technician matches against reality.
  const nums = s => (String(s || '').match(/\d+(?:[.,]\d+)?/g) || []);
  const an = nums(en), bn = nums(es);
  if (an.length !== bn.length) out.push(`numbers: ${an.length} in English, ${bn.length} in Spanish`);
  return out;
}

// Anthropic's published prices, per MILLION tokens, for the model this uses.
// Stated here so the script can report a cost instead of a token count, and
// so a price change is one line rather than arithmetic in three places.
const PRICES = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
};
function costOf(model, inTokens, outTokens) {
  const p = PRICES[model];
  if (!p) return null;
  return (inTokens / 1e6) * p.in + (outTokens / 1e6) * p.out;
}

module.exports = {
  SYSTEM, PRICES,
  isBilingualSource,
  sourceHash, translationState, needsTranslation, viewFor,
  userPrompt, parseTranslation, structureWarnings, costOf,
};
