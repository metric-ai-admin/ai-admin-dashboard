#!/usr/bin/env node
//
// Copy due dates from Asana into the dashboard, once.
//
//   node scripts/backfill-due-dates.js            # dry run, changes nothing
//   node scripts/backfill-due-dates.js --write    # rewrites tasks.json
//
// Run on Render Shell: tasks.json lives on the mounted disk (DATA_DIR), and
// ASANA_TOKEN is set there.
//
// WHY. due_on has been a field on tasks for a long time, and until today
// nothing in the dashboard set it — the dates were entered in Asana and lived
// only there. So an open task can have an Asana card with a date and a
// dashboard card with none, and the Task Manager shows the second.
//
// READ ONLY AGAINST ASANA. It GETs each task and writes nothing back. The
// sync in the other direction already exists (server.js pushes due_on on
// create and on change), and running both at once would make it impossible to
// say which side won.
//
// SCOPE, deliberately narrow:
//   * open tasks only — a completed task's date is history, not a deadline
//   * with an asana_gid — nothing to read otherwise
//   * with NO due_on here — this fills gaps, it never overwrites. A date
//     someone typed into the dashboard is the one they meant.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const TOKEN = process.env.ASANA_TOKEN;
const DUE = require('../lib/due-date.js');

if (!TOKEN) {
  console.error('ASANA_TOKEN is not set in this shell. Run this on Render Shell.');
  process.exit(2);
}
if (!fs.existsSync(TASKS_FILE)) {
  console.error(`tasks.json not found at ${TASKS_FILE}. Set DATA_DIR, or run this where the disk is mounted.`);
  process.exit(2);
}

// Asana allows 150 requests/minute on a free token; 250ms between calls keeps
// well under it and a backfill of a few dozen tasks takes seconds either way.
const PAUSE_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function asanaGet(gid) {
  const r = await fetch(`https://app.asana.com/api/1.0/tasks/${encodeURIComponent(gid)}?opt_fields=due_on,completed,name`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j.data || {};
}

(async () => {
  const raw = fs.readFileSync(TASKS_FILE, 'utf8');
  const tasks = JSON.parse(raw);

  const open = tasks.filter(t => t.priority !== '✅ Done' && !t.completed_at);
  const candidates = open.filter(t => t.asana_gid && !t.due_on);

  console.log(`file        ${TASKS_FILE}`);
  console.log(`tasks       ${tasks.length}  ·  open ${open.length}`);
  console.log(`candidates  ${candidates.length}  (open, linked to Asana, no due date here)\n`);
  if (!candidates.length) { console.log('Nothing to backfill.'); return; }

  const filled = [];
  const blank = [];
  const failed = [];
  for (const t of candidates) {
    let card;
    try { card = await asanaGet(t.asana_gid); }
    catch (e) { failed.push({ t, why: e.message }); await sleep(PAUSE_MS); continue; }
    const due = card.due_on || null;
    if (!due) blank.push(t);
    else if (!DUE.isValidDueOn(due)) failed.push({ t, why: `Asana returned ${JSON.stringify(due)}` });
    else filled.push({ t, due, name: card.name });
    await sleep(PAUSE_MS);
  }

  console.log(`read ${candidates.length} Asana card(s):`);
  console.log(`  with a due date     ${filled.length}`);
  console.log(`  no date in Asana    ${blank.length}`);
  console.log(`  could not be read   ${failed.length}`);
  if (failed.length) failed.slice(0, 5).forEach(f => console.log(`    ${f.t.id}  ${f.why}`));

  if (!filled.length) { console.log('\nNothing to write.'); return; }
  console.log('\nwould set:');
  filled.forEach(f => console.log(`  ${f.due}  ${String(f.t.title).slice(0, 62)}`));

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write to apply.'); return; }

  // Backup first. The dates being copied in are recoverable from Asana; the
  // rest of tasks.json is not.
  const backup = path.join(DATA_DIR, `tasks.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.writeFileSync(backup, raw);
  console.log(`\nbackup  ${backup}`);

  const byId = new Map(filled.map(f => [f.t.id, f.due]));
  let applied = 0;
  for (const t of tasks) {
    // Re-checked against the file rather than trusting the object reference:
    // this must not overwrite a date that appeared while the script was running.
    if (byId.has(t.id) && !t.due_on) { t.due_on = byId.get(t.id); applied++; }
  }
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

  // Read back from disk, not from memory.
  const after = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const nowWithDue = after.filter(t => t.due_on).length;
  console.log(`\nwritten: ${applied} task(s) filled`);
  console.log(`tasks with a due date: ${tasks.length ? after.filter(t => t.due_on).length - (JSON.parse(raw).filter(t => t.due_on).length) : 0} more than before (${nowWithDue} total)`);
  console.log('\nNothing was written to Asana. The dashboard pushes due_on to Asana on');
  console.log('create and on change from here on, so the two stay in step.');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
