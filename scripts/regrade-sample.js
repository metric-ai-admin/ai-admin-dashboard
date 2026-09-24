#!/usr/bin/env node
//
// Re-grade already-graded calls with the CURRENT rubric and show before/after.
//
//   ANTHROPIC_API_KEY=<key> node scripts/regrade-sample.js --date 2026-09-22 --n 15
//   ANTHROPIC_API_KEY=<key> node scripts/regrade-sample.js --date 2026-09-22 --n 15 --write-csv
//
// The key is read from the environment and never printed.
//
// READ-ONLY AGAINST call_grades. Nothing here writes a grade back — the stored
// grades stay exactly as the nightly run left them, so a comparison run can
// never quietly become a regrade of the record.
//
// WHAT IT CONTROLS FOR. The model is not deterministic, so "stored grade vs new
// grade" conflates two different things: the rubric change, and ordinary
// run-to-run variance. Each call is therefore graded ONCE here with the current
// prompt, and compared against BOTH the stored grade and the other calls in the
// same run. If you want a true A/B, run this on the commit before the rubric
// change and again after, and compare the two runs — same calls, same sampling.
//
// Sampling is deterministic: calls are sorted by recording_id and taken evenly
// spaced across the batch, so two runs see the same calls and the sample is not
// biased toward whatever happens to sort first.

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const DATE = arg('date', null);
const N = Number(arg('n', 15));
const WRITE_CSV = process.argv.includes('--write-csv');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set in this shell.');
  console.error('Run as:  ANTHROPIC_API_KEY=<key> node scripts/regrade-sample.js --date 2026-09-22 --n 15');
  process.exit(2);
}

const grading = require(path.join(__dirname, '..', 'call-grading.js'));
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F', 'N/S'];
const gradeOf = g => (g.not_scoreable ? 'N/S' : String(g.overall_grade || '?'));

function distribution(rows, pick) {
  const d = Object.fromEntries(GRADE_ORDER.map(g => [g, 0]));
  rows.forEach(r => { const g = pick(r); if (d[g] !== undefined) d[g]++; });
  return d;
}
const mean = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

(async () => {
  // Pick the batch.
  let q = db.from('call_grades')
    .select('recording_id,agent_name,call_date,overall_grade,overall_score,not_scoreable,categories')
    .limit(1000);
  if (DATE) q = q.eq('call_date', DATE);
  else q = q.gte('call_date', '2026-09-01');
  const { data: stored, error } = await q;
  if (error) throw new Error(error.message);
  if (!stored.length) throw new Error('no graded calls found' + (DATE ? ' for ' + DATE : ''));

  const day = DATE || stored.map(r => r.call_date).sort().pop();
  const batch = stored.filter(r => r.call_date === day).sort((a, b) => a.recording_id.localeCompare(b.recording_id));
  console.log(`batch: ${day} — ${batch.length} graded (${batch.filter(r => !r.not_scoreable).length} scored)`);

  // Evenly spaced sample, deterministic.
  const step = Math.max(1, Math.floor(batch.length / N));
  const sample = [];
  for (let i = 0; i < batch.length && sample.length < N; i += step) sample.push(batch[i]);
  console.log(`sampling ${sample.length} of them, evenly spaced\n`);

  // Transcripts.
  const ids = sample.map(r => r.recording_id);
  const tx = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from('simplevoip_daily_calls')
      .select('recording_id,transcript,caller,call_direction,duration,user_name')
      .in('recording_id', ids.slice(i, i + 100));
    (data || []).forEach(r => { tx[r.recording_id] = r; });
  }

  const results = [];
  for (const [i, r] of sample.entries()) {
    const call = tx[r.recording_id];
    if (!call || !call.transcript) {
      console.log(`  ${String(i + 1).padStart(2)}/${sample.length}  ${r.recording_id.slice(-8)}  SKIPPED — no transcript`);
      continue;
    }
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${sample.length}  ${String(r.agent_name || '?').padEnd(16)} stored ${gradeOf(r).padEnd(3)} ${String(r.overall_score ?? '').padStart(3)}  → `);
    try {
      // gradeTranscript is the same entry point the nightly job uses, with the
      // same argument names — so this measures the rubric, not a second code
      // path that happens to look similar.
      const fresh = await grading.gradeTranscript({
        callType: call.call_direction,
        agent: r.agent_name,
        duration: call.duration,
        transcript: call.transcript,
      });
      const g = gradeOf(fresh);
      console.log(`new ${g.padEnd(3)} ${String(fresh.overall_score ?? '').padStart(3)}  (${(fresh.overall_score ?? 0) - (r.overall_score ?? 0) >= 0 ? '+' : ''}${(fresh.overall_score ?? 0) - (r.overall_score ?? 0)})`);
      results.push({ stored: r, fresh });
    } catch (e) {
      console.log(`ERROR ${e.message.slice(0, 60)}`);
    }
    await new Promise(res => setTimeout(res, 600));   // be kind to the rate limit
  }

  if (!results.length) { console.log('\nnothing graded.'); return; }

  const before = distribution(results.map(r => r.stored), gradeOf);
  const after = distribution(results.map(r => r.fresh), gradeOf);
  console.log('\nGRADE DISTRIBUTION');
  console.log('  grade   before   after   change');
  GRADE_ORDER.forEach(g => {
    const d = after[g] - before[g];
    console.log(`  ${g.padEnd(6)}  ${String(before[g]).padStart(5)}   ${String(after[g]).padStart(5)}   ${d === 0 ? '  —' : (d > 0 ? '+' : '') + d}`);
  });

  const sb = results.filter(r => !r.stored.not_scoreable).map(r => r.stored.overall_score || 0);
  const sa = results.filter(r => !r.fresh.not_scoreable).map(r => r.fresh.overall_score || 0);
  console.log(`\n  mean score   before ${mean(sb)}   after ${mean(sa)}   (${mean(sa) - mean(sb) >= 0 ? '+' : ''}${mean(sa) - mean(sb)})`);
  console.log(`  N/S          before ${before['N/S']}   after ${after['N/S']}`);

  // Which criteria stopped being zeroed — the most useful single view.
  const zeros = rows => {
    const z = {};
    rows.forEach(r => (Array.isArray(r.categories) ? r.categories : []).forEach(c =>
      (Array.isArray(c.items) ? c.items : []).forEach(it => {
        if (Number(it.score) === 0) { const k = String(it.label || '').slice(0, 52); z[k] = (z[k] || 0) + 1; }
      })));
    return z;
  };
  const zb = zeros(results.map(r => r.stored)), za = zeros(results.map(r => r.fresh));
  const keys = [...new Set([...Object.keys(zb), ...Object.keys(za)])]
    .map(k => ({ k, b: zb[k] || 0, a: za[k] || 0 }))
    .filter(x => x.a !== x.b).sort((x, y) => (y.b - y.a) - (x.b - x.a));
  if (keys.length) {
    console.log('\nCRITERIA SCORED ZERO — what moved');
    keys.slice(0, 15).forEach(x => console.log(`  ${String(x.b).padStart(3)} → ${String(x.a).padStart(3)}   ${x.k}`));
  }

  if (WRITE_CSV) {
    const fs = require('fs');
    const out = 'exports/regrade_' + day + '.csv';
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    fs.mkdirSync('exports', { recursive: true });
    fs.writeFileSync(out, ['recording_id,agent,stored_grade,stored_score,new_grade,new_score,delta']
      .concat(results.map(r => [r.stored.recording_id, r.stored.agent_name, gradeOf(r.stored),
        r.stored.overall_score, gradeOf(r.fresh), r.fresh.overall_score,
        (r.fresh.overall_score ?? 0) - (r.stored.overall_score ?? 0)].map(esc).join(','))).join('\n'));
    console.log('\nwrote ' + out + ' (gitignored)');
  }

  console.log('\nNothing was written to call_grades — the stored grades are unchanged.');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
