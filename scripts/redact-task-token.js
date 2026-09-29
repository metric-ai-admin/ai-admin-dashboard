#!/usr/bin/env node
//
// Redact the dead MCP_AUTH_TOKEN out of a Task Manager note.
//
//   node scripts/redact-task-token.js            # dry run, changes nothing
//   node scripts/redact-task-token.js --write    # rewrites tasks.json
//
// Run on Render Shell: the tasks live in a JSON file on the mounted disk
// (DATA_DIR, /var/data in production), not in Supabase, and there is no API
// that can edit an existing note — PUT /api/tasks/:id only ever APPENDS to
// noteHistory. So this edits the file directly.
//
// WHY. On 2026-09-25 a token-rotation note was written with the new
// MCP_AUTH_TOKEN in plain text. The token was rotated again on 09/28 and is
// dead — verified 2026-09-29, 401 against /mcp on both Render services — but a
// dead credential in a note is still a credential in a note, and the same habit
// with a live one is a real incident. The note stays; only the value goes.
//
// SCOPE. One task, one pattern. Everything else is reported and left alone.
// Nothing is printed that could reveal the value: matches are counted and
// located, never echoed.

const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// The one task, and the one shape. A 64-character lowercase hex run is what
// `-join ((1..32)|%{'{0:x2}' -f (Get-Random -Max 256)})` produces, which is how
// these tokens are generated (see the rotation SOP).
const TARGET_ID = 'task_1790352153592_8968';
const TOKEN = /\b[0-9a-f]{64}\b/g;
const PLACEHOLDER = '[REDACTED]';

if (!fs.existsSync(TASKS_FILE)) {
  console.error(`tasks.json not found at ${TASKS_FILE}`);
  console.error('Set DATA_DIR, or run this on the dashboard service where the disk is mounted.');
  process.exit(2);
}

const raw = fs.readFileSync(TASKS_FILE, 'utf8');
const tasks = JSON.parse(raw);
const task = tasks.find(t => t.id === TARGET_ID);
if (!task) {
  console.error(`task ${TARGET_ID} is not in tasks.json — nothing done.`);
  process.exit(2);
}

console.log(`file   ${TASKS_FILE}`);
console.log(`tasks  ${tasks.length}`);
console.log(`target ${TARGET_ID}`);
console.log(`       ${String(task.title).slice(0, 80)}\n`);

// ---- what would change, before changing it --------------------------------
const edits = [];
const scan = (where, text) => {
  const n = (String(text || '').match(TOKEN) || []).length;
  if (n) edits.push({ where, n });
};
scan('notes', task.notes);
(task.noteHistory || []).forEach((note, i) =>
  scan(`noteHistory[${i}] (${String(note.createdAt || '').slice(0, 10)})`, note.text));

if (!edits.length) {
  console.log('No 64-hex value found in this task. Either it is already redacted');
  console.log('or the note changed. Nothing to do.');
  process.exit(0);
}
console.log('would redact:');
edits.forEach(e => console.log(`  ${e.where.padEnd(38)} ${e.n} match(es)`));

// The note must survive; only the value goes. Show the length before and after
// so it is obvious nothing else was removed.
const before = { notes: String(task.notes || ''), history: (task.noteHistory || []).map(n => String(n.text || '')) };

if (!WRITE) {
  console.log('\nDRY RUN — nothing written. Re-run with --write to apply.');
  process.exit(0);
}

// ---- back up, then edit ----------------------------------------------------
// The backup keeps the token, so it lands beside the file on the private disk
// and is named to be deleted once the change is confirmed.
const backup = path.join(DATA_DIR, `tasks.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.writeFileSync(backup, raw);
console.log(`\nbackup  ${backup}`);
console.log('        (it still contains the value — delete it once you have verified the change)');

if (task.notes) task.notes = String(task.notes).replace(TOKEN, PLACEHOLDER);
(task.noteHistory || []).forEach(n => { if (n.text) n.text = String(n.text).replace(TOKEN, PLACEHOLDER); });

fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

// ---- read it back from disk, not from memory -------------------------------
const after = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).find(t => t.id === TARGET_ID);
const stillThere = [String(after.notes || ''), ...(after.noteHistory || []).map(n => String(n.text || ''))]
  .filter(t => TOKEN.test(t)).length;
TOKEN.lastIndex = 0;

console.log('\nverification, re-read from disk:');
console.log(`  64-hex values remaining in this task : ${stillThere}   ${stillThere === 0 ? 'OK' : 'STILL PRESENT'}`);
console.log(`  noteHistory entries before / after   : ${before.history.length} / ${(after.noteHistory || []).length}`);
(after.noteHistory || []).forEach((n, i) => {
  const wasLen = before.history[i] ? before.history[i].length : 0;
  const nowLen = String(n.text || '').length;
  const delta = wasLen - nowLen;
  console.log(`    [${i}] ${String(n.createdAt || '').slice(0, 10)}  ${wasLen} -> ${nowLen} chars`
    + (delta ? `  (-${delta}, esperado 64-${PLACEHOLDER.length}=${64 - PLACEHOLDER.length} por cada valor)` : '  (sin cambios)'));
});
console.log(`  whole file: 64-hex values anywhere   : ${(fs.readFileSync(TASKS_FILE, 'utf8').match(TOKEN) || []).length}`);

console.log('\nNOT covered by this script, and worth checking separately:');
console.log('  - Asana. Notes are mirrored there as comments, and a comment is a');
console.log('    separate copy this file does not reach.');
console.log('  - Any export or backup of tasks.json taken before today.');
