#!/usr/bin/env node
//
// Translates the Maintenance SOPs into Spanish, once each, and stores the
// result. The public pages read what this writes and never call an API
// themselves.
//
//   node scripts/translate-sops.js            # DRY RUN: what would be done
//   node scripts/translate-sops.js --write
//   node scripts/translate-sops.js --write --only <slug>
//   node scripts/translate-sops.js --write --force   # redo even if current
//
// Needs migration 084 and ANTHROPIC_API_KEY.
//
// WHAT IT SKIPS: anything whose stored hash still matches the English. Running
// it twice costs nothing the second time, which is what makes it safe to put
// on a schedule later.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const T = require('../lib/sop-translate.js');
const SOPP = require('../lib/sop-public.js');

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null; })();
const MODEL = process.env.SOP_TRANSLATE_MODEL || 'claude-sonnet-4-6';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// Our own call rather than call-grading's anthropicText, for one reason: that
// helper throws away `usage`, and a run that cannot say what it cost is a run
// nobody can approve the next one from.
async function translate(title, body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: T.SYSTEM,
      messages: [{ role: 'user', content: T.userPrompt(title, body) }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Anthropic ${r.status}`);
  const block = (j.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('no text in the reply');
  return {
    text: block.text,
    inTokens: (j.usage && j.usage.input_tokens) || 0,
    outTokens: (j.usage && j.usage.output_tokens) || 0,
  };
}

const fmtCost = c => c == null ? 'unknown' : '$' + c.toFixed(4);

(async () => {
  const sel = 'id,slug,title,body_md,title_es,body_es,es_source_hash,translated_at';
  const { data, error } = await SOPP.scope(db.from('sop_documents').select(sel));
  if (error) {
    if (/column .* does not exist/i.test(error.message)) {
      console.error('Migration 084 has not been run — the Spanish columns do not exist yet.');
      process.exit(2);
    }
    throw new Error(error.message);
  }
  let rows = data || [];
  if (ONLY) rows = rows.filter(r => r.slug === ONLY);

  const todo = rows.filter(r => FORCE || T.needsTranslation(r));
  const byState = {};
  rows.forEach(r => { const s = T.translationState(r); byState[s] = (byState[s] || 0) + 1; });

  console.log(`${SOPP.DEPARTMENT} SOPs published: ${rows.length}`);
  console.log('  state: ' + (Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
  console.log('  to translate: ' + todo.length + (FORCE ? '  (--force)' : ''));
  console.log('  model: ' + MODEL);

  if (!todo.length) { console.log('\nNothing to do.'); return; }
  if (!WRITE) {
    console.log('\nDRY RUN — nothing called, nothing written. Re-run with --write.');
    todo.slice(0, 40).forEach(r => console.log('   ' + T.translationState(r).padEnd(8) + r.slug));
    return;
  }

  const started = Date.now();
  let inTok = 0, outTok = 0, done = 0;
  const failed = [], warned = [];

  for (const r of todo) {
    const label = r.slug.slice(0, 44).padEnd(46);
    try {
      const out = await translate(r.title, r.body_md);
      inTok += out.inTokens; outTok += out.outTokens;

      const parsed = T.parseTranslation(out.text);
      if (!parsed.ok) { failed.push({ slug: r.slug, error: parsed.error }); console.log('  FAIL ' + label + parsed.error); continue; }

      const warnings = T.structureWarnings(r.body_md, parsed.body);
      if (warnings.length) warned.push({ slug: r.slug, warnings });

      // The hash is of the English THIS translation was made from, taken here
      // rather than at read time: if somebody edits the SOP while this runs,
      // the row is correctly marked stale instead of silently claiming to be
      // a translation of the new text.
      const { error: wErr } = await db.from('sop_documents').update({
        title_es: parsed.title,
        body_es: parsed.body,
        es_source_hash: T.sourceHash(r.title, r.body_md),
        translated_at: new Date().toISOString(),
        translated_by: MODEL,
      }).eq('id', r.id);
      if (wErr) { failed.push({ slug: r.slug, error: wErr.message }); console.log('  FAIL ' + label + wErr.message); continue; }

      done++;
      console.log('  ok   ' + label
        + String(out.inTokens).padStart(6) + ' in '
        + String(out.outTokens).padStart(6) + ' out'
        + (warnings.length ? '   ⚠ ' + warnings.join('; ') : ''));
    } catch (e) {
      failed.push({ slug: r.slug, error: e.message });
      console.log('  FAIL ' + label + e.message);
    }
  }

  const secs = (Date.now() - started) / 1000;
  const cost = T.costOf(MODEL, inTok, outTok);
  console.log('\n' + '-'.repeat(64));
  console.log('translated : ' + done + ' of ' + todo.length);
  console.log('failed     : ' + failed.length);
  console.log('tokens     : ' + inTok.toLocaleString() + ' in, ' + outTok.toLocaleString() + ' out');
  console.log('cost       : ' + fmtCost(cost)
    + (cost != null ? '   (' + fmtCost(cost / Math.max(done, 1)) + ' per SOP)' : ''));
  console.log('time       : ' + secs.toFixed(1) + 's   (' + (secs / Math.max(done, 1)).toFixed(1) + 's per SOP)');

  if (warned.length) {
    console.log('\nSTRUCTURE WARNINGS — stored, but the shape does not match the English:');
    warned.forEach(w => console.log('   ' + w.slug + ': ' + w.warnings.join('; ')));
    console.log('   These are worth reading before the link goes out.');
  }
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach(f => console.log('   ' + f.slug + ': ' + f.error));
  }
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
