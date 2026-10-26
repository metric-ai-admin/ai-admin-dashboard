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
// MEASURING ONLY. Pins sampling so two runs of one transcript can be compared
// without run-to-run noise in the way. Absent by default, and it reaches only
// this script: nothing in the nightly path passes it, and
// test/grading-temperature.test.js asserts that.
//
// '0' must survive: Number('0') is 0 and 0 is falsy, so a `|| undefined`
// anywhere here would silently drop the one value the test exists to send.
const tempAt = process.argv.indexOf('--temperature');
const TEMPERATURE = tempAt > -1 && process.argv[tempAt + 1] !== undefined
  && !String(process.argv[tempAt + 1]).startsWith('--')
  ? Number(process.argv[tempAt + 1]) : undefined;
if (tempAt > -1 && (TEMPERATURE === undefined || Number.isNaN(TEMPERATURE))) {
  console.error('--temperature needs a number, e.g. --temperature 0');
  process.exit(2);
}
// Restrict to calls that actually carry a score. The default is everything,
// because a rubric change can move a call ACROSS the N/S line in either
// direction and that is worth seeing — but "the 55 scored calls" is the usual
// ask, and asking for it should not silently return 55 of the 69 including N/S.
const SCORED_ONLY = process.argv.includes('--scored-only');
const DRY_RUN = process.argv.includes('--dry-run');
// OVERWRITES the stored grades. Off unless asked for, and it takes a backup
// first — see writeGrades() below.
const WRITE_GRADES = process.argv.includes('--write-grades');

// A flag this script does not recognise is an ERROR, not something to ignore.
// On 2026-09-25 a run was launched with --write-grades before that flag
// existed: the script accepted it, spent eight minutes and the API budget, and
// reported success having written nothing. Silence is the worst possible
// response to "do the dangerous thing".
// An explicit list of calls to regrade, comma-separated. For re-running the
// handful a batch dropped — four calls on 2026-09-22 failed with malformed JSON
// and kept their old grades, and re-running the whole day to catch four is both
// expensive and another 51 needless overwrites.
const idsAt = process.argv.indexOf('--recording-ids');
const RECORDING_IDS = idsAt > -1
  ? String(process.argv[idsAt + 1] || '').split(',').map(x => x.trim()).filter(Boolean)
  : null;
if (idsAt > -1 && (!RECORDING_IDS || !RECORDING_IDS.length)) {
  console.error('--recording-ids needs a comma-separated list of recording_id values.');
  process.exit(2);
}

const KNOWN_FLAGS = ['--date', '--n', '--write-csv', '--scored-only', '--dry-run', '--write-grades', '--recording-ids', '--temperature'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN_FLAGS.includes(a));
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(', '));
  console.error('Known flags: ' + KNOWN_FLAGS.join(' '));
  process.exit(2);
}

if (!process.env.ANTHROPIC_API_KEY && !DRY_RUN) {
  console.error('ANTHROPIC_API_KEY is not set in this shell.');
  console.error('Run as:  ANTHROPIC_API_KEY=<key> node scripts/regrade-sample.js --date 2026-09-22 --n 15');
  process.exit(2);
}

// The one definition of what a grade is worth, shared with server.js.
const SCORE = require('../lib/call-score.js');
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
    // rubric_applied, agent_role and call_type ride along so the run can be
    // compared against the stored routing. They were missing, so
    // `r.rubric_applied` was undefined on every row and "ROUTE CHANGED" fired
    // on all twenty — a column dropped from a projection reads exactly like a
    // value that changed.
    .select('recording_id,agent_name,call_date,overall_grade,overall_score,not_scoreable,'
      + 'categories,rubric_applied,agent_role,call_type')
    .limit(1000);
  if (DATE) q = q.eq('call_date', DATE);
  else q = q.gte('call_date', '2026-09-01');
  const { data: stored, error } = await q;
  if (error) throw new Error(error.message);
  if (!stored.length) throw new Error('no graded calls found' + (DATE ? ' for ' + DATE : ''));

  const day = DATE || stored.map(r => r.call_date).sort().pop();
  const wholeDay = stored.filter(r => r.call_date === day).sort((a, b) => a.recording_id.localeCompare(b.recording_id));
  let batch = SCORED_ONLY ? wholeDay.filter(r => !r.not_scoreable) : wholeDay;
  if (RECORDING_IDS) {
    // Named calls are named: --scored-only and --n do not get to filter them
    // out underneath the operator, and an id that is not in the day is an
    // error rather than a silently shorter run.
    const byId = Object.fromEntries(wholeDay.map(r => [r.recording_id, r]));
    const missing = RECORDING_IDS.filter(id => !byId[id]);
    if (missing.length) {
      throw new Error(`--recording-ids: not found in ${day}: ${missing.join(', ')}`);
    }
    batch = RECORDING_IDS.map(id => byId[id]);
  }
  console.log(`batch: ${day} — ${wholeDay.length} graded (${wholeDay.filter(r => !r.not_scoreable).length} scored, ${wholeDay.filter(r => r.not_scoreable).length} N/S)`);
  if (SCORED_ONLY) console.log('--scored-only: N/S calls excluded');

  // Take everything when asked for at least as many as there are. Spacing only
  // applies to a genuine SAMPLE; applied to a full run it would silently drop
  // the tail of the batch.
  let sample;
  if (RECORDING_IDS) {
    sample = batch;
    console.log(`--recording-ids: ${sample.length} named call(s), --n ignored
`);
  } else if (!Number.isFinite(N) || N >= batch.length) {
    sample = batch;
    console.log(`running the FULL batch: ${sample.length} calls\n`);
  } else {
    const step = Math.max(1, Math.floor(batch.length / N));
    sample = [];
    for (let i = 0; i < batch.length && sample.length < N; i += step) sample.push(batch[i]);
    console.log(`sampling ${sample.length} of ${batch.length}, evenly spaced\n`);
  }

  // Say what this will cost before spending it — 55 calls is real money and
  // roughly ten minutes, and a typo in --date should not discover that.
  if (WRITE_GRADES) {
    console.log('*** --write-grades: the stored grades for these calls WILL BE OVERWRITTEN ***');
    console.log('    A backup goes to exports/, and the prior rows are saved to');
    console.log('    call_grades_history (migration 060) before anything is written.\n');
  }
  console.log(`this will make ${sample.length} model call(s) at ~6k max output tokens each`);
  console.log(`expect roughly ${Math.ceil(sample.length * 8 / 60)}-${Math.ceil(sample.length * 15 / 60)} minutes\n`);
  if (DRY_RUN) {
    console.log('--dry-run: stopping before any model call.');
    console.log('first five calls that would be graded:');
    sample.slice(0, 5).forEach(r => console.log(`  ${r.recording_id}  ${r.agent_name}  stored ${r.not_scoreable ? 'N/S' : r.overall_grade + ' ' + r.overall_score}`));
    return;
  }

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
        temperature: TEMPERATURE,
      });
      // THE NUMBER PRODUCTION WOULD STORE, not the one the model reports
      // about itself. Until 2026-10-26 this printed fresh.overall_score, the
      // model's holistic total — which server.js discards in favour of the
      // weighted breakdown, and which can be wildly out: one call here
      // self-reported 0 against a breakdown that computes 45. Read beside the
      // stored (computed) grades, that looked like grading had changed. It had
      // not; the two columns were different quantities.
      //
      // The N/S rule comes with it: two calls were stored Not Scoreable by the
      // flag route ("Suspected agent mismatch"), which this script did not
      // apply, so they appeared to have gained a score.
      const v = SCORE.verdict(fresh);
      fresh.overall_score = v.score;
      fresh.overall_grade = v.grade;
      fresh.not_scoreable = v.notScoreable;
      fresh.not_scoreable_reason = v.reason;
      fresh.flags = v.flags;
      // Kept for the CSV: what the model claimed about itself, beside what its
      // own breakdown produces. The gap is the drift signal.
      fresh.__modelScore = v.modelScore;
      const g = gradeOf(fresh);
      // What the call cost, beside what it scored. A cache that silently does
      // nothing produces identical grades and a 1.25x bill, so the only place
      // the difference is visible is here.
      const u = grading.lastGradeUsage();
      const cost = u
        ? `  [${u.cached} read=${u.cacheReadTokens} write=${u.cacheWriteTokens} out=${u.outputTokens}]`
        : '  [no usage]';
      // Said out loud rather than silently corrected: the gap between what the
      // model claimed and what its own breakdown produces is the signal that
      // the prompt is drifting, and it is the reason this script used to
      // disagree with production.
      const drift = (!v.notScoreable && v.computed && v.modelScore !== null
        && Math.abs(v.modelScore - v.score) > 5)
        ? `  (model said ${v.modelScore})` : '';
      // ---- WHERE THE SCORE CAME FROM, not just what it was -------------------
      //
      // The computed score is earned / weight, and the DENOMINATOR is whatever
      // the model chose to emit. Within one rubric that floats hard on real
      // data: "B — Leasing Agent" shows 15 distinct total weights and category
      // counts from 5 to 22, and "Step 6 — Outbound Voicemail Standard" comes
      // back as 5 or as 100. So a score can move a long way between two runs
      // of the same call without any criterion being judged differently.
      //
      // Decomposed by holding one side still: the denominator-only part is what
      // the score would have been with the SAME earned points over the NEW
      // weight. The two parts do not sum to the whole — there is an interaction
      // term — so the residual is reported rather than quietly folded in.
      const brk = cats => {
        const a = Array.isArray(cats) ? cats : [];
        return {
          n: a.length,
          weight: a.reduce((s, c) => s + (Number(c.weight) || 0), 0),
          earned: a.reduce((s, c) => s + (Number(c.score) || 0), 0),
        };
      };
      const bs = brk(r.categories), bn = brk(fresh.categories);
      const pct = (e, w) => (w > 0 ? (100 * e / w) : null);
      const rawS = pct(bs.earned, bs.weight), rawN = pct(bn.earned, bn.weight);
      let denomOnly = null, numerOnly = null, residual = null, denomShare = null;
      if (rawS !== null && rawN !== null) {
        const total = rawN - rawS;
        denomOnly = pct(bs.earned, bn.weight) - rawS;   // numerator held still
        numerOnly = pct(bn.earned, bs.weight) - rawS;   // denominator held still
        residual = total - denomOnly - numerOnly;
        denomShare = Math.abs(total) > 0.5
          ? Math.round(100 * denomOnly / total) : null;
      }

      const route = [fresh.rubric_applied, fresh.agent_role, fresh.call_type]
        .map(x => (x == null ? '' : String(x)));
      // AND NOTHING IS CLAIMED WHEN THERE IS NOTHING TO COMPARE. Rows graded
      // before migration 055 carry no rubric_applied at all; against those,
      // "changed" would mean "the old row never recorded it", which is a
      // different statement and not one worth shouting on every line. The
      // run-vs-run comparison that answers the routing question properly is
      // scripts/regrade-compare.js, over two fresh runs.
      const storedRoute = (r.rubric_applied || '').trim();
      const routeChanged = storedRoute !== '' && (fresh.rubric_applied || '') !== storedRoute;
      const shape = `  [${bn.n}cat w=${bn.weight}`
        + (bs.weight !== bn.weight ? ` was ${bs.weight}` : '')
        + (denomShare !== null ? ` denom=${denomShare}%` : '')
        + ']' + (routeChanged ? '  ROUTE CHANGED' : '');

      console.log(`new ${g.padEnd(3)} ${String(fresh.overall_score ?? '').padStart(3)}  (${(fresh.overall_score ?? 0) - (r.overall_score ?? 0) >= 0 ? '+' : ''}${(fresh.overall_score ?? 0) - (r.overall_score ?? 0)})${drift}${shape}${cost}`);
      if (routeChanged) {
        console.log(`        rubric: ${r.rubric_applied || '—'}  ->  ${fresh.rubric_applied || '—'}`);
      }
      results.push({
        stored: r, fresh, usage: u, route,
        breakdown: { stored: bs, fresh: bn },
        decomposition: { denomOnly, numerOnly, residual, denomShare },
      });
    } catch (e) {
      console.log(`ERROR ${e.message.slice(0, 60)}`);
    }
    await new Promise(res => setTimeout(res, 600));   // be kind to the rate limit
  }

  if (!results.length) { console.log('\nnothing graded.'); return; }

  // ---- the cache verdict, stated rather than left to be eyeballed -------------
  //
  // The expected shape of a healthy batch: ONE write on the first call, a read
  // on every call after it. All-miss means the breakpoint is not working and
  // the run cost 1.25x for nothing.
  const used = results.map(r => r.usage).filter(Boolean);
  const reads = used.filter(u => u.cached === 'read').length;
  const writes = used.filter(u => u.cached === 'write').length;
  const misses = used.filter(u => u.cached === 'miss').length;
  const readTok = used.reduce((a, u) => a + u.cacheReadTokens, 0);
  const writeTok = used.reduce((a, u) => a + u.cacheWriteTokens, 0);
  const inTok = used.reduce((a, u) => a + u.inputTokens, 0);
  const outTok = used.reduce((a, u) => a + u.outputTokens, 0);
  console.log('\nPROMPT CACHE');
  console.log(`  calls ${used.length}   write ${writes}   read ${reads}   miss ${misses}`);
  console.log(`  tokens  cache_read ${readTok}   cache_write ${writeTok}   uncached_in ${inTok}   out ${outTok}`);
  if (!used.length) {
    console.log('  NO USAGE REPORTED — nothing can be concluded about the cache.');
  } else if (reads === 0) {
    console.log('  CACHE IS NOT WORKING. cache_read_input_tokens was 0 on every call.');
    console.log('  The grades are unaffected; the bill is 1.25x. Do not read this as a pass.');
  } else {
    // Priced at Sonnet 4.6: $3/MTok in, $3.75 write, $0.30 read.
    const cached = (writeTok * 3.75 + readTok * 0.30 + inTok * 3) / 1e6;
    const plain = ((readTok + writeTok + inTok) * 3) / 1e6;
    console.log(`  input cost this run  $${cached.toFixed(4)}  vs  $${plain.toFixed(4)} uncached`
      + `   (${Math.round((1 - cached / plain) * 100)}% less)`);
  }

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

  const moved = results.filter(r => gradeOf(r.stored) !== gradeOf(r.fresh));
  const up = moved.filter(r => GRADE_ORDER.indexOf(gradeOf(r.fresh)) < GRADE_ORDER.indexOf(gradeOf(r.stored)));
  console.log(`\n  GRADE CHANGED on ${moved.length} of ${results.length} calls — ${up.length} up, ${moved.length - up.length} down`);
  moved.forEach(r => console.log(`    ${String(r.stored.agent_name || '?').padEnd(16)} ${gradeOf(r.stored)} ${String(r.stored.overall_score ?? '').padStart(3)}  →  ${gradeOf(r.fresh)} ${String(r.fresh.overall_score ?? '').padStart(3)}`));

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
    // A UNIQUE NAME PER RUN. This was exports/regrade_<day>.csv, so the second
    // run of a two-run comparison overwrote the first — losing exactly the
    // file the comparison needs, silently, with a cheerful "wrote" line.
    const tag = (TEMPERATURE === undefined ? 'tdefault' : 't' + String(TEMPERATURE).replace('.', '_'));
    const out = 'exports/regrade_' + day + '_' + tag + '_'
      + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    fs.mkdirSync('exports', { recursive: true });
    // Enough to attribute a change, not just to see one: the routing the model
    // chose, the shape of the breakdown it produced, and how much of the move
    // came from the denominator alone.
    const header = 'recording_id,agent,stored_grade,stored_score,new_grade,new_score,delta,'
      + 'not_scoreable,ns_reason,rubric_applied,agent_role,call_type,'
      + 'cat_count,total_weight,earned,stored_cat_count,stored_total_weight,stored_earned,'
      + 'denom_only,numer_only,residual,denom_share_pct,model_self_score,temperature';
    fs.writeFileSync(out, [header]
      .concat(results.map(r => {
        const d = r.decomposition || {};
        const b = (r.breakdown || {}).fresh || {};
        const bs = (r.breakdown || {}).stored || {};
        const round = v => (v == null ? null : Math.round(v * 10) / 10);
        return [
          r.stored.recording_id, r.stored.agent_name, gradeOf(r.stored),
          r.stored.overall_score, gradeOf(r.fresh), r.fresh.overall_score,
          (r.fresh.overall_score ?? 0) - (r.stored.overall_score ?? 0),
          r.fresh.not_scoreable ? 'Y' : 'n', r.fresh.not_scoreable_reason,
          r.fresh.rubric_applied, r.fresh.agent_role, r.fresh.call_type,
          b.n, b.weight, b.earned, bs.n, bs.weight, bs.earned,
          round(d.denomOnly), round(d.numerOnly), round(d.residual), d.denomShare,
          r.fresh.__modelScore == null ? '' : r.fresh.__modelScore,
          TEMPERATURE === undefined ? 'default' : TEMPERATURE,
        ].map(esc).join(',');
      })).join('\n'));
    console.log('\nwrote ' + out + ' (gitignored)');
    console.log('  compare two runs with:  node scripts/regrade-compare.js <runA.csv> <runB.csv>');
  }

  if (!WRITE_GRADES) {
    console.log('\nNothing was written to call_grades — the stored grades are unchanged.');
    console.log('Add --write-grades to overwrite them (a backup is taken first).');
    return;
  }

  // ---- Overwrite, with a way back -----------------------------------------
  const fs = require('fs');
  fs.mkdirSync('exports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `exports/call_grades_backup_${day}_${stamp}.json`;

  // The FULL current rows, not just the columns about to change: a partial
  // backup is not a backup. Written and re-read before a single update runs —
  // if the restore file is not on disk and readable, nothing is overwritten.
  const writtenIds = results.map(r => r.stored.recording_id);
  const { data: current, error: readErr } = await db.from('call_grades').select('*').in('recording_id', writtenIds);
  if (readErr) throw new Error('could not read the rows to back up: ' + readErr.message);
  fs.writeFileSync(backupPath, JSON.stringify(current, null, 1));
  const verify = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(verify) || verify.length !== current.length) {
    throw new Error('backup did not read back intact — refusing to overwrite anything');
  }
  console.log(`\nbacked up ${verify.length} rows to ${backupPath}`);

  const RUBRIC_TAG = 'AI (rubric v2.1 regrade)';

  // ---- History, before a single row changes -------------------------------
  //
  // The exports/ file above is a file: gitignored, on a Render disk, gone when
  // the instance recycles. call_grades_history (migration 060) is the durable
  // record. Written FIRST and read back — if history cannot be recorded then
  // nothing is overwritten, because an un-auditable overwrite is exactly the
  // thing this was asked to prevent.
  const batchId = `regrade_${day}_${stamp}`;
  const historyRows = current.map(row => ({
    recording_id: row.recording_id,
    previous: row,
    previous_score: row.overall_score ?? null,
    previous_grade: row.overall_grade ?? null,
    previous_graded_by: row.graded_by ?? null,
    previous_graded_at: row.graded_at ?? null,
    batch_id: batchId,
    replaced_by: RUBRIC_TAG,
    source: 'scripts/regrade-sample.js',
  }));
  const { error: histErr } = await db.from('call_grades_history').insert(historyRows);
  if (histErr) {
    throw new Error(
      'could not write call_grades_history: ' + histErr.message
      + '\nNothing was overwritten. If the table is missing, run'
      + ' supabase/migrations/060_call_grades_history.sql first.');
  }
  const { count: histCount, error: histCountErr } = await db.from('call_grades_history')
    .select('id', { count: 'exact', head: true }).eq('batch_id', batchId);
  if (histCountErr || histCount !== historyRows.length) {
    throw new Error(`history did not read back intact (${histCount} of ${historyRows.length}) — refusing to overwrite anything`);
  }
  console.log(`history: ${histCount} row(s) saved to call_grades_history, batch ${batchId}`);

  let written = 0, failed = 0;
  for (const { stored: s0, fresh } of results) {
    // `fresh` ALREADY CARRIES THE VERDICT, not the model's raw reply: the
    // grading loop above replaces overall_score / overall_grade /
    // not_scoreable / flags with SCORE.verdict() before anything reaches here.
    // Do not "simplify" that away. Writing the model's self-reported total put
    // 56 rows into call_grades on a scale nothing else uses — 45 of them
    // disagreeing with their own category breakdown — and they are still there.
    const patch = {
      overall_score: fresh.overall_score ?? null,
      overall_grade: fresh.overall_grade ?? null,
      not_scoreable: !!fresh.not_scoreable,
      not_scoreable_reason: fresh.not_scoreable_reason ?? null,
      legal_violation: !!fresh.legal_violation,
      fair_housing_flag: !!fresh.fair_housing_flag,
      liability_flag: !!fresh.liability_flag,
      summary: fresh.summary ?? null,
      outcome: fresh.outcome ?? null,
      flags: fresh.flags ?? null,
      categories: fresh.categories ?? null,
      coaching: fresh.coaching ?? null,
      key_moments: fresh.key_moments ?? null,
      agent_role: fresh.agent_role ?? null,
      call_type: fresh.call_type ?? null,
      rubric_applied: fresh.rubric_applied ?? null,
      // Stamped so the record says WHICH rubric produced it. Without this a
      // v2.1 regrade is indistinguishable from the v2.0 nightly run, and
      // nobody could later ask "which grades came from the old rubric".
      graded_by: RUBRIC_TAG,
      graded_at: new Date().toISOString(),
    };
    const { error } = await db.from('call_grades').update(patch).eq('recording_id', s0.recording_id);
    if (error) { failed++; console.log(`  FAILED ${s0.recording_id}: ${error.message}`); }
    else written++;
  }

  console.log(`\nOVERWRITTEN: ${written} row(s)${failed ? `, ${failed} FAILED` : ''}`);
  console.log(`graded_by is now "${RUBRIC_TAG}" on those rows.`);
  console.log(`\nTo undo:  node scripts/restore-call-grades.js ${backupPath}`);
  console.log(`Or from the database, which survives this disk:`);
  console.log(`          node scripts/restore-call-grades.js --batch ${batchId}`);
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
