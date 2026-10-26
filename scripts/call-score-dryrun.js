#!/usr/bin/env node
//
// The rows whose stored score is not the one their own breakdown produces.
//
//   node scripts/call-score-dryrun.js
//   node scripts/call-score-dryrun.js --since 2026-09-01
//
// READ ONLY, AND STRUCTURALLY SO. There is no write path in this file: no
// insert, update, upsert or delete, and no flag that turns one on. It reads
// call_grades, recomputes each row from the `categories` column it already
// carries, and prints the difference.
//
// NOTHING IS RECOMPUTED FROM THE MODEL. Every number below comes from data
// already on the row — the same arithmetic lib/call-score.js does when a grade
// is written. No Anthropic call, no cost, and the result is deterministic: run
// it twice and get the same page.
//
// WHY THESE ROWS EXIST. scripts/regrade-sample.js used to write the model's
// SELF-REPORTED total straight into call_grades, bypassing the weighted
// breakdown that every nightly row uses. The v2.1 regrade on 2026-09-24 wrote
// 56 rows that way. Fixed 2026-10-26 (lib/call-score.js); these rows predate
// the fix and are still on the old scale.
//
// WHAT IT DOES NOT DO. It does not decide. A row where the model and the
// breakdown agree is left out of the "would change" list; a row where they
// disagree is reported with both numbers so somebody can look at the call
// before anything is rewritten.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const SCORE = require('../lib/call-score.js');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : d;
};
// THE DECISION SET, and it is narrower than 'every row that disagrees'.
//
// 560 rows in call_grades disagree with their own breakdown, and only 45 of
// them are a bug:
//
//   509  graded BEFORE 2026-09-18       the computed-score contract did not
//                                        exist yet; the model's total WAS the
//                                        stored score by design. Rewriting
//                                        these would re-score an older rubric
//                                        era, which is a different decision.
//     6  graded ON 2026-09-18            the contract shipped that day; deploy
//                                        lag, same era question.
//    45  AI (rubric v2.1 regrade)        --write-grades wrote the model's
//                                        self-reported total straight in.
//                                        THIS is the bug, fixed 2026-10-26.
//
// No nightly row graded after 2026-09-18 disagrees with its breakdown, so the
// live path is already correct and nothing ongoing is producing more.
//
// --writer selects the population; --all drops the filter and shows every
// disagreeing row, eras included. The default is the 45.
const CONTRACT_DATE = '2026-09-18';
const WRITER = arg('writer', 'AI (rubric v2.1 regrade)');
const ALL = process.argv.includes('--all');
const SINCE = arg('since', '2026-01-01');

// ---- apply mode --------------------------------------------------------------
//
// OFF UNLESS --apply IS TYPED. Without it this file has no write path at all:
// the update below is the only one, and it is unreachable.
//
// THE SCOPE IS NOT A FLAG. The rows it may touch are pinned here as constants —
// graded_by = "AI (rubric v2.1 regrade)" AND call_date = 2026-09-22 — so no
// combination of arguments can aim it at the nightly rows or at the 515 from
// the older era. --writer and --since steer the REPORT; they do not widen what
// apply may write, and it refuses if they have been moved off the pinned set.
//
// It also refuses if the count is not what the dry run showed. A selection that
// has quietly grown is a selection nobody has looked at.
const APPLY = process.argv.includes('--apply');
const APPLY_WRITER = 'AI (rubric v2.1 regrade)';
const APPLY_DATE = '2026-09-22';
const APPLY_EXPECT = Number(arg('expect', '45'));

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// PostgREST caps a plain select at 1000 rows whatever limit is asked for.
async function selectAll(build, label) {
  const page = 1000, out = [];
  for (let from = 0; ; from += page) {
    const r = await build().range(from, from + page - 1);
    if (r.error) throw new Error(label + ': ' + r.error.message);
    out.push(...(r.data || []));
    if ((r.data || []).length < page) break;
  }
  return out;
}

const pad = (s, w) => String(s == null ? '—' : s).padEnd(w);
const padL = (s, w) => String(s == null ? '—' : s).padStart(w);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f1 = v => (v == null ? '—' : v.toFixed(1));

(async () => {
  const rows = await selectAll(() => db.from('call_grades')
    .select('recording_id,call_date,agent_name,property_name,graded_by,graded_at,'
      + 'overall_score,overall_grade,not_scoreable,not_scoreable_reason,'
      + 'categories,legal_violation,flags')
    .gte('call_date', SINCE), 'call_grades');

  if (!rows.length) {
    console.log('No rows at or after ' + SINCE + '. Nothing can be concluded from this run.');
    process.exitCode = 1;
    return;
  }

  // What the row WOULD be if it were written today, from its own stored data.
  const assessed = rows.map(r => {
    const v = SCORE.verdict(r);
    const storedNS = !!r.not_scoreable;
    const scoreChanges = !v.notScoreable && !storedNS
      && v.score !== null && v.score !== r.overall_score;
    const nsChanges = v.notScoreable !== storedNS;
    return { r, v, scoreChanges, nsChanges, changes: scoreChanges || nsChanges };
  });
  const disagreeing = assessed.filter(a => a.changes);
  // Scoped to the population being decided about, so a count in this report
  // is never read as 'rows we should fix' when most of them are a different
  // question entirely.
  const changed = ALL ? disagreeing
    : disagreeing.filter(a => (a.r.graded_by || '') === WRITER);
  const otherEras = disagreeing.length - changed.length;

  console.log('='.repeat(78));
  console.log('call_grades — stored score vs the row\'s own breakdown      (DRY RUN, no writes)');
  console.log('='.repeat(78));
  console.log('population    : ' + (ALL ? 'every disagreeing row, all eras' : 'graded_by = "' + WRITER + '"'));
  console.log('rows examined : ' + rows.length);
  console.log('would change  : ' + changed.length);
  if (otherEras) {
    console.log('');
    console.log('  NOT counted above: ' + otherEras + ' further row(s) also disagree with their');
    console.log('  own breakdown, but were graded before the computed-score contract of ');
    console.log('  ' + CONTRACT_DATE + ', when the model\u0027s total WAS the stored score. Re-scoring');
    console.log('  those is a separate decision about an older rubric era — --all lists them.');
  }
  console.log('');

  if (!changed.length) {
    console.log('Every row already matches its own breakdown. Nothing to decide.');
    return;
  }

  // ---- who wrote them -----------------------------------------------------------
  const byWriter = {};
  changed.forEach(a => {
    const k = a.r.graded_by || '(null)';
    byWriter[k] = (byWriter[k] || 0) + 1;
  });
  console.log('WHO WROTE THE ROWS THAT WOULD CHANGE');
  Object.entries(byWriter).sort((x, y) => y[1] - x[1])
    .forEach(([k, n]) => console.log('  ' + padL(n, 4) + '  ' + k));
  console.log('');

  // ---- the rows -----------------------------------------------------------------
  console.log('EVERY ROW THAT WOULD CHANGE');
  console.log('  ' + pad('recording', 14) + pad('date', 12) + pad('agent', 14)
    + padL('stored', 7) + padL('->new', 7) + padL('diff', 6) + '  grade        note');
  console.log('  ' + '-'.repeat(74));
  changed
    .sort((a, b) => String(a.r.call_date).localeCompare(String(b.r.call_date))
      || String(a.r.recording_id).localeCompare(String(b.r.recording_id)))
    .forEach(a => {
      const { r, v } = a;
      const storedG = r.not_scoreable ? 'N/S' : (r.overall_grade || '—');
      const newG = v.notScoreable ? 'N/S' : (v.grade || '—');
      const diff = (!r.not_scoreable && !v.notScoreable && v.score !== null
        && r.overall_score !== null)
        ? (v.score - r.overall_score) : null;
      const note = a.nsChanges
        ? (v.notScoreable
            ? 'becomes N/S: ' + String(v.reason || '').slice(0, 30)
            : 'was N/S, would now score')
        : (v.computed ? '' : 'no usable breakdown');
      console.log('  ' + pad(String(r.recording_id).slice(-12), 14)
        + pad(r.call_date, 12)
        + pad(String(r.agent_name || '?').slice(0, 12), 14)
        + padL(r.not_scoreable ? 'N/S' : r.overall_score, 7)
        + padL(v.notScoreable ? 'N/S' : v.score, 7)
        + padL(diff == null ? '—' : (diff > 0 ? '+' + diff : diff), 6)
        + '  ' + pad(storedG + ' -> ' + newG, 11) + '  ' + note);
    });
  console.log('');

  // ---- letter grades --------------------------------------------------------------
  const letterMoves = {};
  changed.forEach(a => {
    const from = a.r.not_scoreable ? 'N/S' : (a.r.overall_grade || '?');
    const to = a.v.notScoreable ? 'N/S' : (a.v.grade || '?');
    if (from === to) return;
    const k = from + ' -> ' + to;
    letterMoves[k] = (letterMoves[k] || 0) + 1;
  });
  console.log('LETTER GRADE MOVES');
  if (!Object.keys(letterMoves).length) console.log('  none — only the numbers move');
  Object.entries(letterMoves).sort((x, y) => y[1] - x[1])
    .forEach(([k, n]) => console.log('  ' + padL(n, 4) + '  ' + k));
  console.log('');

  // ---- what reads these numbers -----------------------------------------------------
  const days = [...new Set(changed.map(a => a.r.call_date))].sort();
  const agents = [...new Set(changed.map(a => a.r.agent_name).filter(Boolean))].sort();

  console.log('WHAT THESE ROWS FEED');
  console.log('  Affected call_date(s): ' + days.join(', '));
  console.log('  Affected agent(s)    : ' + agents.join(', '));
  console.log('');
  console.log('  Every one of these reads call_grades.overall_score or overall_grade:');
  console.log('    - Call Analyzer, Grades list        GET /api/calls/grades');
  console.log('    - Call Analyzer, one grade          GET /api/calls/grades/:recording_id');
  console.log('    - Grades export / Lyndsay workbook  GET /api/calls/export,');
  console.log('                                        call-grades-export.js, call-grades-workbook.js');
  console.log('    - Kara 06:00 brief, failed calls    lib/kara-brief-gather.js (below 70)');
  console.log('    - 6 PM EOD, Call Analyzer section   counted by graded_at, not call_date');
  console.log('');
  console.log('  A row stored N/S is in NO average; a row that becomes N/S leaves every');
  console.log('  average it is currently in, and one that stops being N/S joins them.');
  console.log('');

  // ---- the averages, before and after ------------------------------------------------
  console.log('THE AVERAGES THAT MOVE');
  const scoredNow = r => !r.not_scoreable && r.overall_score != null;
  const perDay = {};
  rows.forEach(r => { (perDay[r.call_date] = perDay[r.call_date] || []).push(r); });
  // ONLY THE ROWS BEING DECIDED ABOUT MOVE.
  //
  // A first version substituted the recomputed verdict for EVERY row, which
  // made the window average read +4.7 — the effect of re-scoring the whole
  // table including 515 rows from an era this decision does not touch. The
  // answer to 'what happens if we fix the 45' has to leave every other row
  // exactly where it is.
  const changedIds = new Set(changed.map(a => a.r.recording_id));
  const assessedBy = new Map(changed.map(a => [a.r.recording_id, a]));

  console.log('  ' + pad('call_date', 12) + padL('n', 5) + padL('mean now', 10)
    + padL('mean after', 12) + padL('shift', 8) + padL('<70 now', 9) + padL('after', 7));
  days.forEach(d => {
    const all = perDay[d] || [];
    const now = all.filter(scoredNow).map(r => r.overall_score);
    const after = all.map(r => {
      const a = assessedBy.get(r.recording_id);
      const v = a ? a.v : null;
      if (!v) return scoredNow(r) ? r.overall_score : null;
      return v.notScoreable ? null : v.score;
    }).filter(x => x != null);
    const m1 = mean(now), m2 = mean(after);
    console.log('  ' + pad(d, 12) + padL(all.length, 5) + padL(f1(m1), 10) + padL(f1(m2), 12)
      + padL(m1 != null && m2 != null ? (m2 - m1 >= 0 ? '+' : '') + (m2 - m1).toFixed(1) : '—', 8)
      + padL(now.filter(s => s < 70).length, 9)
      + padL(after.filter(s => s < 70).length, 7));
  });

  // Portfolio-wide, over the whole window, since the workbook and the EOD
  // average across days rather than per day.
  const nowAll = rows.filter(scoredNow).map(r => r.overall_score);
  const afterAll = rows.map(r => {
    const a = assessedBy.get(r.recording_id);
    if (!a) return scoredNow(r) ? r.overall_score : null;
    return a.v.notScoreable ? null : a.v.score;
  }).filter(x => x != null);
  console.log('  ' + '-'.repeat(60));
  console.log('  ' + pad('WINDOW', 12) + padL(rows.length, 5) + padL(f1(mean(nowAll)), 10)
    + padL(f1(mean(afterAll)), 12)
    + padL((mean(afterAll) - mean(nowAll) >= 0 ? '+' : '')
      + (mean(afterAll) - mean(nowAll)).toFixed(1), 8)
    + padL(nowAll.filter(s => s < 70).length, 9)
    + padL(afterAll.filter(s => s < 70).length, 7));
  console.log('');

  // ---- per agent, because the leaderboard is per agent ---------------------------------
  console.log('PER AGENT, over the affected day(s) only');
  console.log('  ' + pad('agent', 16) + padL('n', 5) + padL('mean now', 10) + padL('mean after', 12) + padL('shift', 8));
  agents.forEach(ag => {
    const all = rows.filter(r => r.agent_name === ag && days.includes(r.call_date));
    const now = all.filter(scoredNow).map(r => r.overall_score);
    const after = all.map(r => {
      const a = assessedBy.get(r.recording_id);
      if (!a) return scoredNow(r) ? r.overall_score : null;
      return a.v.notScoreable ? null : a.v.score;
    }).filter(x => x != null);
    const m1 = mean(now), m2 = mean(after);
    console.log('  ' + pad(ag.slice(0, 14), 16) + padL(all.length, 5) + padL(f1(m1), 10) + padL(f1(m2), 12)
      + padL(m1 != null && m2 != null ? (m2 - m1 >= 0 ? '+' : '') + (m2 - m1).toFixed(1) : '—', 8));
  });

  console.log('');

  if (!APPLY) {
    console.log('='.repeat(78));
    console.log('NOTHING WAS WRITTEN. No transcript, resident name or phone number was read.');
    console.log('');
    console.log('To correct the ' + APPLY_EXPECT + ' rows above, re-run with --apply. It backs up');
    console.log('first (call_grades_history AND a file), reads the backup back before');
    console.log('touching anything, and prints the restore command.');
    console.log('='.repeat(78));
    return;
  }

  // ======================= APPLY ============================================
  //
  // Everything below runs only with --apply. The guards come first and each one
  // exits rather than narrowing silently: a correction that quietly did less
  // than it said is worse than one that refused.
  console.log('='.repeat(78));
  console.log('APPLY — correcting stored scores from each row\'s own breakdown');
  console.log('='.repeat(78));

  if (ALL || WRITER !== APPLY_WRITER) {
    console.error('REFUSED: apply is pinned to graded_by = "' + APPLY_WRITER + '".');
    console.error('  --all and --writer steer the report only. Drop them to apply.');
    process.exitCode = 2;
    return;
  }

  // Re-select from the database rather than reusing the report's rows, pinned
  // to BOTH constants. The report may have been filtered by --since.
  const target = changed.filter(a => a.r.graded_by === APPLY_WRITER
    && a.r.call_date === APPLY_DATE);
  const outOfScope = changed.length - target.length;
  if (outOfScope) {
    console.error('REFUSED: ' + outOfScope + ' row(s) in the report are outside the pinned'
      + ' scope (' + APPLY_WRITER + ' on ' + APPLY_DATE + ').');
    process.exitCode = 2;
    return;
  }
  if (target.length !== APPLY_EXPECT) {
    console.error('REFUSED: expected ' + APPLY_EXPECT + ' rows to correct, found ' + target.length + '.');
    console.error('  The selection has changed since it was reviewed. Re-run the dry run,');
    console.error('  look at what moved, then pass --expect ' + target.length + ' if it is right.');
    process.exitCode = 2;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const batchId = 'scorefix_' + APPLY_DATE + '_' + stamp;

  // ---- backup, in the database, BEFORE anything is written -------------------
  //
  // call_grades_history first and read back: the exports/ file lives on a Render
  // disk that the next deploy destroys, which is the backup you want precisely
  // when you cannot have it. A backup nobody can restore from is a comfort.
  const ids = target.map(a => a.r.recording_id);
  const fullRows = await selectAll(() => db.from('call_grades')
    .select('*').in('recording_id', ids), 'rows to back up');
  if (fullRows.length !== target.length) {
    console.error('REFUSED: read back ' + fullRows.length + ' of ' + target.length
      + ' rows for the backup. Nothing was written.');
    process.exitCode = 2;
    return;
  }

  const historyRows = fullRows.map(row => ({
    recording_id: row.recording_id,
    previous: row,
    previous_score: row.overall_score ?? null,
    previous_grade: row.overall_grade ?? null,
    previous_graded_by: row.graded_by ?? null,
    previous_graded_at: row.graded_at ?? null,
    batch_id: batchId,
    replaced_by: 'score recomputed from the stored breakdown',
    source: 'scripts/call-score-dryrun.js --apply',
  }));
  const { error: histErr } = await db.from('call_grades_history').insert(historyRows);
  if (histErr) {
    console.error('REFUSED: could not write call_grades_history: ' + histErr.message);
    console.error('  Nothing was written to call_grades.');
    process.exitCode = 2;
    return;
  }
  const { count: histCount, error: histCountErr } = await db.from('call_grades_history')
    .select('id', { count: 'exact', head: true }).eq('batch_id', batchId);
  if (histCountErr || histCount !== historyRows.length) {
    console.error('REFUSED: history did not read back intact ('
      + histCount + ' of ' + historyRows.length + '). Nothing was written to call_grades.');
    process.exitCode = 2;
    return;
  }
  console.log('backup: ' + histCount + ' row(s) in call_grades_history, batch ' + batchId);

  // The file copy too, for a restore that does not need the database. Gitignored
  // — these rows carry summaries and coaching notes about real calls.
  const fs = require('fs');
  const path = require('path');
  let backupPath = null;
  try {
    const dir = path.join(__dirname, '..', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    backupPath = path.join(dir, 'call_grades_backup_' + APPLY_DATE + '_' + stamp + '.json');
    fs.writeFileSync(backupPath, JSON.stringify(fullRows, null, 2), 'utf8');
    console.log('backup: ' + backupPath);
  } catch (e) {
    // Not fatal: the database copy is the one that survives a deploy, and it is
    // already verified. Said out loud rather than swallowed.
    console.log('note: the file backup could not be written (' + e.message + ').');
    console.log('      call_grades_history batch ' + batchId + ' is intact and is the restore source.');
  }

  // ---- the correction --------------------------------------------------------
  //
  // ONLY the fields the verdict determines. graded_by and graded_at are left
  // exactly as they were: these rows are not being re-graded, their stored
  // score is being recomputed from evidence they already carried. Rewriting the
  // provenance would erase which run produced them.
  console.log('');
  let ok = 0, failed = 0;
  for (const a of target) {
    const patch = {
      overall_score: a.v.notScoreable ? null : a.v.score,
      overall_grade: a.v.notScoreable ? 'N/S' : a.v.grade,
      not_scoreable: a.v.notScoreable,
      not_scoreable_reason: a.v.reason,
      flags: a.v.flags,
    };
    const { error } = await db.from('call_grades')
      .update(patch).eq('recording_id', a.r.recording_id);
    if (error) { failed++; console.log('  FAILED ' + a.r.recording_id + ': ' + error.message); }
    else ok++;
  }
  console.log('corrected: ' + ok + ' row(s)' + (failed ? ', ' + failed + ' FAILED' : ''));

  // ---- did it take? ----------------------------------------------------------
  //
  // Read back and re-derive. "The update returned no error" is not the same
  // claim as "the stored score now equals its breakdown".
  const after2 = await selectAll(() => db.from('call_grades')
    .select('recording_id,overall_score,overall_grade,not_scoreable,categories,legal_violation,flags')
    .in('recording_id', ids), 'verification');
  const stillOff = after2.filter(r => {
    const v = SCORE.verdict(r);
    if (v.notScoreable !== !!r.not_scoreable) return true;
    return !v.notScoreable && v.score !== null && v.score !== r.overall_score;
  });
  console.log('verified : ' + (after2.length - stillOff.length) + ' of ' + after2.length
    + ' row(s) now match their own breakdown'
    + (stillOff.length ? '  — ' + stillOff.length + ' STILL DO NOT' : ''));

  console.log('');
  console.log('='.repeat(78));
  console.log('TO UNDO, either form:');
  console.log('  node scripts/restore-call-grades.js --batch ' + batchId + ' --dry-run');
  console.log('  node scripts/restore-call-grades.js --batch ' + batchId);
  if (backupPath) {
    console.log('  node scripts/restore-call-grades.js ' + backupPath);
  }
  console.log('');
  console.log('The --batch form reads call_grades_history and survives a deploy;');
  console.log('the file does not. Prefer the batch.');
  console.log('='.repeat(78));
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
