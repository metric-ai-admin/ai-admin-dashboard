/**
 * metric-routes.js
 * Registers Erick's maintenance dashboard routes on the ai-admin-dashboard Express app.
 * Called once from server.js: registerMetricRoutes(app, db)
 *
 * Routes mounted:
 *   /api/operational/*          – Erick's maintenance task board (Supabase: operational_tasks)
 *   /api/assignments/*          – Property maintenance assignments (Supabase: property_assignments)
 *   /api/lyndsay/*              – Lyndsay's Command Center task snapshots (Supabase: lyndsay_snapshots)
 *   /api/appfolio/*             – AppFolio WO analyzer + v2 Reports API sync
 *   /api/report                 – Erick's daily work report
 *   /api/maintenance/summary    – Erick's EOD summary (prefixed to avoid collision with /api/summary)
 *   /api/maintenance/sops/*     – Maintenance SOPs (prefixed to avoid collision with /api/sops)
 *
 * NOT registered here (already exist in server.js or intentionally excluded):
 *   /api/asana/*    – ai-admin-dashboard's Asana routes cover the same token/workspace
 *   public/         – Erick uses MCP (Claude Desktop), not the web UI
 */

'use strict';

const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const multer = require('multer');
const jwt    = require('jsonwebtoken');
const cron   = require('node-cron');
const simplevoip = require('./simplevoip');

// ── Shared helpers ────────────────────────────────────────────────────────────

const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── File directories ─────────────────────────────────────────────────────────
// Must honour DATA_DIR the same way server.js does (server.js:161). render.yaml
// mounts a persistent disk at /var/data and sets DATA_DIR to it; writing to
// ./data instead puts these files on Render's ephemeral filesystem, where every
// deploy or restart wipes them — including the maintenance SOPs, which are
// uploaded once and expected to stay.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'appfolio_reports');
const SOPS_DIR    = path.join(DATA_DIR, 'maintenance_sops_files');

// ── AppFolio v2 client ────────────────────────────────────────────────────────
// Only required if the AppFolio Reports module is present.
let afReports = null;
try { afReports = require('./appfolio-reports'); } catch { /* not available */ }

// ── Shared-secret guard for the AppFolio module ──────────────────────────────
// These routes expose billable dollar amounts, per-technician labour hours and
// per-property work orders. server.js has no global auth gate (requireAuth is
// opt-in per route) and CORS is `Access-Control-Allow-Origin: *`, so without
// this the whole module would be world-readable.
//
// Two callers must both keep working:
//   • the dashboard UI  — authenticated by the dashboardToken JWT cookie
//   • Erick's MCP tools — no cookie, so they send the x-metric-key header
//
// Fails OPEN (with the startup warning below) when METRIC_API_KEY is unset.
// This mirrors how server.js treats a missing JWT_SECRET, and avoids a deploy
// that lands before the variable is configured taking down both the dashboard
// and every MCP tool at once.

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Returns the decoded payload, or null. hasValidSession discarded it, but the
// Call Analyzer needs the role: who may read whose calls is decided here, not
// by whether a dropdown was rendered.
function sessionPayload(req) {
  const token  = req.cookies?.dashboardToken;
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try { return jwt.verify(token, secret); } catch { return null; }
}

function hasValidSession(req) {
  return !!sessionPayload(req);
}

function requireMetricAccess(req, res, next) {
  const key = process.env.METRIC_API_KEY;
  if (!key) return next();                       // not configured — warned at startup
  const provided = req.get('x-metric-key');
  if (provided && timingSafeEq(provided, key)) return next();
  if (hasValidSession(req)) return next();
  return res.status(401).json({ error: 'Unauthorized — missing or invalid x-metric-key' });
}

// Write guard for routes the MCP tools also mutate (SOPs, platform projects).
// requireRole('admin') alone would 403 every MCP call — those come over HTTP
// with no cookie, so req.user is undefined. So a valid x-metric-key stands in
// for admin: it is the shared server-to-server secret the MCP already sends,
// and holding it is itself a trust boundary. A browser caller, which has no
// key, must instead be a logged-in admin. Anyone who is neither gets 403.
//
// Unlike requireMetricAccess this does NOT fail open when the key is unset: a
// write should never be admin-gated by an absent secret. With no key set, only
// an admin session passes (and MCP writes would need the key configured, which
// production has).
function requireMetricAdmin(req, res, next) {
  const key = process.env.METRIC_API_KEY;
  const provided = req.get('x-metric-key');
  if (key && provided && timingSafeEq(provided, key)) return next();
  const payload = sessionPayload(req);
  if (payload && payload.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// ── CSV parser (minimal, handles quotes/commas) ───────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* ignore */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// ── multer instances ──────────────────────────────────────────────────────────
const csvMemUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── AppFolio WO analyzer helpers (extracted from metric-dashboard/server.js) ──

function buildHeaderMap(headers) {
  const norm = h => h.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    if (/(workorder|^wo|wonumber|wonum|ticket)/.test(n) && map.wo === undefined) map.wo = i;
    if (/(property|building|community)/.test(n) && map.property === undefined) map.property = i;
    if (/(unit|aptapt|apartment)/.test(n) && map.unit === undefined) map.unit = i;
    if (/(status|stage)/.test(n) && map.status === undefined) map.status = i;
    if (/(assign|tech|vendor|technician)/.test(n) && map.assignee === undefined) map.assignee = i;
    if (/(description|issue|details|summary|problem)/.test(n) && map.description === undefined) map.description = i;
    if (/(created|opened|requestdate|datereceived|submitted)/.test(n) && map.created === undefined) map.created = i;
    if (/(updated|modified|lastactivity)/.test(n) && map.updated === undefined) map.updated = i;
    if (/(photo|image|attachment)/.test(n) && map.photos === undefined) map.photos = i;
  });
  return map;
}

function looksSpanish(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  if (/[ñáéíóú¿¡]/.test(t)) return true;
  const words = ['el ','la ','los ','las ','no ','con ','por ','para ','una ','que ','agua','fuga','baño','cocina','puerta','luz','reparar','inquilino','esta','tiene','hay '];
  return words.filter(w => t.includes(w)).length >= 2;
}

function daysBetween(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((now - d) / 86400000);
}

function analyzeWorkOrders(rows) {
  if (rows.length < 2) return { actions: [], count: 0, headers: [] };
  const headers = rows[0].map(h => h.trim());
  const map = buildHeaderMap(headers);
  const now = new Date();
  const dataRows = rows.slice(1);
  const records = dataRows.map((r, i) => {
    const get = key => (map[key] !== undefined ? (r[map[key]] || '').trim() : '');
    const fields = {};
    headers.forEach((h, j) => { if (h) fields[h] = (r[j] || '').trim(); });
    const description = get('description');
    const status = get('status');
    const created = get('created');
    const updated = get('updated');
    const ageDays = created ? daysBetween(created, now) : null;
    const updatedDays = updated ? daysBetween(updated, now) : ageDays;
    return { idx: i, wo: get('wo') || `(row ${i+2})`, property: get('property') || '—', unit: get('unit') || '',
      status, statusLower: status.toLowerCase(), assignee: get('assignee'), description,
      isSpanish: looksSpanish(description), hasPhotos: !!/[^ ]/.test(get('photos')) && !/^(no|none|0|false)$/i.test(get('photos')),
      created, updated, ageDays, updatedDays, fields };
  });
  const openByUnit = {};
  for (const rec of records) {
    if (/(complete|closed|done|cancel)/.test(rec.statusLower) && !/work done/.test(rec.statusLower)) continue;
    if (rec.unit) (openByUnit[`${rec.property}||${rec.unit}`.toLowerCase()] = openByUnit[`${rec.property}||${rec.unit}`.toLowerCase()] || []).push(rec.wo);
  }
  const order = { urgent: 0, followup: 1, ready: 2, none: 3 };
  const actions = records.map(rec => {
    const acts = [];
    const isWorkDone = /work\s*done|completed work/.test(rec.statusLower);
    const isNew = /new|open|received|submitted/.test(rec.statusLower);
    const isClosed = /closed|complete|cancel/.test(rec.statusLower);
    if (rec.isSpanish) acts.push({ action: 'Translate to English', tier: 'followup', recommendation: 'Description is in Spanish. Translate it before assigning.' });
    if (isNew && !rec.assignee) acts.push({ action: 'Assign technician', tier: 'urgent', recommendation: 'New work order with no technician. Assign one as soon as possible.' });
    if (isWorkDone && !rec.hasPhotos) acts.push({ action: 'Request photos', tier: 'followup', recommendation: 'Marked Work Done with no photos. Request photos from the technician.' });
    if (rec.ageDays !== null && rec.ageDays > 30 && !isClosed) acts.push({ action: 'Escalate', tier: 'urgent', recommendation: `Open for ${rec.ageDays} days. Escalate immediately.` });
    else if (rec.updatedDays !== null && rec.updatedDays > 7 && !isClosed && !isWorkDone) acts.push({ action: 'Follow up with tech', tier: 'followup', recommendation: `No update in ${rec.updatedDays} days.` });
    if (isWorkDone && !rec.isSpanish && rec.hasPhotos) acts.push({ action: 'QC Ready', tier: 'ready', recommendation: 'Ready for QC / billing.' });
    const key = `${rec.property}||${rec.unit}`.toLowerCase();
    if (rec.unit && openByUnit[key] && openByUnit[key].length > 1) acts.push({ action: 'Possible duplicate', tier: 'followup', recommendation: `${openByUnit[key].length} open work orders on the same unit.` });
    if (!acts.length) acts.push({ action: 'No action needed', tier: 'none', recommendation: 'No action needed right now.' });
    const topTier = acts.reduce((best, a) => order[a.tier] < order[best] ? a.tier : best, 'none');
    return { wo: rec.wo, property: rec.property, unit: rec.unit, status: rec.status || '—',
      assignee: rec.assignee || null, ageDays: rec.ageDays, isSpanish: rec.isSpanish, hasPhotos: rec.hasPhotos,
      description: rec.description, descriptionPreview: rec.description.slice(0, 120), fields: rec.fields,
      actions: acts, topTier };
  });
  return { actions, count: actions.length, headers };
}

// ── Property assignment field mapping ─────────────────────────────────────────

const normHeader = h => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function mapAssignmentCols(headers) {
  const nh = headers.map(normHeader);
  const find = (...cands) => { for (const c of cands) { const i = nh.indexOf(c); if (i !== -1) return i; } return -1; };
  return {
    property:         find('property', 'propertyname', 'name'),
    units:            find('units', 'unitcount', 'numunits'),
    hasPool:          find('haspool', 'pool'),
    groundsTech:      find('groundstech', 'groundstechnician'),
    groundsFrequency: find('groundsfrequency', 'frequency'),
    maintenanceTech:  find('maintenancetech', 'technician', 'tech'),
    pestControl:      find('pestcontrol', 'pest'),
    landscaping:      find('landscaping', 'landscape'),
  };
}

function rowToAssignment(r, col) {
  const get = (k, fb = '') => col[k] >= 0 ? (r[col[k]] || '').trim() : fb;
  return {
    property: get('property'), units: parseInt(get('units')) || null,
    hasPool: /^(yes|true|1|y)$/i.test(get('hasPool').trim()),
    groundsTech: get('groundsTech'), groundsFrequency: get('groundsFrequency'),
    maintenanceTech: get('maintenanceTech'), pestControl: get('pestControl'), landscaping: get('landscaping'),
  };
}

function assignmentToSnake(row) {
  return {
    property: row.property, units: row.units ?? null,
    has_pool: row.hasPool ?? row.has_pool ?? false,
    grounds_tech: row.groundsTech ?? row.grounds_tech ?? null,
    grounds_frequency: row.groundsFrequency ?? row.grounds_frequency ?? null,
    maintenance_tech: row.maintenanceTech ?? row.maintenance_tech ?? null,
    pest_control: row.pestControl ?? row.pest_control ?? null,
    landscaping: row.landscaping ?? null,
  };
}

function assignmentToCamel(row) {
  if (!row) return row;
  return {
    property: row.property, units: row.units, hasPool: row.has_pool,
    groundsTech: row.grounds_tech, groundsFrequency: row.grounds_frequency,
    maintenanceTech: row.maintenance_tech, pestControl: row.pest_control,
    landscaping: row.landscaping,
  };
}

// ── Lyndsay snapshot helper ───────────────────────────────────────────────────

async function lyndsayLatest(db) {
  const { data, error } = await db
    .from('lyndsay_snapshots').select('*')
    .order('created_at', { ascending: false }).limit(1).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || { id: null, imported_at: null, report_date: null, tasks: [], checks: {} };
}

const ROUTINE_IDS = ['whereby','dashboard','texts','emergencies','assign-all','waiting','qc','inspections','residents','whatsapp','parts'];

// ── Operational tasks helpers ─────────────────────────────────────────────────

const OPS_TYPES = ['WO Follow-up','Translation','Resident Contact','Tech Contact','Escalation','Billing QC','Daily Recurring','Other'];
const OPS_PRIORITIES = ['🔴 Critical','🟡 Follow-up','🟢 In Progress','🔁 Daily Task','✅ Done'];
const DAILY_STATUS = '🔁 Daily Task';

function opsShape(row) {
  if (!row) return row;
  return { ...row, noteHistory: row.note_history || [] };
}

async function opsGetAll(db) {
  const { data, error } = await db.from('operational_tasks').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function resetDailyTasks(db, tasks) {
  const today = todayStr();
  const stale = tasks.filter(t => t.priority === DAILY_STATUS && t.completed_at && t.completed_at.slice(0, 10) < today);
  if (!stale.length) return;
  await Promise.all(stale.map(t => db.from('operational_tasks').update({ completed_at: null }).eq('id', t.id)));
  stale.forEach(t => { t.completed_at = null; });
}

// ── Maintenance SOPs: file-based (stored in data/maintenance_sops_files/) ─────

const MAINT_SOPS_INDEX = path.join(SOPS_DIR, '_index.json');

async function mSopsReadIndex() {
  try { return JSON.parse(await fsp.readFile(MAINT_SOPS_INDEX, 'utf8')); } catch { return []; }
}

async function mSopsWriteIndex(data) {
  const tmp = MAINT_SOPS_INDEX + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, MAINT_SOPS_INDEX);
}

// ── AppFolio upload multer ────────────────────────────────────────────────────

const afUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, REPORTS_DIR),
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const m = file.originalname.match(/\.(pdf|csv|png|jpe?g)$/i);
      cb(null, `appfolio_${stamp}${m ? '.' + m[1].toLowerCase() : '.csv'}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|pdf|png|jpe?g)$/i.test(file.originalname);
    cb(ok ? null : new Error('Allowed: CSV, PDF, PNG, JPG'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── EOD + Daily report builders ───────────────────────────────────────────────

async function latestAppfolioAnalysis() {
  try {
    const files = (await fsp.readdir(REPORTS_DIR)).filter(f => f.endsWith('_analysis.json'));
    if (!files.length) return null;
    files.sort();
    const raw = await fsp.readFile(path.join(REPORTS_DIR, files[files.length - 1]), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function buildMaintenanceSummary(db) {
  const today = todayStr();
  const ops = await opsGetAll(db);
  const opsCompletedToday = ops.filter(t => t.completed_at && t.completed_at.slice(0, 10) === today);
  const opsOpen = ops.filter(t => t.priority !== '✅ Done');
  const appfolio = await latestAppfolioAnalysis();
  const appfolioToday = appfolio && appfolio.analyzedAt && appfolio.analyzedAt.slice(0, 10) === today ? appfolio : null;
  const candidates = [];
  for (const t of opsOpen) {
    if (t.priority === '🔴 Critical') candidates.push({ source: 'Operational', label: t.title, reason: 'Critical priority', weight: 90 });
  }
  if (appfolioToday) {
    for (const a of (appfolioToday.groups.urgent || [])) candidates.push({ source: 'AppFolio', label: `WO ${a.wo} — ${a.property}`, reason: a.actions.map(x => x.action).join(', '), weight: 80 });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return {
    generatedAt: new Date().toISOString(), date: today,
    operational: {
      completedToday: opsCompletedToday.map(t => ({ title: t.title, type: t.type })),
      open: opsOpen.map(t => ({ title: t.title, type: t.type, priority: t.priority })),
    },
    appfolio: appfolioToday ? { analyzedAt: appfolioToday.analyzedAt, totalWorkOrders: appfolioToday.totalWorkOrders, urgent: appfolioToday.groups.urgent.length, followup: appfolioToday.groups.followup.length, ready: appfolioToday.groups.ready.length } : null,
    topPriorities: candidates.slice(0, 3),
  };
}

async function buildDailyWorkReport(db) {
  const today = todayStr();
  const ops = await opsGetAll(db);
  const opsDone = ops.filter(t => t.completed_at && t.completed_at.slice(0, 10) === today && t.priority !== DAILY_STATUS)
    .map(t => ({ title: t.title, type: t.type, noteHistory: t.note_history || [] }));
  const dailyDone = ops.filter(t => t.priority === DAILY_STATUS && t.completed_at && t.completed_at.slice(0, 10) === today)
    .map(t => ({ title: t.title }));
  const dailyPending = ops.filter(t => t.priority === DAILY_STATUS && (!t.completed_at || t.completed_at.slice(0, 10) !== today))
    .map(t => ({ title: t.title }));
  const notesToday = ops.flatMap(t =>
    (t.note_history || []).filter(n => n.createdAt && n.createdAt.slice(0, 10) === today)
      .map(n => ({ taskTitle: t.title, text: n.text, createdAt: n.createdAt }))
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const appfolio = await latestAppfolioAnalysis();
  const appfolioToday = appfolio && appfolio.analyzedAt && appfolio.analyzedAt.slice(0, 10) === today ? appfolio : null;
  return {
    generatedAt: new Date().toISOString(), date: today, person: 'Erick Frey',
    operationalDone: opsDone, dailyTasksDone: dailyDone, dailyTasksPending: dailyPending,
    notesToday,
    appfolio: appfolioToday ? { totalWorkOrders: appfolioToday.totalWorkOrders, urgent: appfolioToday.groups.urgent.length, followup: appfolioToday.groups.followup.length, ready: appfolioToday.groups.ready.length } : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// registerMetricRoutes — called once from server.js
// ═════════════════════════════════════════════════════════════════════════════

function registerMetricRoutes(app, db) {
  // Ensure required directories exist (ephemeral on Render, recreated on boot)
  for (const dir of [REPORTS_DIR, SOPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(MAINT_SOPS_INDEX)) fs.writeFileSync(MAINT_SOPS_INDEX, '[]');

  // requireMetricAccess fails open when the key is unset, and it now also
  // guards the routes that serve Lyndsay's mailbox — so an unset key exposes
  // her mail, not just billable amounts. Warn loudly either way.
  if (!process.env.METRIC_API_KEY) {
    console.warn('[WARN] METRIC_API_KEY not set — /api/appfolio/* AND the /api/email/* '
               + 'routes that read the Lyndsay mailbox are publicly readable. '
               + 'Set it in the Render dashboard and in the MCP config for Erick.');
  }

  // ── MODULE: Operational Tasks (Erick's maintenance board) ─────────────────
  // Every route here took no guard at all: /api/operational answered 200 to any
  // request, with no cookie and no key, so the board could be read, rewritten or
  // emptied by anyone who knew the URL.
  //
  // requireMetricAccess rather than a session-only check, and for the same reason
  // the technician routes below use it: Erick's MCP tools reach these endpoints
  // over loopback with no cookie, sending x-metric-key instead. A session-only
  // guard would lock out every maintenance tool he has. This takes either and
  // refuses everything else.
  //
  // No requireRole: Erick writes to this board as his job.

  app.get('/api/operational', requireMetricAccess, async (req, res) => {
    try {
      const tasks = await opsGetAll(db);
      await resetDailyTasks(db, tasks);
      res.json(tasks.map(opsShape));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/operational', requireMetricAccess, async (req, res) => {
    const { title, type, person, action, priority, notes } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
    const now = new Date().toISOString();
    const row = {
      id: `op_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
      title: title.trim(),
      type: OPS_TYPES.includes(type) ? type : 'Other',
      person: person || '', action: action || '',
      priority: OPS_PRIORITIES.includes(priority) ? priority : '🟢 In Progress',
      notes: notes || '',
      note_history: notes?.trim() ? [{ text: notes.trim(), createdAt: now }] : [],
      created_at: now, completed_at: null,
    };
    try {
      const { data, error } = await db.from('operational_tasks').insert(row).select().single();
      if (error) throw error;
      res.json(opsShape(data));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/operational/:id', requireMetricAccess, async (req, res) => {
    try {
      const { data: existing, error: fe } = await db.from('operational_tasks').select('*').eq('id', req.params.id).single();
      if (fe || !existing) return res.status(404).json({ error: 'Task not found' });
      const updates = {};
      for (const k of ['title','type','person','action','priority']) if (k in req.body) updates[k] = req.body[k];
      if (req.body.notes?.trim()) {
        const history = existing.note_history || [];
        history.push({ text: req.body.notes.trim(), createdAt: new Date().toISOString() });
        updates.note_history = history; updates.notes = req.body.notes.trim();
      }
      if (req.body.priority === '✅ Done' && !existing.completed_at) updates.completed_at = new Date().toISOString();
      else if (req.body.priority && req.body.priority !== '✅ Done') updates.completed_at = null;
      const { data, error } = await db.from('operational_tasks').update(updates).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json(opsShape(data));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/operational/:id/done', requireMetricAccess, async (req, res) => {
    try {
      const { data: existing, error: fe } = await db.from('operational_tasks').select('priority,completed_at').eq('id', req.params.id).single();
      if (fe || !existing) return res.status(404).json({ error: 'Task not found' });
      const updates = { completed_at: new Date().toISOString() };
      if (existing.priority !== DAILY_STATUS) updates.priority = '✅ Done';
      const { data, error } = await db.from('operational_tasks').update(updates).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json(opsShape(data));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/operational/:id/notes', requireMetricAccess, async (req, res) => {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Note text required' });
    try {
      const { data: existing, error: fe } = await db.from('operational_tasks').select('note_history').eq('id', req.params.id).single();
      if (fe || !existing) return res.status(404).json({ error: 'Task not found' });
      const history = [...(existing.note_history || []), { text, createdAt: new Date().toISOString() }];
      const { data, error } = await db.from('operational_tasks').update({ note_history: history, notes: text }).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json(opsShape(data));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/operational/:id', requireMetricAccess, async (req, res) => {
    try {
      const { data: existing } = await db.from('operational_tasks').select('id').eq('id', req.params.id).single();
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const { error } = await db.from('operational_tasks').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: Property Assignments ──────────────────────────────────────────

  app.get('/api/assignments', async (req, res) => {
    try {
      const { data, error } = await db.from('property_assignments').select('*').order('property');
      if (error) throw error;
      res.json((data || []).map(assignmentToCamel));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/assignments', async (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array' });
    try {
      const { error } = await db.from('property_assignments').upsert(req.body.map(assignmentToSnake), { onConflict: 'property' });
      if (error) throw error;
      res.json({ ok: true, count: req.body.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/assignments/upload', csvMemUpload.single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = parseCSV(req.file.buffer.toString('utf8'));
    if (rows.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });
    const col = mapAssignmentCols(rows[0]);
    if (col.property === -1) return res.status(400).json({ error: 'Could not find a "Property" column' });
    const data = rows.slice(1).filter(r => r.some(c => c.trim())).map(r => rowToAssignment(r, col)).filter(r => r.property);
    try {
      const { error } = await db.from('property_assignments').upsert(data.map(assignmentToSnake), { onConflict: 'property' });
      if (error) throw error;
      res.json({ ok: true, count: data.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/assignments/:property', async (req, res) => {
    try {
      const { data: existing } = await db.from('property_assignments').select('property').eq('property', req.params.property).single();
      if (!existing) return res.status(404).json({ error: 'Property not found' });
      const fieldMap = { property:'property', units:'units', hasPool:'has_pool', groundsTech:'grounds_tech', groundsFrequency:'grounds_frequency', maintenanceTech:'maintenance_tech', pestControl:'pest_control', landscaping:'landscaping' };
      const updates = {};
      for (const [camel, snake] of Object.entries(fieldMap)) if (camel in req.body) updates[snake] = req.body[camel];
      const { data, error } = await db.from('property_assignments').update(updates).eq('property', req.params.property).select().single();
      if (error) throw error;
      res.json(assignmentToCamel(data));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/assignments/:property', async (req, res) => {
    try {
      const { data: existing } = await db.from('property_assignments').select('property').eq('property', req.params.property).single();
      if (!existing) return res.status(404).json({ error: 'Property not found' });
      const { error } = await db.from('property_assignments').delete().eq('property', req.params.property);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: Technicians ───────────────────────────────────────────────────
  // Single source of truth replacing five hardcoded lists (see
  // supabase/migrations/002_technicians.sql). Guarded like the AppFolio module:
  // these rows carry employee home ZIPs and skill ratings.

  const TECH_FIELDS = [
    'full_name', 'active', 'position', 'appfolio_aliases', 'expect_daily_hours',
    'show_on_map', 'home_zip', 'home_lat', 'home_lng',
    'shows_in_make_ready', 'make_ready_note', 'properties_label',
    'cap_ac', 'cap_electrical', 'cap_plumbing', 'cap_pool',
    'cap_welding', 'cap_painting', 'cap_resurfacing', 'cap_cleaning',
    'notes', 'sort_order',
  ];

  const slugify = s => String(s).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')          // strip combining accents (Jose)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // home_lat/home_lng are DOUBLE PRECISION and sort_order is INTEGER. A cleared
  // form field arrives as '', which Postgres rejects outright, so blank means
  // NULL here. A non-numeric value is reported rather than silently nulled —
  // quietly dropping a mistyped coordinate would move a map pin with no warning.
  const TECH_NUMERIC = new Set(['home_lat', 'home_lng', 'sort_order']);
  const TECH_RANGE = { home_lat: [-90, 90], home_lng: [-180, 180] };

  function techPayload(body) {
    const values = {};
    const errors = [];
    for (const f of TECH_FIELDS) {
      if (!(f in body)) continue;
      const raw = body[f];

      if (f === 'appfolio_aliases') {
        values[f] = Array.isArray(raw)
          ? raw.map(s => String(s).trim()).filter(Boolean)
          : String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
        continue;
      }

      if (TECH_NUMERIC.has(f)) {
        if (raw === '' || raw === null || raw === undefined) { values[f] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) { errors.push(`${f} must be a number (got "${raw}")`); continue; }
        const range = TECH_RANGE[f];
        if (range && (n < range[0] || n > range[1])) {
          errors.push(`${f} must be between ${range[0]} and ${range[1]} (got ${n})`);
          continue;
        }
        values[f] = n;
        continue;
      }

      values[f] = raw;
    }
    return { values, errors };
  }

  // The zero-hours roster, formerly ACTIVE_TECHNICIANS in appfolio-reports.js.
  // Returns null when the table isn't there yet, so techActivityToday falls back
  // to its own built-in list rather than reporting an empty roster.
  async function techRoster() {
    try {
      const { data, error } = await db.from('technicians')
        .select('full_name, appfolio_aliases')
        .eq('active', true).eq('expect_daily_hours', true);
      if (error || !data) return null;
      return data.map(t => ({ name: t.full_name, aliases: t.appfolio_aliases || [] }));
    } catch { return null; }
  }

  app.get('/api/technicians', requireMetricAccess, async (req, res) => {
    try {
      let q = db.from('technicians').select('*').order('sort_order').order('full_name');
      if (req.query.active !== 'all') q = q.eq('active', true);
      if (req.query.map === '1')      q = q.eq('show_on_map', true);
      const { data, error } = await q;
      if (error) throw error;
      res.json(data || []);
    } catch (err) {
      res.status(500).json({ error: err.message, hint: 'Has supabase/migrations/002_technicians.sql been run?' });
    }
  });

  app.post('/api/technicians', requireMetricAccess, async (req, res) => {
    const name = (req.body.full_name || '').trim();
    if (!name) return res.status(400).json({ error: 'full_name required' });
    const { values, errors } = techPayload(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const row = { ...values, id: (req.body.id || slugify(name)), full_name: name };
    try {
      const { data, error } = await db.from('technicians').insert(row).select().single();
      if (error) throw error;
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/technicians/:id', requireMetricAccess, async (req, res) => {
    const { values: updates, errors } = techPayload(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields supplied' });
    try {
      const { data, error } = await db.from('technicians')
        .update(updates).eq('id', req.params.id).select().single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Technician not found' });
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/technicians/:id', requireMetricAccess, async (req, res) => {
    try {
      const { error } = await db.from('technicians').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: Lyndsay Command Center snapshots ──────────────────────────────

  app.post('/api/lyndsay/import', async (req, res) => {
    const { tasks, checks, date, exportedAt } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks[] array required' });
    try {
      const row = { imported_at: new Date().toISOString(), exported_at: exportedAt || null, report_date: date || todayStr(), tasks, checks: checks || {} };
      const { error } = await db.from('lyndsay_snapshots').insert(row);
      if (error) throw error;
      const open = tasks.filter(t => !(checks || {})[t.id]).length;
      res.json({ ok: true, count: tasks.length, open, date: row.report_date });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/lyndsay/tasks', async (req, res) => {
    try {
      const snap = await lyndsayLatest(db);
      const checks = snap.checks || {};
      const tasks = (snap.tasks || []).map(t => ({ id: t.id, cat: t.cat, title: t.title, instr: t.instr, wo: t.wo || {}, age: t.age || null, link: t.link || null, extraMeta: t.extraMeta || null, completed: !!checks[t.id] }));
      const routineChecks = Object.fromEntries(Object.entries(checks).filter(([k]) => k.startsWith('routine:')));
      const routineTotal = ROUTINE_IDS.length;
      const routineDone  = ROUTINE_IDS.filter(id => checks['routine:' + id]).length;
      res.json({ importedAt: snap.imported_at, date: snap.report_date, total: tasks.length + routineTotal, open: tasks.filter(t => !t.completed).length + (routineTotal - routineDone), tasks, routineChecks, routineTotal, routineDone });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/lyndsay/tasks/:id/done', async (req, res) => {
    try {
      const snap = await lyndsayLatest(db);
      if (!snap.id) return res.status(404).json({ error: 'No snapshot found' });
      const task = (snap.tasks || []).find(t => t.id === req.params.id);
      if (!task && !req.params.id.startsWith('routine:')) return res.status(404).json({ error: 'Task not found' });
      const checks = { ...(snap.checks || {}), [req.params.id]: 1 };
      const { error } = await db.from('lyndsay_snapshots').update({ checks }).eq('id', snap.id);
      if (error) throw error;
      res.json({ ok: true, id: req.params.id, title: task ? task.title : req.params.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/lyndsay/tasks/:id/done', async (req, res) => {
    try {
      const snap = await lyndsayLatest(db);
      if (!snap.id) return res.status(404).json({ error: 'No snapshot found' });
      const task = (snap.tasks || []).find(t => t.id === req.params.id);
      if (!task && !req.params.id.startsWith('routine:')) return res.status(404).json({ error: 'Task not found' });
      const checks = { ...(snap.checks || {}) };
      delete checks[req.params.id];
      const { error } = await db.from('lyndsay_snapshots').update({ checks }).eq('id', snap.id);
      if (error) throw error;
      res.json({ ok: true, id: req.params.id, title: task ? task.title : req.params.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: AppFolio WO Analyzer ──────────────────────────────────────────

  app.post('/api/appfolio/upload', requireMetricAccess, afUpload.single('csv'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const text = await fsp.readFile(req.file.path, 'utf8');
      const rows = parseCSV(text);
      const analysis = analyzeWorkOrders(rows);
      const groups = { urgent: [], followup: [], ready: [], none: [] };
      for (const a of analysis.actions) groups[a.topTier].push(a);
      const result = { analyzedAt: new Date().toISOString(), file: req.file.filename, sourceType: 'csv', totalWorkOrders: analysis.count, headers: analysis.headers, groups };
      const analysisPath = path.join(REPORTS_DIR, req.file.filename.replace(/\.csv$/i, '_analysis.json'));
      await fsp.writeFile(analysisPath, JSON.stringify(result, null, 2), 'utf8');
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/appfolio/latest', requireMetricAccess, async (req, res) => {
    const data = await latestAppfolioAnalysis();
    res.json(data || { totalWorkOrders: 0, groups: { urgent: [], followup: [], ready: [], none: [] }, analyzedAt: null });
  });

  // AppFolio v2 Reports API (ported from metric-dashboard) — only if module present
  if (afReports) {
    const safeFilename = id => String(id).replace(/[^a-z0-9_\-]/gi, '_');

    // ── Background "sync all" ───────────────────────────────────────────────
    // Eight reports, paced by a 7-request/15-second limiter, take 30-60s end to
    // end. The local dashboard awaits that inside the request; behind Render's
    // proxy it would risk a gateway timeout and leave the UI with no idea
    // whether the sync survived. So the POST starts the job and returns 202,
    // and the UI polls the status route for progress.
    const syncAllJob = {
      running: false, startedAt: null, finishedAt: null,
      total: 0, done: 0, current: null, results: [], error: null,
    };
    const jobSnapshot = () => ({ ...syncAllJob, results: [...syncAllJob.results] });

    async function runSyncAll() {
      const ordered = [...afReports.REPORTS].sort((a, b) => a.priority - b.priority);
      Object.assign(syncAllJob, {
        running: true, startedAt: new Date().toISOString(), finishedAt: null,
        total: ordered.length, done: 0, current: null, results: [], error: null,
      });
      try {
        for (const def of ordered) {
          syncAllJob.current = def.id;
          // syncReport never throws — it records failures in its status file.
          syncAllJob.results.push(await afReports.syncReport(def.id));
          syncAllJob.done++;
        }
      } catch (err) {
        syncAllJob.error = err.message;
      } finally {
        syncAllJob.running = false;
        syncAllJob.current = null;
        syncAllJob.finishedAt = new Date().toISOString();
      }
    }

    // ── Registry + status ───────────────────────────────────────────────────
    app.get('/api/appfolio/reports', requireMetricAccess, async (req, res) => {
      try { res.json(await afReports.overview()); } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/appfolio/reports/sync-all', requireMetricAccess, (req, res) => {
      if (syncAllJob.running) {
        return res.status(409).json({ error: 'A sync is already running', job: jobSnapshot() });
      }
      runSyncAll().catch(() => {});   // deliberately not awaited
      res.status(202).json({ ok: true, started: true, job: jobSnapshot() });
    });

    app.get('/api/appfolio/reports/sync-all/status', requireMetricAccess, (req, res) => {
      res.json(jobSnapshot());
    });

    app.post('/api/appfolio/reports/:id/sync', requireMetricAccess, async (req, res) => {
      const result = await afReports.syncReport(req.params.id);
      res.status(result.ok ? 200 : 502).json(result);
    });

    app.get('/api/appfolio/reports/:id/data', requireMetricAccess, async (req, res) => {
      const data = await afReports.readReportData(req.params.id);
      if (!data) return res.status(404).json({ error: 'No synced data yet for this report.' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      res.json({ ...data, rows: data.rows.slice(0, limit), returned: Math.min(limit, data.rows.length) });
    });

    // ── Local CSV / PDF exports ─────────────────────────────────────────────
    // The Reports API only returns JSON; these are built here from synced rows.
    app.get('/api/appfolio/reports/:id/export.csv', requireMetricAccess, async (req, res) => {
      const data = await afReports.readReportData(req.params.id);
      if (!data) return res.status(404).json({ error: 'No synced data yet for this report.' });
      const name = `${safeFilename(req.params.id)}_${todayStr()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(afReports.toCSV(data.rows || []));
    });

    app.get('/api/appfolio/reports/:id/export.pdf', requireMetricAccess, async (req, res) => {
      const data = await afReports.readReportData(req.params.id);
      if (!data) return res.status(404).json({ error: 'No synced data yet for this report.' });
      const def  = afReports.byId(req.params.id);
      const rows = data.rows || [];
      const name = `${safeFilename(req.params.id)}_${todayStr()}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      try {
        require('./appfolio-pdf').streamTablePDF(res, {
          title: def?.label || req.params.id,
          subtitle: `AppFolio report: ${data.resource || req.params.id}.json`,
          fetchedAt: data.fetchedAt,
          params: data.params,
        }, afReports.collectHeaders(rows), rows);
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + err.message });
        else res.end();
      }
    });

    // ── Derived feeds ───────────────────────────────────────────────────────
    const feed = (route, fn, notSynced) =>
      app.get(route, requireMetricAccess, async (req, res) => {
        try {
          const data = await fn(req);
          if (!data) return res.status(404).json({ error: notSynced });
          res.json(data);
        } catch (err) { res.status(500).json({ error: err.message }); }
      });

    feed('/api/appfolio/feed/efficiency',      ()    => afReports.efficiencyMetrics(),          'Efficiency source reports not synced yet.');
    // Roster comes from the technicians table; techActivityToday falls back to
    // its own built-in list when that returns null (table not migrated yet).
    feed('/api/appfolio/feed/tech-activity',   async req => afReports.techActivityToday(req.query.date, await techRoster()), 'Labor Summary not synced yet.');
    feed('/api/appfolio/feed/billable',        ()    => afReports.billableSummary(),            'Billable reports not synced yet.');
    feed('/api/appfolio/feed/urgent-wos',      ()    => afReports.urgentWorkOrders(),           'Work order report not synced yet.');
    feed('/api/appfolio/feed/wo-by-property',  ()    => afReports.woCountsByProperty(),         'Work order report not synced yet.');
    feed('/api/appfolio/feed/open-wos',        ()    => afReports.openWorkOrders(),             'Work order report (wo_all) not synced yet.');
    feed('/api/appfolio/feed/activities',      ()    => afReports.activitiesSummary(),          'Activities Summary not synced yet.');
    feed('/api/appfolio/feed/inventory',       ()    => afReports.inventorySnapshot(),          'Inventory reports not synced yet.');
  }

  // ── MODULE: Erick's EOD Summary (prefixed — avoids /api/summary collision) ─

  app.get('/api/maintenance/summary', async (req, res) => {
    try { res.json(await buildMaintenanceSummary(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: Erick's Daily Work Report ────────────────────────────────────

  app.get('/api/report', async (req, res) => {
    try { res.json(await buildDailyWorkReport(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── MODULE: Maintenance SOPs (prefixed — avoids /api/sops collision) ──────

  app.get('/api/maintenance/sops', async (req, res) => {
    const index = await mSopsReadIndex();
    res.json(index.map(s => ({ id: s.id, title: s.title, uploadedAt: s.uploadedAt, chars: s.chars })));
  });

  app.get('/api/maintenance/sops/search/:q', async (req, res) => {
    const q = (req.params.q || '').toLowerCase();
    if (!q) return res.json({ results: [] });
    const index = await mSopsReadIndex();
    const results = [];
    for (const sop of index) {
      const lc = (sop.text || '').toLowerCase();
      const pos = lc.indexOf(q);
      if (pos !== -1) {
        const start = Math.max(0, pos - 120);
        results.push({ id: sop.id, title: sop.title, snippet: (start > 0 ? '…' : '') + sop.text.slice(start, pos + q.length + 200).trim() + '…' });
      }
    }
    res.json({ results });
  });

  app.get('/api/maintenance/sops/:id', async (req, res) => {
    const index = await mSopsReadIndex();
    const sop = index.find(s => s.id === req.params.id);
    if (!sop) return res.status(404).json({ error: 'SOP not found' });
    res.json(sop);
  });

  app.delete('/api/maintenance/sops/:id', async (req, res) => {
    let index = await mSopsReadIndex();
    const sop = index.find(s => s.id === req.params.id);
    if (!sop) return res.status(404).json({ error: 'SOP not found' });
    index = index.filter(s => s.id !== req.params.id);
    await mSopsWriteIndex(index);
    res.json({ ok: true });
  });

  // ── MODULE: SimpleVOIP Call Analyzer ──────────────────────────────────────
  // Session only, deliberately: these responses carry resident conversations.
  // requireMetricAccess would also let the shared x-metric-key through, which is
  // right for Erick's MCP tools and wrong for transcripts of people's calls.
  function requireSession(req, res, next) {
    const user = sessionPayload(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.svUser = user;
    next();
  }

  // Which SimpleVOIP user's calls this request may read.
  //
  // A non-admin gets the configured default and nothing else: passing a user_id
  // is refused outright rather than ignored, so nobody can discover that the
  // parameter exists and quietly read a colleague's calls. Hiding the dropdown
  // is not a control — this is.
  //
  // An admin's choice is checked against simplevoip_users, so even they can
  // only reach people on the roster rather than any id they care to type.
  async function resolveVoipUser(req) {
    const asked = String(req.query.user_id || '').trim();
    const isAdmin = req.svUser?.role === 'admin';
    if (!asked) return { userId: simplevoip.defaultUserId(), name: null };
    if (!isAdmin) return { error: 'Only an admin can choose whose calls to view.' };
    const { data, error } = await db.from('simplevoip_users')
      .select('name, user_id').eq('user_id', asked).eq('active', true).maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: 'That user is not on the SimpleVOIP roster.' };
    return { userId: data.user_id, name: data.name };
  }

  // The selector's options. Empty until the roster is filled from Kazoo, which
  // is why the module still falls back to SIMPLEVOIP_USER_ID.
  app.get('/api/simplevoip/users', requireSession, async (req, res) => {
    try {
      const { data, error } = await db.from('simplevoip_users')
        .select('name, user_id, role').eq('active', true).order('name');
      if (error) return res.status(500).json({ error: error.message });
      res.json({
        users: data || [],
        canChoose: req.svUser?.role === 'admin',
        defaultUserId: simplevoip.defaultUserId() || null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/simplevoip/calls', requireSession, async (req, res) => {
    if (!simplevoip.isConfigured()) {
      return res.json({ configured: false, date: null, calls: [],
        message: 'Set SIMPLEVOIP_ACCOUNT_ID and SIMPLEVOIP_USER_ID — see .env.example.' });
    }
    const who = await resolveVoipUser(req);
    if (who.error) return res.status(403).json({ error: who.error });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : todayStr();
    const { calls, error } = await simplevoip.fetchCallsForDate(who.userId, date);
    const shaped = simplevoip.shapeCalls(calls);
    // Compliance pre-scan for the list badge (Office Redirect, Lyndsay
    // 2026-09-01). The flag lives in the transcript, which the list does not
    // otherwise fetch — so calls that have a transcript are fetched here in
    // parallel and scanned deterministically (no model call), and a boolean is
    // attached so the row can show 🚨 without the reviewer opening each call.
    // Failures are non-fatal: an unscanned call simply carries no badge.
    await Promise.all(shaped
      .filter(c => c.has_transcript && c.recording_id)
      .map(async c => {
        try {
          const d = await simplevoip.fetchCallTranscript(who.userId, c.recording_id);
          c.office_redirect = !!(d && simplevoip.detectOfficeRedirect(d.transcription || '').flagged);
        } catch { /* leave unset — no badge */ }
      }));
    // 200 with an error field rather than a 500: partial pages are still worth
    // showing, and the view can say what went wrong beside them.
    res.json({ configured: true, date, user: who.name, user_id: who.userId,
               calls: shaped, error: error || null });
  });

  app.get('/api/simplevoip/calls/:recording_id/transcript', requireSession, async (req, res) => {
    if (!simplevoip.isConfigured()) return res.status(400).json({ error: 'SimpleVOIP is not configured.' });
    const who = await resolveVoipUser(req);
    if (who.error) return res.status(403).json({ error: who.error });
    const shaped = simplevoip.shapeTranscript(
      await simplevoip.fetchCallTranscript(who.userId, req.params.recording_id), req.params.recording_id);
    if (!shaped) return res.status(404).json({ error: 'No transcript for that recording.' });
    // Whose calls these are — so the compliance follow-up names the agent.
    shaped.agent_name = who.name || null;
    res.json(shaped);
  });

  // 6 PM Central. Timezone stated because Render runs UTC, where an unqualified
  // hour would fire at lunchtime in Austin.
  async function archiveTodaysCalls() {
    if (!simplevoip.isConfigured()) return { skipped: 'not configured' };
    const date = todayStr();
    const { calls } = await simplevoip.fetchCallsForDate(null, date);
    const shaped = simplevoip.shapeCalls(calls).filter(c => c.has_transcript && c.recording_id);
    let stored = 0;
    for (const c of shaped) {
      const t = await simplevoip.fetchCallTranscript(null, c.recording_id);
      const text = t?.transcription || '';
      const { error } = await db.from('simplevoip_daily_calls').upsert({
        call_date: date, recording_id: c.recording_id, caller: c.caller,
        duration: c.duration, transcript: text, fetched_at: new Date().toISOString(),
      }, { onConflict: 'recording_id' });
      if (error) console.error('[simplevoip] store failed', c.recording_id, error.message);
      else stored++;
    }
    return { date, seen: shaped.length, stored };
  }

  cron.schedule('0 18 * * *', () => {
    archiveTodaysCalls()
      .then(r => console.log('[simplevoip] archive:', JSON.stringify(r)))
      .catch(err => console.error('[simplevoip] archive failed:', err.message));
  }, { timezone: 'America/Chicago' });

}

// requireMetricAccess is exported so server.js can put the same guard on the
// email routes that serve Lyndsay's mailbox. They need session-or-key for the
// same reason /api/operational does: the MCP tools read them over HTTP with no
// cookie, sending x-metric-key instead.
module.exports = { registerMetricRoutes, requireMetricAccess, requireMetricAdmin };
