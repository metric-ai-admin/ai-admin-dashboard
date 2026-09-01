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
 *
 * Planned — not built:
 *
 *  Accounting / Billing Module — Claudia Villalobos (Accounting/QC).
 *  Pending discovery.
 *
 *    Sources:  the Work Order Billable tab of the Command Center workbook;
 *              QC of work orders moving Work Done → Ready to Bill;
 *              vendor payments; daily billing.
 *
 *    Daily Report section: Claudia reports daily on work orders ready to bill,
 *              vendor items outstanding, and QC status. That means a seventh
 *              owner on the report and a section of her own — today the seven
 *              sections are fixed in REPORT_SECTIONS and only Maintenance has a
 *              live source.
 *
 *    Blocked on: (1) a session with Claudia to map her daily flow,
 *                (2) access to her area of AppFolio.
 *
 *  Written here rather than in docs/backlog because this is where the module
 *  list lives, and the next person to add a module reads this header first.
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
const { registerMetricRoutes, requireMetricAccess, requireMetricAdmin } = require('./metric-routes.js');
const autoMove = require('./email-automove.js');
const crmEngine = require('./crm-task-engine.js');
const XLSX        = require('xlsx');
const multer      = require('multer');
const jwt         = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) logLine('[WARN] JWT_SECRET not set — dashboard auth will not work');

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
// Erick's personal Asana account. Optional — when unset, the maintenance
// Asana view reports that it needs connecting instead of showing an empty board.
const ASANA_TOKEN_ERICK = process.env.ASANA_TOKEN_ERICK;
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
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
// ---- Cache-busted index.html ----------------------------------------------
// index.html referenced app.js and the rest by bare filename, so a browser kept
// running the copy it already had after a deploy. Every front-end fix then
// depended on each person hard-reloading before it reached them — which is how
// a shipped fix came to look like a failed deploy.
//
// The stamp is appended at request time rather than written into the file, so
// the repo copy stays a normal static page and nothing has to run at build time.
// Read once and held in memory: it changes only when the process restarts, which
// on Render is exactly when a deploy happens.
//
// RENDER_GIT_COMMIT is set by Render; Date.now() covers local runs, where it
// also gives every restart a fresh stamp, which is what you want while editing.
const BUILD_HASH = (process.env.RENDER_GIT_COMMIT || '').trim().slice(0, 7) || String(Date.now());
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const STAMPED = /\b(src|href)="((?:app|reports-sync|appfolio-views|command-center)\.js|styles\.css)"/g;
let indexHtml = null;

function renderIndex() {
  // Stamps the stylesheet and the other two scripts too. Versioning only app.js
  // would leave a deploy that changed styles.css or appfolio-views.js with the
  // same problem this exists to fix.
  if (!indexHtml) {
    indexHtml = fs.readFileSync(INDEX_FILE, 'utf8')
      .replace(STAMPED, (_m, attr, file) => `${attr}="${file}?v=${BUILD_HASH}"`);
  }
  return indexHtml;
}

// Ahead of express.static, which would otherwise serve the unstamped file for
// "/" and "/index.html". no-store on the HTML itself: it is the document that
// carries the new stamps, so caching it would pin browsers to the old ones.
app.get(['/', '/index.html'], (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderIndex());
  } catch (err) {
    console.error('[index] could not render:', err.message);
    res.sendFile(INDEX_FILE);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Health check ----------------------------------------------------------
// Deliberately unauthenticated and dependency-free: an uptime monitor needs to
// know the process is serving HTTP, and checking Supabase or Graph here would
// report the dashboard as down whenever a third party has a bad minute.
//
// `uptime` is seconds since this process started. A value that keeps resetting
// means the instance is restarting — which is also what drops in-memory MCP
// sessions, so it is the number to look at if those start failing repeatedly.
// Liveness probe. No auth, responds immediately — for external keep-alive
// pingers to confirm the server is back up after a restart/deploy. (Note: a
// deploy always restarts the process and drops the in-memory MCP session; this
// endpoint lets a pinger detect the restart, it does not prevent it.)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: Math.round(process.uptime()) });
});

// ---- Auth helpers ----------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.cookies?.dashboardToken;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

// ---- POST /api/auth/login --------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Auth not configured' });

  const fictionalEmail = `${username.toLowerCase().trim()}@metric.internal`;

  try {
    // 1. Verify credentials with Supabase Auth using fictional email
    const { data: authData, error: authErr } = await supabasePublic.auth.signInWithPassword({ email: fictionalEmail, password });
    if (authErr || !authData?.user) return res.status(401).json({ error: 'Invalid username or password' });

    // 2. Look up role in dashboard_users by username
    const db = supabaseAdmin || supabasePublic;
    const { data: dbUser, error: dbErr } = await db
      .from('dashboard_users')
      .select('id, email, username, name, role, agent_name, active')
      .eq('username', username.toLowerCase().trim())
      .single();

    if (dbErr || !dbUser) return res.status(403).json({ error: 'User not found in dashboard — contact Arturo' });
    if (!dbUser.active) return res.status(403).json({ error: 'Account inactive — contact Arturo' });

    // 3. Issue JWT in HttpOnly cookie (7 days)
    const payload = { userId: dbUser.id, email: dbUser.email, username: dbUser.username, name: dbUser.name, role: dbUser.role, agentName: dbUser.agent_name };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('dashboardToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ user: payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/auth/logout -------------------------------------------------
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('dashboardToken', { httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

// ---- GET /api/auth/me ------------------------------------------------------
app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.dashboardToken;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
});

// ---- POST /api/auth/reset-password -----------------------------------------
// Sends a Supabase password-reset email. Accepts username; constructs
// the fictional @metric.internal email used in Supabase Auth.
app.post('/api/auth/reset-password', async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Auth not configured' });
  const fictionalEmail = `${username.toLowerCase().trim()}@metric.internal`;
  try {
    const { error } = await supabasePublic.auth.resetPasswordForEmail(fictionalEmail, {
      redirectTo: `${process.env.APP_BASE_URL || 'https://ai-admin-dashboard-jkde.onrender.com'}/login.html`,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, message: 'Password reset email sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Asana is per-person: ASANA_TOKEN is Arturo's (support@livewithmetric.com) and
// only ever sees his tasks. Erick's board lives under his own account, so the
// maintenance view asks for ?owner=erick and this picks the matching token.
// Every helper defaults to ASANA_TOKEN, so existing callers are unaffected.
function asanaTokenFor(owner) {
  return owner === 'erick' ? ASANA_TOKEN_ERICK : ASANA_TOKEN;
}

function asanaHeaders(token = ASANA_TOKEN) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function asanaRequest(method, endpoint, body, token = ASANA_TOKEN) {
  if (!token) throw new Error('ASANA_TOKEN is not set in .env');
  const res = await fetchFn(`${ASANA_BASE}${endpoint}`, {
    method,
    headers: asanaHeaders(token),
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

async function asanaGetAll(endpoint, token = ASANA_TOKEN) {
  if (!token) throw new Error('ASANA_TOKEN is not set in .env');
  const sep = endpoint.includes('?') ? '&' : '?';
  let url = `${ASANA_BASE}${endpoint}${sep}limit=100`;
  const out = [];
  while (url) {
    const res = await fetchFn(url, { headers: asanaHeaders(token) });
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

// Keyed by token — one cache per Asana account, or Erick's identity would be
// served from Arturo's cached entry.
const _meCache = new Map();
// Both accounts belong to two workspaces, and workspaces[0] is the personal
// "livewithmetric.com" one — empty, no projects, no tasks. Picking it blind is
// why every Asana pull returned nothing: Erick's 27 open tasks were in "Metric
// Property Management" the whole time, a workspace the query never asked about.
// Matched by gid first so a rename cannot break it, then by name.
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || 'Metric Property Management';

function pickWorkspace(workspaces = []) {
  if (!workspaces.length) return { ws: null, matched: false };
  const want = ASANA_WORKSPACE.trim().toLowerCase();
  const ws = workspaces.find(w => w.gid === ASANA_WORKSPACE.trim())
          || workspaces.find(w => (w.name || '').trim().toLowerCase() === want);
  // Falling back keeps a misconfigured name from taking Asana down entirely,
  // but it is the failure that hid this bug, so it does not happen quietly.
  return ws ? { ws, matched: true } : { ws: workspaces[0], matched: false };
}

async function getMe(token = ASANA_TOKEN) {
  if (_meCache.has(token)) return _meCache.get(token);
  const me = await asanaRequest('GET', '/users/me?opt_fields=name,email,workspaces.name', null, token);
  const { ws, matched } = pickWorkspace(me.workspaces);
  if (!matched && ws) {
    console.warn(`[asana] no workspace named "${ASANA_WORKSPACE}" for ${me.email || me.gid} — falling back to "${ws.name}". Tasks may be missing.`);
  }
  const shaped = {
    gid: me.gid,
    name: me.name,
    email: me.email,
    workspaceGid: ws ? ws.gid : null,
    workspaceName: ws ? ws.name : null,
    workspaceMatched: matched,
  };
  _meCache.set(token, shaped);
  return shaped;
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

app.get('/api/sops', requireMetricAccess, async (req, res) => {
  const index = await readJSON(SOPS_INDEX, []);
  // Archived SOPs are excluded by default; ?include_archived=true returns them
  // too (each item carries its archived flag so the UI can style them).
  const includeArchived = String(req.query.include_archived) === 'true';
  const items = includeArchived ? index : index.filter(s => !s.archived);
  res.json(items.map(s => ({
    id: s.id, title: s.title, tags: s.tags || [], uploadedAt: s.uploadedAt, chars: (s.text || '').length,
    source: s.source || null, category: s.category || null, slab_url: s.slab_url || null,
    archived: !!s.archived,
  })));
});

// ---- PATCH /api/sops/:id — edit title/category/tags or archive/unarchive ----
// requireMetricAdmin (not the spec's requireAuth): the edit/archive controls are
// admin-only in the UI, and the other SOP writes (POST/DELETE) use this guard —
// a bare requireAuth would let any logged-in user rewrite the knowledge base.
app.patch('/api/sops/:id', requireMetricAdmin, async (req, res) => {
  const index = await readJSON(SOPS_INDEX, []);
  const i = index.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'SOP not found' });
  const { title, category, tags, archived } = req.body || {};
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: 'Title cannot be empty' });
    index[i].title = String(title).trim();
  }
  if (category !== undefined) index[i].category = category === '' || category === null ? null : String(category).trim();
  if (tags !== undefined) index[i].tags = Array.isArray(tags)
    ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
  if (archived !== undefined) index[i].archived = !!archived;
  await writeJSON(SOPS_INDEX, index);
  const s = index[i];
  res.json({
    id: s.id, title: s.title, tags: s.tags || [], category: s.category || null,
    source: s.source || null, slab_url: s.slab_url || null, archived: !!s.archived,
    chars: (s.text || '').length, uploadedAt: s.uploadedAt,
  });
});

app.post('/api/sops', requireMetricAdmin, async (req, res) => {
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

app.get('/api/sops/:id', requireMetricAccess, async (req, res) => {
  const index = await readJSON(SOPS_INDEX, []);
  const sop = index.find(s => s.id === req.params.id);
  if (!sop) return res.status(404).json({ error: 'SOP not found' });
  res.json(sop);
});

app.delete('/api/sops/:id', requireMetricAdmin, async (req, res) => {
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

app.get('/api/sops/search/:q', requireMetricAccess, async (req, res) => {
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

// custom_fields carries Priority. Asana has no native priority field — it is a
// per-project custom field, so it arrives only when asked for by name, and a
// task that belongs to no project cannot have one at all. Most of Erick's sit
// in "My tasks", which is why the client falls back to the due date.
const ASANA_OPT_FIELDS = 'name,assignee.name,due_on,due_at,completed,completed_at,notes,permalink_url,modified_at,projects.name,followers.gid,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name';

// display_value covers every field type Asana renders as text; enum_value.name
// is the fallback for enum fields where it comes back empty. Anything that is
// not one of the three known levels is treated as absent rather than guessed at.
const ASANA_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
function asanaPriority(t) {
  const f = (t.custom_fields || []).find(c => (c.name || '').trim().toLowerCase() === 'priority');
  if (!f) return null;
  const raw = String(f.display_value ?? f.enum_value?.name ?? '').trim().toUpperCase();
  return ASANA_PRIORITIES.includes(raw) ? raw : null;
}

function shapeTask(t, projectLabel) {
  const label = projectLabel
    || (t.projects && t.projects[0] ? t.projects[0].name : 'My tasks');
  return {
    gid: t.gid,
    name: t.name,
    assignee: t.assignee ? t.assignee.name : null,
    assignee_gid: t.assignee ? t.assignee.gid : null,
    follower_gids: (t.followers || []).map(f => f.gid),
    due_on: t.due_on || (t.due_at ? localDateStr(t.due_at) : null),
    priority: asanaPriority(t),   // null when the task has no Priority field
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

// Answers what the empty Asana tab cannot: which identity each token actually
// belongs to, every workspace it can see rather than just workspaces[0], what
// projects live in each, and how many tasks the current query really returns.
// Read-only, and it returns names, gids and counts — the tokens stay here.
// Admin-gated because it maps out the organisation's Asana structure.
app.get('/api/asana/diagnostic', requireAuth, requireRole('admin'), async (req, res) => {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const completedSince = encodeURIComponent(midnight.toISOString());

  const out = [];
  for (const o of [{ owner: 'default', who: 'arturo', token: ASANA_TOKEN },
                   { owner: 'erick',   who: 'erick',  token: ASANA_TOKEN_ERICK }]) {
    const entry = { owner: o.owner, who: o.who, configured: !!o.token };
    if (!o.token) { out.push(entry); continue; }
    try {
      const me = await asanaRequest('GET', '/users/me?opt_fields=name,email,workspaces.name', null, o.token);
      entry.identity = { gid: me.gid, name: me.name, email: me.email };
      const workspaces = me.workspaces || [];
      entry.workspaceCount = workspaces.length;
      const picked = pickWorkspace(workspaces);
      entry.workspaceMatchedByName = picked.matched;
      entry.workspaces = [];
      for (const ws of workspaces) {
        // Flags the one getMe actually queries, so this stays a straight answer
        // to "are we asking the workspace the tasks are in?".
        const w = { gid: ws.gid, name: ws.name, pickedByGetMe: !!picked.ws && ws.gid === picked.ws.gid };
        try {
          const projects = await asanaGetAll(`/workspaces/${ws.gid}/projects?opt_fields=name,archived`, o.token);
          w.projects = projects.map(p => ({ gid: p.gid, name: p.name, archived: !!p.archived }));
        } catch (e) { w.projectsError = e.message; }
        try {
          const tasks = await asanaGetAll(
            `/tasks?assignee=${me.gid}&workspace=${ws.gid}&opt_fields=name,completed&completed_since=${completedSince}`, o.token);
          w.tasksReturned = tasks.length;
          w.openTasks = tasks.filter(t => !t.completed).length;
        } catch (e) { w.tasksError = e.message; }
        entry.workspaces.push(w);
      }
    } catch (err) { entry.error = err.message; }
    out.push(entry);
  }

  res.json({ configuredProjects: ASANA_PROJECTS, extraProjectsEnvSet: !!process.env.ASANA_EXTRA_PROJECTS, owners: out });
});

app.get('/api/asana/tasks', async (req, res) => {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const completedSince = encodeURIComponent(midnight.toISOString());

  const owner = req.query.owner === 'erick' ? 'erick' : 'default';
  const token = asanaTokenFor(owner);

  // 200 rather than an error: the view stays usable and simply explains what is
  // missing, which is what "functional but empty" means here.
  if (!token) {
    return res.json({
      lastUpdated: null, tasks: [], stale: false, owner, notConfigured: true,
      message: owner === 'erick'
        ? "Connect Erick's Asana token to see his tasks."
        : 'ASANA_TOKEN is not set.',
    });
  }

  try {
    const byGid = new Map();

    // Arturo's board is now his Asana "My Tasks" list rather than whole project
    // boards, so it holds his own work instead of the team's. ASANA_EXTRA_PROJECTS
    // is still parsed and still available, just no longer the source for it.
    //
    // The documented route is two calls: the user task list has its own gid and
    // has to be looked up per workspace. There is no /user_task_lists/me, and
    // assignee/workspace are parameters of GET /tasks, not of this endpoint —
    // passing them here does nothing.
    let pullError = null;
    try {
      const me = await getMe(token);
      if (!me.gid || !me.workspaceGid) {
        pullError = 'Asana did not return a user or workspace for this token.';
        console.error(`[asana/tasks:${owner}] pull skipped:`, pullError);
      } else if (owner === 'erick') {
        // Unchanged: his assigned tasks, which is what his board has always been.
        const mine = await asanaGetAll(
          `/tasks?assignee=${me.gid}&workspace=${me.workspaceGid}&opt_fields=${ASANA_OPT_FIELDS}&completed_since=${completedSince}`, token);
        for (const t of (mine || [])) {
          if (!byGid.has(t.gid)) byGid.set(t.gid, shapeTask(t, null));
        }
      } else {
        const list = await asanaRequest('GET',
          `/users/me/user_task_list?workspace=${me.workspaceGid}&opt_fields=gid`, null, token);
        if (!list?.gid) throw new Error('Asana returned no user task list for this account.');
        const mine = await asanaGetAll(
          `/user_task_lists/${list.gid}/tasks?opt_fields=${ASANA_OPT_FIELDS}&completed_since=${completedSince}`, token);
        for (const t of (mine || [])) {
          if (!byGid.has(t.gid)) byGid.set(t.gid, shapeTask(t, null));
        }
      }
    } catch (meErr) {
      pullError = meErr.message;
      console.error(`[asana/tasks:${owner}] my-tasks pull failed:`, meErr.message);
    }

    // No assignee filter on either board any more. Both are now built from a
    // list that is already one person's — Erick's assigned tasks, Arturo's My
    // Tasks — rather than from project boards carrying the whole team.
    const allTasks = [...byGid.values()];

    const payload = { lastUpdated: new Date().toISOString(), tasks: allTasks, stale: false, owner };
    // Only when the failure actually cost us the whole list. A partial pull that
    // still returned project tasks is worth showing without an alarm on it.
    if (pullError && !allTasks.length) { payload.error = pullError; payload.stale = true; }
    // The cache file holds Arturo's board — writing Erick's results into it
    // would poison the Tasks tab and the MCP tools that read it.
    if (owner !== 'erick') await writeJSON(ASANA_CACHE_FILE, payload);
    res.json(payload);
  } catch (err) {
    console.error(`[asana/tasks:${owner}]`, err.message);
    if (owner === 'erick') {
      return res.json({ lastUpdated: null, tasks: [], stale: true, owner, error: err.message });
    }
    const cache = await readJSON(ASANA_CACHE_FILE, { lastUpdated: null, tasks: [] });
    res.status(200).json({ ...cache, stale: true, owner, error: err.message });
  }
});

// The only write path into Asana. requireAuth unlike the read routes beside it:
// this edits records in a system outside our own, and an open endpoint would let
// anyone who knows a task gid rewrite its due date and description.
app.patch('/api/asana/tasks/:gid', requireAuth, async (req, res) => {
  const owner = req.query.owner === 'erick' ? 'erick' : 'default';
  const token = asanaTokenFor(owner);
  if (!token) return res.status(400).json({ error: `No Asana token configured for ${owner}.` });

  const gid = String(req.params.gid || '').trim();
  if (!/^\d+$/.test(gid)) return res.status(400).json({ error: 'Invalid task gid' });

  // Only these two. Whitelisting rather than forwarding the body keeps a typo or
  // a stray field from overwriting something in Asana we never meant to touch.
  const body = {};
  if ('due_on' in req.body) {
    const d = req.body.due_on;
    // null clears the date in Asana; '' would be rejected outright.
    if (d === null || d === '') body.due_on = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) body.due_on = d;
    else return res.status(400).json({ error: 'due_on must be YYYY-MM-DD or null' });
  }
  if ('notes' in req.body) body.notes = String(req.body.notes ?? '');
  if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const updated = await asanaRequest('PUT', `/tasks/${gid}?opt_fields=${ASANA_OPT_FIELDS}`, body, token);
    // Shaped like every task from the read route, so the client can drop it
    // straight into the board without a second mapping that could drift.
    res.json(shapeTask(updated, null));
  } catch (err) {
    console.error(`[asana/patch:${owner}] ${gid}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Comments live in Asana's story stream, which also carries every automated
// event — assignments, due-date changes, section moves. Only actual comments
// are of interest here, so the rest is filtered out rather than shown as noise.
function asanaComment(s) {
  return {
    gid: s.gid,
    text: s.text || '',
    author: s.created_by ? s.created_by.name : 'Unknown',
    created_at: s.created_at || null,
  };
}
const isComment = s => s.type === 'comment' || s.resource_subtype === 'comment_added';
const STORY_FIELDS = 'text,type,resource_subtype,created_at,created_by.name';

function asanaTokenForReq(req) {
  const owner = req.query.owner === 'erick' ? 'erick' : 'default';
  return { owner, token: asanaTokenFor(owner) };
}
const validGid = g => /^\d+$/.test(String(g || '').trim());

app.get('/api/asana/tasks/:gid/comments', requireAuth, async (req, res) => {
  const { owner, token } = asanaTokenForReq(req);
  if (!token) return res.status(400).json({ error: `No Asana token configured for ${owner}.` });
  if (!validGid(req.params.gid)) return res.status(400).json({ error: 'Invalid task gid' });
  try {
    const stories = await asanaGetAll(`/tasks/${req.params.gid}/stories?opt_fields=${STORY_FIELDS}`, token);
    res.json({ comments: (stories || []).filter(isComment).map(asanaComment) });
  } catch (err) {
    console.error(`[asana/comments:${owner}] ${req.params.gid}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/asana/tasks/:gid/comments', requireAuth, async (req, res) => {
  const { owner, token } = asanaTokenForReq(req);
  if (!token) return res.status(400).json({ error: `No Asana token configured for ${owner}.` });
  if (!validGid(req.params.gid)) return res.status(400).json({ error: 'Invalid task gid' });
  const text = String(req.body.text ?? '').trim();
  // Asana accepts an empty story and it renders as a blank comment nobody can
  // remove from here, so it is refused rather than posted.
  if (!text) return res.status(400).json({ error: 'Comment text required' });
  try {
    const story = await asanaRequest('POST', `/tasks/${req.params.gid}/stories?opt_fields=${STORY_FIELDS}`, { text }, token);
    res.json(asanaComment(story));
  } catch (err) {
    console.error(`[asana/comment-post:${owner}] ${req.params.gid}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
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

app.get('/api/platform-projects', requireMetricAccess, async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  projects.sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json(projects);
});

app.post('/api/platform-projects', requireMetricAdmin, async (req, res) => {
  const { id, module, phase, blockers, nextAction, order } = req.body;
  if (!module || !module.trim()) return res.status(400).json({ error: 'Module name required' });
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const entry = {
    id: id || `proj_${Date.now()}`,
    module: module.trim(),
    phase: PROJECT_PHASES.includes(phase) ? phase : 'Not started',
    blockers: blockers || '',
    lastUpdate: new Date().toISOString(),
    nextAction: nextAction || '',
    order: order ?? (projects.length + 1),
  };
  projects.push(entry);
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(entry);
});

// Bulk import preserving exact ids/lastUpdate/subtasks — see
// /api/tasks/bulk-import for why.
app.post('/api/platform-projects/bulk-import', requireMetricAdmin, async (req, res) => {
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

app.put('/api/platform-projects/:id', requireMetricAdmin, async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const allowed = ['module', 'phase', 'blockers', 'nextAction', 'order'];
  for (const k of allowed) {
    if (k in req.body) projects[idx][k] = req.body[k];
  }
  // Optional: mark a batch of subtask IDs as done: true
  if (Array.isArray(req.body.completedSubtasks) && req.body.completedSubtasks.length) {
    const ids = new Set(req.body.completedSubtasks);
    (projects[idx].subtasks || []).forEach(s => { if (ids.has(s.id)) s.done = true; });
  }
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

// ── Subtasks ──────────────────────────────────────────────────────────────

app.post('/api/platform-projects/:id/subtasks', requireMetricAdmin, async (req, res) => {
  const { title, done } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Subtask title required' });
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  if (!Array.isArray(projects[idx].subtasks)) projects[idx].subtasks = [];
  const subtask = { id: `sub_${Date.now()}_${Math.floor(Math.random() * 1e4)}`, title: title.trim(), done: done === true || done === 'true' };
  projects[idx].subtasks.push(subtask);
  projects[idx].lastUpdate = new Date().toISOString();
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json(projects[idx]);
});

app.put('/api/platform-projects/:id/subtasks/:subId', requireMetricAdmin, async (req, res) => {
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

app.delete('/api/platform-projects/:id/subtasks/:subId', requireMetricAdmin, async (req, res) => {
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

app.delete('/api/platform-projects/:id', requireMetricAdmin, async (req, res) => {
  const projects = await readJSON(PLATFORM_PROJECTS_FILE, []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const [removed] = projects.splice(idx, 1);
  await writeJSON(PLATFORM_PROJECTS_FILE, projects);
  res.json({ deleted: removed.id });
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
  // Central only. This text is pasted to Lyndsay, who is in Central — the VET
  // half of formatDualTime exists for Arturo reading the dashboard from
  // Venezuela, and in a message to her it is a second time to reconcile against
  // a meeting she may already be late for. formatDualTime still drives the UI.
  const ctTime = new Date(m.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LYNDSAY_TIMEZONE });
  const count = (m.attendees || []).length;
  const lines = reminderType === 'tomorrow'
    ? [`📅 Tomorrow reminder: ${m.subject} is scheduled for tomorrow at ${ctTime} CT.`, `🕐 ${ctTime} CT — ${m.platform}`, `👥 ${count} attendee(s)`]
    : [`📅 Reminder: ${m.subject} starts in ${leadMinutes} minutes.`, `🕐 ${ctTime} CT — ${m.platform}`, `👥 ${count} attendee(s)`];
  if (m.joinUrl) lines.push(m.joinUrl);
  // The WhatsApp fallback was a note to Arturo about what to do if she went
  // quiet. Pasted into her own message, it told her to chase herself.
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
app.get('/api/email/inbox-counts', requireMetricAccess, (req, res) => {
  res.json(refreshState.inboxCounts || { arturo: null, lyndsay: null, lastChecked: null });
});

// Unread/total counts for ALL Metric departmental mailboxes (Inbox Tracking
// report). Served from the cache the 15-min cron keeps warm — call
// POST /api/email/refresh-now first for a guaranteed-fresh read.
app.get('/api/email/inbox-tracking', requireMetricAccess, (req, res) => {
  res.json(refreshState.inboxTracking || { lastChecked: null, rows: [] });
});

// Every folder (Inbox + system + personal) across all 8 departmental
// mailboxes, computed live on request (not cached by the cron — this is
// meaningfully heavier than the inbox-only tracking above, since it also
// recurses one level into any folder with children).
app.get('/api/email/all-folders-tracking', requireMetricAccess, async (req, res) => {
  try {
    const mailboxes = await fetchAllMailboxFolders();
    res.json({ lastChecked: new Date().toISOString(), mailboxes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the 8 AM CT Excel auto-fill job — lets Arturo (or a
// verification run) confirm it writes correctly without waiting for the cron.
app.post('/api/email/inbox-tracking/sync-excel', requireMetricAdmin, async (req, res) => {
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

app.post('/api/email/refresh-now', requireMetricAccess, async (req, res) => {
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
    // KNOWN ISSUE: only 502/503 are retried. 423 (workbook open/locked in
    // SharePoint), 429 (throttling) and 504 slip through as a recorded {error}
    // and show up as a partial write (e.g. 20/22). Visible on the manual Sync
    // button; only in Render logs on the 8 AM cron. Fix plan (widen the retry
    // set, honor Retry-After, surface the cron result): see
    // docs/backlog/inbox-tracking-sync-partial-writes.md
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
app.get('/api/email/folders', requireMetricAccess, async (req, res) => {
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
app.get('/api/email/search', requireMetricAccess, async (req, res) => {
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
app.get('/api/email/inbox', requireMetricAccess, async (req, res) => {
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
app.get('/api/email/message/:id', requireMetricAccess, async (req, res) => {
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
// Internal route for the dashboard UI — never exposes COPILOT_API_KEY to the
// browser. "Same-origin" is not a guard: anyone could GET this URL and read a
// hundred of Lyndsay's emails, so it takes a session or x-metric-key like the
// rest. External callers still use /api/copilot/export with x-api-key.
app.get('/api/copilot/export-internal', requireMetricAccess, async (req, res) => {
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
app.post('/api/email/setup-outlook-rules', requireAuth, requireRole('admin'), async (req, res) => {
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
app.get('/api/email/triage', requireMetricAccess, async (req, res) => {
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

app.get('/api/email/flagged-for-lyndsay', requireMetricAccess, async (req, res) => {
  const flagged = await readJSON(FLAGGED_FILE, []);
  res.json(flagged.filter(f => !f.handled));
});

app.post('/api/email/:id/handled', requireMetricAccess, async (req, res) => {
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

// Routes behind requireMetricAccess (metric-routes.js) take either the session
// cookie or this header. These loopback calls carry no cookie, so they send the
// header. Read from the environment — never hardcode the key.
const mcpMetricKeyHeaders = () =>
  process.env.METRIC_API_KEY ? { 'x-metric-key': process.env.METRIC_API_KEY } : {};

async function mcpGetJSON(pathname, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${MCP_BASE}${pathname}`, { signal: ac.signal, headers: mcpMetricKeyHeaders() });
    if (!res.ok) return { _error: `The dashboard returned ${res.status} for ${pathname}` };
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return { _error: `The dashboard took too long to respond (${timeoutMs / 1000}s).` };
    return { _error: `Could not reach the dashboard at ${MCP_BASE}.` };
  } finally {
    clearTimeout(timer);
  }
}

const mcpText = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

async function mcpDoFetch(url, options = {}, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      ...options,
      headers: { ...(options.headers || {}), ...mcpMetricKeyHeaders() },
      signal: ac.signal,
    });
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

// =====================================================================
// EMAIL AUTO-MOVE — Phase 1 (see email-automove.js for what it does)
// =====================================================================
// Placed after the Supabase clients exist, because the runner needs one to
// read the allowlist and write auto_move_log.
//
// Both switches default to off, so deploying this changes nothing:
//   AUTO_MOVE_ENABLED=false   the cron does not run at all
//   AUTO_MOVE_DRY_RUN=true    decide and log, move nothing

// ── UI-driven config, without touching the runner ─────────────────────────
// The runner (email-automove.js) reads AUTO_MOVE_ENABLED / AUTO_MOVE_DRY_RUN
// from process.env and knows nothing about this file. The dashboard toggles
// write here, and we mirror the file into process.env — at boot and on every
// toggle — so the cron picks up the change on its next tick with no restart
// and no Render edit. The file is the source of truth; until it exists the
// Render env vars are the default, so nothing changes on first deploy.
const AUTOMOVE_CONFIG_FILE = path.join(DATA_DIR, 'automove_config.json');

function applyAutoMoveConfig(cfg) {
  if (cfg && typeof cfg.enabled === 'boolean') process.env.AUTO_MOVE_ENABLED = cfg.enabled ? 'true' : 'false';
  if (cfg && typeof cfg.dryRun === 'boolean') process.env.AUTO_MOVE_DRY_RUN = cfg.dryRun ? 'true' : 'false';
}
function readAutoMoveConfig() {
  try {
    if (fs.existsSync(AUTOMOVE_CONFIG_FILE)) return JSON.parse(fs.readFileSync(AUTOMOVE_CONFIG_FILE, 'utf8'));
  } catch (err) { logLine(`[auto-move] config read failed: ${err.message}`); }
  return null;
}

// Run-state, separate from config. "Last run" used to be inferred from the
// newest auto_move_log row, which froze whenever a pass logged nothing — a
// disabled cron, or an enabled dry run over an empty inbox (scanned 0, no rows).
// So the run itself is recorded here every time, independent of whether it moved
// anything. lastTick is stamped on every cron fire even while disabled, so the
// dashboard can show the cron is alive rather than crashed.
const AUTOMOVE_STATE_FILE = path.join(DATA_DIR, 'automove_state.json');
function readAutoMoveState() {
  try {
    if (fs.existsSync(AUTOMOVE_STATE_FILE)) return JSON.parse(fs.readFileSync(AUTOMOVE_STATE_FILE, 'utf8'));
  } catch (err) { logLine(`[auto-move] state read failed: ${err.message}`); }
  return {};
}
async function writeAutoMoveState(patch) {
  try {
    const next = Object.assign({}, readAutoMoveState(), patch);
    await writeJSON(AUTOMOVE_STATE_FILE, next);
  } catch (err) { logLine(`[auto-move] state write failed: ${err.message}`); }
}
// Synchronous at boot, so the startup log line below reflects the file, and so
// the file wins over the Render env vars — which is the whole point of moving
// the switch into the UI.
{
  const bootCfg = readAutoMoveConfig();
  if (bootCfg) {
    applyAutoMoveConfig(bootCfg);
    logLine(`[auto-move] config loaded from disk — enabled=${process.env.AUTO_MOVE_ENABLED} dryRun=${process.env.AUTO_MOVE_DRY_RUN}`);
  }
}

async function runAutoMoveNow(opts) {
  if (!GRAPH_CONFIGURED) throw new Error('Graph API not configured');
  if (!CRM_CONFIGURED) throw new Error('Supabase not configured — auto_move_log is unreachable');
  const db = supabaseAdmin || supabasePublic;
  try {
    const token = await graphMailToken();
    const summary = await autoMove.runAutoMove(
      { fetchFn, token, mailbox: MAILBOX_LYNDSAY, db, log: logLine },
      opts || {},
    );
    // Stamp the run whether or not it moved anything — this is the fix for a
    // "Last run" that froze on empty passes.
    await writeAutoMoveState({
      lastRun: new Date().toISOString(),
      lastError: null,
      lastSummary: {
        scanned: summary.scanned, archived: summary.archived,
        unsubscribed: summary.unsubscribed, errors: summary.errors, dryRun: summary.dryRun,
      },
    });
    return summary;
  } catch (err) {
    // A failed attempt is still an attempt; record it so the dashboard shows
    // the error instead of a silently stale timestamp.
    await writeAutoMoveState({ lastRun: new Date().toISOString(), lastError: err.message });
    throw err;
  }
}

// Its own cron rather than a call inside refreshEmailAndCalendar(): if the
// auto-move throws, the email/calendar refresh should not go down with it.
cron.schedule(`*/${EMAIL_REFRESH_MINUTES} * * * *`, async () => {
  // Stamp every fire, even while disabled, so "Last checked" proves the cron is
  // alive — a frozen Last checked means the scheduler itself stopped.
  await writeAutoMoveState({ lastTick: new Date().toISOString(), enabledAtTick: autoMove.autoMoveEnabled() });
  if (!autoMove.autoMoveEnabled()) return;
  try {
    const s = await runAutoMoveNow();
    if (s.scanned) {
      logLine(`[auto-move]${s.dryRun ? ' DRY RUN' : ''} scanned ${s.scanned}, `
            + `moved ${s.moved ?? 0}, archived ${s.archived}, unsubscribe ${s.unsubscribed}, `
            + `blocked ${s.blocked ?? 0}, left alone ${s.skipped}, already handled ${s.alreadyHandled}, errors ${s.errors}`);
    }
  } catch (err) {
    logLine(`[auto-move] ERROR: ${err.message}`);
  }
}, { timezone: LYNDSAY_TIMEZONE });

if (autoMove.autoMoveEnabled()) {
  logLine(`Email Auto-Move: ENABLED, ${autoMove.autoMoveDryRun() ? 'DRY RUN (nothing will move)' : 'LIVE — mail will be moved'}`);
} else {
  logLine('Email Auto-Move: disabled (set AUTO_MOVE_ENABLED=true to start, with AUTO_MOVE_DRY_RUN=true first)');
}

// Manual trigger — the only way to see what a pass would do without waiting
// for the cron. Defaults to a dry run whatever the environment says: a route
// that moves mail should need asking twice, so a live pass takes an explicit
// {"dryRun": false}.
app.post('/api/email/auto-move/run', requireAuth, requireRole('admin'), async (req, res) => {
  const dryRun = (req.body && req.body.dryRun === false) ? false : true;
  try {
    res.json({ ok: true, summary: await runAutoMoveNow({ dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The UTC instant of a Central-time day boundary — start (00:00) or end
// (23:59:59.999) of a YYYY-MM-DD. shortOffset resolves CST vs CDT at that date,
// so DST is handled. Used to filter executed_at on the office's day, not UTC's.
function ctBoundaryUTC(dateStr, endOfDay) {
  const wall = new Date(dateStr + (endOfDay ? 'T23:59:59.999' : 'T00:00:00.000') + 'Z');
  const off = new Intl.DateTimeFormat('en-US', { timeZone: LYNDSAY_TIMEZONE, timeZoneName: 'shortOffset' })
    .formatToParts(wall).find(p => p.type === 'timeZoneName').value;         // e.g. "GMT-5"
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/);
  const offMin = m ? (parseInt(m[1], 10) * 60 + (m[1].startsWith('-') ? -1 : 1) * (m[2] ? parseInt(m[2], 10) : 0)) : 0;
  return new Date(wall.getTime() - offMin * 60000).toISOString();
}

// Applies the shared From/To/Action/DryRun filters to an auto_move_log query.
function applyAutoMoveFilters(q, query) {
  if (query.from) q = q.gte('executed_at', ctBoundaryUTC(String(query.from), false));
  if (query.to) q = q.lte('executed_at', ctBoundaryUTC(String(query.to), true));
  if (query.action && query.action !== 'all') {
    if (query.action === 'error') q = q.not('error', 'is', null);
    else q = q.eq('action', String(query.action));
  }
  if (query.dryRun === 'live') q = q.eq('dry_run', false);
  else if (query.dryRun === 'dry') q = q.eq('dry_run', true);
  return q;
}

// The action log: paginated, filterable, with global moved-today/week/month
// counts, and a ?format=csv export of the filtered set. requireMetricAdmin.
app.get('/api/email/auto-move/log', requireMetricAdmin, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const db = supabaseAdmin || supabasePublic;

  try {
    // ── CSV export: the whole filtered set, no pagination ──────────────────
    if (String(req.query.format).toLowerCase() === 'csv') {
      let q = db.from('auto_move_log')
        .select('executed_at,sender,subject,action,matched_on,target_folder,dry_run,error')
        .order('executed_at', { ascending: false }).limit(10000);
      q = applyAutoMoveFilters(q, req.query);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const cols = ['executed_at', 'sender', 'subject', 'action', 'matched_on', 'target_folder', 'dry_run', 'error'];
      const cell = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = '﻿' + [cols.join(',')].concat((data || []).map(r => cols.map(c => cell(r[c])).join(','))).join('\r\n');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: LYNDSAY_TIMEZONE });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="auto_move_log_${today}.csv"`);
      return res.send(csv);
    }

    // ── Paginated page of entries ──────────────────────────────────────────
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    let q = db.from('auto_move_log').select('*', { count: 'exact' })
      .order('executed_at', { ascending: false }).range(offset, offset + limit - 1);
    q = applyAutoMoveFilters(q, req.query);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    // ── Global summary — actions actually MOVED (dry_run=false) by CT day.
    // One query since the start of the month, then bucketed in Central time.
    const monthStart = new Date().toLocaleDateString('en-CA', { timeZone: LYNDSAY_TIMEZONE }).slice(0, 7) + '-01';
    const summary = { today: 0, week: 0, month: 0 };
    const { data: moved, error: sErr } = await db.from('auto_move_log')
      .select('executed_at').eq('dry_run', false)
      .gte('executed_at', ctBoundaryUTC(monthStart, false));
    if (sErr) throw new Error(sErr.message);
    const ctDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: LYNDSAY_TIMEZONE }).format(new Date(d));
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: LYNDSAY_TIMEZONE }).format(new Date());
    // Monday-based week start, in Central time.
    const nowCt = new Date(new Date().toLocaleString('en-US', { timeZone: LYNDSAY_TIMEZONE }));
    const weekStart = new Date(nowCt); weekStart.setDate(nowCt.getDate() - ((nowCt.getDay() + 6) % 7)); weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = new Intl.DateTimeFormat('en-CA', { timeZone: LYNDSAY_TIMEZONE }).format(weekStart);
    for (const r of (moved || [])) {
      const d = ctDate(r.executed_at);
      summary.month++;
      if (d === todayStr) summary.today++;
      if (d >= weekStartStr) summary.week++;
    }

    res.json({
      enabled: autoMove.autoMoveEnabled(),
      dryRun: autoMove.autoMoveDryRun(),
      intervalMinutes: EMAIL_REFRESH_MINUTES,
      summary,
      page: { offset, limit, total: count ?? (data || []).length, returned: (data || []).length },
      entries: data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current switch state for the dashboard controls. requireMetricAdmin: this is
// admin-only config, and the same guard the SOP/platform writes use.
app.get('/api/email/auto-move/status', requireMetricAdmin, async (req, res) => {
  const state = readAutoMoveState();
  const out = {
    enabled: autoMove.autoMoveEnabled(),
    dryRun: autoMove.autoMoveDryRun(),
    intervalMinutes: EMAIL_REFRESH_MINUTES,
    // The actual last execution, recorded every run regardless of actions.
    lastRun: state.lastRun || null,
    // Every cron fire, disabled or not — a stale value here means the scheduler
    // stopped, not just that nothing moved.
    lastTick: state.lastTick || null,
    lastError: state.lastError || null,
    lastSummary: state.lastSummary || null,
    processedToday: 0,
  };
  if (CRM_CONFIGURED) {
    try {
      const db = supabaseAdmin || supabasePublic;
      const { data } = await db.from('auto_move_log')
        .select('executed_at').order('executed_at', { ascending: false }).limit(500);
      const rows = data || [];
      // Fallback for installs from before run-state existed: the newest logged
      // action, so lastRun is not blank on first deploy of this change.
      if (!out.lastRun) out.lastRun = rows[0]?.executed_at || null;
      // Count in Central time so "today" is the office's day, not UTC's — the
      // same reason the runner slices the mailbox on local midnight.
      const ctDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: LYNDSAY_TIMEZONE }).format(new Date(d));
      const today = ctDate(new Date());
      out.processedToday = rows.filter(r => ctDate(r.executed_at) === today).length;
    } catch (err) { out.logError = err.message; }
  }
  res.json(out);
});

// Flip one switch. Writes the config file and mirrors it into process.env so
// the cron picks it up next tick — no restart, no Render edit. The runner is
// not touched. requireMetricAdmin, as specified.
app.post('/api/email/auto-move/toggle', requireMetricAdmin, async (req, res) => {
  const { setting, value } = req.body || {};
  if (setting !== 'enabled' && setting !== 'dryRun') {
    return res.status(400).json({ error: 'setting must be "enabled" or "dryRun"' });
  }
  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be a boolean' });
  }
  // Merge onto current state so flipping one switch preserves the other, even
  // on the very first toggle when no file exists yet.
  const cfg = readAutoMoveConfig() || {
    enabled: autoMove.autoMoveEnabled(),
    dryRun: autoMove.autoMoveDryRun(),
  };
  cfg[setting] = value;
  try {
    await writeJSON(AUTOMOVE_CONFIG_FILE, cfg);
  } catch (err) {
    return res.status(500).json({ error: `Could not persist config: ${err.message}` });
  }
  applyAutoMoveConfig(cfg);
  logLine(`[auto-move] ${setting}=${value} set by admin via dashboard`);
  res.json({ ok: true, enabled: autoMove.autoMoveEnabled(), dryRun: autoMove.autoMoveDryRun() });
});

// ---- Auto-Move rules (Phase 2) — the config-driven routing table ----
// requireAuth per spec; the rules decide where a CEO's mail goes, so any change
// is admin-adjacent, but the endpoint follows the requested guard exactly.
const AUTOMOVE_RULE_COLS = ['priority', 'match_type', 'match_value', 'action', 'target_folder', 'mark_read', 'active', 'confidence', 'notes'];
const AUTOMOVE_MATCH_TYPES = ['sender_exact', 'sender_domain', 'header', 'subject_contains', 'subject_startswith'];
const AUTOMOVE_ACTIONS = ['move', 'move_read', 'archive', 'archive_read', 'move_unsubscribe'];
function autoMoveRulePick(body) {
  const out = {};
  for (const c of AUTOMOVE_RULE_COLS) if (body[c] !== undefined) out[c] = body[c] === '' ? null : body[c];
  return out;
}

app.get('/api/email/auto-move/rules', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const db = supabaseAdmin || supabasePublic;
  const { data, error } = await db.from('automove_rules').select('*').order('priority', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rules: data || [] });
});

app.post('/api/email/auto-move/rules', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = autoMoveRulePick(req.body || {});
  if (!row.match_type || !AUTOMOVE_MATCH_TYPES.includes(row.match_type)) return res.status(400).json({ error: 'match_type must be one of: ' + AUTOMOVE_MATCH_TYPES.join(', ') });
  if (!row.match_value) return res.status(400).json({ error: 'match_value is required' });
  if (!row.action || !AUTOMOVE_ACTIONS.includes(row.action)) return res.status(400).json({ error: 'action must be one of: ' + AUTOMOVE_ACTIONS.join(', ') });
  const db = supabaseAdmin || supabasePublic;
  const { data, error } = await db.from('automove_rules').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/api/email/auto-move/rules/:id', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = autoMoveRulePick(req.body || {});
  if (row.match_type && !AUTOMOVE_MATCH_TYPES.includes(row.match_type)) return res.status(400).json({ error: 'invalid match_type' });
  if (row.action && !AUTOMOVE_ACTIONS.includes(row.action)) return res.status(400).json({ error: 'invalid action' });
  if (!Object.keys(row).length) return res.status(400).json({ error: 'No updatable fields sent' });
  const db = supabaseAdmin || supabasePublic;
  const { data, error } = await db.from('automove_rules').update(row).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Soft delete — set active=false so the rule stops firing but its history in
// auto_move_log (rule_id) stays resolvable.
app.delete('/api/email/auto-move/rules/:id', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const db = supabaseAdmin || supabasePublic;
  const { data, error } = await db.from('automove_rules').update({ active: false }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, rule: data });
});

// ---- GET /api/bd-crm/export/csv — GoHighLevel export for John Hernandez ----
// Every property, all columns as headers, for john@writecode.ninja. The most
// complete property is sorted first so the file opens on a fully-populated
// example. requireMetricAdmin: exports owner names, phones and emails.
app.get('/api/bd-crm/export/csv', requireMetricAdmin, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'BD CRM not configured' });
  const db = supabaseAdmin || supabasePublic;
  try {
    // Every column of properties, plus the most recent entry of each related
    // table with ALL of its columns — nothing omitted (Lyndsay 09/01). Column
    // sets are dynamic (union of a known list + whatever the rows actually have)
    // so a column added later still appears, and the known list keeps the
    // headers present even when a table is empty.
    const [props, phones, onlines, dms, follows, appts, insps] = await Promise.all([
      db.from('properties').select('*'),
      db.from('phone_shops').select('*'),
      db.from('online_shops').select('*'),
      db.from('dm_reviews').select('*'),
      db.from('follow_ups').select('*'),
      db.from('appointments').select('*'),
      db.from('inspections').select('*'),
    ]);
    for (const r of [props, phones, onlines, dms, follows, appts, insps]) if (r.error) throw new Error(r.error.message);
    const rows = props.data || [];

    const groupBy = (arr) => {
      const m = new Map();
      for (const r of (arr || [])) { if (!m.has(r.property_id)) m.set(r.property_id, []); m.get(r.property_id).push(r); }
      return m;
    };
    const byPhone = groupBy(phones.data), byOnline = groupBy(onlines.data), byDm = groupBy(dms.data),
          byFollow = groupBy(follows.data), byAppt = groupBy(appts.data), byInsp = groupBy(insps.data);

    // "Ready for Lyndsay" ranking, unchanged — the most complete property leads.
    const rankOf = (p) => {
      const ph = (byPhone.get(p.id) || []).length, on = (byOnline.get(p.id) || []).length, dm = (byDm.get(p.id) || []).length;
      return { ready: ph >= 3 && on >= 1 && dm >= 1, tier: (ph >= 3 ? 1 : 0) + (on >= 1 ? 1 : 0) + (dm >= 1 ? 1 : 0), raw: ph + on + dm };
    };
    rows.sort((a, b) => {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra.ready !== rb.ready) return ra.ready ? -1 : 1;
      if (ra.tier !== rb.tier) return rb.tier - ra.tier;
      return rb.raw - ra.raw;
    });

    // Known columns per related table (header fallback when a table is empty);
    // property_id is dropped as redundant with the property row.
    const KNOWN = {
      phone:       ['id', 'shop_date', 'agent_name', 'call_duration', 'score', 'greeting', 'product_knowledge', 'closing', 'notes', 'audio_url', 'created_at'],
      online:      ['id', 'shop_date', 'platform', 'score', 'response_time_hrs', 'photos_quality', 'listing_accuracy', 'notes', 'created_at'],
      dm:          ['id', 'reviewed_at', 'overall_score', 'ai_filled', 'audit_notes', 'website_scores', 'floorplan_scores', 'gbp_scores', 'facebook_scores', 'ils_scores', 'updated_at', 'created_at'],
      followup:    ['id', 'follow_up_date', 'method', 'contact_name', 'outcome', 'next_action', 'next_action_date', 'completed', 'notes', 'created_at'],
      appointment: ['id', 'appointment_at', 'status', 'outcome', 'notes', 'agent_name', 'created_at'],
      inspection:  ['id', 'visited_date', 'building_condition', 'notes', 'created_at'],
    };
    const colsFor = (data, known) => {
      const set = new Set(known);
      for (const r of (data || [])) for (const k of Object.keys(r)) if (k !== 'property_id') set.add(k);
      return [...set];
    };
    const phoneCols = colsFor(phones.data, KNOWN.phone);
    const onlineCols = colsFor(onlines.data, KNOWN.online);
    const dmCols = colsFor(dms.data, KNOWN.dm);
    const followCols = colsFor(follows.data, KNOWN.followup);
    const apptCols = colsFor(appts.data, KNOWN.appointment);
    const inspCols = colsFor(insps.data, KNOWN.inspection);

    // Most recent entry by a date field (desc, nulls last, created_at tiebreak).
    const latestBy = (arr, field) => (arr || []).slice().sort((a, b) => {
      const av = a[field] || '', bv = b[field] || '';
      if (av !== bv) return av < bv ? 1 : -1;
      return (b.created_at || '') < (a.created_at || '') ? -1 : 1;
    })[0] || null;
    // Phone calls read oldest -> newest, so call1 is the first call.
    const phonesAsc = (arr) => (arr || []).slice().sort((a, b) => (a.shop_date || '9999') < (b.shop_date || '9999') ? -1 : 1);

    const FALLBACK_COLS = ['id', 'property_name', 'address', 'city', 'state', 'zip', 'submarket', 'style', 'year_built', 'asset_class', 'units', 'vacancy_pct', 'avg_asking_unit', 'avg_unit_sf', 'management_company', 'management_type', 'owner_name', 'owner_contact_name', 'owner_phone', 'owner_email', 'owner_address', 'assigned_to', 'phone_assignee', 'phone_assignee3', 'online_dm_assignee', 'rop_status', 'lead_score_override', 'lyndsay_reviewed', 'notes', 'created_at', 'updated_at'];
    const baseCols = rows.length ? Object.keys(rows[0]) : FALLBACK_COLS;
    const px = (prefix, cols) => cols.map(c => prefix + c);
    const header = [
      ...baseCols,
      ...px('call1_', phoneCols), ...px('call2_', phoneCols), ...px('call3_', phoneCols),
      ...px('online_', onlineCols),
      ...px('dm_', dmCols),
      ...px('followup_', followCols),
      ...px('appointment_', apptCols),
      ...px('inspection_', inspCols),
    ];

    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rowCells = (obj, cols) => cols.map(c => cell(obj ? obj[c] : null));

    const lines = [header.join(',')];
    for (const p of rows) {
      const calls = phonesAsc(byPhone.get(p.id)).slice(0, 3);
      lines.push([
        ...baseCols.map(c => cell(p[c])),
        ...rowCells(calls[0] || null, phoneCols), ...rowCells(calls[1] || null, phoneCols), ...rowCells(calls[2] || null, phoneCols),
        ...rowCells(latestBy(byOnline.get(p.id), 'shop_date'), onlineCols),
        ...rowCells((byDm.get(p.id) || [])[0] || null, dmCols),
        ...rowCells(latestBy(byFollow.get(p.id), 'follow_up_date'), followCols),
        ...rowCells(latestBy(byAppt.get(p.id), 'appointment_at'), apptCols),
        ...rowCells(latestBy(byInsp.get(p.id), 'visited_date'), inspCols),
      ].join(','));
    }
    // BOM so Excel reads UTF-8 — owner names carry accents.
    const csv = '﻿' + lines.join('\r\n');

    const today = new Date().toLocaleDateString('en-CA', { timeZone: LYNDSAY_TIMEZONE });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bd_crm_export_${today}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// EVICTION TRACKER — persisted sessions + the ported standalone app
// =====================================================================
// The parsing/stage logic lives untouched in public/evictions-app.html (the
// original React tool). The dashboard tab embeds it in an iframe; these routes
// give it somewhere to save and reload.

// Username from the session cookie, or null (e.g. an MCP caller with only the
// key). Used to stamp who saved an eviction upload.
function sessionUsername(req) {
  try {
    const token = req.cookies?.dashboardToken;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET)?.username || null;
  } catch { return null; }
}

// Newest saved session. requireMetricAccess: session or key, like the other
// read routes — the app fetches this on load to rehydrate.
app.get('/api/evictions/session/latest', requireMetricAccess, async (req, res) => {
  if (!CRM_CONFIGURED) return res.json({ session: null });
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error } = await db.from('eviction_sessions')
      .select('*').order('uploaded_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ session: data || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save one upload. requireMetricAdmin: uploading replaces what everyone sees.
app.post('/api/evictions/session', requireMetricAdmin, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const { data, report_date } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data (object) is required' });
  try {
    const db = supabaseAdmin || supabasePublic;
    const uploaded_by = sessionUsername(req) || 'unknown';
    const row = { data, uploaded_by, report_date: report_date || null };
    const { data: saved, error } = await db.from('eviction_sessions').insert([row]).select('id,uploaded_at,uploaded_by,report_date').single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, session: saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The ported app itself, served to any valid session (the nav tab is admin-only
// on the client; upload is admin-gated on the server). Same-origin so its
// fetches to /api/evictions/* carry the cookie.
app.get('/evictions/app', requireMetricAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'evictions-app.html'));
});

// =====================================================================
// ACCOUNTING / BILLING — Claudia Villalobos (Accounting/QC)
// =====================================================================
// Vendors, bills, and QC/payment tasks. All routes requireAuth; no role gate
// yet (Arturo + Claudia). Writes accept only whitelisted columns so a stray
// field cannot reach the table.
const acctDb = () => supabaseAdmin || supabasePublic;

// Keeps a request body to the columns that exist. Drops undefined so PATCH only
// touches what was sent. Empty strings become null for the nullable text/number
// columns so a cleared form field clears the cell rather than storing "".
function acctPick(body, cols) {
  const out = {};
  for (const c of cols) {
    if (body[c] === undefined) continue;
    out[c] = body[c] === '' ? null : body[c];
  }
  return out;
}
const VENDOR_COLS = ['name', 'type', 'email', 'phone', 'w9_status', 'w9_year', 'notes'];
const BILL_COLS   = ['vendor_id', 'property', 'work_order_ref', 'amount', 'status', 'due_date', 'paid_date', 'notes'];
const TASK_COLS   = ['title', 'type', 'status', 'assigned_to', 'priority', 'due_date', 'notes'];

// ---- Vendors ----
app.get('/api/accounting/vendors', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const { data, error } = await acctDb().from('accounting_vendors').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ vendors: data || [] });
});
app.post('/api/accounting/vendors', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, VENDOR_COLS);
  if (!row.name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await acctDb().from('accounting_vendors').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
app.patch('/api/accounting/vendors/:id', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, VENDOR_COLS);
  if (!Object.keys(row).length) return res.status(400).json({ error: 'No updatable fields sent' });
  const { data, error } = await acctDb().from('accounting_vendors').update(row).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---- Bills ----
app.get('/api/accounting/bills', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  let q = acctDb().from('accounting_bills').select('*').order('created_at', { ascending: false });
  if (req.query.status && req.query.status !== 'all') q = q.eq('status', String(req.query.status));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ bills: data || [] });
});
app.post('/api/accounting/bills', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, BILL_COLS);
  const { data, error } = await acctDb().from('accounting_bills').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
app.patch('/api/accounting/bills/:id', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, BILL_COLS);
  if (!Object.keys(row).length) return res.status(400).json({ error: 'No updatable fields sent' });
  const { data, error } = await acctDb().from('accounting_bills').update(row).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---- Tasks ----
app.get('/api/accounting/tasks', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  let q = acctDb().from('accounting_tasks').select('*').order('created_at', { ascending: false });
  if (req.query.status && req.query.status !== 'all') q = q.eq('status', String(req.query.status));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data || [] });
});
app.post('/api/accounting/tasks', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, TASK_COLS);
  if (!row.title) return res.status(400).json({ error: 'title is required' });
  const { data, error } = await acctDb().from('accounting_tasks').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
app.patch('/api/accounting/tasks/:id', requireAuth, async (req, res) => {
  if (!CRM_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured' });
  const row = acctPick(req.body || {}, TASK_COLS);
  if (!Object.keys(row).length) return res.status(400).json({ error: 'No updatable fields sent' });
  const { data, error } = await acctDb().from('accounting_tasks').update(row).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


// Middleware: require Supabase to be configured before serving CRM routes
function requireCRM(req, res, next) {
  if (!CRM_CONFIGURED) {
    return res.status(503).json({ error: 'BD CRM not configured — set SUPABASE_URL and SUPABASE_ANON_KEY in .env' });
  }
  next();
}

// A bd_agent or maintenance user only ever sees properties they personally
// shop. Deliberately NOT assigned_to: that field is the primary BD rep, and
// being the rep is not the same as doing the shopping.
//
// Returns the agent name to filter by, or null when the caller sees everything.
// /api/crm/properties applies it as a database predicate and /api/crm/tasks in
// memory — different mechanics, one rule, so the two cannot drift apart.
const CRM_RESTRICTED_ROLES = ['bd_agent', 'maintenance'];

function crmRestrictToAgent(req) {
  const role = req.user?.role;
  const agent = req.user?.agentName;
  return (CRM_RESTRICTED_ROLES.includes(role) && agent) ? agent : null;
}

const crmAgentShops = (p, agent) =>
  p.phone_assignee === agent || p.phone_assignee3 === agent || p.online_dm_assignee === agent;

// ---- GET /api/crm/status -------------------------------------------------------
app.get('/api/crm/status', (req, res) => {
  res.json({ configured: CRM_CONFIGURED, hasAdmin: !!supabaseAdmin });
});

// ---- GET /api/crm/properties ---------------------------------------------------
// Query params: page (1-based), limit (default 50, max 200), search, submarket,
//   assigned_to, rop_status, asset_class, lyndsay_reviewed (true/false)
app.get('/api/crm/properties', requireCRM, requireAuth, async (req, res) => {
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

    // Role-based property filter — see crmRestrictToAgent above. Applied in the
    // query here rather than in JS, so the rows never leave the database.
    const callerAgent = crmRestrictToAgent(req);
    if (callerAgent) {
      query = query.or(`phone_assignee.eq.${callerAgent},phone_assignee3.eq.${callerAgent},online_dm_assignee.eq.${callerAgent}`);
    }

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
    const db = supabaseAdmin || supabasePublic;
    const { data: property, error: propErr } = await db
      .from('properties').select('*').eq('id', req.params.id).single();
    if (propErr) return res.status(404).json({ error: propErr.message });

    const [phones, online, follows, drafts, appts, insp, dm] = await Promise.all([
      db.from('phone_shops').select('*').eq('property_id', req.params.id).order('shop_date', { ascending: false }),
      db.from('online_shops').select('*').eq('property_id', req.params.id).order('shop_date', { ascending: false }),
      db.from('follow_ups').select('*').eq('property_id', req.params.id).order('follow_up_date', { ascending: false }),
      db.from('outreach_drafts').select('*').eq('property_id', req.params.id).order('created_at', { ascending: false }),
      db.from('appointments').select('*').eq('property_id', req.params.id).order('appointment_at', { ascending: false }),
      db.from('inspections').select('*').eq('property_id', req.params.id).order('visited_date', { ascending: false }),
      db.from('dm_reviews').select('*').eq('property_id', req.params.id).maybeSingle(),
    ]);

    res.json({
      ...property,
      phone_shops:     phones.data || [],
      online_shops:    online.data || [],
      follow_ups:      follows.data || [],
      outreach_drafts: drafts.data || [],
      appointments:    appts.data  || [],
      inspections:     insp.data   || [],
      dm_review:       dm.data     || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Property assignment ------------------------------------------------------
// Registered ABOVE PATCH /api/crm/properties/:id on purpose: Express matches in
// order, so "bulk-assign" would otherwise arrive as a property id and the route
// below would try to update a property that does not exist.
//
// The column is phone_assignee3, not phone_assignee2 — there has never been a 2.
// The alias is accepted so a caller written against the other name still lands
// on the right column rather than failing with an unknown-column error.
const ASSIGN_FIELDS = {
  phone_assignee: 'phone_assignee',
  phone_assignee3: 'phone_assignee3',
  phone_assignee2: 'phone_assignee3',
};

function assignPayload(body) {
  const field = ASSIGN_FIELDS[String(body?.field || '').trim()];
  if (!field) {
    return { error: `field must be one of ${Object.keys(ASSIGN_FIELDS).join(', ')}` };
  }
  // Blank clears the assignment, which is a real thing to want — stored as null
  // rather than '' so the "unassigned" filters and the task engine agree.
  const raw = body?.agent_name;
  const agent_name = (raw === null || String(raw ?? '').trim() === '') ? null : String(raw).trim();
  return { field, agent_name };
}

app.patch('/api/crm/properties/bulk-assign', requireCRM, requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  const { field, agent_name, error } = assignPayload(req.body);
  if (error) return res.status(400).json({ error });
  const ids = Array.isArray(req.body?.property_ids) ? req.body.property_ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'property_ids required' });

  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error: e } = await db.from('properties')
      .update({ [field]: agent_name }).in('id', ids).select('id');
    if (e) return res.status(500).json({ error: e.message });
    // Counted from what came back, not from what was asked for: an id that no
    // longer exists silently updates nothing, and reporting the request size
    // would tell the operator a reassignment landed when it did not.
    res.json({ ok: true, field, agent_name, updated: (data || []).length, requested: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/crm/properties/:id/assign', requireCRM, requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  const { field, agent_name, error } = assignPayload(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error: e } = await db.from('properties')
      .update({ [field]: agent_name }).eq('id', req.params.id).select().single();
    if (e) return res.status(500).json({ error: e.message });
    if (!data) return res.status(404).json({ error: 'Property not found' });
    res.json({ ok: true, field, agent_name, property: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PATCH /api/crm/properties/:id ---------------------------------------------
app.patch('/api/crm/properties/:id', requireCRM, async (req, res) => {
  try {
    const allowed = [
      'property_name','address','city','state','zip','submarket','style',
      'year_built','asset_class','units','vacancy_pct','avg_asking_unit','avg_unit_sf',
      'management_company','management_type',
      'owner_name','owner_contact_name','owner_phone','owner_email','owner_address',
      'assigned_to','phone_assignee','phone_assignee3','online_dm_assignee',
      'rop_status','lead_score_override','lyndsay_reviewed','notes',
      // Phase B — feed the task engine's owner-response and contact-hold rules.
      'owner_response_at','owner_response_handled','needs_contact_update',
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

// ---- POST /api/crm/properties/:id/phone-shops ----------------------------------
app.post('/api/crm/properties/:id/phone-shops', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error } = await db.from('phone_shops')
      .insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- POST /api/crm/properties/:id/online-shops ---------------------------------
app.post('/api/crm/properties/:id/online-shops', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error } = await db.from('online_shops')
      .insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/properties/:id/appointments ----------------------------------
app.get('/api/crm/properties/:id/appointments', requireCRM, async (req, res) => {
  try {
    const { data, error } = await (supabaseAdmin || supabasePublic)
      .from('appointments').select('*').eq('property_id', req.params.id)
      .order('appointment_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- POST /api/crm/properties/:id/appointments ---------------------------------
app.post('/api/crm/properties/:id/appointments', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error } = await db.from('appointments')
      .insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PATCH /api/crm/appointments/:id -------------------------------------------
app.patch('/api/crm/appointments/:id', requireCRM, async (req, res) => {
  try {
    const allowed = ['status', 'outcome', 'notes', 'appointment_at'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const { data, error } = await (supabaseAdmin || supabasePublic)
      .from('appointments').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/properties/:id/inspections -----------------------------------
app.get('/api/crm/properties/:id/inspections', requireCRM, async (req, res) => {
  try {
    const { data, error } = await (supabaseAdmin || supabasePublic)
      .from('inspections').select('*').eq('property_id', req.params.id)
      .order('visited_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- POST /api/crm/properties/:id/inspections ----------------------------------
app.post('/api/crm/properties/:id/inspections', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { data, error } = await db.from('inspections')
      .insert({ ...req.body, property_id: req.params.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/properties/:id/dm-review -------------------------------------
app.get('/api/crm/properties/:id/dm-review', requireCRM, async (req, res) => {
  try {
    const { data, error } = await (supabaseAdmin || supabasePublic)
      .from('dm_reviews').select('*').eq('property_id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PUT /api/crm/properties/:id/dm-review (upsert) ----------------------------
app.put('/api/crm/properties/:id/dm-review', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { website_scores, floorplan_scores, gbp_scores, facebook_scores, ils_scores, audit_notes, ai_filled } = req.body;

    // Compute overall_score: average of all numeric grade/yn values across sections
    const allScores = [website_scores, floorplan_scores, gbp_scores, facebook_scores, ils_scores]
      .filter(Boolean).flatMap(section => Object.values(section))
      .filter(v => typeof v === 'number' && !isNaN(v));
    const overall_score = allScores.length
      ? parseFloat((allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2))
      : null;

    const row = {
      property_id: req.params.id,
      reviewed_at: new Date().toISOString(),
      overall_score,
      website_scores:   website_scores   || {},
      floorplan_scores: floorplan_scores || {},
      gbp_scores:       gbp_scores       || {},
      facebook_scores:  facebook_scores  || {},
      ils_scores:       ils_scores       || {},
      audit_notes:      audit_notes      || null,
      ai_filled:        ai_filled        || false,
      updated_at:       new Date().toISOString(),
    };

    const { data, error } = await db.from('dm_reviews')
      .upsert(row, { onConflict: 'property_id' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/properties/:id/history ---------------------------------------
// Returns a reconstructed change timeline from sub-table created_at timestamps.
app.get('/api/crm/properties/:id/history', requireCRM, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const [phones, online, follows, appts, insp, dm, drafts] = await Promise.all([
      db.from('phone_shops').select('id,shop_date,agent_name,notes,created_at').eq('property_id', req.params.id),
      db.from('online_shops').select('id,shop_date,platform,notes,created_at').eq('property_id', req.params.id),
      db.from('follow_ups').select('id,follow_up_date,method,outcome,created_at').eq('property_id', req.params.id),
      db.from('appointments').select('id,appointment_at,status,outcome,created_at').eq('property_id', req.params.id),
      db.from('inspections').select('id,visited_date,building_condition,created_at').eq('property_id', req.params.id),
      db.from('dm_reviews').select('id,reviewed_at,overall_score,updated_at').eq('property_id', req.params.id).maybeSingle(),
      db.from('outreach_drafts').select('id,channel,subject,status,created_at').eq('property_id', req.params.id),
    ]);

    const events = [
      ...(phones.data  || []).map(r => ({ when: r.created_at, area: 'Phone Shop',    detail: `${r.agent_name || '—'} · ${r.notes || ''}`.trim() })),
      ...(online.data  || []).map(r => ({ when: r.created_at, area: 'Online Shop',   detail: `${r.platform || '—'} · ${r.notes || ''}`.trim() })),
      ...(follows.data || []).map(r => ({ when: r.created_at, area: 'Follow-Up',     detail: `${r.method || '—'} → ${r.outcome || ''}`.trim() })),
      ...(appts.data   || []).map(r => ({ when: r.created_at, area: 'Appointment',   detail: `${r.status || ''}${r.outcome ? ' · ' + r.outcome : ''}` })),
      ...(insp.data    || []).map(r => ({ when: r.created_at, area: 'Inspection',    detail: `Building: ${r.building_condition || '—'}` })),
      ...(drafts.data  || []).map(r => ({ when: r.created_at, area: 'Outreach Draft',detail: `${r.channel || '—'} · ${r.subject || ''}`.trim() })),
      ...(dm.data ? [{ when: dm.data.updated_at, area: 'DM Review', detail: `Score: ${dm.data.overall_score ?? '—'}` }] : []),
    ].sort((a, b) => new Date(b.when) - new Date(a.when));

    res.json(events);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/outreach-drafts -----------------------------------------------
// Returns all outreach_drafts with status='draft', joined to property info.
app.get('/api/crm/outreach-drafts', requireCRM, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client
      .from('outreach_drafts')
      .select('id, property_id, channel, subject, body, status, notes, created_at, properties(property_name, assigned_to, online_dm_assignee)')
      .eq('status', 'draft')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Group by property_id
    const grouped = {};
    for (const d of (data || [])) {
      const pid = d.property_id;
      if (!grouped[pid]) {
        grouped[pid] = {
          property_id: pid,
          property_name: d.properties?.property_name || '—',
          assigned_to:   d.properties?.assigned_to   || null,
          dm_assignee:   d.properties?.online_dm_assignee || null,
          drafts: [],
        };
      }
      grouped[pid].drafts.push({
        id: d.id, channel: d.channel, subject: d.subject,
        body: d.body, notes: d.notes, created_at: d.created_at,
      });
    }
    res.json({ groups: Object.values(grouped), total: (data||[]).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/crm/import-costar ------------------------------------------------
// Accepts a .xlsx CoStar export, fuzzy-matches properties by name, updates fields.
const multerMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Normalise a string for fuzzy matching: lowercase, strip non-alphanumeric.
function costarNorm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Map flexible CoStar column header variations to canonical keys.
const COSTAR_COL_ALIASES = {
  property_name:      ['propertyname','property name','name','propertyaddress'],
  address:            ['address','propertyaddress','streetaddress'],
  vacancy_pct:        ['vacancy%','vacancyrate','vac%','vacancypct','vacancy'],
  avg_asking_unit:    ['avgaskingrent/unit','avgasking/unit','avgaskingunit','askingrent/unit','avgrent'],
  management_company: ['managementcompany','managingcompany','managementfirm','manager'],
  owner_name:         ['ownername','owner','propertyowner'],
};

function costarMapRow(rawRow) {
  // Build a normalised-key → raw-value lookup from the row's keys.
  const normKeys = {};
  for (const k of Object.keys(rawRow)) { normKeys[costarNorm(k)] = rawRow[k]; }

  const out = {};
  for (const [canonical, aliases] of Object.entries(COSTAR_COL_ALIASES)) {
    for (const alias of aliases) {
      if (normKeys[alias] !== undefined) { out[canonical] = normKeys[alias]; break; }
    }
  }
  return out;
}

app.post('/api/crm/import-costar', requireCRM, multerMemory.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send as multipart field "file".' });
  try {
    // Parse xlsx
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Spreadsheet is empty or unreadable.' });

    // Fetch all properties (id + property_name) for matching
    const client = supabaseAdmin || supabasePublic;
    const { data: allProps, error: propErr } = await client
      .from('properties').select('id, property_name').limit(5000);
    if (propErr) return res.status(500).json({ error: propErr.message });

    // Build normalised lookup: normName → { id, property_name }
    const propIndex = {};
    for (const p of (allProps || [])) { propIndex[costarNorm(p.property_name)] = p; }

    const results = { matched: 0, updated: 0, skipped: 0, unmatched: [] };

    for (const rawRow of rows) {
      const row = costarMapRow(rawRow);
      if (!row.property_name) continue;

      const normName = costarNorm(row.property_name);
      const match = propIndex[normName];
      if (!match) { results.unmatched.push(row.property_name); continue; }
      results.matched++;

      // Build update payload — only include fields that have a value
      const updates = {};
      if (row.vacancy_pct     != null && row.vacancy_pct     !== '') updates.vacancy_pct        = parseFloat(String(row.vacancy_pct).replace(/[^0-9.]/g, '')) || null;
      if (row.avg_asking_unit != null && row.avg_asking_unit !== '') updates.avg_asking_unit     = parseFloat(String(row.avg_asking_unit).replace(/[^0-9.]/g, '')) || null;
      if (row.management_company)                                     updates.management_company = String(row.management_company).trim();
      if (row.owner_name)                                             updates.owner_name         = String(row.owner_name).trim();
      if (row.address)                                                updates.address            = String(row.address).trim();

      if (!Object.keys(updates).length) { results.skipped++; continue; }

      const { error: upErr } = await client.from('properties').update(updates).eq('id', match.id);
      if (upErr) { results.unmatched.push(`${row.property_name} (update error: ${upErr.message})`); continue; }
      results.updated++;
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/crm/tasks --------------------------------------------------------
// Derives tasks from properties in Supabase — no separate tasks table.
// requireAuth is not optional here: tasks expose every property's activity and
// assignments, and without a session there is no role to restrict by. Verified
// no MCP tool calls this route, so adding it breaks nothing.
app.get('/api/crm/tasks', requireCRM, requireAuth, async (req, res) => {
  try {
    const db = supabaseAdmin || supabasePublic;
    const { agent } = req.query; // optional narrowing by the UI's agent dropdown

    // select('*') on purpose: the engine reads year_built, asset_class and
    // phone_assignee3, which the old column list did not include.
    const query = db.from('properties').select('*');
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const properties = data || [];

    // Hydrate every property with its activity, then let crm-task-engine decide.
    // Six bulk reads rather than six per property: with ~250 properties the
    // per-property version would be 1,500 round trips.
    const [phones, onlines, follows, appts, insps, dms, targeted] = await Promise.all([
      db.from('phone_shops').select('*'),
      db.from('online_shops').select('*'),
      db.from('follow_ups').select('*'),
      db.from('appointments').select('*'),
      db.from('inspections').select('*'),
      db.from('dm_reviews').select('*'),
      db.from('targeted_companies').select('company_name'),
    ]);

    const groupBy = rows => {
      const out = {};
      (rows || []).forEach(r => { (out[r.property_id] = out[r.property_id] || []).push(r); });
      return out;
    };
    const byPhone   = groupBy(phones.data);
    const byOnline  = groupBy(onlines.data);
    const byFollow  = groupBy(follows.data);
    const byAppt    = groupBy(appts.data);
    const byInsp    = groupBy(insps.data);
    const byDm      = {};
    (dms.data || []).forEach(r => { byDm[r.property_id] = r; });

    // Same restriction as /api/crm/properties, applied before the engine runs so
    // a restricted caller cannot see tasks for properties they do not shop. The
    // ?agent= dropdown then narrows further within whatever remains.
    const restrictAgent = crmRestrictToAgent(req);
    const visible = restrictAgent
      ? properties.filter(p => crmAgentShops(p, restrictAgent))
      : properties;

    const hydrated = visible.map(p => ({
      ...p,
      phone_shops:  byPhone[p.id]  || [],
      online_shops: byOnline[p.id] || [],
      follow_ups:   byFollow[p.id] || [],
      appointments: byAppt[p.id]   || [],
      inspections:  byInsp[p.id]   || [],
      dm_review:    byDm[p.id]     || null,
    }));

    let tasks = crmEngine.computeTasks(hydrated, {
      targetedCompanies: (targeted.data || []).map(r => r.company_name),
    });

    // Agent filter stays a substring match, as before — the UI sends a name.
    if (agent) {
      const q = agent.toLowerCase();
      tasks = tasks.filter(t => String(t.agent || '').toLowerCase().includes(q));
    }

    res.json({
      ok: true,
      total: tasks.length,
      totalMinutes: tasks.reduce((s, t) => s + (t.minutes || 0), 0),
      summary: crmEngine.agentSummary(tasks),
      tasks,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Targeted management companies ---------------------------------------------
// Worth +150 in the task engine. This list previously lived in each person's
// browser localStorage, so it was per-user and the server could never see it.

app.get('/api/crm/targeted-companies', requireCRM, async (req, res) => {
  try {
    const { data, error } = await (supabaseAdmin || supabasePublic)
      .from('targeted_companies').select('*').order('company_name');
    if (error) throw error;
    res.json({ companies: (data || []).map(r => r.company_name) });
  } catch (err) {
    res.status(500).json({ error: err.message, hint: 'Has supabase/migrations/003_crm_phase_b.sql been run?' });
  }
});

// Replace the whole list — matches how the textarea behaves. Deleting first
// means a name removed from the box actually disappears.
app.put('/api/crm/targeted-companies', requireCRM, async (req, res) => {
  const names = Array.isArray(req.body.companies)
    ? req.body.companies
    : String(req.body.companies || '').split('\n');

  // Dedupe on the same normalized form the unique index uses, so a list with
  // "Greystar" and "greystar " is not rejected outright by the insert.
  const seen = new Set();
  const clean = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ company_name: name });
  }

  try {
    const db = supabaseAdmin || supabasePublic;
    const { error: delErr } = await db.from('targeted_companies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (delErr) throw delErr;
    if (clean.length) {
      const { error: insErr } = await db.from('targeted_companies').insert(clean);
      if (insErr) throw insErr;
    }
    res.json({ ok: true, count: clean.length, companies: clean.map(c => c.company_name) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ---- BD Agents (roster) --------------------------------------------------------
// The read is restricted to admin and operations, not just any signed-in user:
// this table carries internal staff emails and phone numbers, which the property
// list does not, and a bd_agent has no reason to hold the team's contact
// details. Writes are admin-only on top of that.
const BD_AGENT_FIELDS = ['name', 'email', 'role', 'phone', 'status', 'crm_alias', 'notes'];
const BD_AGENT_STATUSES = ['active', 'inactive', 'unknown'];

function bdAgentPayload(body, { partial }) {
  const out = {};
  for (const k of BD_AGENT_FIELDS) {
    if (!(k in body)) continue;
    // Blanks are stored as null, not '', so the partial unique index on email
    // keeps treating "no email" as absent rather than as a value five rows share.
    const v = typeof body[k] === 'string' ? body[k].trim() : body[k];
    out[k] = (v === '' || v === undefined) ? null : v;
  }
  if (!partial && !out.name) return { error: 'Name is required' };
  if ('name' in out && !out.name) return { error: 'Name cannot be empty' };
  if (out.status && !BD_AGENT_STATUSES.includes(out.status)) {
    return { error: `status must be one of ${BD_AGENT_STATUSES.join(', ')}` };
  }
  return { data: out };
}

// The database enforces uniqueness on the normalised name and email; this turns
// its error into something a person can act on rather than a raw 23505.
function bdAgentError(error) {
  if (error.code === '23505') {
    return error.message.includes('email')
      ? 'Another agent already has that email.'
      : 'An agent with that name already exists.';
  }
  return error.message;
}

app.get('/api/crm/bd-agents', requireCRM, requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('bd_agents').select('*').order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/crm/bd-agents', requireCRM, requireAuth, requireRole('admin'), async (req, res) => {
  const { data: payload, error: bad } = bdAgentPayload(req.body || {}, { partial: false });
  if (bad) return res.status(400).json({ error: bad });
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('bd_agents').insert(payload).select().single();
    if (error) return res.status(400).json({ error: bdAgentError(error) });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/crm/bd-agents/:id', requireCRM, requireAuth, requireRole('admin'), async (req, res) => {
  const { data: payload, error: bad } = bdAgentPayload(req.body || {}, { partial: true });
  if (bad) return res.status(400).json({ error: bad });
  if (!Object.keys(payload).length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('bd_agents').update(payload).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: bdAgentError(error) });
    if (!data) return res.status(404).json({ error: 'Agent not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Separate from the PATCH above because it is a toggle, not an edit: the caller
// says which agent, the server decides the next value. An agent whose status is
// 'unknown' becomes 'active' — the toggle is how you resolve that, and going to
// 'inactive' instead would record a decision nobody made.
app.patch('/api/crm/bd-agents/:id/status', requireCRM, requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data: cur, error: fe } = await client.from('bd_agents').select('status').eq('id', req.params.id).single();
    if (fe || !cur) return res.status(404).json({ error: 'Agent not found' });
    const next = cur.status === 'active' ? 'inactive' : 'active';
    const { data, error } = await client.from('bd_agents').update({ status: next }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- G&B rotation --------------------------------------------------------------
// G&B Management answers one phone number for all of its properties, so the same
// person calling twice in a row reaches someone who just spoke to them.
// Confirmed with Lyndsay 2026-08-31: four people, roughly fortnightly, chosen
// randomly.
//
// Matched in JS rather than with an ILIKE filter: the literal is "G&B", and an
// ampersand inside a PostgREST `or` string is a parameter separator. With 251
// properties the whole column is cheaper to read than the bug would be to find.
const GB_PATTERNS = ['g&b', 'g & b', 'gandb', 'g and b'];
const gbNorm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isGbCompany = c => { const n = gbNorm(c); return !!n && GB_PATTERNS.some(p => n.includes(p)); };

async function gbLoad(client) {
  const [props, agents, history] = await Promise.all([
    client.from('properties').select('id, property_name, address, management_company'),
    // Membership is its own flag, not a filter on employment status: Lisa is a
    // contractor sitting at status 'unknown', and whether she takes G&B calls is
    // a different question from whether she is on staff. No names in code.
    client.from('bd_agents').select('name, crm_alias').eq('in_gb_rotation', true).order('name'),
    client.from('gb_rotation').select('*').order('assigned_at', { ascending: false }),
  ]);
  if (props.error) throw new Error(props.error.message);
  if (agents.error) throw new Error(agents.error.message);
  if (history.error) throw new Error(history.error.message);
  return {
    properties: (props.data || []).filter(p => isGbCompany(p.management_company)),
    // The alias is what the rest of the CRM stores on a property; the full name
    // is only a label.
    agents: (agents.data || []).map(a => (a.crm_alias || a.name || '').trim()).filter(Boolean),
    history: history.data || [],
  };
}

// Newest first from the query, so the first row seen for a property is current.
function gbCurrentByProperty(history) {
  const cur = new Map();
  for (const r of history) if (!cur.has(r.property_id)) cur.set(r.property_id, r);
  return cur;
}

/**
 * Who calls this property next.
 *
 * Never-called first, then longest-since-called, then fewest already handed out
 * in this run, then random. The first two are the rotation Lyndsay described;
 * the third keeps a first run — where every agent is equally new to every
 * property — from landing six properties on one person by chance; the random
 * tail is the "just randomly" she asked for, applied among candidates that are
 * otherwise indistinguishable.
 *
 * The current holder is removed outright: not calling twice in a row is the
 * whole point, and it outranks every other consideration.
 */
function gbPickAgent(agents, lastByAgent, current, runCounts) {
  const pool = agents.filter(a => a !== current);
  // One agent in the rotation and they already hold it: nobody else can take it.
  if (!pool.length) return null;
  const scored = pool.map(a => ({
    agent: a,
    last: lastByAgent.get(a) ?? null,
    run: runCounts.get(a) || 0,
    coin: Math.random(),
  }));
  scored.sort((x, y) => {
    if ((x.last === null) !== (y.last === null)) return x.last === null ? -1 : 1;
    if (x.last !== null && x.last !== y.last) return x.last - y.last;
    if (x.run !== y.run) return x.run - y.run;
    return x.coin - y.coin;
  });
  return scored[0].agent;
}

const GB_ROTATE_DAYS = 14;

app.get('/api/crm/gb-rotation', requireCRM, requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { properties, agents, history } = await gbLoad(client);
    const cur = gbCurrentByProperty(history);
    const today = reportDateStr();
    const rows = properties.map(p => {
      const a = cur.get(p.id) || null;
      return {
        property_id: p.id,
        property_name: p.property_name,
        address: p.address,
        management_company: p.management_company,
        assigned_agent: a?.assigned_agent || null,
        assigned_at: a?.assigned_at || null,
        rotate_after: a?.rotate_after || null,
        // Negative means overdue. Computed here so the badge does not depend on
        // the reader's clock.
        days_left: a?.rotate_after
          ? Math.round((Date.parse(a.rotate_after + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 86400000)
          : null,
        notes: a?.notes || null,
      };
    }).sort((x, y) => String(x.property_name || '').localeCompare(String(y.property_name || '')));
    res.json({ agents, rotateDays: GB_ROTATE_DAYS, properties: rows,
               unassigned: rows.filter(r => !r.assigned_agent).length,
               overdue: rows.filter(r => r.days_left != null && r.days_left < 0).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/crm/gb-rotation/assign', requireCRM, requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { properties, agents, history } = await gbLoad(client);
    if (!agents.length) {
      return res.status(400).json({ error: 'Nobody is in the G&B rotation. Tick in_gb_rotation on bd_agents.' });
    }
    if (!properties.length) {
      return res.json({ ok: true, assigned: 0, message: 'No properties are managed by G&B.' });
    }

    // Last time each agent had each property, from the full history.
    const lastByProperty = new Map();
    for (const r of history) {
      if (!lastByProperty.has(r.property_id)) lastByProperty.set(r.property_id, new Map());
      const m = lastByProperty.get(r.property_id);
      const t = Date.parse(r.assigned_at) || 0;
      if (!m.has(r.assigned_agent) || t > m.get(r.assigned_agent)) m.set(r.assigned_agent, t);
    }
    const cur = gbCurrentByProperty(history);
    const runCounts = new Map();
    const now = new Date();
    const rotateAfter = new Date(now); rotateAfter.setDate(rotateAfter.getDate() + GB_ROTATE_DAYS);

    const rows = [];
    for (const p of properties) {
      const pick = gbPickAgent(agents, lastByProperty.get(p.id) || new Map(),
                               cur.get(p.id)?.assigned_agent || null, runCounts);
      if (!pick) continue;
      runCounts.set(pick, (runCounts.get(pick) || 0) + 1);
      rows.push({
        property_id: p.id, assigned_agent: pick,
        assigned_at: now.toISOString(), rotate_after: localDateStr(rotateAfter),
        notes: req.body?.notes || null,
      });
    }
    if (!rows.length) return res.json({ ok: true, assigned: 0, message: 'Nothing to rotate.' });

    // Inserted, not upserted: the history is what proves nobody called twice in
    // a row, so a run appends rather than replacing what came before.
    const { error } = await client.from('gb_rotation').insert(rows);
    if (error) return res.status(500).json({ error: error.message });

    const per = {};
    for (const r of rows) per[r.assigned_agent] = (per[r.assigned_agent] || 0) + 1;
    res.json({ ok: true, assigned: rows.length, perAgent: per, rotateDays: GB_ROTATE_DAYS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /api/crm/team-performance ---------------------------------------------
// Same guard as the roster read: this is per-person output, and operations is as
// far down as it should go.
//
// Every number here is counted from activity rows the agent created. There is no
// task-completion record to read and there should not be one: crm-task-engine.js
// derives the queue from property state, so a task disappears precisely when the
// row that answers it is written. The row is the completion. A "mark complete"
// button would count clicks rather than work, and would not clear the task
// anyway, since the engine recomputes from state and would not consult it.
//
// Which means a metric can only be as honest as its attribution. Until 006 only
// phone_shops recorded who did the work, so the rest are reported as untracked
// rather than as zero — a zero next to a rank badge reads as "did nothing",
// which is a different and damaging claim.
const TP_RANGES = { today: 0, week: 6, month: 29 };
// A metric counts as tracked once enough rows carry a name to mean anything. Four
// rows cannot support a performance panel whatever fraction of them is populated.
const TP_MIN_ATTRIBUTED = 10;

function tpDaysAgo(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n);
  return d;
}
const tpDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

app.get('/api/crm/team-performance', requireCRM, requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  const range = TP_RANGES[req.query.range] != null ? req.query.range : 'week';
  const client = supabaseAdmin || supabasePublic;

  try {
    const { data: agents, error: ae } = await client.from('bd_agents')
      .select('name, crm_alias, status').eq('status', 'active').not('crm_alias', 'is', null).order('name');
    if (ae) return res.status(500).json({ error: ae.message });

    // One read per table over the widest window, bucketed in memory afterwards,
    // rather than three round trips per agent per metric.
    const monthAgo = tpDateStr(tpDaysAgo(TP_RANGES.month));
    const monthAgoTs = tpDaysAgo(TP_RANGES.month).toISOString();
    const [phone, online, fups, dms, drafts] = await Promise.all([
      client.from('phone_shops').select('agent_name, shop_date, notes').gte('shop_date', monthAgo),
      client.from('online_shops').select('agent_name, shop_date').gte('shop_date', monthAgo),
      client.from('follow_ups').select('agent_name, follow_up_date').gte('follow_up_date', monthAgo),
      client.from('dm_reviews').select('agent_name, updated_at').gte('updated_at', monthAgoTs),
      client.from('outreach_drafts').select('approved_by, created_at').gte('created_at', monthAgoTs),
    ]);

    const rows = r => (r?.data || []);
    // Coverage asks whether the metric is being recorded at all, so it looks at
    // every row in the window rather than only the selected period — a quiet
    // week is not the same as a column nobody fills in.
    const attributed = (list, key) => list.filter(r => r[key] != null && String(r[key]).trim() !== '').length;

    const inRange = (value, r) => {
      if (!value) return false;
      const day = String(value).slice(0, 10);
      return day >= tpDateStr(tpDaysAgo(TP_RANGES[r])) && day <= tpDateStr(new Date());
    };

    // connection lives inside the notes JSON string, not a column, so it is read
    // here rather than filtered in the query.
    const connOf = n => {
      if (!n) return null;
      try { const p = typeof n === 'object' ? n : JSON.parse(n); return p && typeof p === 'object' ? (p.connection ?? null) : null; }
      catch { return null; }
    };

    const phoneRows = rows(phone), onlineRows = rows(online), fupRows = rows(fups),
          dmRows = rows(dms), draftRows = rows(drafts);

    const withConnection = phoneRows.filter(r => connOf(r.notes) != null).length;
    const coverage = {
      phone_shops:     attributed(phoneRows, 'agent_name')  >= TP_MIN_ATTRIBUTED,
      online_shops:    attributed(onlineRows, 'agent_name') >= TP_MIN_ATTRIBUTED,
      follow_ups:      attributed(fupRows, 'agent_name')    >= TP_MIN_ATTRIBUTED,
      dm_reviews:      attributed(dmRows, 'agent_name')     >= TP_MIN_ATTRIBUTED,
      outreach_drafts: attributed(draftRows, 'approved_by') >= TP_MIN_ATTRIBUTED,
      hot_leads:       withConnection >= TP_MIN_ATTRIBUTED,
    };
    // Tasks completed is the sum of the four activity types, so it is only
    // meaningful once at least one of them is attributed.
    coverage.tasks_completed = coverage.phone_shops || coverage.online_shops
      || coverage.follow_ups || coverage.dm_reviews;

    const countFor = (list, nameKey, dateKey, alias, r) =>
      list.filter(x => x[nameKey] === alias && inRange(x[dateKey], r)).length;

    const out = agents.map(a => {
      const alias = a.crm_alias;
      const tasksIn = r =>
        countFor(phoneRows,  'agent_name',  'shop_date',       alias, r) +
        countFor(onlineRows, 'agent_name',  'shop_date',       alias, r) +
        countFor(fupRows,    'agent_name',  'follow_up_date',  alias, r) +
        countFor(dmRows,     'agent_name',  'updated_at',      alias, r);
      return {
        agent_name: a.name,
        crm_alias: alias,
        tasks_completed_today: tasksIn('today'),
        tasks_completed_week:  tasksIn('week'),
        tasks_completed_month: tasksIn('month'),
        hot_leads_contacted: phoneRows.filter(x =>
          x.agent_name === alias && connOf(x.notes) === 'answered_agent' && inRange(x.shop_date, range)).length,
        phone_shops:     countFor(phoneRows,  'agent_name',  'shop_date',      alias, range),
        online_shops:    countFor(onlineRows, 'agent_name',  'shop_date',      alias, range),
        follow_ups:      countFor(fupRows,    'agent_name',  'follow_up_date', alias, range),
        outreach_drafts: countFor(draftRows,  'approved_by', 'created_at',     alias, range),
        dm_reviews:      countFor(dmRows,     'agent_name',  'updated_at',     alias, range),
      };
    });

    // Ranked on phone shops alone, because it is the only metric with enough
    // history to rank on. Ties share a place rather than being ordered by name.
    const ranked = [...out].filter(a => a.phone_shops > 0)
      .sort((a, b) => b.phone_shops - a.phone_shops);
    let place = 0, prev = null;
    ranked.forEach((a, i) => { if (a.phone_shops !== prev) { place = i + 1; prev = a.phone_shops; } a.rank = place; });
    for (const a of out) if (a.rank == null) a.rank = null;

    res.json({ range, agents: out, coverage, rankedBy: 'phone_shops' });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// =====================================================================
// MODULE — UNIFIED DAILY OPERATIONS REPORT
// =====================================================================
// Shell only: the seven sections are structure and placeholders. Content lands
// in a later phase, once the team confirms what each of them reports.

// Stored into the report's jsonb at generate time rather than read from here at
// render time, so changing this constant later cannot rewrite the history of
// reports already signed. Owners are as confirmed by Jay. Three of them —
// Rocío on leasing and collections, Bekah on pending items — have no dashboard
// account yet; they own the section regardless, and the placeholder names them
// so it is clear whose input is missing rather than just that something is.
const REPORT_SECTIONS = [
  { key: 'urgent',      icon: '🚨', title: 'Urgent / Needs Attention', owner: 'Jay Manuel' },
  { key: 'leasing',     icon: '🏠', title: 'Leasing & Applications',   owner: 'Rocío' },
  { key: 'maintenance', icon: '🔧', title: 'Maintenance',              owner: 'Erick Frey' },
  { key: 'collections', icon: '💰', title: 'Collections',              owner: 'Rocío' },
  { key: 'kpi',         icon: '📊', title: 'KPI Results',              owner: 'Jay Manuel' },
  { key: 'pending',     icon: '⏳', title: 'Pending Items',            owner: 'Bekah' },
  { key: 'accounting',  icon: '💵', title: 'Accounting',              owner: 'Claudia' },
  { key: 'other',       icon: '📝', title: 'Other',                    owner: 'Team' },
];

// Who is expected to sign, as their dashboard_users.name reads exactly — a row is
// matched to an account by comparing against the signed-in user's name, so the
// two have to agree.
//
// Spelled exactly as dashboard_users.name spells them — reportSignerFor matches a
// row to an account by that string, so a mismatch means the person is offered no
// row at all. Rebekah, Kara and Rocío are here ahead of their accounts being
// created; until then their rows show as outstanding, which is accurate.
const REPORT_SIGNERS = [
  'Jay Manuel', 'Lyndsay Hanes', 'Arturo Mendoza',
  'Rebekah Tuckner', 'Kara Garst', 'Rocío Hunsberger',
];

// Lyndsay is 'admin' in dashboard_users — there is no 'ceo' row today. Kept in
// the list anyway because TAB_ACCESS already carries a ceo entry, so if that role
// is ever created it should reach this panel rather than silently not.
const REPORT_ADMIN_ROLES = ['admin', 'ceo'];
const isReportAdmin = req => REPORT_ADMIN_ROLES.includes(req.user?.role);

// Accents and casing must not decide whether a sign-off counts: 'Rocío',
// 'rocio' and 'ROCIO ' are one person.
const reportNorm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().toLowerCase();

// Which roster row belongs to the signed-in user. Matches on the full name or on
// its first token, so "Rocío Hunsberger" answers to the "Rocío" row.
function reportSignerFor(req) {
  const me = reportNorm(req.user?.name);
  if (!me) return null;
  const first = me.split(/\s+/)[0];
  return REPORT_SIGNERS.find(s => {
    const n = reportNorm(s);
    return n === me || n === first;
  }) || null;
}

function reportDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Maintenance is the first section to carry real data: Erick's board already
// holds it, so asking him to retype it into a report would be transcription, not
// reporting. The other six stay placeholders until their owners confirm what
// they report.
//
// The priority strings must match OPS_PRIORITIES in metric-routes.js exactly —
// a mismatched emoji there once put every Daily Task in the wrong column, and
// here it would silently report zero critical items on a board that had six.
const OPS_CRITICAL = '🔴 Critical';
const OPS_FOLLOWUP = '🟡 Follow-up';

// Erick works from three places and they answer different questions: the board
// is what he wrote down, the Command Center is what the AppFolio workbook
// flagged, Asana is what other people asked of him. They used to share one
// section and overwrite each other, so the report showed whichever had been
// touched last and silently dropped the other two.
//
// operational_tasks carries no source or assigned_to column — the whole table is
// his board, so there is nothing to filter it by.
async function maintBoardSummary(client) {
  const { data, error } = await client.from('operational_tasks').select('title, priority, completed_at');
  if (error) return { error: error.message };
  const rows = data || [];
  const open = rows.filter(t => !t.completed_at);
  const today = reportDateStr();
  const critical = open.filter(t => t.priority === OPS_CRITICAL).map(t => t.title);
  const followup = open.filter(t => t.priority === OPS_FOLLOWUP).map(t => t.title);
  return {
    critical, followup,
    // localDateStr, not a slice of the ISO string: that gives the UTC date and
    // rolls over hours before local midnight.
    completed_today: rows.filter(t => t.completed_at && localDateStr(t.completed_at) === today).length,
    total_open: open.length,
    severity: critical.length ? 'red' : (followup.length ? 'amber' : 'green'),
  };
}

async function maintCommandCenterSummary(client) {
  const { data, error } = await client.from('cc_daily_state')
    .select('tasks, total_tasks, completed_tasks, generated_at, updated_at')
    .eq('state_date', reportDateStr()).maybeSingle();
  if (error) return { loaded: false, error: error.message };
  if (!data) return { loaded: false };

  // The stored tasks carry the Command Center's own category keys, so the
  // breakdown is counted from them rather than guessed at.
  const byCategory = {};
  for (const t of (Array.isArray(data.tasks) ? data.tasks : [])) {
    const k = t?.cat || 'other';
    byCategory[k] = (byCategory[k] || 0) + 1;
  }
  const total = data.total_tasks || 0, done = data.completed_tasks || 0;
  return {
    loaded: true,
    total_tasks: total,
    completed_tasks: done,
    pct: total ? Math.round(done / total * 100) : 0,
    byCategory,
    generated_at: data.generated_at || null,
    updated_at: data.updated_at || null,
  };
}

// Null rather than an error object: the brief asks for this one to disappear
// quietly when Asana is unreachable, and a report missing a third of itself is
// better than one shouting about a service nobody asked about.
async function maintAsanaSummary() {
  try {
    const token = asanaTokenFor('erick');
    if (!token) return null;
    const me = await getMe(token);
    if (!me.gid || !me.workspaceGid) return null;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const rows = await asanaGetAll(
      `/tasks?assignee=${me.gid}&workspace=${me.workspaceGid}`
      + `&opt_fields=name,due_on,due_at,completed,completed_at`
      + `&completed_since=${encodeURIComponent(midnight.toISOString())}`, token);

    const today = reportDateStr();
    const all = rows || [];
    const open = all.filter(t => !t.completed);
    const due = t => t.due_on || (t.due_at ? localDateStr(t.due_at) : null);
    return {
      open: open.length,
      overdue: open.filter(t => { const d = due(t); return d && d < today; }).length,
      completed_today: all.filter(t => t.completed && t.completed_at
        && localDateStr(t.completed_at) === today).length,
      titles: open.slice(0, 10).map(t => t.name).filter(Boolean),
    };
  } catch (err) {
    console.error('[maint-summary] asana unavailable:', err.message);
    return null;
  }
}

async function maintDailySummary() {
  const client = supabaseAdmin || supabasePublic;
  const [board, commandCenter, asana] = await Promise.all([
    maintBoardSummary(client),
    maintCommandCenterSummary(client),
    maintAsanaSummary(),
  ]);
  // Worst of the three wins. Anything overdue in Asana is as red as a critical
  // on the board — the point of showing all three is that no single one of them
  // gets to call the day quiet.
  const severity =
    (board.severity === 'red' || (asana && asana.overdue > 0)) ? 'red'
    : (board.severity === 'amber' || (commandCenter.loaded && commandCenter.pct < 100)) ? 'amber'
    : 'green';
  return { board, commandCenter, asana, severity, lastUpdated: new Date().toISOString() };
}

app.get('/api/maintenance/daily-summary', requireAuth, async (req, res) => {
  try { res.json(await maintDailySummary()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

async function reportMaintenanceSection() {
  return {
    key: 'maintenance', icon: '🔧', title: 'Maintenance', owner: 'Erick Frey',
    status: 'auto',
    content: await maintDailySummary(),
    last_updated: new Date().toISOString(),
  };
}

async function reportBuildSections(client) {
  const sections = REPORT_SECTIONS.map(s => ({ ...s, status: 'pending', content: null }));
  const i = sections.findIndex(s => s.key === 'maintenance');
  if (i >= 0) {
    try { sections[i] = await reportMaintenanceSection(); }
    catch (err) { console.error('[reports] maintenance section unavailable:', err.message); }
  }
  const j = sections.findIndex(s => s.key === 'accounting');
  if (j >= 0) {
    try { sections[j] = await reportAccountingSection(); }
    catch (err) { console.error('[reports] accounting section unavailable:', err.message); }
  }
  return sections;
}

// Accounting roll-up for the Daily Report — read live from the three accounting
// tables at generation time. Severity: red if any urgent open task, amber if
// any bill is pending approval, green otherwise.
async function reportAccountingSection() {
  const client = supabaseAdmin || supabasePublic;
  const [tasksR, billsR, vendorsR] = await Promise.all([
    client.from('accounting_tasks').select('priority,status'),
    client.from('accounting_bills').select('status,amount'),
    client.from('accounting_vendors').select('w9_status'),
  ]);
  for (const r of [tasksR, billsR, vendorsR]) if (r.error) throw new Error(r.error.message);
  const openTasks = (tasksR.data || []).filter(t => t.status !== 'done');
  const urgentTasks = openTasks.filter(t => t.priority === 'urgent').length;
  const normalTasks = openTasks.filter(t => t.priority === 'normal').length;
  const pending = (billsR.data || []).filter(b => b.status === 'pending');
  const pendingBills = pending.length;
  const pendingAmount = pending.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const w9Issues = (vendorsR.data || []).filter(v => v.w9_status === 'missing' || v.w9_status === 'outdated').length;
  const severity = urgentTasks > 0 ? 'red' : (pendingBills > 0 ? 'amber' : 'green');
  return {
    key: 'accounting', icon: '💵', title: 'Accounting', owner: 'Claudia',
    status: 'auto',
    content: { accounting: true, severity, urgentTasks, normalTasks, pendingBills, pendingAmount, w9Issues },
    last_updated: new Date().toISOString(),
  };
}

// Generating twice in one day returns the existing report rather than a second
// one. Sign-offs hang off a report id, so two reports for the same date would
// split the team across two documents with no sign that it had happened.
app.post('/api/reports/daily/generate', requireAuth, async (req, res) => {
  const client = supabaseAdmin || supabasePublic;
  const report_date = reportDateStr();
  const sections = await reportBuildSections(client);
  try {
    // Upsert by report_date. A unique index (daily_reports_date_key) allows one
    // report per day, so "Generate" must UPDATE the existing row with freshly
    // built sections rather than return it untouched — otherwise a report made
    // before a section (e.g. Accounting) was added never picks it up, which is
    // exactly the stuck-at-12:09 symptom.
    const { data: existing } = await client.from('daily_reports')
      .select('id').eq('report_date', report_date).maybeSingle();
    if (existing) {
      const { data: updated, error } = await client.from('daily_reports')
        .update({ sections }).eq('id', existing.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ...updated, created: false, updated: true });
    }

    const { data, error } = await client.from('daily_reports')
      .insert({ report_date, sections }).select().single();
    // 23505 means someone else inserted between our check and insert. Update
    // their row with our freshly-built sections so the result is still current.
    if (error && error.code === '23505') {
      const { data: raced } = await client.from('daily_reports').select('id').eq('report_date', report_date).single();
      const { data: updated } = await client.from('daily_reports')
        .update({ sections }).eq('id', raced.id).select().single();
      return res.json({ ...updated, created: false, updated: true });
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, created: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Re-reads a live section against its source. Only maintenance has one today, so
// an unknown key is refused rather than silently doing nothing — a Refresh that
// reports success without refreshing is worse than one that says it cannot.
// requireAuth without a role check: anyone who can read the report can refresh
// it, and this writes nothing but a section's own data.
app.patch('/api/reports/daily/:id/section', requireAuth, async (req, res) => {
  const key = String(req.body?.key || 'maintenance').trim();
  if (key !== 'maintenance') return res.status(400).json({ error: `Section "${key}" has no live source.` });
  const client = supabaseAdmin || supabasePublic;
  try {
    const { data: report, error: fe } = await client.from('daily_reports')
      .select('id, sections').eq('id', req.params.id).single();
    if (fe || !report) return res.status(404).json({ error: 'Report not found' });

    const fresh = await reportMaintenanceSection();
    // Rebuilt from the stored array rather than from REPORT_SECTIONS, so a
    // section added to the constant later cannot appear retroactively on a
    // report that was generated and signed before it existed.
    const sections = (report.sections || []).map(s => (s.key === key ? fresh : s));
    if (!sections.some(s => s.key === key)) sections.push(fresh);

    const { data, error } = await client.from('daily_reports')
      .update({ sections }).eq('id', report.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Today's report without creating one, so opening the tab is a read.
app.get('/api/reports/daily/today', requireAuth, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data } = await client.from('daily_reports').select('*').eq('report_date', reportDateStr()).maybeSingle();
    res.json({
      report: data || null,
      sections: REPORT_SECTIONS,
      signers: REPORT_SIGNERS,
      me: { name: req.user?.name || null, signer: reportSignerFor(req), isAdmin: isReportAdmin(req) },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The typed name is an attestation, not the identity — the row is written from
// the session either way. Requiring it to match stops Jay from signing Kara's
// row by typing her name, which is the whole point of asking someone to type it.
app.post('/api/reports/daily/signoff', requireAuth, async (req, res) => {
  const signer = reportSignerFor(req);
  if (!signer) return res.status(403).json({ error: 'You are not on the sign-off list for this report.' });

  const typed = reportNorm(req.body?.typed_name);
  if (!typed) return res.status(400).json({ error: 'Type your name to confirm.' });
  const me = reportNorm(req.user.name);
  if (typed !== me && typed !== me.split(/\s+/)[0] && typed !== reportNorm(signer)) {
    return res.status(400).json({ error: 'That is not your name — type your own to sign off.' });
  }

  const report_id = String(req.body?.report_id || '').trim();
  if (!report_id) return res.status(400).json({ error: 'report_id required' });

  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('report_signoffs')
      .insert({ report_id, user_name: signer }).select().single();
    // Already signed. There is no un-sign, so this is not an error worth
    // surfacing as one — report the existing record instead.
    if (error && error.code === '23505') {
      const { data: prev } = await client.from('report_signoffs')
        .select('*').eq('report_id', report_id).eq('user_name', signer).single();
      return res.json({ ...prev, alreadySigned: true });
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admins see the whole roster and who is missing. Everyone else sees their own
// row and nothing about their colleagues.
app.get('/api/reports/daily/signoffs/:report_id', requireAuth, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('report_signoffs')
      .select('*').eq('report_id', req.params.report_id).order('confirmed_at');
    if (error) return res.status(500).json({ error: error.message });

    const signoffs = data || [];
    if (isReportAdmin(req)) {
      const byName = new Map(signoffs.map(s => [reportNorm(s.user_name), s]));
      return res.json({
        admin: true,
        rows: REPORT_SIGNERS.map(name => {
          const hit = byName.get(reportNorm(name));
          return { name, signed: !!hit, confirmed_at: hit?.confirmed_at || null };
        }),
      });
    }
    const signer = reportSignerFor(req);
    const mine = signer ? signoffs.find(s => reportNorm(s.user_name) === reportNorm(signer)) : null;
    res.json({
      admin: false,
      rows: signer ? [{ name: signer, signed: !!mine, confirmed_at: mine?.confirmed_at || null }] : [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// One row per open. Deliberately not deduplicated — the repetition is the point.
app.post('/api/reports/daily/view', requireAuth, async (req, res) => {
  const report_id = String(req.body?.report_id || '').trim();
  if (!report_id) return res.status(400).json({ error: 'report_id required' });
  try {
    const client = supabaseAdmin || supabasePublic;
    const { error } = await client.from('report_views')
      .insert({ report_id, user_name: req.user?.name || req.user?.username || 'Unknown' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin-only, and it stays that way: this is a record of who read what and when,
// and the people in it cannot see it.
app.get('/api/reports/daily/views/:report_id', requireAuth, requireRole(...REPORT_ADMIN_ROLES), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('report_views')
      .select('user_name, viewed_at').eq('report_id', req.params.report_id).order('viewed_at');
    if (error) return res.status(500).json({ error: error.message });

    const agg = new Map();
    for (const v of (data || [])) {
      const cur = agg.get(v.user_name);
      if (!cur) agg.set(v.user_name, { name: v.user_name, first: v.viewed_at, last: v.viewed_at, count: 1 });
      else { cur.last = v.viewed_at; cur.count++; }
    }
    res.json({ rows: [...agg.values()].sort((a, b) => b.count - a.count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── End Daily Operations Report ─────────────────────────────────────────────

// =====================================================================
// MODULE — COMMAND CENTER DAILY STATE
// =====================================================================
// Registered here rather than in metric-routes.js, which owns the rest of
// /api/maintenance/*, because requireAuth lives in this file and is the guard
// this needs. requireMetricAccess over there also accepts the shared key, which
// is right for Erick's MCP tools but wider than a browser-only feature wants.
//
// Keyed by date, not by user: Erick is the only person who works this board, and
// two browsers open on the same day should converge rather than fork.

const CC_STATE_RETENTION_DAYS = 7;

app.get('/api/maintenance/command-center/state', requireAuth, async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('cc_daily_state')
      .select('*').eq('state_date', reportDateStr()).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    // null, not 404: "no state yet today" is the normal first call each morning,
    // and the client should not have to tell that apart from a failure.
    res.json({ state: data || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/maintenance/command-center/state', requireAuth, async (req, res) => {
  const body = req.body || {};
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const checks = (body.checks && typeof body.checks === 'object' && !Array.isArray(body.checks)) ? body.checks : {};
  const state_date = reportDateStr();
  try {
    const client = supabaseAdmin || supabasePublic;
    // Counts are recomputed here rather than trusted from the client, so the
    // stored row cannot disagree with the payload it was built from.
    const completed = tasks.filter(t => t && checks[t.id]).length;
    const row = {
      state_date, tasks, checks,
      total_tasks: tasks.length,
      completed_tasks: completed,
      generated_at: body.generated_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client.from('cc_daily_state')
      .upsert(row, { onConflict: 'state_date' }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Pruned on write instead of on a schedule — this table is touched often
    // enough that a cron would be a second thing to maintain for no gain.
    // Failing to prune must not fail the save.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CC_STATE_RETENTION_DAYS);
    client.from('cc_daily_state').delete().lt('state_date', localDateStr(cutoff))
      .then(({ error: de }) => { if (de) console.error('[cc-state] prune failed:', de.message); });

    res.json({ ok: true, state: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── End Command Center daily state ──────────────────────────────────────────

// =====================================================================
// MODULE — DAILY 6 PM REPORT
// =====================================================================
// Lyndsay's end-of-day roll-up, spec confirmed 2026-08-17: the day's meetings in
// three categories, action items from their transcripts, and her inbox at the
// moment it runs. WhatsApp delivery is a later step.
//
// Two of those inputs are not reachable from this server yet, and the report is
// built so a reader can tell "nothing happened" from "we could not look":
//
//   Transcripts need OnlineMeetingTranscript.Read.All as an APPLICATION
//   permission with admin consent, plus a Teams application access policy
//   (New-CsApplicationAccessPolicy) scoping this app to Lyndsay's meetings.
//   GRAPH_SCOPES holds only Mail and Calendars today.
//
//   Action-item extraction needs an Anthropic key the server can call out with.
//   COPILOT_API_KEY is an inbound key guarding a route for external callers, not
//   that. Nothing here calls a model.
//
// The meeting list and the inbox snapshot are real and work now. Both gaps drop
// into the stored shape without a schema change or a rewrite here.
//
// Note also that meeting-transcript:///events/{token} named in the brief is an
// MCP resource. MCP servers are attached to a Claude client, not to this
// process, so a cron running inside Express cannot reach it — the transcript
// route has to be Graph.

const SIXPM_CATEGORIES = ['KPI Meetings', 'Client calls', 'Operations'];
const sixPmNorm = s => String(s || '').trim().toLowerCase();

async function sixPmMeetings() {
  const out = { meetings: [], matched: 0, otherToday: 0, error: null };
  try {
    const token = await graphAccessToken();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    // categories is what the three buckets are read from — Outlook categories,
    // which only exist if someone tags the meeting. The existing calendar read
    // does not request the field, so this query is its own.
    const url = `https://graph.microsoft.com/v1.0/users/${MAILBOX_LYNDSAY}/calendarView`
      + `?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}`
      + '&$select=subject,start,end,attendees,organizer,onlineMeeting,categories,bodyPreview,isAllDay'
      + '&$orderby=start/dateTime&$top=100';
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="America/Chicago"' } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Graph returned ${res.status}`);

    const wanted = SIXPM_CATEGORIES.map(sixPmNorm);
    for (const e of (json.value || [])) {
      if (e.isAllDay) continue;
      const cats = Array.isArray(e.categories) ? e.categories : [];
      const hit = cats.find(c => wanted.includes(sixPmNorm(c)));
      if (!hit) { out.otherToday++; continue; }
      out.matched++;
      out.meetings.push({
        subject: e.subject || '(no subject)',
        category: SIXPM_CATEGORIES.find(c => sixPmNorm(c) === sixPmNorm(hit)) || hit,
        start: e.start?.dateTime || null,
        end: e.end?.dateTime || null,
        organizer: e.organizer?.emailAddress?.name || null,
        attendees: (e.attendees || []).map(a => a.emailAddress?.name).filter(Boolean).slice(0, 12),
        joinUrl: e.onlineMeeting?.joinUrl || null,
        preview: (e.bodyPreview || '').slice(0, 300),
        // Filled in once transcripts are reachable; null means not looked at,
        // which is not the same as a meeting with nothing said in it.
        transcript: null,
      });
    }
  } catch (err) {
    out.error = err.message;
    console.error('[6pm] calendar read failed:', err.message);
  }
  return out;
}

async function sixPmBuild() {
  const cal = await sixPmMeetings();
  const inbox = refreshState.inboxCounts || null;
  return {
    report_date: reportDateStr(),
    meetings: cal.meetings,
    action_items: [],
    inbox_snapshot: inbox ? { lyndsay: inbox.lyndsay ?? null, lastChecked: inbox.lastChecked ?? null } : {},
    sources: {
      meetings: cal.error ? 'error' : 'ok',
      meetings_error: cal.error || null,
      meetings_matched: cal.matched,
      meetings_other_today: cal.otherToday,
      categories: SIXPM_CATEGORIES,
      // Stated rather than left to be inferred from an empty array.
      transcripts: 'unavailable',
      transcripts_reason: 'Needs OnlineMeetingTranscript.Read.All (application) with admin consent and a Teams application access policy for Lyndsay.',
      action_items: 'unavailable',
      action_items_reason: 'Needs an Anthropic API key the server can call out with. COPILOT_API_KEY is an inbound guard, not that.',
      inbox: inbox ? 'ok' : 'unavailable',
    },
    generated_at: new Date().toISOString(),
  };
}

async function sixPmGenerate() {
  const client = supabaseAdmin || supabasePublic;
  const row = await sixPmBuild();
  const { data, error } = await client.from('daily_6pm_reports')
    .upsert(row, { onConflict: 'report_date' }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

app.post('/api/reports/daily-6pm/generate', requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  try { res.json({ ok: true, report: await sixPmGenerate() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/daily-6pm/latest', requireAuth, requireRole('admin', 'operations'), async (req, res) => {
  try {
    const client = supabaseAdmin || supabasePublic;
    const { data, error } = await client.from('daily_6pm_reports')
      .select('*').order('generated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ report: data || null, categories: SIXPM_CATEGORIES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6 PM Central, stated explicitly: Render runs UTC, so an unqualified "18 * * *"
// would fire at noon or 1 PM in Austin depending on the season.
cron.schedule('0 18 * * *', () => {
  sixPmGenerate()
    .then(r => logLine(`[6pm] report generated for ${r.report_date}`))
    .catch(err => console.error('[6pm] scheduled run failed:', err.message));
}, { timezone: 'America/Chicago' });

// ── End Daily 6 PM Report ───────────────────────────────────────────────────

// ── Maintenance routes (Erick's board, property assignments, Lyndsay snapshots,
//    AppFolio analyzer) — registered on the same app instance using Supabase db ──
registerMetricRoutes(app, supabaseAdmin || supabasePublic);

// ---- Boot -------------------------------------------------------------------
app.listen(PORT, () => {
  logLine(`AI Admin Dashboard listening on http://localhost:${PORT}`);
  console.log(`AI Admin Dashboard running at http://localhost:${PORT}`);
});

// Keep-alive self-ping every 10 minutes. Only in production against the public
// URL — skipped when APP_BASE_URL is localhost (dev). Caveats, stated plainly:
// this cannot stop a deploy from restarting the process (which is what drops
// the MCP session), and on Render's Starter plan the instance does not
// hibernate, so there is nothing here to keep awake. An *external* pinger
// hitting /health is the reliable anti-hibernation path; this internal ping is
// added per request and is harmless.
if (/^https:\/\//.test(APP_BASE_URL) && !/localhost|127\.0\.0\.1/.test(APP_BASE_URL)) {
  setInterval(() => {
    fetchFn(`${APP_BASE_URL}/health`).catch(err => logLine(`[keep-alive] ping failed: ${err.message}`));
  }, 10 * 60 * 1000);
  logLine(`[keep-alive] self-ping ${APP_BASE_URL}/health every 10 min`);
}
