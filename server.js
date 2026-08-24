/**
 * Metric Property Management — AI Admin Dashboard
 * Backend: Node.js + Express
 *
 * Separate from metric-dashboard (maintenance role). Single source of truth
 * for the AI Admin role: Lyndsay's email/calendar, task manager, platform
 * projects tracker, SOPs, Asana, and end-of-day summary.
 *
 * Modules:
 *  1. Task Manager        (/api/tasks/*)
 *  2. SOPs Knowledge Base  (/api/sops/*)
 *  3. Asana Integration    (/api/asana/*)
 *  4. Platform Projects    (/api/platform-projects/*)
 *  5. Email & Calendar     (/api/email/*, /api/calendar/*) — stub until Graph API credentials are set
 *  6. End of Day Summary   (/api/summary)
 */

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const cron = require('node-cron');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { PDFDocument } = require('pdf-lib');
const { randomUUID } = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { registerAllTools } = require('./mcp-tools.cjs');

// ---- Crash logging ----------------------------------------------------------
const LOG_FILE = path.join(__dirname, 'dashboard.log');
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.error(line);
}
process.on('uncaughtException', (err) => {
  logLine(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
  process.exit(1); // BAT loop will restart it
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : JSON.stringify(reason);
  logLine(`[ERROR] unhandledRejection: ${msg}`);
});

const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const ASANA_PROJECTS = [];
if (process.env.ASANA_EXTRA_PROJECTS) {
  for (const entry of process.env.ASANA_EXTRA_PROJECTS.split(',')) {
    const [gid, ...rest] = entry.trim().split(':');
    if (gid) ASANA_PROJECTS.push({ gid: gid.trim(), label: (rest.join(':').trim() || `Project ${gid.trim()}`) });
  }
}
const ASANA_BASE = 'https://app.asana.com/api/1.0';

// ---- Graph API config (Email + Calendar — stub until credentials set) ------
const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || '';
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || '';
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || '';
const GRAPH_CONFIGURED = !!(GRAPH_TENANT_ID && GRAPH_CLIENT_ID && GRAPH_CLIENT_SECRET);
const MAILBOX_ARTURO = process.env.MAILBOX_ARTURO || 'arturo-admin@metricpropertymanagement.com';
const MAILBOX_LYNDSAY = process.env.MAILBOX_LYNDSAY || 'lyndsay@metricpropertymanagement.com';
// All Metric departmental mailboxes tracked in the Inbox Tracking report —
// read via graphMailToken() (application permissions cover every mailbox in
// the tenant, no per-mailbox delegate access needed).
const METRIC_MAILBOXES = (process.env.METRIC_MAILBOXES || `${MAILBOX_ARTURO},${MAILBOX_LYNDSAY}`)
  .split(',').map(s => s.trim()).filter(Boolean);
const METRIC_MAILBOX_NAMES = {
  'support@livewithmetric.com': 'Support Email inbox',
  'collections@livewithmetric.com': 'Collections Main Inbox',
  'hello@livewithmetric.com': 'Hello Email Inbox',
  'maintenance@livewithmetric.com': 'Maintenance Main Inbox',
  'leasing@livewithmetric.com': 'Leasing Inbox',
  'accounting@metricpropertymanagement.com': 'Accounting Email Inbox',
  'marketing@metricpropertymanagement.com': 'Marketing Main Inbox',
  'admin@metricpropertymanagement.com': 'Jay Admin Email',
  'lyndsay@metricpropertymanagement.com': 'Lyndsay',
};

// ---- SharePoint "Inbox Tracking" Excel auto-fill --------------------------
// Workbook: Lyndsay's OneDrive, "Claude Files/All Daily - Weekly - Monthly
// Tracking MPM.xlsx", sheet "Inbox Tracking". Resolved once via the Graph
// /shares API against the SharePoint URL Lyndsay shared — driveId/itemId
// are stable identifiers for that file regardless of renames/moves within
// the same drive.
const EXCEL_DRIVE_ID = 'b!AZ0EyNFgSkaAOz1CehgsFrQRkPpTsgRLulPUnuRUG5m8qQlMQtVUT6KE4v8ENcL2';
const EXCEL_ITEM_ID = '01HZ3W3BRSZCY2F72MRZDICZ2ORQX3L3QQ';
const EXCEL_SHEET_NAME = 'Inbox Tracking';

// SOPS docx -> PDF conversion. Real path confirmed live via Graph — it's
// "Desktop/SOPS" (the synced Windows Desktop folder), NOT
// "Documents/Desktop/SOPS" as originally assumed; that path 404s.
const SOPS_MAILBOX = 'lyndsay@metricpropertymanagement.com';
const SOPS_SOURCE_PATH = 'Desktop/SOPS';
const SOPS_DEST_FOLDER_NAME = 'SOPS-PDF';
const SOPS_MAX_PAGES_PER_FILE = 100;
// The complete inbox-tracking mapping — every Excel row this dashboard
// keeps in sync, both mailbox-level (folderName: "Inbox") and personal
// per-person folder rows. Jay confirmed this mapping on 2026-08-19; it lives
// in .env (not hardcoded) specifically so it can be corrected/extended later
// without a code change. lyndsay@ is intentionally absent — no row for her
// in this sheet.
const INBOX_TRACKING_MAPPING = (() => {
  try {
    const parsed = JSON.parse(process.env.INBOX_TRACKING_MAPPING || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logLine(`[inbox-tracking] INBOX_TRACKING_MAPPING is invalid JSON, ignoring: ${err.message}`);
    return [];
  }
})();
const EMAIL_REFRESH_MINUTES = parseInt(process.env.EMAIL_REFRESH_MINUTES || '15', 10);
// Reminder lead time varies by meeting type — see classifyMeeting() below.
const REMINDER_MINUTES_CLIENT = parseInt(process.env.REMINDER_MINUTES_CLIENT || '15', 10);
const REMINDER_MINUTES_INTERNAL = parseInt(process.env.REMINDER_MINUTES_INTERNAL || '5', 10);
const REMINDER_MINUTES_LEGAL = parseInt(process.env.REMINDER_MINUTES_LEGAL || '30', 10);
const REMINDER_MINUTES_DEFAULT = parseInt(process.env.REMINDER_MINUTES_DEFAULT || '10', 10);
const INTERNAL_DOMAINS = ['metricpropertymanagement.com', 'livewithmetric.com'];
const ARTURO_TIMEZONE = process.env.ARTURO_TIMEZONE || 'America/Caracas';
const LYNDSAY_TIMEZONE = process.env.LYNDSAY_TIMEZONE || 'America/Chicago';

// Delegated permissions — the dashboard authenticates AS Arturo (auth code
// flow), not as an app daemon. Lyndsay's mailbox is reached via the *.Shared
// scopes once she grants Arturo delegate access in Outlook; no separate
// sign-in is needed for her.
// APP_BASE_URL must be set in production (e.g. https://metric-ai-admin-dashboard.onrender.com)
// — without it the OAuth redirect would point at an unreachable localhost
// URL once deployed. Falls back to localhost for local dev, unchanged.
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const GRAPH_REDIRECT_URI = `${APP_BASE_URL}/auth/callback`;
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Read.Shared',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Calendars.Read.Shared',
  'offline_access',
];

// ---- Paths -----------------------------------------------------------------
// DATA_DIR is overridable so a persistent disk can be mounted somewhere
// other than the app's own folder in production (Render's filesystem is
// ephemeral otherwise — every deploy/restart would wipe tasks, the Lyndsay
// queue, the Graph token cache, etc.). Defaults to the local ./data folder,
// unchanged for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const ASANA_CACHE_FILE = path.join(DATA_DIR, 'asana_cache.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity_log.json');
const SOPS_DIR = path.join(DATA_DIR, 'sops');
const SOPS_INDEX = path.join(SOPS_DIR, '_index.json');
const PLATFORM_PROJECTS_FILE = path.join(DATA_DIR, 'platform_projects.json');
const EMAIL_RULES_FILE = path.join(DATA_DIR, 'email_rules.json');
const FLAGGED_FILE = path.join(DATA_DIR, 'flagged_items.json');
const LYNDSAY_QUEUE_FILE = path.join(DATA_DIR, 'lyndsay_message_queue.json');
const MEETINGS_FILE = path.join(DATA_DIR, 'meetings.json');
const GRAPH_TOKEN_CACHE_FILE = path.join(DATA_DIR, 'graph_token_cache.json');

// Ensure folders/files exist on boot
for (const dir of [DATA_DIR, SOPS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');
if (!fs.existsSync(ASANA_CACHE_FILE)) fs.writeFileSync(ASANA_CACHE_FILE, JSON.stringify({ lastUpdated: null, tasks: [] }));
if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]');
if (!fs.existsSync(SOPS_INDEX)) fs.writeFileSync(SOPS_INDEX, '[]');
if (!fs.existsSync(PLATFORM_PROJECTS_FILE)) fs.writeFileSync(PLATFORM_PROJECTS_FILE, '[]');
if (!fs.existsSync(EMAIL_RULES_FILE)) fs.writeFileSync(EMAIL_RULES_FILE, JSON.stringify({ rules: [] }));
if (!fs.existsSync(FLAGGED_FILE)) fs.writeFileSync(FLAGGED_FILE, '[]');
if (!fs.existsSync(LYNDSAY_QUEUE_FILE)) fs.writeFileSync(LYNDSAY_QUEUE_FILE, '[]');
if (!fs.existsSync(MEETINGS_FILE)) fs.writeFileSync(MEETINGS_FILE, JSON.stringify({ lastUpdated: null, date: null, arturo: [], lyndsay: [] }));

// ---- Middleware ------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ---------------------------------------------------------------
// Date-only string in the SERVER'S LOCAL TIMEZONE (Arturo's machine, Venezuela
// UTC-4) — never use toISOString().slice(0,10) for this, since that gives the
// UTC calendar date and rolls over to "tomorrow" a few hours before local
// midnight (e.g. after ~8pm local). Accepts a Date or an ISO timestamp string
// so stored timestamps (completed_at, due_at, etc.) can be compared the same way.
function localDateStr(d = new Date()) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return localDateStr();
}
function tomorrowStr() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return localDateStr(d);
}

// Microsoft Graph's calendarView returns event start/end as UTC by default,
// but WITHOUT a trailing 'Z' (confirmed by comparing the default response
// against an explicit Prefer: outlook.timezone="UTC" request — they're
// identical). Without the 'Z', `new Date(...)` parses the string as the
// server's LOCAL time instead of UTC, which silently shifted every stored
// meeting time by the Venezuela UTC offset. Append 'Z' at ingestion so every
// downstream consumer (conflict detection, reminder timing, dual-time
// display) works from the correct absolute instant.
function normalizeGraphDateTime(dt) {
  if (!dt) return dt;
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(dt) ? dt : `${dt}Z`;
}

// Formats an absolute instant as "[time] CT | [time] VET" for display.
function formatDualTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const ct = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LYNDSAY_TIMEZONE });
  const vet = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ARTURO_TIMEZONE });
  return `${ct} CT | ${vet} VET`;
}

async function readJSON(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  // Write to a temp file then rename — atomic on NTFS, prevents OneDrive
  // from locking the target file mid-write and causing EBUSY crashes.
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function logActivity(entry) {
  try {
    const log = await readJSON(ACTIVITY_FILE, []);
    log.push({ at: new Date().toISOString(), ...entry });
    await writeJSON(ACTIVITY_FILE, log.slice(-2000));
  } catch (e) {
    console.error('[logActivity]', e.message);
  }
}

function asanaHeaders() {
  return {
    'Authorization': `Bearer ${ASANA_TOKEN}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function asanaRequest(method, endpoint, body) {
  if (!ASANA_TOKEN) throw new Error('ASANA_TOKEN is not set in .env');
  const res = await fetchFn(`${ASANA_BASE}${endpoint}`, {
    method,
    headers: asanaHeaders(),
    body: body ? JSON.stringify({ data: body }) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || `Asana API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

async function asanaGetAll(endpoint) {
  if (!ASANA_TOKEN) throw new Error('ASANA_TOKEN is not set in .env');
  const sep = endpoint.includes('?') ? '&' : '?';
  let url = `${ASANA_BASE}${endpoint}${sep}limit=100`;
  const out = [];
  while (url) {
    const res = await fetchFn(url, { headers: asanaHeaders() });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.errors?.[0]?.message || `Asana API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    out.push(...(json.data || []));
    url = json.next_page ? json.next_page.uri : null;
  }
  return out;
}

let _meCache = null;
async function getMe() {
  if (_meCache) return _meCache;
  const me = await asanaRequest('GET', '/users/me?opt_fields=name,email,workspaces.name');
  _meCache = {
    gid: me.gid,
    name: me.name,
    email: me.email,
    workspaceGid: me.workspaces && me.workspaces[0] ? me.workspaces[0].gid : null,
    workspaceName: me.workspaces && me.workspaces[0] ? me.workspaces[0].name : null,
  };
  return _meCache;
}

// =====================================================================
// MODULE 1 — TASK MANAGER
// =====================================================================
// Scoped to AI Admin work: Lyndsay Review follow-ups, "To Review Together"
// items, admin requests from Lyndsay, and Arturo's own to-dos.

const TASK_TYPES = ['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other'];
const TASK_PRIORITIES = ['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done'];

function migrateNotes(task) {
  if (!task.noteHistory) {
    task.noteHistory = (task.notes && task.notes.trim())
      ? [{ text: task.notes.trim(), createdAt: task.created_at || new Date().toISOString() }]
      : [];
  }
}

app.get('/api/tasks', async (req, res) => {
  const tasks = await readJSON(TASKS_FILE, []);
  let dirty = false;
  tasks.forEach(t => { if (!t.noteHistory) { migrateNotes(t); dirty = true; } });
  if (dirty) await writeJSON(TASKS_FILE, tasks);
  res.json(tasks);
});

app.post('/api/tasks', async (req, res) => {
  const tasks = await readJSON(TASKS_FILE, []);
  const { title, type, source, priority, notes, due_on } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });

  const now = new Date().toISOString();
  const task = {
    id: `task_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
    title: title.trim(),
    type: TASK_TYPES.includes(type) ? type : 'Other',
    source: source || '',
    priority: TASK_PRIORITIES.includes(priority) ? priority : '🟢 In Progress',
    due_on: due_on || null,
    notes: notes || '',
    noteHistory: (notes && notes.trim()) ? [{ text: notes.trim(), createdAt: now }] : [],
    created_at: now,
    completed_at: null,
  };
  tasks.unshift(task);
  await writeJSON(TASKS_FILE, tasks);
  await logActivity({ kind: 'task_created', taskId: task.id, title: task.title });
  res.json(task);
});

app.put('/api/tasks/:id', async (req, res) => {
  const tasks = await readJSON(TASKS_FILE, []);
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });

  const allowed = ['title', 'type', 'source', 'priority', 'due_on'];
  for (const k of allowed) {
    if (k in req.body) tasks[idx][k] = req.body[k];
  }
  if ('notes' in req.body && req.body.notes && req.body.notes.trim()) {
    migrateNotes(tasks[idx]);
    const note = { text: req.body.notes.trim(), createdAt: new Date().toISOString() };
    tasks[idx].noteHistory.push(note);
    tasks[idx].notes = req.body.notes.trim();
  }

  if (req.body.priority === '✅ Done' && !tasks[idx].completed_at) {
    tasks[idx].completed_at = new Date().toISOString();
  } else if (req.body.priority && req.body.priority !== '✅ Done') {
    tasks[idx].completed_at = null;
  }

  await writeJSON(TASKS_FILE, tasks);
  res.json(tasks[idx]);
});

app.post('/api/tasks/:id/done', async (req, res) => {
  const tasks = await readJSON(TASKS_FILE, []);
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  tasks[idx].priority = '✅ Done';
  tasks[idx].completed_at = new Date().toISOString();
  await writeJSON(TASKS_FILE, tasks);
  await logActivity({ kind: 'task_completed', taskId: tasks[idx].id, title: tasks[idx].title });
  res.json(tasks[idx]);
});

app.post('/api/tasks/:id/notes', async (req, res) => {
  const tasks = await readJSON(TASKS_FILE, []);
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Note text required' });
  migrateNotes(tasks[idx]);
  tasks[idx].noteHistory.push({ text, createdAt: new Date().toISOString() });
  tasks[idx].notes = text;
  await writeJSON(TASKS_FILE, tasks);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', async (req, res) => {
  let tasks = await readJSON(TASKS_FILE, []);
  const before = tasks.length;
  tasks = tasks.filter(t => t.id !== req.params.id);
  if (tasks.length === before) return res.status(404).json({ error: 'Task not found' });
  await writeJSON(TASKS_FILE, tasks);
  res.json({ ok: true });
});

// Bulk import preserving exact ids/timestamps — for migrating data between
// instances (e.g. local -> cloud). Unlike POST /api/tasks (which always
// mints a fresh id/created_at), this upserts by id so it's safe to re-run.
app.post('/api/tasks/bulk-import', async (req, res) => {
  const incoming = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  if (!incoming.length) return res.status(400).json({ error: '"tasks" array required' });
  const tasks = await readJSON(TASKS_FILE, []);
  let added = 0, updated = 0;
  for (const t of incoming) {
    if (!t.id) continue;
    const idx = tasks.findIndex(x => x.id === t.id);
    if (idx === -1) { tasks.push(t); added++; } else { tasks[idx] = t; updated++; }
  }
  await writeJSON(TASKS_FILE, tasks);
  res.json({ ok: true, added, updated, total: tasks.length });
});

// =====================================================================
// MODULE 2 — SOPs KNOWLEDGE BASE
// =====================================================================

app.get('/api/sops', async (req, res) => {
  const index = await readJSON(SOPS_INDEX, []);
  res.json(index.map(s => ({
    id: s.id, title: s.title, tags: s.tags || [], uploadedAt: s.uploadedAt, chars: (s.text || '').length,
    source: s.source || null, category: s.category || null, slab_url: s.slab_url || null,
  })));
});

app.post('/api/sops', async (req, res) => {
  const { title, text, tags, source, category, slab_url } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Body text required' });
  const index = await readJSON(SOPS_INDEX, []);
  const entry = {
    id: `sop_${Date.now()}`,
    title: title.trim(),
    tags: Array.isArray(tags) ? tags : [],
    source: source || null,
    category: category || null,
    slab_url: slab_url || null,
    uploadedAt: new Date().toISOString(),
    text: text.trim(),
  };
  index.unshift(entry);
  await writeJSON(SOPS_INDEX, index);
  res.json({ id: entry.id, title: entry.title, chars: entry.text.length });
});

app.get('/api/sops/:id', async (req, res) => {
  const index = await readJSON(SOPS_INDEX, []);
  const sop = index.find(s => s.id === req.params.id);
  if (!sop) return res.status(404).json({ error: 'SOP not found' });
  res.json(sop);
});

app.delete('/api/sops/:id', async (req, res) => {
  let index = await readJSON(SOPS_INDEX, []);
  const before = index.length;
  index = index.filter(s => s.id !== req.params.id);
  if (index.length === before) return res.status(404).json({ error: 'SOP not found' });
  await writeJSON(SOPS_INDEX, index);
  res.json({ ok: true });
});

// Bulk import preserving exact ids/uploadedAt — see /api/tasks/bulk-import
// for why (migrating between instances without minting fresh ids).
app.post('/api/sops/bulk-import', async (req, res) => {
  const incoming = Array.isArray(req.body?.sops) ? req.body.sops : [];
  if (!incoming.length) return res.status(400).json({ error: '"sops" array required' });
  const index = await readJSON(SOPS_INDEX, []);
  let added = 0, updated = 0;
  for (const s of incoming) {
    if (!s.id) continue;
    const idx = index.findIndex(x => x.id === s.id);
    if (idx === -1) { index.push(s); added++; } else { index[idx] = s; updated++; }
  }
  await writeJSON(SOPS_INDEX, index);
  res.json({ ok: true, added, updated, total: index.length });
});

app.get('/api/sops/search/:q', async (req, res) => {
  const q = (req.params.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const index = await readJSON(SOPS_INDEX, []);
  const results = [];
  for (const sop of index) {
    const lc = (sop.text || '').toLowerCase();
    const pos = lc.indexOf(q);
    if (pos !== -1) {
      const start = Math.max(0, pos - 120);
      results.push({
        id: sop.id, title: sop.title,
        snippet: (start > 0 ? '…' : '') + sop.text.slice(start, pos + q.length + 200).trim() + '…',
      });
    }
  }
  res.json({ results });
});

// =====================================================================
// MODULE 3 — ASANA INTEGRATION (read/import — no auto-editing)
// =====================================================================

const ASANA_OPT_FIELDS = 'name,assignee.name,due_on,due_at,completed,completed_at,notes,permalink_url,modified_at,projects.name,followers.gid';

function shapeTask(t, projectLabel) {
  const label = projectLabel
    || (t.projects && t.projects[0] ? t.projects[0].name : 'Mis tareas');
  return {
    gid: t.gid,
    name: t.name,
    assignee: t.assignee ? t.assignee.name : null,
    assignee_gid: t.assignee ? t.assignee.gid : null,
    follower_gids: (t.followers || []).map(f => f.gid),
    due_on: t.due_on || (t.due_at ? localDateStr(t.due_at) : null),
    completed: !!t.completed,
    completed_at: t.completed_at || null,
    notes: t.notes || '',
    notes_preview: (t.notes || '').slice(0, 100),
    permalink_url: t.permalink_url || null,
    modified_at: t.modified_at || null,
    project: label,
  };
}

app.get('/api/asana/me', async (req, res) => {
  try {
    res.json(await getMe());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/asana/tasks', async (req, res) => {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const completedSince = encodeURIComponent(midnight.toISOString());

  try {
    const byGid = new Map();

    for (const project of ASANA_PROJECTS) {
      const tasks = await asanaGetAll(
        `/projects/${project.gid}/tasks?opt_fields=${ASANA_OPT_FIELDS}&completed_since=${completedSince}`);
      for (const t of (tasks || [])) {
        if (!byGid.has(t.gid)) byGid.set(t.gid, shapeTask(t, project.label));
      }
    }

    try {
      const me = await getMe();
      if (me.gid && me.workspaceGid) {
        const mine = await asanaGetAll(
          `/tasks?assignee=${me.gid}&workspace=${me.workspaceGid}&opt_fields=${ASANA_OPT_FIELDS}&completed_since=${completedSince}`);
        for (const t of (mine || [])) {
          if (!byGid.has(t.gid)) byGid.set(t.gid, shapeTask(t, null));
        }
      }
    } catch (meErr) {
      console.error('[asana/tasks] my-tasks pull failed:', meErr.message);
    }

    const allTasks = [...byGid.values()];
    const payload = { lastUpdated: new Date().toISOString(), tasks: allTasks, stale: false };
    await writeJSON(ASANA_CACHE_FILE, payload);
    res.json(payload);
  } catch (err) {
    console.error('[asana/tasks]', err.message);
    const cache = await readJSON(ASANA_CACHE_FILE, { lastUpdated: null, tasks: [] });
    res.status(200).json({ ...cache, stale: true, error: err.message });
  }
});

// Import tasks from a given Asana project's live list into the Task Manager,
// so they show up alongside everything else in one place. Skips tasks
// already imported (matched by asanaGid).
app.post('/api/asana/import', async (req, res) => {
  const { projectGid } = req.body || {};
  if (!projectGid) return res.status(400).json({ error: 'projectGid required' });
  try {
    const rawTasks = await asanaGetAll(`/projects/${projectGid}/tasks?opt_fields=${ASANA_OPT_FIELDS}`);
    const shaped = rawTasks.filter(t => !t.completed).map(t => shapeTask(t));

    const tasks = await readJSON(TASKS_FILE, []);
    const existingGids = new Set(tasks.filter(t => t.asanaGid).map(t => t.asanaGid));
    let imported = 0;
    const now = new Date().toISOString();
    for (const t of shaped) {
      if (existingGids.has(t.gid)) continue;
      tasks.unshift({
        id: `task_${Date.now()}_${Math.floor(Math.random() * 1e4)}_${imported}`,
        title: t.name,
        type: 'Asana Import',
        source: t.project,
        priority: '🟢 In Progress',
        notes: t.notes_preview || '',
        noteHistory: [],
        created_at: now,
        completed_at: null,
        asanaGid: t.gid,
        asanaUrl: t.permalink_url,
        due_on: t.due_on,
      });
      imported++;
    }
    await writeJSON(TASKS_FILE, tasks);
    await logActivity({ kind: 'asana_import', projectGid, imported });
    res.json({ ok: true, imported, total: shaped.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// MODULE 4 — PLATFORM PROJECTS TRACKER
// =====================================================================
// Tracks the multi-department platform build (Unified Operations Platform
// Proposal — Netlify + Supabase + React).

const PROJECT_PHASES = ['Not started', 'Discovery', 'In Development', 'Testing', 'Live'];

app.get('/api/platform-projects', async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  projects.sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json(projects);
});

app.post('/api/platform-projects', async (req, res) => {
  const { module, phase, blockers, nextAction } = req.body;
  if (!module || !module.trim()) return res.status(400).json({ error: 'Module name required' });
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const entry = {
    id: `proj_${Date.now()}`,
    module: module.trim(),
    phase: PROJECT_PHASES.includes(phase) ? phase : 'Not started',
    blockers: blockers || '',
    lastUpdate: new Date().toISOString(),
    nextAction: nextAction || '',
    order: projects.length + 1,
  };
  projects.push(entry);
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(entry);
});

// Bulk import preserving exact ids/lastUpdate/subtasks — see
// /api/tasks/bulk-import for why.
app.post('/api/platform-projects/bulk-import', async (req, res) => {
  const incoming = Array.isArray(req.body?.projects) ? req.body.projects : [];
  if (!incoming.length) return res.status(400).json({ error: '"projects" array required' });
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  let added = 0, updated = 0;
  for (const p of incoming) {
    if (!p.id) continue;
    const idx = projects.findIndex(x => x.id === p.id);
    if (idx === -1) { projects.push(p); added++; } else { projects[idx] = p; updated++; }
  }
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json({ ok: true, added, updated, total: projects.length });
});

app.put('/api/platform-projects/:id', async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const allowed = ['module', 'phase', 'blockers', 'nextAction', 'order'];
  for (const k of allowed) {
    if (k in req.body) projects[idx][k] = req.body[k];
  }
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

// ── Subtasks ──────────────────────────────────────────────────────────────

app.post('/api/platform-projects/:id/subtasks', async (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Subtask title required' });
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  if (!Array.isArray(projects[idx].subtasks)) projects[idx].subtasks = [];
  const subtask = { id: `sub_${Date.now()}_${Math.floor(Math.random() * 1e4)}`, title: title.trim(), done: false };
  projects[idx].subtasks.push(subtask);
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

app.put('/api/platform-projects/:id/subtasks/:subId', async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const subs = projects[idx].subtasks || [];
  const subIdx = subs.findIndex(s => s.id === req.params.subId);
  if (subIdx === -1) return res.status(404).json({ error: 'Subtask not found' });
  if ('done' in req.body) subs[subIdx].done = !!req.body.done;
  if ('title' in req.body && req.body.title.trim()) subs[subIdx].title = req.body.title.trim();
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

app.delete('/api/platform-projects/:id/subtasks/:subId', async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const before = (projects[idx].subtasks || []).length;
  projects[idx].subtasks = (projects[idx].subtasks || []).filter(s => s.id !== req.params.subId);
  if (projects[idx].subtasks.length === before) return res.status(404).json({ error: 'Subtask not found' });
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

// =====================================================================
// MODULE 5 — EMAIL & CALENDAR (Microsoft Graph API, both mailboxes)
// =====================================================================
// Delegated permissions — the dashboard authenticates AS Arturo via the
// OAuth authorization-code flow (MSAL), not as an app daemon. Visit
// /auth/login once to sign in; after that MSAL silently refreshes the
// token from its cached refresh token, so no repeated sign-in is needed.
// Lyndsay's mailbox is reached via the *.Shared scopes once she grants
// Arturo delegate access in Outlook — no separate sign-in for her.
//
// Until GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET are set in
// .env, or until the one-time sign-in is completed, these endpoints stay
// in stub mode.

// Tracks when the background refresh last/next ran, so the UI can show a
// "Last refreshed / Next refresh" indicator without reading server logs.
const refreshState = { lastRun: null, nextRun: null, running: false, authRequired: false, inboxCounts: null, inboxTracking: null };
function scheduleNextRun() {
  refreshState.nextRun = new Date(Date.now() + EMAIL_REFRESH_MINUTES * 60 * 1000).toISOString();
}
scheduleNextRun();

class GraphAuthRequiredError extends Error {}

// Persistent MSAL token cache — read/written as plain JSON so the refresh
// token survives server restarts (no repeated browser sign-in required).
const msalCachePlugin = {
  beforeCacheAccess: async (ctx) => {
    const cache = await readJSON(GRAPH_TOKEN_CACHE_FILE, null);
    if (cache) ctx.tokenCache.deserialize(JSON.stringify(cache));
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) {
      await writeJSON(GRAPH_TOKEN_CACHE_FILE, JSON.parse(ctx.tokenCache.serialize()));
    }
  },
};

const msalClient = GRAPH_CONFIGURED ? new ConfidentialClientApplication({
  auth: {
    clientId: GRAPH_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${GRAPH_TENANT_ID}`,
    clientSecret: GRAPH_CLIENT_SECRET,
  },
  cache: { cachePlugin: msalCachePlugin },
}) : null;

// GET /auth/login — kicks off the one-time browser consent for Arturo.
app.get('/auth/login', async (req, res) => {
  if (!GRAPH_CONFIGURED) return res.status(400).send('Graph API not configured — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env first.');
  try {
    const url = await msalClient.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri: GRAPH_REDIRECT_URI });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`Could not start sign-in: ${err.message}`);
  }
});

// GET /auth/callback — Azure AD redirects here with ?code= after consent.
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`Sign-in failed: ${error} — ${error_description || ''}`);
  if (!code) return res.status(400).send('Missing authorization code.');
  try {
    await msalClient.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri: GRAPH_REDIRECT_URI });
    refreshState.authRequired = false;
    logLine('[auth] Microsoft account connected successfully.');
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>&#9989; Microsoft account connected</h2>
      <p>You can close this tab and return to the dashboard.</p>
      <a href="/">Go to dashboard</a>
    </body></html>`);
    refreshEmailAndCalendar(); // kick off an immediate refresh now that we're connected
  } catch (err) {
    logLine(`[auth] callback ERROR: ${err.message}`);
    res.status(500).send(`Sign-in failed: ${err.message}`);
  }
});

async function graphAccessToken() {
  if (!GRAPH_CONFIGURED) throw new Error('Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env');
  const accounts = await msalClient.getTokenCache().getAllAccounts();
  if (!accounts.length) throw new GraphAuthRequiredError('No Microsoft account connected yet — visit /auth/login to sign in as Arturo.');
  const result = await msalClient.acquireTokenSilent({ account: accounts[0], scopes: GRAPH_SCOPES });
  return result.accessToken;
}

// Client-credentials (app-only) token — used ONLY for reading Lyndsay's mail,
// since Mail/Inbox delegate access was never granted to Arturo in Outlook
// (Calendar delegate access was, which is why the calendar keeps using the
// delegated graphAccessToken() above — don't change that). Requires the
// Mail.Read APPLICATION permission with admin consent in the App Registration,
// alongside (not replacing) the existing delegated permissions.
async function graphMailToken() {
  if (!GRAPH_CONFIGURED) throw new Error('Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env');
  // skipCache: MSAL persists client-credential tokens via the same file cache
  // plugin as the delegated flow, so a token minted BEFORE an app permission
  // is added/changed in Azure keeps getting served (stale roles claim) until
  // it naturally expires — bit us when Files.ReadWrite.All was added but the
  // still-valid cached token only had the old roles. Always fetch fresh.
  const result = await msalClient.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'], skipCache: true });
  return result.accessToken;
}

// Detects a meeting's platform from its online-meeting join URL / location /
// body preview, and separately returns the join URL (if any) so reminder
// messages can include the actual link.
function detectMeetingPlatform(e) {
  const joinUrl = e.onlineMeeting?.joinUrl || '';
  const haystack = [joinUrl, e.location?.displayName, e.bodyPreview].filter(Boolean).join(' ');
  let platform;
  if (/teams\.microsoft\.com/i.test(haystack) || e.onlineMeeting) platform = 'Teams';
  else if (/zoom\.us/i.test(haystack)) platform = 'Zoom';
  else if (/meet\.google\.com/i.test(haystack)) platform = 'Google Meet';
  else if (/in-?person/i.test(e.location?.displayName || '')) platform = 'In-person';
  else if (e.location?.displayName) platform = e.location.displayName;
  else platform = 'No link available';
  return { platform, joinUrl };
}

// Classifies a meeting to decide how much lead time its reminder gets:
//  - legal: eviction/hearing/court/writ/legal matters — longest lead, these
//    need real prep.
//  - client: organizer is external (not @metricpropertymanagement.com or
//    @livewithmetric.com) — Client/BD meetings.
//  - internal: internal organizer + a recurring-standup-shaped subject.
//  - default: everything else.
function classifyMeeting(m) {
  const subject = m.subject || '';
  if (/eviction|hearing|court|writ|legal/i.test(subject)) {
    return { meetingType: 'legal', leadMinutes: REMINDER_MINUTES_LEGAL };
  }
  const organizerDomain = (m.organizerEmail || '').split('@')[1]?.toLowerCase() || '';
  const isInternal = organizerDomain && INTERNAL_DOMAINS.some(d => organizerDomain === d || organizerDomain.endsWith(`.${d}`));
  if (organizerDomain && !isInternal) {
    return { meetingType: 'client', leadMinutes: REMINDER_MINUTES_CLIENT };
  }
  if (isInternal && /daily|weekly|standup|huddle|kpi/i.test(subject)) {
    return { meetingType: 'internal', leadMinutes: REMINDER_MINUTES_INTERNAL };
  }
  return { meetingType: 'default', leadMinutes: REMINDER_MINUTES_DEFAULT };
}

// Builds the copy-paste reminder text for a meeting on Lyndsay's calendar.
// Never sent automatically — Arturo copies this and sends it himself.
function buildReminderMessage(m, reminderType = 'today', leadMinutes = REMINDER_MINUTES_DEFAULT) {
  const dual = formatDualTime(m.start);
  const ctTime = new Date(m.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LYNDSAY_TIMEZONE });
  const count = (m.attendees || []).length;
  const lines = reminderType === 'tomorrow'
    ? [`📅 Tomorrow reminder: ${m.subject} is scheduled for tomorrow at ${ctTime} CT.`, `🕐 ${dual} — ${m.platform}`, `👥 ${count} attendee(s)`]
    : [`📅 Reminder: ${m.subject} starts in ${leadMinutes} minutes.`, `🕐 ${dual} — ${m.platform}`, `👥 ${count} attendee(s)`];
  if (m.joinUrl) lines.push(m.joinUrl);
  lines.push('', '⚠️ If Lyndsay doesn\'t respond, call her on WhatsApp.');
  return lines.join('\n');
}

// Reads the Lyndsay message queue with old sent items auto-purged — anything
// sent AND created more than 24h ago is dropped so the queue doesn't grow
// forever. Used everywhere the queue is read, so the purge is transparent
// (runs on every load, not just at startup or on mark-sent).
async function readLyndsayQueue() {
  const queue = await readJSON(LYNDSAY_QUEUE_FILE, []);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const purged = queue.filter(q => !(q.sent && new Date(q.createdAt).getTime() < cutoff));
  if (purged.length !== queue.length) await writeJSON(LYNDSAY_QUEUE_FILE, purged);
  return purged;
}

// Auto-queues reminder messages for Lyndsay's meetings:
//  - Today's meetings: fires when the meeting is within its classified lead
//    time of starting (classifyMeeting() — client/internal/legal/default).
//  - Tomorrow's meetings: fires once (today), a heads-up so Arturo can send it
//    end-of-day today rather than scrambling tomorrow morning.
// Skips cancelled meetings and dedupes against any still-pending (not sent)
// reminder already queued for the same event + reminder type.
async function generateLyndsayReminders(lyndsayMeetings) {
  const now = new Date();
  const queue = await readLyndsayQueue();
  let changed = false;
  const alreadyQueued = (eventId, reminderType) =>
    eventId && queue.some(q => q.eventId === eventId && q.reminderType === reminderType);

  for (const m of lyndsayMeetings) {
    if (m.isCancelled) continue;
    const { meetingType, leadMinutes } = classifyMeeting(m);

    if (m.day === 'today') {
      const minutesUntil = (new Date(m.start) - now) / 60000;
      if (minutesUntil <= 0 || minutesUntil > leadMinutes) continue;
      if (alreadyQueued(m.id, 'today')) continue;
      queue.unshift({
        id: `msg_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
        eventId: m.id || null,
        meetingTitle: m.subject,
        meetingTime: m.start,
        reminderType: 'today',
        meetingType,
        reminderMinutesBefore: leadMinutes,
        text: buildReminderMessage(m, 'today', leadMinutes),
        reason: `Meeting reminder (auto, ${meetingType}, ${leadMinutes} min lead)`,
        createdAt: new Date().toISOString(),
        sent: false,
      });
      changed = true;
    } else if (m.day === 'tomorrow') {
      if (alreadyQueued(m.id, 'tomorrow')) continue;
      queue.unshift({
        id: `msg_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
        eventId: m.id || null,
        meetingTitle: m.subject,
        meetingTime: m.start,
        reminderType: 'tomorrow',
        meetingType,
        reminderMinutesBefore: leadMinutes,
        text: buildReminderMessage(m, 'tomorrow', leadMinutes),
        reason: 'Tomorrow reminder (auto)',
        createdAt: new Date().toISOString(),
        sent: false,
      });
      changed = true;
    }
  }
  if (changed) await writeJSON(LYNDSAY_QUEUE_FILE, queue);
}

// Pulls new/unread mail + today's calendar for both mailboxes and stores
// results locally. No-ops (logs a warning) until Graph credentials are set.
async function refreshEmailAndCalendar() {
  refreshState.running = true;
  if (!GRAPH_CONFIGURED) {
    logLine('[email-refresh] skipped — Graph API not configured yet (stub mode)');
    refreshState.lastRun = new Date().toISOString();
    refreshState.running = false;
    scheduleNextRun();
    return;
  }
  try {
    const token = await graphAccessToken();
    refreshState.authRequired = false;
    const mailboxes = [
      { key: 'arturo', address: MAILBOX_ARTURO },
      { key: 'lyndsay', address: MAILBOX_LYNDSAY },
    ];
    const rules = await readJSON(EMAIL_RULES_FILE, { rules: [] });
    const flagged = await readJSON(FLAGGED_FILE, []);
    const meetings = { lastUpdated: new Date().toISOString(), date: todayStr(), arturo: [], lyndsay: [] };

    for (const mb of mailboxes) {
      const headers = { Authorization: `Bearer ${token}` };

      // Unread messages
      const mailRes = await fetchFn(
        `https://graph.microsoft.com/v1.0/users/${mb.address}/mailFolders/inbox/messages?$filter=isRead eq false&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview`,
        { headers });
      const mailJson = await mailRes.json().catch(() => ({}));
      const messages = mailJson.value || [];

      for (const msg of messages) {
        const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || '';
        const subject = msg.subject || '';
        const matched = (rules.rules || []).find(r =>
          (r.senderContains && sender.toLowerCase().includes(r.senderContains.toLowerCase())) ||
          (r.subjectContains && subject.toLowerCase().includes(r.subjectContains.toLowerCase())));
        if (matched && matched.action === 'flag-for-lyndsay') {
          flagged.push({
            id: `flag_${msg.id}`,
            mailbox: mb.key,
            subject, sender,
            receivedAt: msg.receivedDateTime,
            preview: msg.bodyPreview,
            handled: false,
            flaggedAt: new Date().toISOString(),
          });
        }
      }

      // Today + tomorrow's calendar (48h window)
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setDate(end.getDate() + 1); end.setHours(23, 59, 59, 999);
      const calRes = await fetchFn(
        `https://graph.microsoft.com/v1.0/users/${mb.address}/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,location,attendees,onlineMeeting,bodyPreview,isAllDay,showAs,organizer`,
        { headers });
      const calJson = await calRes.json().catch(() => ({}));
      const events = calJson.value || [];
      const tmrwStr = tomorrowStr();

      meetings[mb.key] = events.map(e => {
        const { platform, joinUrl } = detectMeetingPlatform(e);
        const start = normalizeGraphDateTime(e.start?.dateTime);
        const end = normalizeGraphDateTime(e.end?.dateTime);
        const startLocalDate = start ? localDateStr(start) : todayStr();
        return {
          id: e.id,
          subject: e.subject,
          start,
          end,
          day: startLocalDate === tmrwStr ? 'tomorrow' : 'today',
          isAllDay: !!e.isAllDay,
          showAs: e.showAs || 'busy',
          organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || '',
          organizerEmail: e.organizer?.emailAddress?.address || '',
          platform,
          joinUrl,
          isCancelled: !!e.isCancelled || /^cancel(l)?ed:/i.test(e.subject || ''),
          attendees: (e.attendees || []).map(a => a.emailAddress?.name || a.emailAddress?.address),
        };
      });

      // Auto-accept invites matched by rule (e.g. Roku Sirisotti)
      for (const rule of (rules.rules || [])) {
        if (rule.action !== 'always-accept-invite' || !rule.senderContains) continue;
        // Best-effort: Graph invite auto-accept would go here once mailbox
        // access is confirmed live — left as a follow-up once credentials exist.
      }
    }

    // Flag time conflicts if Arturo is expected at both calendars simultaneously.
    // Skip all-day events (not real meetings), Focus time / Viva Insights
    // auto-blocks, and anything marked "free" (informational, not blocking).
    const isRealConflictSource = m =>
      !m.isAllDay &&
      m.showAs !== 'free' &&
      !/focus time/i.test(m.subject || '') &&
      !/viva/i.test(m.organizer || '');
    for (const a of meetings.arturo) {
      if (!isRealConflictSource(a)) continue;
      for (const l of meetings.lyndsay) {
        if (!isRealConflictSource(l)) continue;
        const aStart = new Date(a.start), aEnd = new Date(a.end);
        const lStart = new Date(l.start), lEnd = new Date(l.end);
        if (aStart < lEnd && lStart < aEnd) {
          a.conflict = true; l.conflict = true;
        }
      }
    }

    await writeJSON(MEETINGS_FILE, meetings);
    await writeJSON(FLAGGED_FILE, flagged);
    await generateLyndsayReminders(meetings.lyndsay);

    // Inbox unread/total counts — separate try/catch so a failure here (e.g.
    // Lyndsay's app-only permission not propagated yet) never blocks the
    // calendar refresh above from completing and being marked successful.
    try {
      const [arturoCounts, lyndsayCounts] = await Promise.all([
        fetchInboxUnreadCount('arturo').catch(err => ({ unread: 0, total: 0, error: err.message })),
        fetchInboxUnreadCount('lyndsay').catch(err => ({ unread: 0, total: 0, error: err.message })),
      ]);
      refreshState.inboxCounts = { arturo: arturoCounts, lyndsay: lyndsayCounts, lastChecked: new Date().toISOString() };
    } catch (err) {
      logLine(`[email-refresh] inbox count fetch ERROR: ${err.message}`);
    }

    // All-mailboxes Inbox Tracking report — separate try/catch, same reason
    // as above (one mailbox's permission issue shouldn't fail the refresh).
    try {
      const rows = await fetchAllMailboxCounts();
      refreshState.inboxTracking = { lastChecked: new Date().toISOString(), rows };
    } catch (err) {
      logLine(`[email-refresh] inbox tracking fetch ERROR: ${err.message}`);
    }

    logLine('[email-refresh] completed');
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) {
      refreshState.authRequired = true;
      logLine(`[email-refresh] ${err.message}`);
    } else {
      logLine(`[email-refresh] ERROR: ${err.message}`);
    }
  } finally {
    refreshState.lastRun = new Date().toISOString();
    refreshState.running = false;
    scheduleNextRun();
  }
}

app.get('/api/email/refresh-status', (req, res) => {
  res.json({ configured: GRAPH_CONFIGURED, intervalMinutes: EMAIL_REFRESH_MINUTES, authUrl: '/auth/login', ...refreshState });
});

// Separate from calendar's "last refreshed" — lets the UI show staleness of
// the email check specifically (populated by the same cron cycle above).
app.get('/api/email/inbox-counts', (req, res) => {
  res.json(refreshState.inboxCounts || { arturo: null, lyndsay: null, lastChecked: null });
});

// Unread/total counts for ALL Metric departmental mailboxes (Inbox Tracking
// report). Served from the cache the 15-min cron keeps warm — call
// POST /api/email/refresh-now first for a guaranteed-fresh read.
app.get('/api/email/inbox-tracking', (req, res) => {
  res.json(refreshState.inboxTracking || { lastChecked: null, rows: [] });
});

// Every folder (Inbox + system + personal) across all 8 departmental
// mailboxes, computed live on request (not cached by the cron — this is
// meaningfully heavier than the inbox-only tracking above, since it also
// recurses one level into any folder with children).
app.get('/api/email/all-folders-tracking', async (req, res) => {
  try {
    const mailboxes = await fetchAllMailboxFolders();
    res.json({ lastChecked: new Date().toISOString(), mailboxes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the 8 AM CT Excel auto-fill job — lets Arturo (or a
// verification run) confirm it writes correctly without waiting for the cron.
app.post('/api/email/inbox-tracking/sync-excel', async (req, res) => {
  try {
    const result = await writeInboxTrackingToExcel();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Uploads one small file (these PDFs are all well under Graph's 4MB simple-
// upload limit) by addressing it as a path relative to a known parent
// folder ID — safer than building a full path-based URL when filenames
// contain emoji/special characters (several SOPS docx names do).
async function uploadSopsFile(base, headers, destFolderId, filename, buffer) {
  const r = await fetchFn(`${base}/items/${destFolderId}:/${encodeURIComponent(filename)}:/content`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/pdf' }, body: buffer,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error?.message || `upload error ${r.status}`);
  return json;
}

// Converts every .docx in Lyndsay's SOPS folder to PDF (via Graph's native
// format=pdf conversion — no LibreOffice/local conversion needed), splitting
// any result over SOPS_MAX_PAGES_PER_FILE pages into PartN chunks with
// pdf-lib. Optional `limit` processes only the first N files, for testing
// before running the full batch. Rate-limited (500ms between files) and
// isolates one file's failure from the rest.
async function convertSopsToPdf({ limit, names } = {}) {
  const token = await graphMailToken();
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://graph.microsoft.com/v1.0/users/${SOPS_MAILBOX}/drive`;

  let url = `${base}/root:/${SOPS_SOURCE_PATH}:/children?$top=200&$select=id,name,file`;
  let files = [];
  while (url) {
    const r = await fetchFn(url, { headers });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error?.message || `Graph error listing source folder (${r.status})`);
    files.push(...(json.value || []));
    url = json['@odata.nextLink'] || null;
  }
  files = files.filter(f => f.file && f.name.toLowerCase().endsWith('.docx'));
  if (names && names.length) {
    const wanted = new Set(names.map(n => n.toLowerCase()));
    files = files.filter(f => wanted.has(f.name.toLowerCase()));
  } else if (limit) {
    files = files.slice(0, limit);
  }

  // Ensure the SOPS-PDF destination subfolder exists.
  let destFolderId;
  const destRes = await fetchFn(`${base}/root:/${SOPS_SOURCE_PATH}/${SOPS_DEST_FOLDER_NAME}`, { headers });
  if (destRes.status === 404) {
    const parentRes = await fetchFn(`${base}/root:/${SOPS_SOURCE_PATH}`, { headers });
    const parentJson = await parentRes.json().catch(() => ({}));
    if (!parentRes.ok) throw new Error(parentJson.error?.message || `source folder "${SOPS_SOURCE_PATH}" not found`);
    const createRes = await fetchFn(`${base}/items/${parentJson.id}/children`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SOPS_DEST_FOLDER_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
    const createJson = await createRes.json().catch(() => ({}));
    if (!createRes.ok) throw new Error(createJson.error?.message || 'failed to create SOPS-PDF folder');
    destFolderId = createJson.id;
    logLine(`[sops-convert] created destination folder ${SOPS_DEST_FOLDER_NAME}`);
  } else {
    const destJson = await destRes.json().catch(() => ({}));
    if (!destRes.ok) throw new Error(destJson.error?.message || `Graph error checking dest folder (${destRes.status})`);
    destFolderId = destJson.id;
  }

  const summary = { total: files.length, converted: [], errors: [], splitFiles: [] };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const baseName = file.name.replace(/\.docx$/i, '');
    logLine(`[sops-convert] Converting ${i + 1}/${files.length}: ${file.name}...`);
    try {
      const pdfRes = await fetchFn(`${base}/items/${file.id}/content?format=pdf`, { headers });
      if (!pdfRes.ok) {
        const errJson = await pdfRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Graph conversion error ${pdfRes.status}`);
      }
      const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pageCount = pdfDoc.getPageCount();

      if (pageCount <= SOPS_MAX_PAGES_PER_FILE) {
        await uploadSopsFile(base, headers, destFolderId, `${baseName}.pdf`, pdfBuffer);
        summary.converted.push({ name: file.name, pages: pageCount });
      } else {
        const parts = Math.ceil(pageCount / SOPS_MAX_PAGES_PER_FILE);
        for (let p = 0; p < parts; p++) {
          const startPage = p * SOPS_MAX_PAGES_PER_FILE;
          const endPage = Math.min(startPage + SOPS_MAX_PAGES_PER_FILE, pageCount);
          const indices = Array.from({ length: endPage - startPage }, (_, k) => startPage + k);
          const chunkDoc = await PDFDocument.create();
          const copiedPages = await chunkDoc.copyPages(pdfDoc, indices);
          copiedPages.forEach(pg => chunkDoc.addPage(pg));
          const chunkBytes = Buffer.from(await chunkDoc.save());
          await uploadSopsFile(base, headers, destFolderId, `${baseName}-Part${p + 1}.pdf`, chunkBytes);
        }
        summary.converted.push({ name: file.name, pages: pageCount, split: parts });
        summary.splitFiles.push({ name: file.name, pages: pageCount, parts });
      }
    } catch (err) {
      logLine(`[sops-convert] ERROR converting ${file.name}: ${err.message}`);
      summary.errors.push({ name: file.name, error: err.message });
    }

    if (i < files.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  logLine(`[sops-convert] Done. Converted ${summary.converted.length}/${summary.total}, errors ${summary.errors.length}, split files ${summary.splitFiles.length}`);
  return summary;
}

// POST /api/tools/convert-sops  body: { limit?: number }
// Pass `limit` to test on the first N files before running the full batch.
app.post('/api/tools/convert-sops', async (req, res) => {
  try {
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : undefined;
    const names = Array.isArray(req.body?.names) ? req.body.names : undefined;
    const result = await convertSopsToPdf({ limit, names });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/email/refresh-now', async (req, res) => {
  await refreshEmailAndCalendar();
  res.json({ configured: GRAPH_CONFIGURED, intervalMinutes: EMAIL_REFRESH_MINUTES, authUrl: '/auth/login', ...refreshState });
});

// Resolves a Graph base URL for a mailbox key. Arturo is the signed-in
// delegated user, so /me is equivalent to /users/{his address} and is what
// Graph expects for his own mailbox; Lyndsay's is reached via the *.Shared
// scopes using her address, once she's granted Arturo delegate access. Any
// other value is treated as a raw tenant mailbox address (departmental
// mailboxes — support/collections/hello/etc.) reached via graphMailToken().
function graphMailboxBase(mailboxKey) {
  if (mailboxKey === 'arturo') return 'https://graph.microsoft.com/v1.0/me';
  if (mailboxKey === 'lyndsay') return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX_LYNDSAY)}`;
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxKey)}`;
}

function shapeInboxMessage(m, mailboxKey) {
  return {
    id: m.id,
    subject: m.subject || '',
    sender: {
      name: m.sender?.emailAddress?.name || m.from?.emailAddress?.name || '',
      email: m.sender?.emailAddress?.address || m.from?.emailAddress?.address || '',
    },
    receivedAt: m.receivedDateTime,
    isRead: !!m.isRead,
    hasAttachments: !!m.hasAttachments,
    preview: (m.bodyPreview || '').slice(0, 150),
    importance: m.importance || 'normal',
    mailbox: mailboxKey,
  };
}

// Gets a per-mailbox delegated/app-only token depending on which mailbox —
// same split used everywhere else: Lyndsay's mail uses the app-only token
// (no Mail/Inbox delegate access granted to Arturo), Arturo's own mailbox
// uses the delegated token.
async function graphMailboxToken(mailboxKey) {
  // Arturo's own mailbox is the only one reached with the delegated token —
  // Lyndsay's and every departmental mailbox (raw email addresses) use the
  // app-only token, since delegate access was never granted for those.
  return mailboxKey === 'arturo' ? graphAccessToken() : graphMailToken();
}

// Cheap unread/total count for a mailbox's Inbox — reads the folder's own
// unreadItemCount/totalItemCount metadata directly instead of paging messages.
async function fetchInboxUnreadCount(mailboxKey) {
  const token = await graphMailboxToken(mailboxKey);
  const url = `${graphMailboxBase(mailboxKey)}/mailFolders/Inbox?$select=unreadItemCount,totalItemCount`;
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error?.message || `Graph error ${r.status}`);
  return { unread: json.unreadItemCount || 0, total: json.totalItemCount || 0 };
}

// Flat unread/total counts for every row in INBOX_TRACKING_MAPPING — both
// mailbox-level (folderName: "Inbox") and personal per-person folder rows.
// Fetches each mailbox's folder list ONCE (via listMailFolders, app-only
// graphMailToken()) and matches every mapped row against it, rather than
// one Graph call per row. A failure on one mailbox reports an error on just
// that mailbox's rows, not fatal to the rest.
// Strip any leading non-letter/non-digit characters before comparing —
// some old Deleted Items folders carry a stray private-use glyph prefix
// (e.g. hello@'s "Oscar" folder is literally " Oscar", not a plain
// space) left over from an old Outlook rule/icon, not real whitespace so
// .trim() alone doesn't catch it.
const normalizeFolderName = s => (s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();

async function resolveNestedFolder(email, token, pathSegments) {
  const headers = { Authorization: `Bearer ${token}` };
  const base = graphMailboxBase(email);

  const topRes = await fetchFn(`${base}/mailFolders?$select=id,displayName&$top=50`, { headers });
  const topJson = await topRes.json().catch(() => ({}));
  if (!topRes.ok) throw new Error(topJson.error?.message || `Graph error ${topRes.status}`);
  let current = (topJson.value || []).find(f => normalizeFolderName(f.displayName) === normalizeFolderName(pathSegments[0]));
  if (!current) return null;

  for (let i = 1; i < pathSegments.length; i++) {
    const childRes = await fetchFn(`${base}/mailFolders/${encodeURIComponent(current.id)}/childFolders?$select=id,displayName,unreadItemCount,totalItemCount&$top=50`, { headers });
    const childJson = await childRes.json().catch(() => ({}));
    if (!childRes.ok) throw new Error(childJson.error?.message || `Graph error ${childRes.status}`);
    current = (childJson.value || []).find(f => normalizeFolderName(f.displayName) === normalizeFolderName(pathSegments[i]));
    if (!current) return null;
  }
  return current;
}

async function fetchAllMailboxCounts() {
  const token = await graphMailToken();
  const byEmail = new Map();
  for (const row of INBOX_TRACKING_MAPPING) {
    if (!byEmail.has(row.email)) byEmail.set(row.email, []);
    byEmail.get(row.email).push(row);
  }

  const results = await Promise.all([...byEmail.entries()].map(async ([email, rows]) => {
    const simpleRows = rows.filter(r => !r.folderPath);
    const pathRows = rows.filter(r => r.folderPath);
    const out = [];

    try {
      if (simpleRows.length) {
        const folders = await listMailFolders(email, token);
        out.push(...simpleRows.map(row => {
          // Personal folders are sometimes nested (e.g. "Katie" lives under
          // support@'s Inbox, not top-level) and occasionally duplicated
          // under Deleted Items from an old cleanup - prefer a top-level
          // match, then any non-Deleted-Items match, and only fall back to
          // a Deleted Items copy (flagged) if that's genuinely the only one.
          const candidates = folders.filter(f => normalizeFolderName(f.displayName) === normalizeFolderName(row.folderName));
          const match = candidates.find(f => !f.parentName)
            || candidates.find(f => f.parentName !== 'Deleted Items')
            || candidates[0];
          if (!match) {
            logLine(`[inbox-tracking] folder "${row.folderName}" not found in ${email}`);
            return { ...row, unread: null, total: null, error: `folder "${row.folderName}" not found` };
          }
          const result = { ...row, unread: match.unreadItemCount || 0, total: match.totalItemCount || 0 };
          if (match.parentName === 'Deleted Items') {
            result.note = `only found under Deleted Items - verify this is the intended "${row.folderName}" folder`;
            logLine(`[inbox-tracking] WARNING: "${row.folderName}" in ${email} only found under Deleted Items`);
          }
          return result;
        }));
      }
    } catch (err) {
      logLine(`[inbox-tracking] ${email} ERROR: ${err.message}`);
      out.push(...simpleRows.map(row => ({ ...row, unread: null, total: null, error: err.message })));
    }

    // Rows nested deeper than listMailFolders()'s one-level recursion
    // (folderPath: an array of names walked from a top-level folder down)
    // are resolved individually via resolveNestedFolder(). A failure here
    // (e.g. Sammy Ramos's different-domain mailbox being 403/404) only
    // skips that row, logged as a warning, never fatal to the rest.
    for (const row of pathRows) {
      const derivedFolderName = row.folderName || row.folderPath[row.folderPath.length - 1];
      try {
        const folder = await resolveNestedFolder(email, token, row.folderPath);
        if (!folder) {
          const msg = `nested folder path "${row.folderPath.join(' > ')}" not found in ${email}`;
          logLine(`[inbox-tracking] WARNING: ${msg}`);
          out.push({ ...row, folderName: derivedFolderName, unread: null, total: null, error: msg });
        } else {
          out.push({ ...row, folderName: derivedFolderName, unread: folder.unreadItemCount || 0, total: folder.totalItemCount || 0 });
        }
      } catch (err) {
        logLine(`[inbox-tracking] WARNING: nested folder path "${row.folderPath.join(' > ')}" in ${email} ERROR: ${err.message}`);
        out.push({ ...row, folderName: derivedFolderName, unread: null, total: null, error: err.message });
      }
    }

    return out;
  }));
  return results.flat();
}

// Departmental mailboxes only (excludes lyndsay@ — her folders are already
// covered by the dedicated get_lyndsay_folders/get_lyndsay_folder_emails
// tools, so listing them again here would be redundant).
const DEPARTMENTAL_MAILBOXES = METRIC_MAILBOXES.filter(e => e !== MAILBOX_LYNDSAY);

// Every folder (Inbox + everything else — system folders like Sent/Deleted
// AND personal per-person folders, unfiltered) with unread/total counts,
// across all departmental mailboxes. Used to discover what personal folders
// exist inside each mailbox (e.g. "Arturo", "Katie" inside support@) so the
// Excel sync can eventually be extended to write per-person counts too.
async function fetchAllMailboxFolders() {
  const token = await graphMailToken();
  return Promise.all(DEPARTMENTAL_MAILBOXES.map(async (email) => {
    const displayName = METRIC_MAILBOX_NAMES[email] || email;
    try {
      const folders = await listMailFolders(email, token);
      const inboxFolder = folders.find(f => f.displayName === 'Inbox' && !f.parentName);
      const others = folders.filter(f => f !== inboxFolder);
      return {
        email,
        displayName,
        inbox: { unread: inboxFolder?.unreadItemCount || 0, total: inboxFolder?.totalItemCount || 0 },
        folders: others.map(f => ({
          name: f.displayName,
          unread: f.unreadItemCount || 0,
          total: f.totalItemCount || 0,
          parent: f.parentName || null,
        })),
      };
    } catch (err) {
      logLine(`[all-folders-tracking] ${email} ERROR: ${err.message}`);
      return { email, displayName, error: err.message };
    }
  }));
}

// Excel serial-date <-> JS Date helpers (Excel's epoch is 1899-12-30, not
// 1900-01-01, due to the historical Lotus 1-2-3 leap-year bug it inherited).
function excelSerialToDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}
function dateToExcelSerial(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
}
function excelColLetter(n) {
  let s = '';
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Writes today's unread counts into the SharePoint "Inbox Tracking" sheet —
// automates what team members currently type in by hand each morning.
// Row 10 holds one date per column starting at B10 (2025-10-08, sequential,
// no gaps through end of 2026); today's column is located by offsetting from
// B10's date and then verified by reading that exact cell back, since a
// wrong offset would otherwise silently write to the wrong day.
async function writeInboxTrackingToExcel() {
  const token = await graphMailToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://graph.microsoft.com/v1.0/drives/${EXCEL_DRIVE_ID}/items/${EXCEL_ITEM_ID}/workbook/worksheets('${EXCEL_SHEET_NAME}')`;

  const baseCellRes = await fetchFn(`${base}/range(address='B10')`, { headers });
  const baseCellJson = await baseCellRes.json().catch(() => ({}));
  if (!baseCellRes.ok) throw new Error(baseCellJson.error?.message || `Graph error reading B10 (${baseCellRes.status})`);
  const baseSerial = baseCellJson.values?.[0]?.[0];
  if (typeof baseSerial !== 'number') throw new Error('B10 in "Inbox Tracking" is not a date serial — sheet layout may have changed');

  const nowCT = new Date(new Date().toLocaleString('en-US', { timeZone: LYNDSAY_TIMEZONE }));
  const todaySerial = dateToExcelSerial(nowCT);
  const colLetter = excelColLetter(2 + (todaySerial - baseSerial)); // column B = index 2

  const checkRes = await fetchFn(`${base}/range(address='${colLetter}10')`, { headers });
  const checkJson = await checkRes.json().catch(() => ({}));
  if (checkJson.values?.[0]?.[0] !== todaySerial) {
    throw new Error(`Could not locate today's column in "Inbox Tracking" — expected serial ${todaySerial} at ${colLetter}10, found ${checkJson.values?.[0]?.[0]}`);
  }

  // Row numbers can shift if someone inserts/deletes a row in the sheet, so
  // look them up by label every run instead of hardcoding row indices.
  const labelsRes = await fetchFn(`${base}/range(address='A1:A80')`, { headers });
  const labelsJson = await labelsRes.json().catch(() => ({}));
  const labelRows = new Map();
  const duplicateLabels = new Set();
  (labelsJson.values || []).forEach((row, i) => {
    const label = String(row[0] || '').trim().toLowerCase();
    if (!label) return;
    // First occurrence wins if a label is duplicated in the sheet (flagged
    // below) - deterministic and matches how a human reading top-to-bottom
    // would pick "the" row for that label.
    if (labelRows.has(label)) { duplicateLabels.add(label); return; }
    labelRows.set(label, i + 1); // 1-indexed row number
  });
  if (duplicateLabels.size) {
    logLine(`[inbox-tracking-excel] WARNING: duplicate row label(s) in column A, used first occurrence: ${[...duplicateLabels].join(', ')}`);
  }

  const trackedRows = await fetchAllMailboxCounts();
  const results = [];
  for (const tr of trackedRows) {
    const row = labelRows.get(String(tr.rowLabel || '').trim().toLowerCase());
    if (!row) { results.push({ rowLabel: tr.rowLabel, email: tr.email, skipped: `label "${tr.rowLabel}" not found in column A` }); continue; }
    if (tr.unread === null) { results.push({ rowLabel: tr.rowLabel, email: tr.email, skipped: `fetch error: ${tr.error}` }); continue; }

    const cell = `${colLetter}${row}`;
    // Writing 18 cells in quick succession against the same Excel session
    // occasionally trips a transient 502/503 from Graph — retry those a
    // couple times with a short backoff before giving up on that cell.
    let writeRes, writeErrJson;
    for (let attempt = 0; attempt < 3; attempt++) {
      writeRes = await fetchFn(`${base}/range(address='${cell}')`, {
        method: 'PATCH', headers, body: JSON.stringify({ values: [[tr.unread]] }),
      });
      if (writeRes.ok) break;
      writeErrJson = await writeRes.json().catch(() => ({}));
      if (writeRes.status !== 502 && writeRes.status !== 503) break;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
    if (!writeRes.ok) {
      results.push({ rowLabel: tr.rowLabel, email: tr.email, cell, error: writeErrJson?.error?.message || `Graph error ${writeRes.status}` });
    } else {
      results.push({ rowLabel: tr.rowLabel, email: tr.email, cell, unread: tr.unread });
    }
  }
  logLine(`[inbox-tracking-excel] wrote column ${colLetter} (${nowCT.toDateString()}): ${JSON.stringify(results)}`);
  return { column: colLetter, results, duplicateRowLabels: [...duplicateLabels] };
}

async function fetchFolderChildren(mailboxKey, token, parentId) {
  const url = `${graphMailboxBase(mailboxKey)}/mailFolders/${encodeURIComponent(parentId)}/childFolders?$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount&$top=50`;
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json().catch(() => ({}));
  return r.ok ? (json.value || []) : [];
}

// Graph's GET /mailFolders only returns TOP-LEVEL folders — several of
// Lyndsay's real folders (Lyndsay Review, Need to File, Rhoxie To Do, etc.)
// are nested one level down, typically under Inbox. Pull one level of
// children for every top-level folder that has any, so all of them are
// discoverable by name.
async function listMailFolders(mailboxKey, token) {
  const url = `${graphMailboxBase(mailboxKey)}/mailFolders?$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount&$top=50`;
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error?.message || `Graph error ${r.status}`);
  const topLevel = json.value || [];

  const all = [...topLevel];
  for (const folder of topLevel) {
    if (!folder.childFolderCount) continue;
    const children = await fetchFolderChildren(mailboxKey, token, folder.id);
    all.push(...children.map(c => ({ ...c, parentName: folder.displayName })));
  }
  return all;
}

// Resolves a folder name to the path segment Graph's /mailFolders/{x}/messages
// expects. "Inbox" is a well-known name Graph resolves on its own; any other
// folder (Lyndsay Review, Need to File, Rhoxie To Do, ...) must be looked up
// by displayName first since Graph won't resolve arbitrary names in the path.
async function resolveFolderPath(mailboxKey, token, folderName) {
  if (!folderName || folderName.toLowerCase() === 'inbox') return 'inbox';
  const folders = await listMailFolders(mailboxKey, token);
  const match = folders.find(f => (f.displayName || '').toLowerCase() === folderName.toLowerCase());
  if (!match) throw new Error(`Folder "${folderName}" not found`);
  return match.id;
}

// Lists all mail folders (with unread/total counts) for a mailbox — lets
// Arturo discover what's available beyond the Inbox (Lyndsay Review, Need to
// File, Rhoxie To Do, Client Emails, etc.) before reading a specific one.
// GET /api/email/folders?mailbox=lyndsay|arturo|both|<any tenant email>
// Any value other than lyndsay/arturo/both is treated as a raw departmental
// mailbox address (support@, collections@, etc.) and read via graphMailToken().
app.get('/api/email/folders', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env once the Azure App Registration is ready.' });
  }
  const mailboxParam = (req.query.mailbox || 'lyndsay').toLowerCase();
  const targets = mailboxParam === 'both' ? ['lyndsay', 'arturo'] : [mailboxParam];
  const perMailbox = {};
  for (const key of targets) {
    let token;
    try {
      token = await graphMailboxToken(key);
    } catch (err) {
      if (err instanceof GraphAuthRequiredError) { perMailbox[key] = { authRequired: true, message: err.message }; continue; }
      perMailbox[key] = { error: err.message };
      continue;
    }
    try {
      const folders = await listMailFolders(key, token);
      perMailbox[key] = { folders: folders.map(f => ({ id: f.id, name: f.displayName, parent: f.parentName || null, unreadCount: f.unreadItemCount, totalCount: f.totalItemCount })) };
    } catch (err) {
      perMailbox[key] = { error: err.message };
    }
  }
  if (targets.length === 1) return res.json({ configured: true, mailbox: targets[0], ...perMailbox[targets[0]] });
  res.json({ configured: true, mailbox: 'both', ...perMailbox });
});

// Cross-folder search. NOTE: the unified Microsoft Search API
// (/search/query) does NOT support entityTypes:['message'] under
// application permissions at all ("Application permission is only
// supported for... site, list, listItem, drive, driveItem") — a hard
// platform limitation, not something fixable with a parameter. Since
// Lyndsay's mail uses an application-permission token, we use the regular
// mail API's mailbox-wide /messages collection with $search instead — that
// endpoint spans every folder in the mailbox (Inbox, Deleted Items, all
// custom folders) in one call and works under both delegated and
// application permissions. Read-only, same response shape as /api/email/inbox.
// GET /api/email/search?mailbox=lyndsay|arturo&q=OpenAI&limit=10
app.get('/api/email/search', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env once the Azure App Registration is ready.' });
  }
  const q = req.query.q || '';
  if (!q.trim()) return res.status(400).json({ error: 'q (search term) is required' });
  const mailboxKey = (req.query.mailbox || 'lyndsay').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  let token;
  try {
    token = await graphMailboxToken(mailboxKey);
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) return res.json({ configured: true, authRequired: true, message: err.message });
    return res.status(500).json({ error: err.message });
  }

  try {
    const select = 'id,subject,sender,from,receivedDateTime,isRead,hasAttachments,bodyPreview,importance';
    const searchParam = encodeURIComponent(`"${q}"`);
    const url = `${graphMailboxBase(mailboxKey)}/messages?$search=${searchParam}&$top=${limit}&$select=${select}`;
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: json.error?.message || `Graph error ${r.status}` });
    const emails = (json.value || []).map(m => shapeInboxMessage(m, mailboxKey));
    res.json({ configured: true, mailbox: mailboxKey, query: q, count: emails.length, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only inbox reader — no marking as read, moving, or deleting.
// GET /api/email/inbox?mailbox=lyndsay|arturo|both&limit=50&unread=true&folder=Inbox
app.get('/api/email/inbox', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env once the Azure App Registration is ready.' });
  }

  const mailboxParam = (req.query.mailbox || 'lyndsay').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const unreadOnly = req.query.unread === 'true';
  const folder = req.query.folder || 'Inbox';
  const targets = mailboxParam === 'both' ? ['lyndsay', 'arturo'] : [mailboxParam];
  const select = 'id,subject,sender,from,receivedDateTime,isRead,hasAttachments,bodyPreview,importance';

  const perMailbox = {};
  for (const key of targets) {
    // Lyndsay's Mail/Inbox delegate access was never granted to Arturo, so her
    // mail uses the app-only (client credentials) token instead of the
    // delegated one. Arturo's own mailbox keeps using the delegated token.
    let token;
    try {
      token = await graphMailboxToken(key);
    } catch (err) {
      if (err instanceof GraphAuthRequiredError) { perMailbox[key] = { authRequired: true, message: err.message }; continue; }
      perMailbox[key] = { error: err.message };
      continue;
    }
    const headers = { Authorization: `Bearer ${token}` };
    let folderPath;
    try {
      folderPath = await resolveFolderPath(key, token, folder);
    } catch (err) {
      perMailbox[key] = { error: err.message };
      continue;
    }
    const filterPart = unreadOnly ? '&$filter=isRead eq false' : '';
    const url = `${graphMailboxBase(key)}/mailFolders/${encodeURIComponent(folderPath)}/messages?$top=${limit}&$select=${select}&$orderby=receivedDateTime desc${filterPart}`;
    try {
      const r = await fetchFn(url, { headers });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) { perMailbox[key] = { error: json.error?.message || `Graph error ${r.status}` }; continue; }
      const emails = (json.value || []).map(m => shapeInboxMessage(m, key));
      perMailbox[key] = { count: emails.length, emails, folder };
    } catch (err) {
      perMailbox[key] = { error: err.message };
    }
  }

  if (targets.length === 1) return res.json({ configured: true, mailbox: targets[0], ...perMailbox[targets[0]] });
  res.json({ configured: true, mailbox: 'both', ...perMailbox });
});

// Read-only single-message reader (full body) — for classifying an email
// that needs more context than the inbox preview gives.
// GET /api/email/message/:id?mailbox=lyndsay|arturo
app.get('/api/email/message/:id', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env once the Azure App Registration is ready.' });
  }
  const mailboxKey = (req.query.mailbox || 'lyndsay').toLowerCase();
  let token;
  try {
    token = await graphMailboxToken(mailboxKey);
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) return res.json({ configured: true, authRequired: true, message: err.message });
    return res.status(500).json({ error: err.message });
  }
  const url = `${graphMailboxBase(mailboxKey)}/messages/${encodeURIComponent(req.params.id)}?$select=id,subject,sender,from,receivedDateTime,body,isRead,hasAttachments`;
  try {
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: json.error?.message || `Graph error ${r.status}` });
    res.json({
      configured: true,
      id: json.id,
      subject: json.subject || '',
      sender: {
        name: json.sender?.emailAddress?.name || json.from?.emailAddress?.name || '',
        email: json.sender?.emailAddress?.address || json.from?.emailAddress?.address || '',
      },
      receivedAt: json.receivedDateTime,
      isRead: !!json.isRead,
      hasAttachments: !!json.hasAttachments,
      body: json.body?.content || '',
      bodyType: json.body?.contentType || 'text',
      mailbox: mailboxKey,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Copilot Export — secure read of Lyndsay's latest 100 inbox emails ----
// Internal route for the dashboard UI — no auth required (same-origin, never
// exposes COPILOT_API_KEY to the browser). External callers must use
// /api/copilot/export with a valid x-api-key header.
app.get('/api/copilot/export-internal', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.status(503).json({ error: 'Graph API not configured — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env.' });
  }
  let token;
  try {
    token = await graphMailboxToken('lyndsay');
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) return res.status(503).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
  try {
    const select = 'id,subject,sender,from,receivedDateTime,isRead,hasAttachments,bodyPreview,importance';
    const url = `${graphMailboxBase('lyndsay')}/mailFolders/inbox/messages?$top=100&$orderby=receivedDateTime desc&$select=${select}`;
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: json.error?.message || `Graph error ${r.status}` });
    const raw = json.value || [];
    const emails = raw.map(m => ({
      id: m.id,
      subject: m.subject || '',
      sender: m.sender?.emailAddress?.name || m.from?.emailAddress?.name || '',
      senderEmail: m.sender?.emailAddress?.address || m.from?.emailAddress?.address || '',
      receivedAt: m.receivedDateTime || null,
      isRead: !!m.isRead,
      importance: m.importance || 'normal',
      hasAttachments: !!m.hasAttachments,
      preview: m.bodyPreview || '',
    }));
    const unreadCount = emails.filter(e => !e.isRead).length;
    res.json({
      generatedAt: new Date().toISOString(),
      mailbox: MAILBOX_LYNDSAY,
      unreadCount,
      totalCount: emails.length,
      emails,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validates x-api-key against COPILOT_API_KEY env var before serving.
function requireCopilotApiKey(req, res, next) {
  if (!process.env.COPILOT_API_KEY) {
    return res.status(500).json({ error: 'COPILOT_API_KEY is not configured on this server.' });
  }
  if (req.headers['x-api-key'] !== process.env.COPILOT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/copilot/export', requireCopilotApiKey, async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.status(503).json({ error: 'Graph API not configured — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env.' });
  }
  let token;
  try {
    token = await graphMailboxToken('lyndsay');
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) return res.status(503).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
  try {
    const select = 'id,subject,sender,from,receivedDateTime,isRead,hasAttachments,bodyPreview,importance';
    const url = `${graphMailboxBase('lyndsay')}/mailFolders/inbox/messages?$top=100&$orderby=receivedDateTime desc&$select=${select}`;
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: json.error?.message || `Graph error ${r.status}` });
    const raw = json.value || [];
    const emails = raw.map(m => ({
      id: m.id,
      subject: m.subject || '',
      sender: m.sender?.emailAddress?.name || m.from?.emailAddress?.name || '',
      senderEmail: m.sender?.emailAddress?.address || m.from?.emailAddress?.address || '',
      receivedAt: m.receivedDateTime || null,
      isRead: !!m.isRead,
      importance: m.importance || 'normal',
      hasAttachments: !!m.hasAttachments,
      preview: m.bodyPreview || '',
    }));
    const unreadCount = emails.filter(e => !e.isRead).length;
    res.json({
      generatedAt: new Date().toISOString(),
      mailbox: MAILBOX_LYNDSAY,
      unreadCount,
      totalCount: emails.length,
      emails,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/triage/log-session -----------------------------------------------
// Inserts one triage session record into Supabase triage_sessions table.
app.post('/api/triage/log-session', async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const db = supabaseAdmin || supabasePublic;
  const {
    session_date, emails_processed, lyndsay_review, bekah_follow_up,
    rocio, mpm_team, clients, archive, unsubscribe, do_not_move,
    manual_corrections, correction_notes, confidence_avg,
  } = req.body || {};
  if (!emails_processed && emails_processed !== 0) {
    return res.status(400).json({ error: 'emails_processed is required' });
  }
  const row = {
    session_date:       session_date       || undefined,
    emails_processed:   emails_processed   ?? 0,
    lyndsay_review:     lyndsay_review     ?? 0,
    bekah_follow_up:    bekah_follow_up    ?? 0,
    rocio:              rocio              ?? 0,
    mpm_team:           mpm_team           ?? 0,
    clients:            clients            ?? 0,
    archive:            archive            ?? 0,
    unsubscribe:        unsubscribe        ?? 0,
    do_not_move:        do_not_move        ?? 0,
    manual_corrections: manual_corrections ?? 0,
    correction_notes:   correction_notes   || null,
    confidence_avg:     confidence_avg     ?? null,
  };
  const { data, error } = await db.from('triage_sessions').insert([row]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true, session: data });
});

// ---- GET /api/triage/summary ----------------------------------------------------
// Returns cumulative stats across all triage sessions.
app.get('/api/triage/summary', async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const db = supabaseAdmin || supabasePublic;

  const { data, error } = await db
    .from('triage_sessions')
    .select('*')
    .order('session_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const sessions = data || [];
  const total_sessions = sessions.length;

  // Cumulative counters
  const totals = {
    emails_processed:   0,
    lyndsay_review:     0,
    bekah_follow_up:    0,
    rocio:              0,
    mpm_team:           0,
    clients:            0,
    archive:            0,
    unsubscribe:        0,
    do_not_move:        0,
    manual_corrections: 0,
  };
  let confidenceSum = 0, confidenceCount = 0;
  for (const s of sessions) {
    for (const k of Object.keys(totals)) totals[k] += (s[k] || 0);
    if (s.confidence_avg != null) { confidenceSum += parseFloat(s.confidence_avg); confidenceCount++; }
  }

  const accuracy_rate = totals.emails_processed > 0
    ? ((totals.emails_processed - totals.manual_corrections) / totals.emails_processed)
    : null;

  // Weekly corrections trend: group by ISO week
  const weeklyMap = {};
  for (const s of sessions) {
    const d = new Date(s.session_date);
    // ISO week number
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    if (!weeklyMap[key]) weeklyMap[key] = { week: key, sessions: 0, emails: 0, corrections: 0 };
    weeklyMap[key].sessions    += 1;
    weeklyMap[key].emails      += (s.emails_processed || 0);
    weeklyMap[key].corrections += (s.manual_corrections || 0);
  }
  const weekly_trend = Object.values(weeklyMap).sort((a, b) => a.week.localeCompare(b.week));

  res.json({
    ok: true,
    total_sessions,
    totals,
    accuracy_rate: accuracy_rate !== null ? parseFloat(accuracy_rate.toFixed(4)) : null,
    accuracy_pct:  accuracy_rate !== null ? `${(accuracy_rate * 100).toFixed(1)}%` : null,
    confidence_avg_overall: confidenceCount > 0 ? parseFloat((confidenceSum / confidenceCount).toFixed(4)) : null,
    weekly_trend,
  });
});

// ---- POST /api/email/setup-outlook-rules ----------------------------------------
// Creates 8 Outlook message rules in Lyndsay's inbox via Graph API.
// Requires MailboxSettings.ReadWrite application permission.
// Idempotent-ish: skips rules whose displayName already exists.
app.post('/api/email/setup-outlook-rules', async (req, res) => {
  if (!GRAPH_CONFIGURED) return res.status(503).json({ error: 'Graph API not configured' });
  try {
    const token = await graphMailboxToken('lyndsay');
    const base  = graphMailboxBase('lyndsay');
    const h     = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ── 1. Resolve Archive folder ID ────────────────────────────────────────
    const archR = await fetchFn(`${base}/mailFolders/archive`, { headers: h });
    const archJ = await archR.json();
    if (!archR.ok) return res.status(502).json({ error: `Cannot resolve Archive folder: ${archJ.error?.message}` });
    const archiveId = archJ.id;

    // ── 2. Find or create "Rocio" folder in Inbox ────────────────────────────
    const childR = await fetchFn(`${base}/mailFolders/inbox/childFolders?$top=100`, { headers: h });
    const childJ = await childR.json();
    let rocioFolder = (childJ.value || []).find(f => f.displayName.toLowerCase() === 'rocio');
    let rocioCreated = false;
    let rocioError = null;
    if (!rocioFolder) {
      const mkR = await fetchFn(`${base}/mailFolders/inbox/childFolders`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ displayName: 'Rocio' }),
      });
      const mkJ = await mkR.json();
      if (mkR.ok) {
        rocioFolder = mkJ;
        rocioCreated = true;
      } else {
        rocioError = mkJ.error?.message || 'Access denied — add Mail.ReadWrite application permission';
      }
    }
    const rocioId = rocioFolder?.id || null;

    // ── 3. Fetch existing rule names (to skip duplicates) ────────────────────
    const existR = await fetchFn(`${base}/mailFolders/inbox/messageRules?$top=250`, { headers: h });
    const existJ = await existR.json();
    const existingNames = new Set((existJ.value || []).map(r => r.displayName.toLowerCase()));

    // ── 4. Rule definitions ──────────────────────────────────────────────────
    const rules = [
      {
        displayName: 'SimpleVoip no-reply → Archive',
        conditions: { senderContains: ['noreply@simplevoip.com'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'AppFolio Mailer → Archive',
        conditions: { senderContains: ['communications@metricpropertymanagement.mailer.appfolio.us'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'AppFolio Box Score → Archive',
        conditions: { senderContains: ['donotreply@appfolio.com'], subjectContains: ['Box Score'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'AppFolio Bank Feed → Archive',
        conditions: { senderContains: ['donotreply@appfolio.com'], subjectContains: ['Bank Feed'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'WebWork no-reply → Archive',
        conditions: { senderContains: ['noreply@webwork-tracker.com'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'Supabase welcome → Archive',
        conditions: { senderContains: ['welcome@supabase.com'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'Asana no-reply → Archive',
        conditions: { senderContains: ['no-reply@asana.com'] },
        actions:    { moveToFolder: archiveId, stopProcessingRules: true },
      },
      {
        displayName: 'AppFolio countersign → Rocio',
        conditions: { senderContains: ['donotreply@appfolio.com'], subjectContains: ['countersign'] },
        actions:    { moveToFolder: rocioId, stopProcessingRules: true },
      },
    ];

    // ── 5. Create each rule, skip if display name already exists ─────────────
    const results = [];
    for (const rule of rules) {
      if (existingNames.has(rule.displayName.toLowerCase())) {
        results.push({ rule: rule.displayName, status: 'skipped (already exists)' });
        continue;
      }
      // Skip rules that require rocioId if folder creation failed
      if (rule.actions.moveToFolder === rocioId && !rocioId) {
        results.push({ rule: rule.displayName, status: 'skipped (Rocio folder unavailable)', error: rocioError });
        continue;
      }
      const body = { displayName: rule.displayName, sequence: 1, isEnabled: true,
                     conditions: rule.conditions, actions: rule.actions };
      const r = await fetchFn(`${base}/mailFolders/inbox/messageRules`, {
        method: 'POST', headers: h, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        results.push({ rule: rule.displayName, status: 'created', id: j.id });
      } else {
        results.push({ rule: rule.displayName, status: 'error', error: j.error?.message });
      }
    }

    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status.startsWith('skipped')).length;
    const errors  = results.filter(r => r.status === 'error').length;
    res.json({ ok: true, summary: { created, skipped, errors }, rocioFolderCreated: rocioCreated, rocioError: rocioError || undefined, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real unread/total counts + top senders per mailbox — backs get_email_triage_status.
app.get('/api/email/triage', async (req, res) => {
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env once the Azure App Registration is ready.' });
  }
  // Lyndsay's mail uses the app-only token (no Mail/Inbox delegate access);
  // Arturo's own mailbox keeps using the delegated token.
  async function summarize(mailboxKey) {
    let token;
    try {
      token = await graphMailboxToken(mailboxKey);
    } catch (err) {
      if (err instanceof GraphAuthRequiredError) return { unread: 0, total: 0, authRequired: true, message: err.message };
      return { unread: 0, total: 0, error: err.message };
    }
    const url = `${graphMailboxBase(mailboxKey)}/mailFolders/Inbox/messages?$top=100&$select=id,sender,from,isRead`;
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { unread: 0, total: 0, error: json.error?.message || `Graph error ${r.status}` };
    const emails = json.value || [];
    const unreadEmails = emails.filter(m => !m.isRead);
    const senderCounts = {};
    for (const m of unreadEmails) {
      const name = m.sender?.emailAddress?.name || m.from?.emailAddress?.name || 'Unknown';
      senderCounts[name] = (senderCounts[name] || 0) + 1;
    }
    const topSenders = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
    return { unread: unreadEmails.length, total: emails.length, topSenders };
  }
  try {
    const [lyndsay, arturoFull] = await Promise.all([summarize('lyndsay'), summarize('arturo')]);
    const { topSenders, ...arturo } = arturoFull; // topSenders omitted for Arturo, per spec
    res.json({ configured: true, lastRefreshed: refreshState.lastRun, lyndsay, arturo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email/flagged-for-lyndsay', async (req, res) => {
  const flagged = await readJSON(FLAGGED_FILE, []);
  res.json(flagged.filter(f => !f.handled));
});

app.post('/api/email/:id/handled', async (req, res) => {
  const flagged = await readJSON(FLAGGED_FILE, []);
  const idx = flagged.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  flagged[idx].handled = true;
  flagged[idx].handledAt = new Date().toISOString();
  await writeJSON(FLAGGED_FILE, flagged);
  res.json({ ok: true });
});

app.get('/api/calendar/today', async (req, res) => {
  const { mailbox } = req.query;
  const meetings = await readJSON(MEETINGS_FILE, { lastUpdated: null, date: null, arturo: [], lyndsay: [] });
  if (!GRAPH_CONFIGURED) {
    return res.json({ configured: false, message: 'Graph API not configured yet — stub data only.', ...meetings });
  }
  if (mailbox === 'arturo') return res.json({ configured: true, lastUpdated: meetings.lastUpdated, date: meetings.date, meetings: meetings.arturo });
  if (mailbox === 'lyndsay') return res.json({ configured: true, lastUpdated: meetings.lastUpdated, date: meetings.date, meetings: meetings.lyndsay });
  res.json({ configured: true, ...meetings });
});

// Ready-to-send reminder queue — copy/paste text, never auto-sent.
app.get('/api/lyndsay-queue', async (req, res) => {
  res.json(await readLyndsayQueue());
});

app.post('/api/lyndsay-queue', async (req, res) => {
  const { text: msgText, reason } = req.body;
  if (!msgText || !msgText.trim()) return res.status(400).json({ error: 'text required' });
  const queue = await readLyndsayQueue();
  const entry = {
    id: `msg_${Date.now()}`,
    text: msgText.trim(),
    reason: reason || '',
    createdAt: new Date().toISOString(),
    sent: false,
  };
  queue.unshift(entry);
  await writeJSON(LYNDSAY_QUEUE_FILE, queue);
  res.json(entry);
});

// Bulk import preserving exact ids/createdAt/sent state — see
// /api/tasks/bulk-import for why. Goes through readLyndsayQueue() so the
// normal 24h-sent-item purge still applies on the next read.
app.post('/api/lyndsay-queue/bulk-import', async (req, res) => {
  const incoming = Array.isArray(req.body?.queue) ? req.body.queue : [];
  if (!incoming.length) return res.status(400).json({ error: '"queue" array required' });
  const queue = await readLyndsayQueue();
  let added = 0, updated = 0;
  for (const m of incoming) {
    if (!m.id) continue;
    const idx = queue.findIndex(x => x.id === m.id);
    if (idx === -1) { queue.push(m); added++; } else { queue[idx] = m; updated++; }
  }
  await writeJSON(LYNDSAY_QUEUE_FILE, queue);
  res.json({ ok: true, added, updated, total: queue.length });
});

app.post('/api/lyndsay-queue/:id/sent', async (req, res) => {
  const queue = await readLyndsayQueue();
  const idx = queue.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Message not found' });
  queue[idx].sent = true;
  queue[idx].sentAt = new Date().toISOString();
  await writeJSON(LYNDSAY_QUEUE_FILE, queue);
  res.json(queue[idx]);
});

// Manual "+ Add Reminder" button on a meeting card — generates the reminder
// immediately regardless of how far away the meeting is. Dedupes against any
// still-pending (not yet sent) reminder already queued for the same event.
app.post('/api/lyndsay-queue/from-meeting', async (req, res) => {
  const { meeting } = req.body || {};
  if (!meeting || !meeting.subject || !meeting.start) return res.status(400).json({ error: 'meeting {subject, start, platform, attendees, joinUrl, id, day} required' });
  const reminderType = meeting.day === 'tomorrow' ? 'tomorrow' : 'today';
  const { meetingType, leadMinutes } = classifyMeeting(meeting);
  const queue = await readLyndsayQueue();
  if (meeting.id) {
    const existing = queue.find(q => q.eventId === meeting.id && q.reminderType === reminderType && !q.sent);
    if (existing) return res.json(existing);
  }
  const entry = {
    id: `msg_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
    eventId: meeting.id || null,
    meetingTitle: meeting.subject,
    meetingTime: meeting.start,
    reminderType,
    meetingType,
    reminderMinutesBefore: leadMinutes,
    text: buildReminderMessage(meeting, reminderType, leadMinutes),
    reason: reminderType === 'tomorrow' ? 'Tomorrow reminder' : `Meeting reminder (${meetingType}, ${leadMinutes} min lead)`,
    createdAt: new Date().toISOString(),
    sent: false,
  };
  queue.unshift(entry);
  await writeJSON(LYNDSAY_QUEUE_FILE, queue);
  res.json(entry);
});

// =====================================================================
// MODULE 6 — END OF DAY SUMMARY
// =====================================================================

async function buildSummary() {
  const today = todayStr();

  const tasks = await readJSON(TASKS_FILE, []);
  const completedToday = tasks.filter(t => t.completed_at && localDateStr(t.completed_at) === today);
  const open = tasks.filter(t => t.priority !== '✅ Done');

  const flagged = await readJSON(FLAGGED_FILE, []);
  const stillFlagged = flagged.filter(f => !f.handled);

  const meetings = await readJSON(MEETINGS_FILE, { date: null, arturo: [], lyndsay: [] });
  const meetingsToday = meetings.date === today
    ? { arturo: (meetings.arturo || []).filter(m => m.day !== 'tomorrow'), lyndsay: (meetings.lyndsay || []).filter(m => m.day !== 'tomorrow') }
    : { arturo: [], lyndsay: [] };

  const candidates = [];
  for (const t of open) {
    if (t.priority === '🔴 Critical') candidates.push({ source: 'Task', label: t.title, reason: 'Critical priority', weight: 100 });
  }
  for (const f of stillFlagged) {
    candidates.push({ source: 'Email', label: `${f.subject} (${f.mailbox})`, reason: 'Flagged for Lyndsay — needs judgment call', weight: 80 });
  }
  for (const t of open) {
    if (t.due_on === today) candidates.push({ source: 'Task', label: t.title, reason: 'Due today', weight: 70 });
  }
  candidates.sort((a, b) => b.weight - a.weight);

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    tasks: {
      completedToday: completedToday.map(t => ({ title: t.title, type: t.type })),
      open: open.map(t => ({ title: t.title, type: t.type, priority: t.priority })),
    },
    meetings: {
      arturo: meetingsToday.arturo || [],
      lyndsay: meetingsToday.lyndsay || [],
    },
    flaggedForLyndsay: stillFlagged.map(f => ({ subject: f.subject, mailbox: f.mailbox, sender: f.sender })),
    topPriorities: candidates.slice(0, 3),
  };
}

app.get('/api/summary', async (req, res) => {
  res.json(await buildSummary());
});

function summaryToText(s) {
  const L = [];
  L.push(`METRIC PROPERTY MANAGEMENT — AI ADMIN END OF DAY SUMMARY`);
  L.push(`Date: ${s.date}   |   Generated: ${new Date(s.generatedAt).toLocaleString()}`);
  L.push(``);
  L.push(`== TASKS ==`);
  L.push(`Completed today (${s.tasks.completedToday.length}):`);
  s.tasks.completedToday.forEach(t => L.push(`  - ${t.title} (${t.type})`));
  L.push(`Still open (${s.tasks.open.length}):`);
  s.tasks.open.forEach(t => L.push(`  - ${t.priority} ${t.title} (${t.type})`));
  L.push(``);
  L.push(`== MEETINGS TODAY ==`);
  L.push(`Arturo: ${s.meetings.arturo.length}`);
  s.meetings.arturo.forEach(m => L.push(`  - ${formatDualTime(m.start)} — ${m.subject} (${m.platform})${m.conflict ? ' ⚠ CONFLICT' : ''}`));
  L.push(`Lyndsay: ${s.meetings.lyndsay.length}`);
  s.meetings.lyndsay.forEach(m => L.push(`  - ${formatDualTime(m.start)} — ${m.subject} (${m.platform})${m.conflict ? ' ⚠ CONFLICT' : ''}`));
  L.push(``);
  L.push(`== STILL FLAGGED FOR LYNDSAY ==`);
  if (s.flaggedForLyndsay.length) {
    s.flaggedForLyndsay.forEach(f => L.push(`  - [${f.mailbox}] ${f.subject} (from ${f.sender})`));
  } else {
    L.push(`  None`);
  }
  L.push(``);
  L.push(`== TOP PRIORITIES FOR TOMORROW ==`);
  s.topPriorities.forEach((p, i) => L.push(`  ${i + 1}. [${p.source}] ${p.label} — ${p.reason}`));
  return L.join('\n');
}

app.get('/api/summary/export', async (req, res) => {
  const s = await buildSummary();
  res.setHeader('Content-Disposition', `attachment; filename="eod_summary_${s.date}.txt"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(summaryToText(s));
});

// Plain text for the "Copy as plain text" button — same content, no download.
app.get('/api/summary/text', async (req, res) => {
  const s = await buildSummary();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(summaryToText(s));
});

// =====================================================================
// BACKGROUND JOB — runs independently of any dashboard tab / Claude chat
// =====================================================================

cron.schedule(`*/${EMAIL_REFRESH_MINUTES} * * * *`, () => {
  refreshEmailAndCalendar();
});
// Kick off one refresh attempt on boot too (logs stub-mode message if not configured yet).
refreshEmailAndCalendar();
// Purge stale sent reminders from the Lyndsay queue on startup.
readLyndsayQueue();

// Reminder lead times are as short as 4-5 minutes, so waiting for the full
// EMAIL_REFRESH_MINUTES (15 min) Graph refresh would miss most reminder
// windows entirely. Re-check already-cached meeting data every 2 minutes
// instead — no extra Graph API calls, just re-evaluates generateLyndsayReminders()
// against the last calendar snapshot written by refreshEmailAndCalendar().
cron.schedule('*/2 * * * *', async () => {
  if (!GRAPH_CONFIGURED) return;
  const meetings = await readJSON(MEETINGS_FILE, null);
  if (meetings && Array.isArray(meetings.lyndsay)) {
    await generateLyndsayReminders(meetings.lyndsay);
  }
});

// Auto-fills the SharePoint "Inbox Tracking" sheet every morning at 8 AM CT —
// replaces each team member manually typing their own mailbox's unread count
// into the sheet. Scheduled in LYNDSAY_TIMEZONE (CT) explicitly so it fires
// at 8 AM there regardless of what timezone the dashboard's host machine is in.
cron.schedule('0 8 * * *', async () => {
  if (!GRAPH_CONFIGURED) return;
  try {
    await writeInboxTrackingToExcel();
  } catch (err) {
    logLine(`[inbox-tracking-excel] ERROR: ${err.message}`);
  }
}, { timezone: LYNDSAY_TIMEZONE });

// =====================================================================
// MCP over HTTP — /mcp (StreamableHTTP transport, for mcp-remote / cloud)
// =====================================================================
// Same tool set as the local stdio server (mcp-server.mjs), from the shared
// mcp-tools.cjs — just reached over HTTP instead of stdio, and calling this
// same process's own REST API via a loopback fetch instead of a child
// process talking to a separately-running dashboard. No auth: mcp-remote
// (the Claude Desktop bridge) is the thing that needs to reach this, and it
// doesn't authenticate to the dashboards it proxies.

const MCP_BASE = `http://localhost:${PORT}`;

async function mcpGetJSON(pathname, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${MCP_BASE}${pathname}`, { signal: ac.signal });
    if (!res.ok) return { _error: `El dashboard respondió ${res.status} en ${pathname}` };
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return { _error: `El dashboard tardó demasiado en responder (${timeoutMs / 1000}s).` };
    return { _error: `No se pudo conectar al dashboard en ${MCP_BASE}.` };
  } finally {
    clearTimeout(timer);
  }
}

const mcpText = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

async function mcpDoFetch(url, options = {}, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: ac.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// sessionId -> transport, per the SDK's stateful StreamableHTTP pattern.
const mcpTransports = {};

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && mcpTransports[sessionId]) {
    transport = mcpTransports[sessionId];
  } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => { mcpTransports[newSessionId] = transport; },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete mcpTransports[transport.sessionId];
    };
    const mcpServer = new McpServer({ name: 'ai-admin-dashboard', version: '1.0.0' });
    registerAllTools(mcpServer, { BASE: MCP_BASE, getJSON: mcpGetJSON, doFetch: mcpDoFetch, text: mcpText });
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// ═══════════════════════════════════════════════════════════════════════════
// BD CRM — Business Development CRM backed by Supabase
// Tables: properties, phone_shops, online_shops, follow_ups, outreach_drafts
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRM_API_SECRET = process.env.CRM_API_SECRET || '';

let supabaseAdmin = null; // service-role client (writes, migration)
let supabasePublic = null; // anon client (reads)

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  if (SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  logLine('BD CRM: Supabase client initialized');
} else {
  logLine('BD CRM: SUPABASE_URL / SUPABASE_ANON_KEY not set — CRM module disabled');
}

const CRM_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// Middleware: require Supabase to be configured before serving CRM routes
function requireCRM(req, res, next) {
  if (!CRM_CONFIGURED) {
    return res.status(503).json({ error: 'BD CRM not configured — set SUPABASE_URL and SUPABASE_ANON_KEY in .env' });
  }
  next();
}

// ---- GET /api/crm/status -------------------------------------------------------
app.get('/api/crm/status', (req, res) => {
  res.json({ configured: CRM_CONFIGURED, hasAdmin: !!supabaseAdmin });
});

// ---- GET /api/crm/properties ---------------------------------------------------
// Query params: page (1-based), limit (default 50, max 200), search, submarket,
//   assigned_to, rop_status, asset_class, lyndsay_reviewed (true/false)
app.get('/api/crm/properties', requireCRM, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;

    const db = supabaseAdmin || supabasePublic;
    let query = db
      .from('properties')
      .select('*', { count: 'exact' })
      .order('property_name', { ascending: true })
      .range(from, from + limit - 1);

    if (req.query.search) {
      const s = req.query.search.trim();
      query = query.or(`property_name.ilike.%${s}%,address.ilike.%${s}%,management_company.ilike.%${s}%,owner_name.ilike.%${s}%`);
    }
    if (req.query.submarket)       query = query.eq('submarket', req.query.submarket);
    if (req.query.assigned_to)     query = query.eq('assigned_to', req.query.assigned_to);
    if (req.query.rop_status)      query = query.eq('rop_status', req.query.rop_status);
    if (req.query.asset_class)     query = query.eq('asset_class', req.query.asset_class);
    if (req.query.lyndsay_reviewed !== undefined) {
      query = query.eq('lyndsay_reviewed', req.query.lyndsay_reviewed === 'true');
    }

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ properties: data, total: count, page, limit, pages: Math.ceil(count / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/crm/properties/:id -----------------------------------------------
app.get('/api/crm/properties/:id', requireCRM, async (req, res) => {
  try {
    const { data: property, error: propErr } = await (supabaseAdmin || supabasePublic)
      .from('properties').select('*').eq('id', req.params.id).single();
    if (propErr) return res.status(404).json({ error: propErr.message });

    const [phones, online, follows, drafts] = await Promise.all([
      ( supabaseAdmin || supabasePublic).from('phone_shops').select('*').eq('property_id', req.params.id).order('shop_date', { ascending: false }),
      ( supabaseAdmin || supabasePublic).from('online_shops').select('*').eq('property_id', req.params.id).order('shop_date', { ascending: false }),
      ( supabaseAdmin || supabasePublic).from('follow_ups').select('*').eq('property_id', req.params.id).order('follow_up_date', { ascending: false }),
      ( supabaseAdmin || supabasePublic).from('outreach_drafts').select('*').eq('property_id', req.params.id).order('created_at', { ascending: false }),
    ]);

    res.json({
      ...property,
      phone_shops:     phones.data || [],
      online_shops:    online.data || [],
      follow_ups:      follows.data || [],
      outreach_drafts: drafts.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- PATCH /api/crm/properties/:id ---------------------------------------------
app.patch('/api/crm/properties/:id', requireCRM, async (req, res) => {
  try {
    const allowed = [
      'rop_status','lead_score_override','lyndsay_reviewed','notes',
      'assigned_to','phone_assignee','phone_assignee3','online_dm_assignee',
      'owner_name','owner_contact_name','owner_phone','owner_email','owner_address',
    ];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('properties').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/crm/properties/:id/follow-ups -----------------------------------
app.post('/api/crm/properties/:id/follow-ups', requireCRM, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('follow_ups').insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/crm/properties/:id/outreach-drafts ------------------------------
app.post('/api/crm/properties/:id/outreach-drafts', requireCRM, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('outreach_drafts').insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/crm/meta ---------------------------------------------------------
// Returns distinct values for filter dropdowns (submkts, assignees, statuses, etc.)
app.get('/api/crm/meta', requireCRM, async (req, res) => {
  try {
    const [submkts, assignees, statuses, classes] = await Promise.all([
      ( supabaseAdmin || supabasePublic).from('properties').select('submarket').order('submarket'),
      ( supabaseAdmin || supabasePublic).from('properties').select('assigned_to').order('assigned_to'),
      ( supabaseAdmin || supabasePublic).from('properties').select('rop_status').order('rop_status'),
      ( supabaseAdmin || supabasePublic).from('properties').select('asset_class').order('asset_class'),
    ]);
    const unique = (arr, key) => [...new Set((arr.data || []).map(r => r[key]).filter(Boolean))];
    res.json({
      submkts:   unique(submkts,   'submarket'),
      assignees: unique(assignees, 'assigned_to'),
      statuses:  unique(statuses,  'rop_status'),
      classes:   unique(classes,   'asset_class'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/crm/bulk-import -------------------------------------------------
// Bulk upsert for data migration. Requires SUPABASE_SERVICE_ROLE_KEY.
// Accepts { properties: [...], phone_shops: [...], ... }
app.post('/api/crm/bulk-import', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Bulk import requires SUPABASE_SERVICE_ROLE_KEY' });
  }
  try {
    const results = {};
    for (const table of ['properties', 'phone_shops', 'online_shops', 'follow_ups', 'outreach_drafts']) {
      const rows = req.body[table];
      if (!Array.isArray(rows) || !rows.length) { results[table] = { skipped: true }; continue; }
      const { error, count } = await supabaseAdmin.from(table).upsert(rows, { onConflict: 'id', count: 'exact' });
      if (error) { results[table] = { error: error.message }; } else { results[table] = { upserted: count }; }
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── End BD CRM ──────────────────────────────────────────────────────────────

// ---- Boot -------------------------------------------------------------------
app.listen(PORT, () => {
  logLine(`AI Admin Dashboard listening on http://localhost:${PORT}`);
  console.log(`AI Admin Dashboard running at http://localhost:${PORT}`);
});
