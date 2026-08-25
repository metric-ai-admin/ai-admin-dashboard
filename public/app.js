const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Date-only string in the BROWSER'S LOCAL TIMEZONE — never toISOString().slice(0,10)
// here, since that gives the UTC calendar date and rolls over to "tomorrow" a few
// hours before local midnight (Arturo is UTC-4). Accepts a Date or ISO string so
// stored timestamps (created_at, completed_at) can be compared the same way.
function localDateStr(d = new Date()) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const todayStr = () => localDateStr();

// Must match ARTURO_TIMEZONE / LYNDSAY_TIMEZONE in .env.
const ARTURO_TZ = 'America/Caracas';
const LYNDSAY_TZ = 'America/Chicago';
function formatDualTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const ct = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LYNDSAY_TZ });
  const vet = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ARTURO_TZ });
  return `${ct} CT | ${vet} VET`;
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'success'))
    .catch(() => toast('Could not copy — select and copy manually', 'error'));
}

// ---- Auth / session ---------------------------------------------------------
const TAB_ACCESS = {
  admin:       ['tasks', 'sops', 'platform', 'email', 'eod', 'maintenance', 'crm'],
  ceo:         ['crm', 'platform', 'eod'],
  operations:  ['tasks', 'platform', 'email', 'eod'],
  maintenance: ['crm'],
  bd_agent:    ['crm'],
};

let currentUser = null;

async function initAuth() {
  try {
    const data = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);
    if (!data?.user) { window.location.href = '/login.html'; return; }
    currentUser = data.user;
  } catch {
    window.location.href = '/login.html';
    return;
  }

  // Update sidebar brand with user name/role
  const brandName = $('.brand-name');
  const brandRole = $('.brand-role');
  const brandEmail = $('.brand-email');
  if (brandName) brandName.textContent = currentUser.name;
  if (brandRole) brandRole.textContent = roleLabelFor(currentUser.role);
  if (brandEmail) brandEmail.textContent = currentUser.email;

  // Gate tabs by role
  const allowed = TAB_ACCESS[currentUser.role] || [];
  const allTabBtns = $$('#tabs button[data-tab]');
  allTabBtns.forEach(btn => {
    if (!allowed.includes(btn.dataset.tab)) btn.style.display = 'none';
  });

  // Activate first allowed tab
  const firstAllowed = allTabBtns.find(b => allowed.includes(b.dataset.tab));
  if (firstAllowed) {
    $$('#tabs button').forEach(b => b.classList.remove('active'));
    $$('.tab').forEach(t => t.classList.remove('active'));
    firstAllowed.classList.add('active');
    const tabEl = $(`#tab-${firstAllowed.dataset.tab}`);
    if (tabEl) tabEl.classList.add('active');
    loadTab(firstAllowed.dataset.tab);
  }

  // Wire logout button
  $('#logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login.html';
  });
}

function roleLabelFor(role) {
  return { admin: 'AI Admin', ceo: 'CEO', operations: 'Operations Manager', maintenance: 'Maintenance Coordinator', bd_agent: 'BD Agent' }[role] || role;
}

// ---- Tabs -------------------------------------------------------------------
$$('#tabs button[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#tabs button[data-tab]').forEach(b => b.classList.remove('active'));
    $$('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    loadTab(btn.dataset.tab);
  });
});

function loadTab(tab) {
  if (tab !== 'maintenance') {
    $('#maintenance-subnav')?.classList.add('hidden');
    const caret = $('#maint-subnav-caret');
    if (caret) caret.textContent = '›';
  }
  if (tab === 'tasks') loadTasks();
  if (tab === 'sops') loadSops();
  if (tab === 'platform') loadPlatform();
  if (tab === 'email') loadEmail();
  if (tab === 'eod') loadEod();
  if (tab === 'maintenance') loadMaintenance();
  if (tab === 'crm') { crmApplyUserRole(); crmLoadMeta(); crmLoadProperties(); }
  if (window.innerWidth <= 820) $('#sidebar').classList.remove('open');
}

// ---- Mobile sidebar toggle ----------------------------------------------------
$('#menu-toggle')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// ---- Sidebar sync status dot ---------------------------------------------------
function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1m ago';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

async function refreshSidebarStatus() {
  const dot = $('#sidebar-status-dot');
  const text = $('#sidebar-status-text');
  try {
    const s = await api('/api/email/refresh-status');
    dot.className = 'status-dot' + (s.configured ? '' : ' warn');
    text.textContent = `Last sync: ${timeAgo(s.lastRun)}`;
  } catch {
    dot.className = 'status-dot err';
    text.textContent = 'Dashboard unreachable';
  }
}
refreshSidebarStatus();
setInterval(refreshSidebarStatus, 30000);

// =====================================================================
// TASKS — Kanban board
// =====================================================================

const TASK_TYPES = ['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other'];
const TYPE_ICONS = {
  'Lyndsay Review': '👑', 'To Review Together': '🤝', 'Admin Request': '📌',
  'Email Follow-up': '📧', 'Platform Build': '🏗️', 'Asana Import': '📋', 'Other': '📎',
};
const TASK_COLUMNS = [
  { key: '🔴 Critical', header: '🔴 Critical', pills: ['all', 'pending', 'critical'], collapsible: false, cls: 'col-critical' },
  { key: '🟡 Follow-up', header: '🟡 Follow-up', pills: ['all', 'pending'], collapsible: true, cls: 'col-followup' },
  { key: '🟢 In Progress', header: '🟢 In Progress', pills: ['all', 'pending'], collapsible: false, cls: 'col-inprogress' },
  { key: '✅ Done', header: '✅ Completed', pills: ['all', 'done'], collapsible: true, cls: 'col-done' },
];
const PRIO_CLASS = { '🔴 Critical': 'prio-critical', '🟡 Follow-up': 'prio-followup', '🟢 In Progress': 'prio-inprogress', '✅ Done': 'prio-done' };

let taskCache = [];
let taskTimeFilter = 'today';
let taskStatusFilter = 'all';

// Populate the type filter dropdown once
$('#task-type-filter').innerHTML = '<option value="">All</option>' + TASK_TYPES.map(t => `<option>${t}</option>`).join('');

async function loadTasks() {
  taskCache = await api('/api/tasks');
  renderTasks();
}

function renderTaskCard(t) {
  const today = todayStr();
  const isDone = t.priority === '✅ Done';
  const overdue = t.due_on && t.due_on < today && !isDone;
  const dueToday = t.due_on === today && !isDone;
  return `
    <div class="card ${PRIO_CLASS[t.priority] || ''} ${isDone ? 'completed' : ''}" data-id="${t.id}">
      <div class="card-meta" style="justify-content:space-between">
        <span class="badge badge-gray">${TYPE_ICONS[t.type] || '📎'} ${esc(t.type)}</span>
        ${t.completed_at ? `<span class="muted small">✅ ${new Date(t.completed_at).toLocaleDateString()}</span>` : ''}
      </div>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">
        ${t.source ? `<span>👤 <b>${esc(t.source)}</b></span>` : ''}
        ${t.due_on ? `<span class="${overdue ? 'badge badge-red' : dueToday ? 'badge badge-amber' : ''}">${overdue ? '⚠ overdue ' : '📅 '}${t.due_on}</span>` : `<span class="muted small">Created ${new Date(t.created_at).toLocaleDateString()}</span>`}
      </div>
      ${t.notes ? `<div class="card-notes">${esc(t.notes.length > 100 ? t.notes.slice(0, 100) + '…' : t.notes)}</div>` : ''}
      <details class="comments">
        <summary>📝 Notes <span class="note-count">(${(t.noteHistory || []).length})</span></summary>
        <div class="note-history">
          ${(t.noteHistory || []).length
            ? [...t.noteHistory].reverse().map(n => `
              <div class="note-entry">
                <span class="note-time">${new Date(n.createdAt).toLocaleString()}</span>
                <span>${esc(n.text)}</span>
              </div>`).join('')
            : '<span class="muted small">No notes yet.</span>'}
        </div>
        <div class="note-add">
          <input type="text" placeholder="Add note..." data-note-input>
          <button class="btn-sm" data-act="add-note">+ Add</button>
        </div>
      </details>
      <div class="card-actions">
        ${!isDone ? `<button class="btn-sm primary" data-act="done">✓ Mark Done</button>` : ''}
        <select data-prio>${['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done'].map(p => `<option ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
        <button class="btn-sm btn-danger" data-act="delete">🗑</button>
      </div>
    </div>`;
}

function renderTasks() {
  const ft = $('#task-type-filter').value;
  const today = todayStr();
  const d7 = new Date(); d7.setDate(d7.getDate() - 7);
  const weekAgo = localDateStr(d7);

  let baseList = taskCache.filter(t => !ft || t.type === ft);
  const inRange = (t, cutoff) => {
    if (t.priority === '🔴 Critical') return true;
    if (t.priority === '✅ Done') return t.completed_at && localDateStr(t.completed_at) >= cutoff;
    if (t.due_on && t.due_on >= cutoff) return true;
    return localDateStr(t.created_at) >= cutoff;
  };
  if (taskTimeFilter === 'today') baseList = baseList.filter(t => inRange(t, today));
  else if (taskTimeFilter === 'week') baseList = baseList.filter(t => inRange(t, weekAgo));

  // KPI bar — global snapshot
  const kc = {
    critical: taskCache.filter(t => t.priority === '🔴 Critical').length,
    followup: taskCache.filter(t => t.priority === '🟡 Follow-up').length,
    inprogress: taskCache.filter(t => t.priority === '🟢 In Progress').length,
    done: taskCache.filter(t => t.priority === '✅ Done').length,
  };
  $('#task-kpi-bar').innerHTML = [
    { label: 'Critical', count: kc.critical, cls: 'kpi-chip-red' },
    { label: 'Follow-up', count: kc.followup, cls: 'kpi-chip-amber' },
    { label: 'In Progress', count: kc.inprogress, cls: 'kpi-chip-blue' },
    { label: 'Done', count: kc.done, cls: 'kpi-chip-green' },
  ].filter(c => c.count > 0).map(c => `<span class="kpi-chip ${c.cls}"><span class="kpi-num">${c.count}</span> ${c.label}</span>`).join('');

  // Time pills
  $$('#task-time-pills .pill').forEach(p => p.classList.toggle('active', p.dataset.time === taskTimeFilter));

  // Status pill counts (time-filtered)
  const counts = {
    all: baseList.length,
    pending: baseList.filter(t => t.priority !== '✅ Done').length,
    critical: baseList.filter(t => t.priority === '🔴 Critical').length,
    done: baseList.filter(t => t.priority === '✅ Done').length,
  };
  const labels = { all: 'All', pending: '⏳ Pending', critical: '🔴 Critical', done: '✅ Completed' };
  $$('#task-status-pills .pill').forEach(p => {
    p.classList.toggle('active', p.dataset.status === taskStatusFilter);
    p.innerHTML = `${labels[p.dataset.status]} <span class="pill-count">(${counts[p.dataset.status]})</span>`;
  });

  const grouped = {};
  TASK_COLUMNS.forEach(c => { grouped[c.key] = []; });
  baseList.forEach(t => { if (grouped[t.priority]) grouped[t.priority].push(t); });

  const visible = TASK_COLUMNS.filter(c => c.pills.includes(taskStatusFilter));
  const el = $('#task-list');
  el.className = visible.length === 1 ? 'card-grid' : 'kanban';

  if (!baseList.length) {
    el.innerHTML = '<div class="empty-state">No tasks. Add one above ☝</div>';
    return;
  }

  el.innerHTML = visible.map(col => {
    const tasks = grouped[col.key] || [];
    if (visible.length === 1) {
      return tasks.length ? tasks.map(renderTaskCard).join('') : '<div class="empty-state">Nothing in this category.</div>';
    }
    return `
      <div class="kanban-column ${col.cls}${col.collapsible ? ' col-collapsed' : ''}" data-col-key="${col.key}">
        <div class="kanban-col-head">
          <span>${col.header}<span class="col-toggle">▾</span></span>
          <span class="kanban-col-count">${tasks.length}</span>
        </div>
        <div class="kanban-col-body">
          ${tasks.length ? tasks.map(renderTaskCard).join('') : '<p class="kanban-col-empty">No tasks</p>'}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.kanban-col-head').forEach(head => {
    head.addEventListener('click', () => head.closest('.kanban-column').classList.toggle('col-collapsed'));
  });

  el.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    card.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); handleTaskAction(btn.dataset.act, id, card); }));
    card.querySelector('[data-prio]')?.addEventListener('change', e => updateTask(id, { priority: e.target.value }));
  });
}

async function handleTaskAction(act, id, card) {
  try {
    if (act === 'done') {
      await api(`/api/tasks/${id}/done`, { method: 'POST' });
      toast('Marked done', 'success');
      loadTasks();
    } else if (act === 'delete') {
      if (!confirm('Delete this task?')) return;
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      toast('Deleted');
      loadTasks();
    } else if (act === 'add-note') {
      const input = card.querySelector('[data-note-input]');
      const text = input.value.trim();
      if (!text) return toast('Write a note first', 'error');
      await api(`/api/tasks/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      toast('Note added', 'success');
      loadTasks();
    }
  } catch (err) { toast(err.message, 'error'); }
}

async function updateTask(id, patch) {
  await api(`/api/tasks/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  loadTasks();
}

$('#task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fd)) });
    e.target.reset();
    toast('Task added', 'success');
    loadTasks();
  } catch (err) { toast(err.message, 'error'); }
});
$('#refresh-tasks').addEventListener('click', loadTasks);
$('#task-type-filter').addEventListener('change', renderTasks);
$$('#task-time-pills .pill').forEach(p => p.addEventListener('click', () => { taskTimeFilter = p.dataset.time; renderTasks(); }));
$$('#task-status-pills .pill').forEach(p => p.addEventListener('click', () => { taskStatusFilter = p.dataset.status; renderTasks(); }));

// =====================================================================
// SOPs — expandable cards with formatted content + Slab links
// =====================================================================

let sopCache = [];
let sopCurrentList = [];
let openSopId = null;
const sopDetailCache = {};

// Renders ALL-CAPS "HEADER:" lines as section headers, "-" lines as bullets,
// everything else as plain paragraphs.
function formatSopContent(text) {
  const lines = String(text || '').split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const isHeading = line.endsWith(':') && line === line.toUpperCase() && /[A-Z]/.test(line);
    if (isHeading) {
      closeList();
      html += `<div class="sop-heading">${esc(line)}</div>`;
    } else if (line.startsWith('-')) {
      if (!inList) { html += '<ul class="sop-list">'; inList = true; }
      html += `<li>${esc(line.slice(1).trim())}</li>`;
    } else {
      closeList();
      html += `<p class="sop-p">${esc(line)}</p>`;
    }
  }
  closeList();
  return html;
}

async function loadSops() {
  sopCache = await api('/api/sops');
  sopCurrentList = sopCache;
  renderSops();
}

function renderSops() {
  const list = sopCurrentList;
  $('#sop-list').innerHTML = list.map(s => {
    const isOpen = s.id === openSopId;
    const detail = sopDetailCache[s.id];
    return `
      <div class="project-card ${isOpen ? 'open' : ''}" data-id="${s.id}">
        <div class="project-head" data-toggle>
          <div>
            <div class="project-title">${esc(s.title)} ${s.category ? `<span class="badge badge-blue">${esc(s.category)}</span>` : ''}</div>
            ${s.source ? `<div class="muted small" style="margin-top:4px">${esc(s.source)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="muted small">${s.chars} chars</span>
            <span class="project-toggle">▶</span>
          </div>
        </div>
        <div class="project-body">
          ${isOpen ? (detail ? `
            ${s.slab_url ? `<a class="btn-sm primary slab-link" href="${esc(s.slab_url)}" target="_blank" rel="noopener">Open in Slab →</a>` : ''}
            <div class="sop-content">${formatSopContent(detail.text)}</div>
            <p class="muted small" style="margin-top:12px">Last updated: ${detail.uploadedAt ? new Date(detail.uploadedAt).toLocaleString() : '—'}</p>
          ` : '<p class="muted small">Loading...</p>') : ''}
        </div>
      </div>`;
  }).join('') || '<p class="hint">No SOPs yet.</p>';

  $$('#sop-list .project-head').forEach(head => {
    head.addEventListener('click', () => toggleSop(head.closest('.project-card').dataset.id));
  });
}

async function toggleSop(id) {
  if (openSopId === id) {
    openSopId = null;
    renderSops();
    return;
  }
  openSopId = id;
  if (!sopDetailCache[id]) {
    renderSops(); // show "Loading..." immediately
    sopDetailCache[id] = await api(`/api/sops/${encodeURIComponent(id)}`);
  }
  renderSops();
}

$('#sop-search').addEventListener('input', async e => {
  const q = e.target.value.trim();
  if (!q) { sopCurrentList = sopCache; renderSops(); return; }
  const { results } = await api(`/api/sops/search/${encodeURIComponent(q)}`);
  const ids = new Set(results.map(r => r.id));
  sopCurrentList = sopCache.filter(s => ids.has(s.id));
  if (sopCurrentList.length) await toggleSopOpen(sopCurrentList[0].id);
  else { openSopId = null; renderSops(); }
});

// Opens a specific SOP (used by search auto-expand) without toggling closed if already open.
async function toggleSopOpen(id) {
  openSopId = id;
  if (!sopDetailCache[id]) {
    renderSops();
    sopDetailCache[id] = await api(`/api/sops/${encodeURIComponent(id)}`);
  }
  renderSops();
}

$('#sop-add-toggle').addEventListener('click', () => $('#sop-add-form').classList.toggle('hidden'));
$('#sop-add-cancel').addEventListener('click', () => { $('#sop-add-form').classList.add('hidden'); $('#sop-add-form').reset(); });
$('#sop-add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  try {
    await api('/api/sops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    e.target.reset();
    e.target.classList.add('hidden');
    toast('SOP added', 'success');
    loadSops();
  } catch (err) { toast(err.message, 'error'); }
});

// =====================================================================
// PLATFORM PROJECTS — expandable cards with subtasks
// =====================================================================

const PROJECT_PHASES = ['Not started', 'Discovery', 'In Development', 'Testing', 'Live'];
const openProjects = new Set();

async function loadPlatform() {
  const projects = await api('/api/platform-projects');
  renderPlatform(projects);
}

function renderPlatform(projects) {
  $('#platform-list').innerHTML = projects.map(p => {
    const subtasks = p.subtasks || [];
    const done = subtasks.filter(s => s.done).length;
    const pct = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0;
    const isOpen = openProjects.has(p.id);
    return `
      <div class="project-card ${isOpen ? 'open' : ''}" data-id="${p.id}">
        <div class="project-head" data-toggle>
          <div>
            <div class="project-title">${esc(p.module)} <span class="badge badge-blue">${esc(p.phase)}</span></div>
            ${p.blockers ? `<div class="blockers-banner" style="margin-top:6px">⚠ ${esc(p.blockers)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;min-width:160px">
            <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
            <span class="progress-label">${done}/${subtasks.length || 0}</span>
            <span class="project-toggle">▶</span>
          </div>
        </div>
        <div class="project-body">
          <div class="field-row">
            <label>Stage</label>
            <select data-field="phase">${PROJECT_PHASES.map(ph => `<option ${ph === p.phase ? 'selected' : ''}>${ph}</option>`).join('')}</select>
          </div>
          <div class="field-row">
            <label>Next action</label>
            <input type="text" data-field="nextAction" value="${esc(p.nextAction || '')}" placeholder="Next action...">
          </div>
          <div class="field-row">
            <label>Blockers</label>
            <textarea data-field="blockers" placeholder="Any blockers...">${esc(p.blockers || '')}</textarea>
          </div>
          <div class="field-row">
            <label>Subtasks</label>
            <div class="subtask-list">
              ${subtasks.map(s => `
                <div class="subtask-row ${s.done ? 'done' : ''}" data-sub-id="${s.id}">
                  <input type="checkbox" ${s.done ? 'checked' : ''} data-sub-toggle>
                  <span>${esc(s.title)}</span>
                  <button class="del-sub" data-sub-delete title="Delete">✕</button>
                </div>`).join('') || '<p class="muted small">No subtasks yet — add the first one below.</p>'}
            </div>
            <div class="subtask-add">
              <input type="text" placeholder="New subtask..." data-sub-input>
              <button class="btn-sm" data-add-sub>+ Add</button>
            </div>
          </div>
          <p class="muted small">Last update: ${p.lastUpdate ? new Date(p.lastUpdate).toLocaleString() : '—'}</p>
        </div>
      </div>`;
  }).join('');

  $$('#platform-list .project-head').forEach(head => {
    head.addEventListener('click', () => {
      const card = head.closest('.project-card');
      const id = card.dataset.id;
      card.classList.toggle('open');
      if (card.classList.contains('open')) openProjects.add(id); else openProjects.delete(id);
    });
  });

  $$('#platform-list .project-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-field=phase]')?.addEventListener('change', e => updateProject(id, { phase: e.target.value }));
    card.querySelector('[data-field=nextAction]')?.addEventListener('change', e => updateProject(id, { nextAction: e.target.value }));
    card.querySelector('[data-field=blockers]')?.addEventListener('change', e => updateProject(id, { blockers: e.target.value }));

    card.querySelectorAll('[data-sub-toggle]').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', e => {
        const subId = e.target.closest('[data-sub-id]').dataset.subId;
        toggleSubtask(id, subId, e.target.checked);
      });
    });
    card.querySelectorAll('[data-sub-delete]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const subId = e.target.closest('[data-sub-id]').dataset.subId;
        deleteSubtask(id, subId);
      });
    });
    const addBtn = card.querySelector('[data-add-sub]');
    const addInput = card.querySelector('[data-sub-input]');
    addBtn?.addEventListener('click', e => { e.stopPropagation(); addSubtask(id, addInput.value); });
    addInput?.addEventListener('click', e => e.stopPropagation());
    addInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(id, addInput.value); } });
  });
}

async function updateProject(id, patch) {
  try {
    await api(`/api/platform-projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    toast('Saved', 'success');
    loadPlatform();
  } catch (err) { toast(err.message, 'error'); }
}

async function addSubtask(id, title) {
  if (!title || !title.trim()) return;
  try {
    await api(`/api/platform-projects/${id}/subtasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    openProjects.add(id);
    loadPlatform();
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleSubtask(id, subId, done) {
  try {
    await api(`/api/platform-projects/${id}/subtasks/${subId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    openProjects.add(id);
    loadPlatform();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteSubtask(id, subId) {
  try {
    await api(`/api/platform-projects/${id}/subtasks/${subId}`, { method: 'DELETE' });
    openProjects.add(id);
    loadPlatform();
  } catch (err) { toast(err.message, 'error'); }
}

// =====================================================================
// EMAIL / CALENDAR
// =====================================================================

let lyndsayTodayCache = [];
let lyndsayTomorrowCache = [];

// Returns current time and meeting start both in CT for accurate comparison.
// Uses toLocaleString trick to get a Date object in CT — avoids browser-local
// timezone skewing the urgency check (Arturo runs the browser from Venezuela VET).
function meetingUrgency(isoStart) {
  if (!isoStart) return { level: null, mins: null };
  const nowCT  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const startCT = new Date(new Date(isoStart).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const mins = Math.round((startCT - nowCT) / 60000);
  if (mins > 30 || mins < -5) return { level: null, mins };
  if (mins <= 5) return { level: 'now', mins };
  return { level: 'soon', mins };
}

// Web Audio API beep — no CDN, no files.
function playAlertSound(level) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (freq, t, dur) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t); osc.stop(t + dur);
    };
    if (level === 'now') { beep(880, ctx.currentTime, 0.15); beep(880, ctx.currentTime + 0.22, 0.15); }
    else { beep(440, ctx.currentTime, 0.22); }
  } catch { /* AudioContext unavailable */ }
}

function formatCT(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LYNDSAY_TZ
  }) + ' <span class="tz-label">CT</span>';
}

function renderMeetings(list, isLyndsay) {
  if (!list || !list.length) return '<p class="muted small">No meetings today (or stub mode).</p>';
  return list.map((m, i) => `
    <div class="card meeting-card" style="margin-bottom:8px" data-start="${esc(m.start || '')}" data-subject="${esc(m.subject || '')}">
      <div class="card-title" style="font-size:13.5px">
        ${esc(m.subject)}
        ${m.conflict ? ' <span class="badge badge-red">⚠ CONFLICT</span>' : ''}
        ${m.isCancelled ? ' <span class="badge badge-gray">Cancelled</span>' : ''}
        ${m._crossCal ? ' <span class="badge badge-amber" title="From support@ calendar">📧 support@</span>' : ''}
        <span class="meeting-urgency-badge"></span>
      </div>
      <div class="card-meta">
        <span class="mono small">🕐 ${formatCT(m.start)}</span>
        <span class="badge badge-blue">${esc(m.platform || '—')}</span>
        ${m.attendees && m.attendees.length ? `<span class="muted small">${m.attendees.length} attendee(s)</span>` : ''}
      </div>
      ${isLyndsay && !m.isCancelled ? `
        <div class="card-actions">
          <button class="btn-sm add-reminder-btn" data-idx="${i}">+ Add Reminder</button>
          <span class="meeting-action-btns"></span>
        </div>` : ''}
    </div>`).join('');
}

async function addReminderForMeeting(meeting) {
  try {
    await api('/api/lyndsay-queue/from-meeting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting }) });
    toast('Reminder added to queue', 'success');
    loadEmail();
    updateReminderAlerts();
  } catch (err) { toast(err.message, 'error'); }
}

// ---- Inbox panels (read-only — no reply/move/delete) -------------------------
// Two separate collapsible panels now (Support Inbox / Lyndsay's Inbox),
// clearly split rather than sharing a sub-tab switcher.
$('#support-inbox-toggle').addEventListener('click', () => $('#support-inbox-panel').classList.toggle('open'));
$('#lyndsay-inbox-toggle').addEventListener('click', () => $('#lyndsay-inbox-panel').classList.toggle('open'));
$('#inbox-tracking-toggle').addEventListener('click', () => $('#inbox-tracking-panel').classList.toggle('open'));

$('#copy-inbox-copilot-btn').addEventListener('click', async () => {
  const statusEl = $('#copy-inbox-copilot-status');
  statusEl.textContent = 'Exporting…';
  try {
    const res = await fetch('/api/copilot/export-internal');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
    statusEl.textContent = '✅ Inbox copied for Copilot';
  } catch (err) {
    statusEl.textContent = `❌ Failed to export inbox: ${err.message}`;
  }
});
$('#inbox-tracking-refresh-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  await api('/api/email/refresh-now', { method: 'POST' });
  loadInboxTracking();
});

const inboxTrackingFolderCache = {};

async function loadInboxTracking() {
  const data = await api('/api/email/inbox-tracking');
  const rows = data.rows || [];
  $('#inbox-tracking-status').textContent = data.lastChecked
    ? `Last checked: ${new Date(data.lastChecked).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : 'Not checked yet.';

  // Group the flat row list by mailbox, preserving mapping order — the
  // "Inbox" row is the mailbox's own header row, every other folderName is
  // a permanently-visible tracked personal folder underneath it.
  const byEmail = new Map();
  rows.forEach(r => {
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r);
  });

  $('#inbox-tracking-body').innerHTML = [...byEmail.entries()].map(([email, group]) => {
    const inboxRow = group.find(r => r.folderName === 'Inbox');
    const personalRows = group.filter(r => r.folderName !== 'Inbox');
    if (!inboxRow) return '';

    const mainHtml = inboxRow.error
      ? `<tr class="error" data-mailbox-group="${esc(email)}"><td>${esc(inboxRow.rowLabel)}</td><td colspan="2">${esc(inboxRow.error)}</td></tr>`
      : `<tr class="${inboxRow.unread > 20 ? 'attention' : ''}" data-mailbox-group="${esc(email)}"><td><span class="folder-toggle" data-toggle-email="${esc(email)}">▶</span> ${esc(inboxRow.rowLabel)}</td><td>${inboxRow.unread}</td><td>${inboxRow.total}</td></tr>`;

    const subRowsHtml = personalRows.map(r => {
      if (r.error) return `<tr class="folder-subrow tracked" data-mailbox-group="${esc(email)}"><td style="padding-left:24px" colspan="2">↳ ${esc(r.rowLabel)}: ${esc(r.error)}</td></tr>`;
      const note = r.note ? ` title="${esc(r.note)}"` : '';
      return `<tr class="folder-subrow tracked" data-mailbox-group="${esc(email)}" data-folder-name="${esc(r.folderName)}"${note}><td style="padding-left:24px">↳ ${esc(r.rowLabel)}${r.note ? ' ⚠' : ''}</td><td>${r.unread}</td><td>${r.total}</td></tr>`;
    }).join('');

    return mainHtml + subRowsHtml;
  }).join('') || '<tr><td colspan="3" class="muted small">No data yet — click Refresh.</td></tr>';

  $$('#inbox-tracking-body [data-toggle-email]').forEach(el => {
    el.addEventListener('click', () => toggleMailboxFolders(el.dataset.toggleEmail, el));
  });
}

// Any OTHER folder inside a departmental mailbox, beyond the ones already
// permanently tracked above — lazy-loaded per row on first expand, since
// discovering folders recurses one level into every folder with children
// and is meaningfully heavier than the cached tracked counts.
async function toggleMailboxFolders(email, toggleEl) {
  const existing = document.querySelectorAll(`tr.folder-subrow.extra[data-subrow-for="${email}"]`);
  if (existing.length) {
    existing.forEach(tr => tr.remove());
    toggleEl.textContent = '▶';
    return;
  }
  toggleEl.textContent = '⏳';
  let folders = inboxTrackingFolderCache[email];
  if (!folders) {
    try {
      const data = await api(`/api/email/folders?mailbox=${encodeURIComponent(email)}`);
      // Top-level, non-Inbox folders only — nested children stay collapsed
      // inside their parent, one level of sub-rows is enough for this view.
      folders = (data.folders || []).filter(f => f.name !== 'Inbox' && !f.parent);
      inboxTrackingFolderCache[email] = folders;
    } catch {
      folders = [];
    }
  }
  const trackedNames = new Set([...document.querySelectorAll(`tr.folder-subrow.tracked[data-mailbox-group="${email}"]`)].map(tr => tr.dataset.folderName));
  const extra = folders.filter(f => !trackedNames.has(f.name));

  toggleEl.textContent = '▼';
  const groupRows = document.querySelectorAll(`[data-mailbox-group="${email}"]`);
  const anchor = groupRows[groupRows.length - 1];
  const html = extra.length
    ? extra.map(f => `<tr class="folder-subrow extra" data-subrow-for="${esc(email)}"><td style="padding-left:24px">↳ ${esc(f.name)}</td><td>${f.unreadCount}</td><td>${f.totalCount}</td></tr>`).join('')
    : `<tr class="folder-subrow extra" data-subrow-for="${esc(email)}"><td colspan="3" class="muted small" style="padding-left:24px">No other folders.</td></tr>`;
  anchor.insertAdjacentHTML('afterend', html);
}

function renderInboxLoadPrompt(mailboxKey) {
  return `
    <div class="inbox-controls" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
      <select class="folder-select" data-inbox-mailbox="${mailboxKey}" style="min-width:180px">
        <option value="Inbox">Inbox</option>
      </select>
      <button class="btn-sm load-inbox-btn" data-inbox-mailbox="${mailboxKey}">Load Inbox</button>
    </div>
    <div class="inbox-results" data-inbox-mailbox="${mailboxKey}"></div>`;
}
$('#inbox-lyndsay').innerHTML = renderInboxLoadPrompt('lyndsay');
$('#inbox-arturo').innerHTML = renderInboxLoadPrompt('arturo');
$$('.load-inbox-btn').forEach(btn => btn.addEventListener('click', () => {
  const folder = $(`.folder-select[data-inbox-mailbox="${btn.dataset.inboxMailbox}"]`)?.value || 'Inbox';
  loadInbox(btn.dataset.inboxMailbox, folder);
}));
loadFolderOptions('lyndsay');
loadFolderOptions('arturo');

// Populates the folder dropdown with every real folder in the mailbox (Lyndsay
// Review, Need to File, Rhoxie To Do, etc.), not just Inbox. Fails silently
// (keeps the Inbox-only default) if Graph isn't configured/connected yet.
async function loadFolderOptions(mailboxKey) {
  try {
    const data = await api(`/api/email/folders?mailbox=${mailboxKey}`);
    if (!data.configured || data.authRequired || data.error || !data.folders) return;
    const select = document.querySelector(`.folder-select[data-inbox-mailbox="${mailboxKey}"]`);
    if (!select) return;
    select.innerHTML = data.folders.map(f => `<option value="${esc(f.name)}">${esc(f.name)} (${f.unreadCount}/${f.totalCount})</option>`).join('');
  } catch { /* keep Inbox-only default */ }
}

async function loadInbox(mailboxKey, folder = 'Inbox') {
  const container = $(`.inbox-results[data-inbox-mailbox="${mailboxKey}"]`);
  container.innerHTML = '<p class="muted small">Loading...</p>';
  try {
    const data = await api(`/api/email/inbox?mailbox=${mailboxKey}&limit=50&folder=${encodeURIComponent(folder)}`);
    if (!data.configured) { container.innerHTML = `<p class="muted small">${esc(data.message || 'Graph API not configured.')}</p>`; return; }
    if (data.authRequired) { container.innerHTML = `<p class="muted small">Microsoft account not connected yet. <a href="/auth/login">Connect Microsoft 365 →</a></p>`; return; }
    if (data.error) { container.innerHTML = `<p class="muted small">Error: ${esc(data.error)}</p>`; return; }
    const emails = data.emails || [];
    const unread = emails.filter(e => !e.isRead).length;
    container.innerHTML = `
      <div class="inbox-count-badge"><span class="badge badge-blue">${unread} unread / ${emails.length} total</span> <button class="btn-sm reload-inbox-btn" data-inbox-mailbox="${mailboxKey}" data-folder="${esc(folder)}" style="float:right">🔄 Reload</button></div>
      ${emails.map(e => `
        <div class="inbox-row ${!e.isRead ? 'unread' : ''}">
          <span class="unread-dot ${e.isRead ? 'read' : ''}"></span>
          <div class="inbox-row-body">
            <div class="inbox-row-top">
              <span class="inbox-sender">${esc(e.sender.name || e.sender.email || 'Unknown')}</span>
              <span class="inbox-time">${e.receivedAt ? new Date(e.receivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
            </div>
            <div class="inbox-subject">${esc(e.subject || '(no subject)')}${e.hasAttachments ? ' 📎' : ''}</div>
            <div class="inbox-preview">${esc(e.preview || '')}</div>
          </div>
        </div>`).join('') || '<p class="muted small">This folder is empty.</p>'}`;
    $$(`.inbox-results[data-inbox-mailbox="${mailboxKey}"] .reload-inbox-btn`).forEach(btn =>
      btn.addEventListener('click', () => loadInbox(mailboxKey, btn.dataset.folder)));
  } catch (err) {
    container.innerHTML = `<p class="muted small">Error: ${esc(err.message)}</p>`;
  }
}

let lastAlertLevel = null;
let meetingAlertInterval = null;

function checkMeetingAlerts() {
  let topLevel = null;
  let topSubject = '';

  // Patch per-card badges without re-rendering the list
  $$('#meetings-lyndsay-today .meeting-card').forEach(card => {
    const { level, mins } = meetingUrgency(card.dataset.start);
    const subject = card.dataset.subject || '';

    const badge = card.querySelector('.meeting-urgency-badge');
    if (badge) {
      if (level === 'now') {
        badge.innerHTML = ' <span class="badge badge-red meeting-badge-blink">🔴 NOW</span>';
      } else if (level === 'soon') {
        badge.innerHTML = ` <span class="badge badge-yellow">⚡ ${mins}m</span>`;
      } else {
        badge.innerHTML = '';
      }
    }

    // Show/hide action buttons
    const actionBtns = card.querySelector('.meeting-action-btns');
    if (actionBtns) {
      if (level && !actionBtns.querySelector('.alert-sent-btn')) {
        actionBtns.innerHTML = `
          <button class="btn-sm alert-sent-btn">✅ Reminder Sent</button>
          <button class="btn-sm alert-called-btn">📞 Called 3x</button>`;
        actionBtns.querySelector('.alert-sent-btn').addEventListener('click', () =>
          toast(`Reminder sent for: ${subject}`, 'success'));
        actionBtns.querySelector('.alert-called-btn').addEventListener('click', () =>
          toast(`Logged: Called 3x for ${subject}`, 'success'));
      } else if (!level) {
        actionBtns.innerHTML = '';
      }
    }

    if (level === 'now' && topLevel !== 'now') { topLevel = 'now'; topSubject = subject; }
    if (level === 'soon' && !topLevel) { topLevel = 'soon'; topSubject = subject; }
  });

  // Top banner — injected above #meetings-lyndsay-today if not already there
  let banner = $('#meeting-time-alert');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'meeting-time-alert';
    const target = $('#meetings-lyndsay-today');
    if (target) target.parentNode.insertBefore(banner, target);
  }

  if (topLevel === 'now') {
    banner.className = 'meeting-alert-now';
    banner.innerHTML = `🔴 <b>NOW — ${esc(topSubject)}</b> is starting right now`;
  } else if (topLevel === 'soon') {
    banner.className = 'meeting-alert-soon';
    banner.innerHTML = `⚠ <b>Starting Soon:</b> ${esc(topSubject)}`;
  } else {
    banner.className = '';
    banner.innerHTML = '';
  }

  if (topLevel && topLevel !== lastAlertLevel) playAlertSound(topLevel);
  lastAlertLevel = topLevel;
}

async function loadEmail() {
  const status = await api('/api/email/refresh-status');
  const fmt = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  if (!status.configured) {
    $('#refresh-status').innerHTML = `Graph API not configured yet — background job runs every ${status.intervalMinutes} min but stays in stub mode. Last check: ${fmt(status.lastRun)}.`;
    $('#connect-graph-btn').classList.add('hidden');
  } else if (status.authRequired) {
    $('#refresh-status').innerHTML = `Graph API configured — Microsoft account not connected yet.`;
    $('#connect-graph-btn').classList.remove('hidden');
  } else {
    $('#refresh-status').innerHTML = `Last refreshed: <b>${fmt(status.lastRun)}</b> · Next refresh: <b>${fmt(status.nextRun)}</b> (every ${status.intervalMinutes} min)`;
    $('#connect-graph-btn').classList.add('hidden');
  }

  // Inbox unread counts — refreshed by the same cron cycle as the calendar,
  // exposed separately so staleness of the *email* check is visible even if
  // the calendar refresh looks fine.
  try {
    const counts = await api('/api/email/inbox-counts');
    const checkEl = $('#email-check-status');
    if (!counts.lastChecked) {
      checkEl.textContent = '';
    } else {
      const staleMs = Date.now() - new Date(counts.lastChecked).getTime();
      const stale = staleMs > 20 * 60 * 1000;
      checkEl.innerHTML = `Last email check: <b>${fmt(counts.lastChecked)}</b>` + (stale ? ' <span class="badge badge-red">⚠ stale — over 20 min ago</span>' : '');

      const arturoBadge = $('#arturo-unread-badge');
      if (counts.arturo?.unread > 0) { arturoBadge.textContent = `${counts.arturo.unread} unread`; arturoBadge.classList.remove('hidden'); }
      else arturoBadge.classList.add('hidden');

      const lyndsayBadge = $('#lyndsay-unread-badge');
      if (counts.lyndsay?.unread > 0) { lyndsayBadge.textContent = `${counts.lyndsay.unread} unread`; lyndsayBadge.classList.remove('hidden'); }
      else lyndsayBadge.classList.add('hidden');
    }
  } catch { /* leave whatever was last shown */ }

  try { await loadInboxTracking(); } catch { /* leave whatever was last shown */ }

  const cal = await api('/api/calendar/today');
  const arturoToday = (cal.arturo || []).filter(m => m.day !== 'tomorrow');
  $('#meetings-arturo-today').innerHTML = renderMeetings(arturoToday, false);

  const lyndsayAll = cal.lyndsay || [];
  lyndsayTodayCache = lyndsayAll.filter(m => m.day !== 'tomorrow');
  lyndsayTomorrowCache = lyndsayAll.filter(m => m.day === 'tomorrow');

  // Pull meetings from support@ calendar where Lyndsay is an attendee.
  // Three-variant matching because Graph API attendee shape varies by endpoint.
  const isLyndsayAttendee = a => {
    if (typeof a === 'string') {
      const s = a.toLowerCase();
      return s.includes('lyndsay') || s === 'all metric';
    }
    const email = (a.email || a.emailAddress?.address || '').toLowerCase();
    const name  = (a.name  || a.emailAddress?.name  || '').toLowerCase();
    return email === 'lyndsay@metricpropertymanagement.com' ||
           name.includes('lyndsay') ||
           name === 'all metric';
  };
  const existingKeys = new Set(lyndsayTodayCache.map(m => m.start + m.subject));
  arturoToday.forEach(m => {
    if ((m.attendees || []).some(isLyndsayAttendee) && !existingKeys.has(m.start + m.subject)) {
      lyndsayTodayCache.push({ ...m, _crossCal: true });
      existingKeys.add(m.start + m.subject);
    }
  });

  $('#meetings-lyndsay-today').innerHTML = renderMeetings(lyndsayTodayCache, true);
  $$('#meetings-lyndsay-today .add-reminder-btn').forEach(btn =>
    btn.addEventListener('click', () => addReminderForMeeting(lyndsayTodayCache[+btn.dataset.idx])));
  checkMeetingAlerts();
  if (!meetingAlertInterval) meetingAlertInterval = setInterval(checkMeetingAlerts, 60_000);

  $('#tomorrow-section').classList.toggle('hidden', lyndsayTomorrowCache.length === 0);
  $('#meetings-lyndsay-tomorrow').innerHTML = renderMeetings(lyndsayTomorrowCache, true);
  $$('#meetings-lyndsay-tomorrow .add-reminder-btn').forEach(btn =>
    btn.addEventListener('click', () => addReminderForMeeting(lyndsayTomorrowCache[+btn.dataset.idx])));

  const flagged = await api('/api/email/flagged-for-lyndsay');
  $('#flagged-list').innerHTML = flagged.map(f => `
    <div class="card" style="margin-bottom:8px">
      <div class="card-title" style="font-size:13.5px">${esc(f.subject)}</div>
      <div class="card-meta"><span class="badge badge-gray">${esc(f.mailbox)}</span><span>from ${esc(f.sender)}</span></div>
      <div class="card-actions"><button class="btn-sm" data-flag-id="${f.id}">Mark handled</button></div>
    </div>`).join('') || '<p class="muted small">Nothing flagged.</p>';
  $$('[data-flag-id]').forEach(btn => btn.addEventListener('click', () => markHandled(btn.dataset.flagId)));

  const queue = await api('/api/lyndsay-queue');
  const pending = queue.filter(q => !q.sent);
  const sentToday = queue.filter(q => q.sent);

  const pendingCardHtml = q => `
    <div class="card queue-item" style="margin-bottom:8px" data-msg-id="${q.id}">
      <div class="queue-text">
        ${q.meetingTitle ? `<div class="muted small mono">🕐 ${formatDualTime(q.meetingTime)} — ${esc(q.meetingTitle)}</div>` : ''}
        <div style="white-space:pre-wrap">${esc(q.text)}</div>
        <div class="card-meta">${q.reason ? `<span class="muted small">${esc(q.reason)}</span>` : ''}</div>
      </div>
      <div class="card-actions" style="flex-direction:column;align-items:stretch">
        <button class="btn-sm copy-btn" data-copy="${encodeURIComponent(q.text)}">📋 Copy</button>
        <button class="btn-sm" data-mark-sent="${q.id}">✓ Mark sent</button>
      </div>
    </div>`;

  const sentCardHtml = q => `
    <div class="card queue-item" style="margin-bottom:8px;opacity:0.5" data-msg-id="${q.id}">
      <div class="queue-text">
        ${q.meetingTitle ? `<div class="muted small mono">🕐 ${formatDualTime(q.meetingTime)} — ${esc(q.meetingTitle)}</div>` : ''}
        <div style="white-space:pre-wrap">${esc(q.text)}</div>
        <div class="card-meta">${q.reason ? `<span class="muted small">${esc(q.reason)}</span>` : ''}<span class="badge badge-green">✅ sent</span></div>
      </div>
    </div>`;

  $('#queue-list').innerHTML = `
    <div class="queue-section-header">PENDING REMINDERS (${pending.length})</div>
    ${pending.length ? pending.map(pendingCardHtml).join('') : '<p class="muted small">✅ No pending reminders — you\'re all caught up!</p>'}
    ${sentToday.length ? `
      <div class="queue-section-header queue-collapsible-header" id="sent-today-toggle" style="cursor:pointer;margin-top:16px">
        <span id="sent-today-caret">▶</span> SENT TODAY (${sentToday.length})
      </div>
      <div id="sent-today-body" style="display:none">
        ${sentToday.map(sentCardHtml).join('')}
      </div>` : ''}
  `;
  $$('[data-copy]').forEach(btn => btn.addEventListener('click', () => {
    copyToClipboard(decodeURIComponent(btn.dataset.copy));
    const original = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = original; }, 2000);
  }));
  $$('[data-mark-sent]').forEach(btn => btn.addEventListener('click', () => markMessageSent(btn.dataset.markSent)));
  const sentToggle = $('#sent-today-toggle');
  if (sentToggle) {
    sentToggle.addEventListener('click', () => {
      const body = $('#sent-today-body');
      const caret = $('#sent-today-caret');
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'block' : 'none';
      caret.textContent = isHidden ? '▼' : '▶';
    });
  }
}

async function markMessageSent(id) {
  await api(`/api/lyndsay-queue/${id}/sent`, { method: 'POST' });
  loadEmail();
  updateReminderAlerts();
}

async function markHandled(id) {
  await api(`/api/email/${id}/handled`, { method: 'POST' });
  loadEmail();
}

$('#refresh-now-btn').addEventListener('click', async () => {
  const btn = $('#refresh-now-btn');
  btn.disabled = true; btn.textContent = 'Refreshing...';
  try {
    await api('/api/email/refresh-now', { method: 'POST' });
    toast('Refresh triggered', 'success');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔄 Refresh Now'; loadEmail(); }
});

// =====================================================================
// END OF DAY — formatted report
// =====================================================================

async function loadEod() {
  const s = await api('/api/summary');
  $('#eod-date').textContent = `Date: ${s.date} · Generated: ${new Date(s.generatedAt).toLocaleString()}`;

  const list = (items, empty) => items.length
    ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`
    : `<p class="summary-empty">${empty}</p>`;

  const priorities = s.topPriorities.length
    ? s.topPriorities.map((p, i) => `
        <div class="priority-item">
          <span class="priority-rank">${i + 1}</span>
          <div><b>[${esc(p.source)}]</b> ${esc(p.label)} — <span class="muted">${esc(p.reason)}</span></div>
        </div>`).join('')
    : '<p class="summary-empty">Nothing urgent flagged for tomorrow.</p>';

  $('#eod-output').innerHTML = `
    <div class="summary-grid">
      <div class="summary-card top-priorities">
        <h4>🎯 Top Priorities for Tomorrow</h4>
        ${priorities}
      </div>
      <div class="summary-card completed">
        <h4>✅ Completed Today</h4>
        ${list(s.tasks.completedToday.map(t => `${esc(t.title)} <span class="muted small">(${esc(t.type)})</span>`), 'Nothing completed yet today.')}
      </div>
      <div class="summary-card open">
        <h4>📋 Still Open</h4>
        ${list(s.tasks.open.map(t => `${esc(t.priority)} ${esc(t.title)} <span class="muted small">(${esc(t.type)})</span>`), 'Nothing open — clean slate.')}
      </div>
      <div class="summary-card meetings-arturo">
        <h4>📅 Meetings — Arturo</h4>
        ${list(s.meetings.arturo.map(m => `<span class="mono">${formatDualTime(m.start)}</span> — ${esc(m.subject)} <span class="muted small">(${esc(m.platform)})</span>${m.conflict ? ' ⚠' : ''}`), 'No meetings.')}
      </div>
      <div class="summary-card meetings-lyndsay">
        <h4>📅 Meetings — Lyndsay</h4>
        ${list(s.meetings.lyndsay.map(m => `<span class="mono">${formatDualTime(m.start)}</span> — ${esc(m.subject)} <span class="muted small">(${esc(m.platform)})</span>${m.conflict ? ' ⚠' : ''}`), 'No meetings.')}
      </div>
      <div class="summary-card flagged">
        <h4>🚩 Flagged for Lyndsay</h4>
        ${list(s.flaggedForLyndsay.map(f => `[${esc(f.mailbox)}] ${esc(f.subject)} — from ${esc(f.sender)}`), 'Nothing still flagged.')}
      </div>
    </div>`;
}

$('#eod-refresh').addEventListener('click', loadEod);
$('#eod-copy').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/summary/text');
    const text = await res.text();
    copyToClipboard(text);
  } catch { toast('Could not fetch summary text', 'error'); }
});

// ---- Pending reminder alerts (sidebar badge, banner, tab title) --------------
// Runs independently of loadEmail() so the alert stays live even when Arturo
// is on a different tab (Tasks, SOPs, etc.) — that's the whole point.
const BASE_TITLE = document.title;
async function updateReminderAlerts() {
  let queue;
  try {
    queue = await api('/api/lyndsay-queue');
  } catch {
    return; // dashboard unreachable — leave whatever was last shown
  }
  const pending = queue.filter(q => !q.sent).length;

  const badge = $('#reminder-badge');
  if (pending > 0) { badge.textContent = String(pending); badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const banner = $('#reminder-alert-banner');
  if (pending > 0) {
    $('#reminder-alert-count').textContent = String(pending);
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  document.title = pending > 0 ? `(${pending}) ${BASE_TITLE}` : BASE_TITLE;
}
updateReminderAlerts();
setInterval(updateReminderAlerts, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// BD CRM Phase 2 module
// ═══════════════════════════════════════════════════════════════════════════

const crmState = {
  // Property list
  page: 1, limit: 50, total: 0, pages: 0,
  search: '', submarket: '', assigned_to: '', rop_status: '', asset_class: '',
  mgmt_type: '', sort: 'score',
  // Active view & modal
  view: 'dashboard',
  agent: 'Lyndsay',
  // Active property in modal
  activeProperty: null,
  activeModalTab: 'overview',
  // DM review in-progress scores
  dmScores: { website: {}, floorplan: {}, gbp: {}, facebook: {}, ils: {} },
};

async function crmFetch(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

function crmBuildQuery() {
  const p = new URLSearchParams({
    page: crmState.page, limit: crmState.limit,
    ...(crmState.search      && { search:      crmState.search }),
    ...(crmState.submarket   && { submarket:    crmState.submarket }),
    ...(crmState.assigned_to && { assigned_to:  crmState.assigned_to }),
    ...(crmState.rop_status  && { rop_status:   crmState.rop_status }),
    ...(crmState.asset_class && { asset_class:  crmState.asset_class }),
    ...(crmState.mgmt_type   && { mgmt_type:    crmState.mgmt_type }),
  });
  return `/api/crm/properties?${p}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtCurrency(v) {
  if (v == null) return '—';
  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtPct(v) { return v == null ? '—' : Number(v).toFixed(1) + '%'; }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }

function crmScoreBadge(score) {
  if (score == null) return `<div class="crm-score-badge score-none">—</div>`;
  const cls = score >= 8 ? 'score-high' : score >= 6 ? 'score-med' : score >= 4 ? 'score-low' : 'score-min';
  return `<div class="crm-score-badge ${cls}">${score}</div>`;
}

function crmMgmtPill(t) {
  if (!t) return '<span class="crm-mgmt-pill crm-mgmt-unknown">—</span>';
  const cls = t === 'third-party' ? 'crm-mgmt-third' : t === 'owner-managed' ? 'crm-mgmt-owner' : 'crm-mgmt-unknown';
  return `<span class="crm-mgmt-pill ${cls}">${esc(t)}</span>`;
}

function computeLeadScore(p) {
  if (p.lead_score_override) return { score: p.lead_score_override, breakdown: ['Manual override'] };
  let s = 0; const b = [];
  const vac = parseFloat(p.vacancy_pct);
  if (!isNaN(vac)) {
    if (vac > 30) { s += 4; b.push('Vacancy > 30% (+4)'); }
    else if (vac > 19) { s += 3; b.push('Vacancy 20-30% (+3)'); }
    else if (vac > 11) { s += 2; b.push('Vacancy 12-19% (+2)'); }
    else if (vac > 7)  { s += 1; b.push('Vacancy 8-11% (+1)'); }
  }
  const yr = parseInt(p.year_built);
  if (!isNaN(yr)) {
    const age = new Date().getFullYear() - yr;
    if (age >= 40) { s += 1.5; b.push('Age ≥ 40 yrs (+1.5)'); }
    else if (age >= 20) { s += 0.75; b.push('Age 20-39 yrs (+0.75)'); }
  }
  if (p.asset_class === 'C') { s += 1; b.push('Class C (+1)'); }
  else if (p.asset_class === 'B') { s += 0.5; b.push('Class B (+0.5)'); }
  return { score: Math.min(10, Math.max(1, Math.round(s * 10) / 10)), breakdown: b };
}

// ── View switching ────────────────────────────────────────────────────────────
function crmSetView(view) {
  crmState.view = view;
  $$('.crm-view').forEach(el => el.classList.add('hidden'));
  $(`#crm-view-${view}`)?.classList.remove('hidden');
  $$('.crm-nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.crmView === view));
  if (view === 'tasks') crmLoadTasks();
  if (view === 'drafts') crmLoadDraftsList();
}

$$('.crm-nav-btn').forEach(btn =>
  btn.addEventListener('click', () => crmSetView(btn.dataset.crmView))
);

$('#crm-agent-select').addEventListener('change', e => { crmState.agent = e.target.value; });

function crmApplyUserRole() {
  const sel = $('#crm-agent-select');
  if (!sel || !currentUser) return;
  const lockedRoles = ['bd_agent', 'maintenance'];
  if (lockedRoles.includes(currentUser.role) && currentUser.agentName) {
    sel.value = currentUser.agentName;
    crmState.agent = currentUser.agentName;
    sel.disabled = true;
  }
}

// ── KPI bar ───────────────────────────────────────────────────────────────────
function crmRenderKPI(data) {
  const props = data.properties || [];
  const total = data.total || 0;
  const hotLeads = props.filter(p => (p.lead_score_override || 0) >= 7).length;
  const withVac = props.filter(p => p.vacancy_pct != null);
  const avgVac = withVac.length ? (withVac.reduce((s, p) => s + Number(p.vacancy_pct), 0) / withVac.length) : null;
  $('#crm-kpi-bar').innerHTML = `
    <div class="crm-kpi"><span class="crm-kpi-num">${total.toLocaleString()}</span><span class="crm-kpi-label">Properties</span></div>
    <div class="crm-kpi"><span class="crm-kpi-num">${props.filter(p => p.management_type === 'third-party').length}</span><span class="crm-kpi-label">Active Leads</span></div>
    <div class="crm-kpi"><span class="crm-kpi-num">${hotLeads}</span><span class="crm-kpi-label">Hot Leads (7+)</span></div>
    <div class="crm-kpi"><span class="crm-kpi-num">${avgVac != null ? avgVac.toFixed(1) + '%' : '—'}</span><span class="crm-kpi-label">Avg Vacancy</span></div>
  `;
}

// ── Property table ────────────────────────────────────────────────────────────
function crmRenderTable(properties) {
  const tbody = $('#crm-tbody');
  const empty = $('#crm-empty');
  if (!properties.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  tbody.innerHTML = properties.map(p => {
    const { score } = computeLeadScore(p);
    const agents = [
      p.phone_assignee      ? `📞 ${esc(p.phone_assignee)}` : '',
      p.online_dm_assignee  ? `💻 ${esc(p.online_dm_assignee)}` : '',
    ].filter(Boolean).join('<br>');
    return `<tr class="crm-row" data-id="${esc(p.id)}">
      <td>${crmScoreBadge(score)}</td>
      <td><div class="crm-prop-name">${esc(p.property_name||'—')}</div><div class="crm-address">${esc([p.city,p.zip].filter(Boolean).join(', '))}</div></td>
      <td>${esc(p.submarket||'—')}</td>
      <td><span class="crm-class crm-class-${(p.asset_class||'').toLowerCase()}">${esc(p.asset_class||'—')}</span></td>
      <td class="mono">${p.units??'—'}</td>
      <td class="mono">${fmtPct(p.vacancy_pct)}</td>
      <td class="mono">${fmtCurrency(p.avg_asking_unit)}</td>
      <td>${crmMgmtPill(p.management_type)}</td>
      <td>${esc(p.management_company||'—')}</td>
      <td class="crm-agents-cell">${agents||'—'}</td>
      <td><span class="crm-status-badge">${esc(p.rop_status||'—')}</span></td>
    </tr>`;
  }).join('');
  $$('#crm-tbody .crm-row').forEach(row =>
    row.addEventListener('click', () => crmOpenModal(row.dataset.id))
  );
}

function crmRenderPagination() {
  const el = $('#crm-pagination');
  if (crmState.pages <= 1) { el.innerHTML = ''; return; }
  const start = (crmState.page - 1) * crmState.limit + 1;
  const end = Math.min(crmState.page * crmState.limit, crmState.total);
  el.innerHTML = `
    <button class="btn-sm" id="crm-prev" ${crmState.page === 1 ? 'disabled' : ''}>← Prev</button>
    <span class="crm-page-info">${start}–${end} of ${crmState.total.toLocaleString()}</span>
    <button class="btn-sm" id="crm-next" ${crmState.page >= crmState.pages ? 'disabled' : ''}>Next →</button>
  `;
  $('#crm-prev')?.addEventListener('click', () => { crmState.page--; crmLoadProperties(); });
  $('#crm-next')?.addEventListener('click', () => { crmState.page++; crmLoadProperties(); });
}

async function crmLoadProperties() {
  $('#crm-status-line').textContent = 'Loading…';
  try {
    const data = await crmFetch(crmBuildQuery());
    if (data.error) { $('#crm-status-line').textContent = `❌ ${data.error}`; return; }
    crmState.total = data.total; crmState.pages = data.pages;
    $('#crm-status-line').textContent = `${data.total.toLocaleString()} properties · page ${data.page}/${data.pages}`;
    crmRenderKPI(data);
    crmRenderTable(data.properties);
    crmRenderPagination();
  } catch (err) {
    $('#crm-status-line').textContent = `❌ ${err.message}`;
  }
}

async function crmLoadMeta() {
  try {
    const meta = await crmFetch('/api/crm/meta');
    const populate = (selectId, values) => {
      const sel = $(selectId);
      if (!sel) return;
      const cur = sel.value;
      const first = sel.options[0]?.text || '';
      sel.innerHTML = `<option value="">${first}</option>` +
        values.filter(Boolean).map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
    };
    populate('#crm-filter-submarket', meta.submkts || []);
    populate('#crm-filter-assigned',  meta.assignees || []);
  } catch {}
}

// ── Property modal ────────────────────────────────────────────────────────────
async function crmOpenModal(id) {
  const modal = $('#crm-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#crm-modal-name').textContent = 'Loading…';
  $('#crm-modal-address').textContent = '';
  $('#crm-modal-score-badge').textContent = '…';
  $('#crm-modal-score-badge').className = 'crm-score-badge score-none';

  try {
    const p = await crmFetch(`/api/crm/properties/${id}`);
    if (p.error) { showToast('Error: ' + p.error, 'error'); crmCloseModal(); return; }
    crmState.activeProperty = p;
    crmRenderModalHeader(p);
    crmSwitchModalTab('overview');
  } catch (err) {
    showToast('Failed to load property: ' + err.message, 'error');
    crmCloseModal();
  }
}

function crmCloseModal() {
  $('#crm-modal').classList.add('hidden');
  document.body.style.overflow = '';
  crmState.activeProperty = null;
}

function crmRenderModalHeader(p) {
  const { score } = computeLeadScore(p);
  const badge = $('#crm-modal-score-badge');
  badge.textContent = score ?? '—';
  badge.className = 'crm-score-badge ' + (score >= 8 ? 'score-high' : score >= 6 ? 'score-med' : score >= 4 ? 'score-low' : score ? 'score-min' : 'score-none');
  $('#crm-modal-name').textContent = p.property_name || '—';
  $('#crm-modal-address').textContent = [p.address, p.city, p.zip].filter(Boolean).join(', ');
}

function crmSwitchModalTab(tab) {
  crmState.activeModalTab = tab;
  $$('.crm-modal-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.modalTab === tab));
  $$('.crm-modal-pane').forEach(pane => pane.classList.toggle('hidden', pane.id !== `crm-mtab-${tab}`));
  const p = crmState.activeProperty;
  if (!p) return;
  if (tab === 'overview')     crmRenderOverview(p);
  if (tab === 'phone')        crmRenderPhoneList(p.phone_shops);
  if (tab === 'online')       crmRenderOnlineList(p.online_shops);
  if (tab === 'appointments') crmRenderApptList(p.appointments);
  if (tab === 'followups')    crmRenderFUList(p.follow_ups);
  if (tab === 'inspection')   crmRenderInspList(p.inspections);
  if (tab === 'dm')           crmRenderDM(p.dm_review);
  if (tab === 'outreach')     crmRenderOutreach(p);
  if (tab === 'history')      crmRenderHistory(p.id);
}

$$('.crm-modal-tab').forEach(btn =>
  btn.addEventListener('click', () => crmSwitchModalTab(btn.dataset.modalTab))
);
$('#crm-modal-close').addEventListener('click', crmCloseModal);
$('#crm-modal-overlay').addEventListener('click', crmCloseModal);

// ── Overview tab ──────────────────────────────────────────────────────────────
function crmRenderOverview(p) {
  // Fill all data-field inputs/selects/textareas
  $$('.crm-editable').forEach(el => {
    const f = el.dataset.field;
    if (!f) return;
    if (el.type === 'checkbox') { el.checked = !!p[f]; return; }
    el.value = p[f] ?? '';
  });
  // Lead score
  const { score, breakdown } = computeLeadScore(p);
  const large = $('#crm-modal-score-large');
  large.textContent = score ?? '—';
  large.className = 'crm-score-large ' + (score >= 8 ? 'score-high' : score >= 6 ? 'score-med' : score >= 4 ? 'score-low' : score ? 'score-min' : 'score-none');
  $('#crm-score-breakdown').innerHTML = breakdown.map(b => `• ${esc(b)}`).join('<br>');
  // Record info
  $('#crm-info-id').textContent = p.id;
  $('#crm-info-created').textContent = fmtDate(p.created_at);
  $('#crm-info-updated').textContent = fmtDate(p.updated_at);
  // Lyndsay checkbox
  $('#crm-lyndsay-reviewed').checked = !!p.lyndsay_reviewed;
  // Save button
  $('#crm-overview-save').onclick = () => crmSaveOverview(p.id);
}

async function crmSaveOverview(id) {
  const statusEl = $('#crm-overview-save-status');
  statusEl.textContent = 'Saving…';
  const updates = {};
  $$('.crm-editable').forEach(el => {
    if (!el.dataset.field) return;
    updates[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value || null;
  });
  updates.lyndsay_reviewed = $('#crm-lyndsay-reviewed').checked;
  try {
    const result = await crmFetch(`/api/crm/properties/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (result.error) throw new Error(result.error);
    Object.assign(crmState.activeProperty, result);
    crmRenderModalHeader(result);
    statusEl.textContent = '✅ Saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
  }
}

// ── Phone shop tab ────────────────────────────────────────────────────────────
function crmRenderPhoneList(shops) {
  const connLabel = { answered_agent: 'Answered', answered_ai: 'AI/Service', voicemail: 'Voicemail', no_answer: 'No Answer', wrong_number: 'Wrong #' };
  const connCls   = { answered_agent: 'conn-answered', answered_ai: 'conn-answered', voicemail: 'conn-voicemail', no_answer: 'conn-noanswer', wrong_number: 'conn-noanswer' };
  $('#crm-phone-count').textContent = `${shops.length} call(s) logged`;
  $('#crm-phone-list').innerHTML = shops.length ? shops.map(s => `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span class="crm-entry-meta">${fmtDate(s.shop_date)} · ${esc(s.agent_name||'—')}</span>
        <span class="crm-connection-badge ${connCls[s.notes?.connection] || 'conn-noanswer'}">${esc(s.notes?.connection ? connLabel[s.notes.connection] : '—')}</span>
      </div>
      ${s.score != null ? `<span class="crm-entry-meta">Score: ${s.score}</span>` : ''}
      ${s.notes ? `<p class="small" style="margin-top:4px;">${esc(s.notes)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No calls logged yet.</p>';
}

$('#crm-phone-add-btn').addEventListener('click', () => {
  $('#crm-phone-form').classList.toggle('hidden');
});
$('#crm-phone-cancel').addEventListener('click', () => $('#crm-phone-form').classList.add('hidden'));
$('#crm-phone-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = {
    shop_date: $('#pf-date').value || new Date().toISOString().slice(0,10),
    agent_name: $('#pf-agent').value,
    score: parseFloat($('#pf-score').value) || null,
    notes: JSON.stringify({ connection: $('#pf-connection').value, text: $('#pf-notes').value }),
  };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/phone-shops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderPhoneList(updated.phone_shops);
    $('#crm-phone-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Online shop tab ───────────────────────────────────────────────────────────
function crmRenderOnlineList(shops) {
  $('#crm-online-list').innerHTML = shops.length ? shops.map(s => `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span class="crm-entry-meta">${fmtDate(s.shop_date)} · ${esc(s.agent_name||'—')}</span>
        ${s.score != null ? `<span class="crm-entry-meta">Score: ${s.score}</span>` : ''}
      </div>
      ${s.platform ? `<div class="small">${esc(s.platform)}</div>` : ''}
      ${s.notes ? `<p class="small" style="margin-top:4px;">${esc(s.notes)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No online shops yet.</p>';
}

$('#crm-online-add-btn').addEventListener('click', () => $('#crm-online-form').classList.toggle('hidden'));
$('#crm-online-cancel').addEventListener('click', () => $('#crm-online-form').classList.add('hidden'));
$('#crm-online-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = { shop_date: $('#of-date').value || new Date().toISOString().slice(0,10), agent_name: $('#of-agent').value, platform: $('#of-platform').value, score: parseFloat($('#of-score').value) || null, notes: $('#of-notes').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/online-shops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderOnlineList(updated.online_shops);
    $('#crm-online-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Appointments tab ──────────────────────────────────────────────────────────
function crmRenderApptList(appts) {
  const statusLabel = { scheduled: '📅 Scheduled', completed: '✅ Completed', no_show: '❌ No Show', cancelled: '🚫 Cancelled', missed_follow_up: '⚠️ Missed Follow-Up' };
  $('#crm-appt-list').innerHTML = appts.length ? appts.map(a => `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span>${esc(statusLabel[a.status] || a.status)}</span>
        <span class="crm-entry-meta">${fmtDateTime(a.appointment_at)}</span>
      </div>
      ${a.agent_name ? `<div class="small">Agent: ${esc(a.agent_name)}</div>` : ''}
      ${a.outcome ? `<p class="small" style="margin-top:4px;">${esc(a.outcome)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No appointments logged.</p>';
}

$('#crm-appt-add-btn').addEventListener('click', () => $('#crm-appt-form').classList.toggle('hidden'));
$('#crm-appt-cancel').addEventListener('click', () => $('#crm-appt-form').classList.add('hidden'));
$('#crm-appt-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = { appointment_at: $('#af-datetime').value || null, agent_name: $('#af-agent').value, status: $('#af-status').value, outcome: $('#af-notes').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/appointments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderApptList(updated.appointments);
    $('#crm-appt-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Follow-ups tab ────────────────────────────────────────────────────────────
function crmRenderFUList(fus) {
  const methodLabel = { call_back: '📞 Call Back', email_response: '📧 Email Response', text: '💬 Text', owner_response: '🔥 Owner Responded' };
  $('#crm-fu-list').innerHTML = fus.length ? fus.map(f => `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span>${esc(methodLabel[f.method] || f.method)}</span>
        <span class="crm-entry-meta">${fmtDate(f.follow_up_date)}</span>
      </div>
      ${f.outcome ? `<p class="small" style="margin-top:4px;">${esc(f.outcome)}</p>` : ''}
      ${f.next_action ? `<p class="small muted">Next: ${esc(f.next_action)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No follow-ups logged.</p>';
}

$('#crm-fu-add-btn').addEventListener('click', () => $('#crm-fu-form').classList.toggle('hidden'));
$('#crm-fu-cancel').addEventListener('click', () => $('#crm-fu-form').classList.add('hidden'));
$('#crm-fu-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = { method: $('#ff-method').value, follow_up_date: $('#ff-date').value || new Date().toISOString().slice(0,10), completed: $('#ff-completed').value === 'true', outcome: $('#ff-outcome').value, next_action: $('#ff-next').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/follow-ups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderFUList(updated.follow_ups);
    $('#crm-fu-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Inspection tab ────────────────────────────────────────────────────────────
function crmRenderInspList(insps) {
  $('#crm-insp-list').innerHTML = insps.length ? insps.map(i => `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span class="crm-entry-meta">${fmtDate(i.visited_date)}</span>
        ${i.building_condition ? `<span class="crm-connection-badge conn-answered">${esc(i.building_condition)}</span>` : ''}
      </div>
      <div class="small">
        ${i.office_open != null ? `Office open: ${i.office_open ? 'Yes' : 'No'}` : ''}
        ${i.rop_sign_posted != null ? ` · ROP sign: ${i.rop_sign_posted ? 'Yes' : 'No'}` : ''}
      </div>
      ${i.notes ? `<p class="small" style="margin-top:4px;">${esc(i.notes)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No inspections logged.</p>';
}

$('#crm-insp-add-btn').addEventListener('click', () => $('#crm-insp-form').classList.toggle('hidden'));
$('#crm-insp-cancel').addEventListener('click', () => $('#crm-insp-form').classList.add('hidden'));
$('#crm-insp-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const boolField = id => { const v = $(id).value; return v === '' ? null : v === 'true'; };
  const body = { visited_date: $('#if-date').value || null, office_open: boolField('#if-office'), building_condition: $('#if-building').value || null, grounds_condition: $('#if-grounds').value || null, rop_sign_posted: boolField('#if-rop'), phone_test_result: $('#if-phone').value || null, notes: $('#if-notes').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/inspections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderInspList(updated.inspections);
    $('#crm-insp-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── DM Review tab ─────────────────────────────────────────────────────────────
function crmRenderDM(dmReview) {
  if (dmReview) {
    crmState.dmScores = {
      website:   dmReview.website_scores   || {},
      floorplan: dmReview.floorplan_scores || {},
      gbp:       dmReview.gbp_scores       || {},
      facebook:  dmReview.facebook_scores  || {},
      ils:       dmReview.ils_scores       || {},
    };
    $('#crm-dm-audit-notes').value = dmReview.audit_notes || '';
  } else {
    crmState.dmScores = { website: {}, floorplan: {}, gbp: {}, facebook: {}, ils: {} };
  }
  crmInitDMPickers();
  crmUpdateDMOverall();
}

function crmInitDMPickers() {
  const GRADE_LABELS = ['N/A', 'Liability', 'Poor', 'Fair', 'Good', 'Great'];
  $$('.crm-grade-picker').forEach(el => {
    const { section, key } = el.dataset;
    const current = crmState.dmScores[section]?.[key];
    el.innerHTML = GRADE_LABELS.map((lbl, i) =>
      `<button class="crm-grade-btn ${current === i ? 'active' : ''}" data-val="${i}">${lbl}</button>`
    ).join('');
    el.querySelectorAll('.crm-grade-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        crmState.dmScores[section] = crmState.dmScores[section] || {};
        crmState.dmScores[section][key] = parseInt(btn.dataset.val);
        el.querySelectorAll('.crm-grade-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        crmUpdateDMOverall();
      })
    );
  });
  $$('.crm-yn-picker').forEach(el => {
    const { section, key } = el.dataset;
    const current = crmState.dmScores[section]?.[key];
    el.innerHTML = `
      <button class="crm-yn-btn ${current === 5 ? 'active-yes' : ''}" data-val="5">Yes</button>
      <button class="crm-yn-btn ${current === 0 ? 'active-no' : ''}" data-val="0">No</button>`;
    el.querySelectorAll('.crm-yn-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        crmState.dmScores[section] = crmState.dmScores[section] || {};
        crmState.dmScores[section][key] = parseInt(btn.dataset.val);
        el.querySelectorAll('.crm-yn-btn').forEach(b => b.classList.remove('active-yes', 'active-no'));
        btn.classList.add(parseInt(btn.dataset.val) === 5 ? 'active-yes' : 'active-no');
        crmUpdateDMOverall();
      })
    );
  });
}

function crmUpdateDMOverall() {
  const all = Object.values(crmState.dmScores).flatMap(s => Object.values(s || {})).filter(v => typeof v === 'number');
  const maxPerItem = 5;
  const pct = all.length ? Math.round((all.reduce((a, b) => a + b, 0) / (all.length * maxPerItem)) * 100) : null;
  $('#crm-dm-overall').textContent = pct != null ? `DM Score: ${pct}%` : '—';
}

$('#crm-dm-save-btn').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  try {
    await crmFetch(`/api/crm/properties/${p.id}/dm-review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...crmState.dmScores, audit_notes: $('#crm-dm-audit-notes').value }),
    });
    showToast('DM Review saved ✅', 'success');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Outreach tab ──────────────────────────────────────────────────────────────
function crmRenderOutreach(p) {
  // ── Dossier grid: key data fields ──
  const dossierFields = [
    { label: 'Owner',        value: p.owner_name },
    { label: 'Owner Phone',  value: p.owner_phone },
    { label: 'Mgmt Company', value: p.management_company },
    { label: 'Submarket',    value: p.submarket },
    { label: 'Vacancy',      value: p.vacancy_pct != null ? parseFloat(p.vacancy_pct).toFixed(1) + '%' : null },
    { label: 'Avg Asking',   value: p.avg_asking_unit != null ? fmtCurrency(p.avg_asking_unit) + '/unit' : null },
    { label: 'Lead Score',   value: (() => { const { score } = computeLeadScore(p); return score; })() },
    { label: 'Units',        value: p.units },
    { label: 'Year Built',   value: p.year_built },
    { label: 'Asset Class',  value: p.asset_class },
  ];
  $('#crm-dossier-grid').innerHTML = dossierFields.map(f => `
    <div class="crm-dossier-field">
      <span class="crm-dossier-label">${esc(f.label)}</span>
      <span class="crm-dossier-value">${f.value != null ? esc(String(f.value)) : '<span class="muted">—</span>'}</span>
    </div>`).join('');

  // ── Lead signals ──
  const { breakdown } = computeLeadScore(p);
  const angles = [];
  if (p.vacancy_pct && parseFloat(p.vacancy_pct) > 12) angles.push(`📉 Vacancy at ${parseFloat(p.vacancy_pct).toFixed(1)}% — underperforming market`);
  if (!(p.phone_shops||[]).length) angles.push('📞 No phone shops on record');
  else if ((p.phone_shops||[]).some(s => { try { return JSON.parse(s.notes)?.connection === 'no_answer'; } catch { return false; } })) angles.push('📞 Phone shop — no answer logged');
  angles.push(...breakdown.map(b => `📊 ${b}`));
  $('#crm-dossier-body').innerHTML = angles.length
    ? `<ul class="crm-dossier-signals">${angles.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '<p class="muted small">No strong lead signals detected yet.</p>';

  // ── Drafts ──
  crmRenderDraftList(p.outreach_drafts);

  // ── Follow-up notes ──
  $('#crm-outreach-notes').value = p.notes || '';
}

function crmRenderDraftList(drafts) {
  const statusCls = { draft: '', approved: 'crm-badge-approved', sent: 'crm-badge-sent' };
  $('#crm-draft-list').innerHTML = (drafts||[]).length ? drafts.map(d => {
    const preview = (d.body || '').slice(0, 140);
    const truncated = (d.body||'').length > 140;
    return `<div class="crm-draft-card">
      <div class="crm-draft-meta">
        <span class="crm-draft-channel">${esc(d.channel||'—')}</span>
        <span class="crm-status-badge ${statusCls[d.status]||''}">${esc(d.status||'draft')}</span>
        <span class="crm-draft-date">${fmtDate(d.created_at)}</span>
      </div>
      ${d.subject ? `<div class="crm-draft-subject">${esc(d.subject)}</div>` : ''}
      ${preview ? `<div class="crm-draft-body-text">${esc(preview)}${truncated ? '…' : ''}</div>` : ''}
      ${d.notes ? `<div class="small muted" style="margin-top:4px;">Note: ${esc(d.notes)}</div>` : ''}
    </div>`;
  }).join('') : '<p class="muted small">No drafts yet. Click + New Draft to add one.</p>';
}

$('#crm-draft-add-btn').addEventListener('click', () => {
  const form = $('#crm-draft-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    // Pre-fill agent name from settings
    const savedName = localStorage.getItem('crm_username') || '';
    if (savedName && !$('#df-notes').value) $('#df-notes').value = `— ${savedName}`;
  }
});
$('#crm-draft-cancel').addEventListener('click', () => {
  $('#crm-draft-form').classList.add('hidden');
  ['#df-channel','#df-subject','#df-body','#df-notes'].forEach(id => $(id).value = '');
  $('#df-status').value = 'draft';
});
$('#crm-draft-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = { channel: $('#df-channel').value, status: $('#df-status').value, subject: $('#df-subject').value, body: $('#df-body').value, notes: $('#df-notes').value };
  if (!body.body.trim()) { showToast('Body is required', 'error'); return; }
  try {
    await crmFetch(`/api/crm/properties/${p.id}/outreach-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderDraftList(updated.outreach_drafts);
    $('#crm-draft-form').classList.add('hidden');
    ['#df-channel','#df-subject','#df-body','#df-notes'].forEach(id => $(id).value = '');
    showToast('Draft saved ✅', 'success');
  } catch (err) { showToast(err.message, 'error'); }
});

$('#crm-notes-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const statusEl = $('#crm-notes-save-status');
  statusEl.textContent = 'Saving…';
  try {
    const result = await crmFetch(`/api/crm/properties/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: $('#crm-outreach-notes').value }),
    });
    if (result.error) throw new Error(result.error);
    crmState.activeProperty.notes = result.notes;
    statusEl.textContent = '✅ Saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) { statusEl.textContent = '❌ ' + err.message; }
});

// ── History tab ───────────────────────────────────────────────────────────────
async function crmRenderHistory(id) {
  $('#crm-history-list').innerHTML = '<p class="muted small">Loading history…</p>';
  try {
    const events = await crmFetch(`/api/crm/properties/${id}/history`);
    if (!events.length) { $('#crm-history-list').innerHTML = '<p class="muted small">No activity recorded yet.</p>'; return; }
    $('#crm-history-list').innerHTML = `<table class="crm-history-table">
      <thead><tr><th>When</th><th>Area</th><th>Detail</th></tr></thead>
      <tbody>${events.map(e => `<tr>
        <td class="mono small">${fmtDateTime(e.when)}</td>
        <td class="crm-history-area">${esc(e.area)}</td>
        <td class="small">${esc(e.detail)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (err) { $('#crm-history-list').innerHTML = `<p class="muted small">Error: ${esc(err.message)}</p>`; }
}

// ── Task Queue view ───────────────────────────────────────────────────────────
async function crmLoadTasks() {
  $('#crm-tasks-status').textContent = 'Loading…';
  const agentFilter = $('#crm-task-agent-filter').value;
  const typeFilter  = $('#crm-task-type-filter').value;
  try {
    const data = await crmFetch(`/api/crm/tasks${agentFilter ? '?agent=' + encodeURIComponent(agentFilter) : ''}`);
    const tasks = (data.tasks || []).filter(t => !typeFilter || t.type === typeFilter);
    $('#crm-tasks-status').textContent = `${tasks.length} task(s)`;
    const typeIcon = { phone_shop: '📞', online_shop: '💻', lyndsay_review: '⭐', missed_tour: '🔥' };
    $('#crm-tasks-body').innerHTML = tasks.length ? tasks.map(t => `
      <div class="crm-task-card">
        <div class="crm-task-type-icon">${typeIcon[t.type] || '📋'}</div>
        <div class="crm-task-body">
          <div class="crm-task-title">${esc(t.property_name||'—')}</div>
          <div class="crm-task-detail">${esc(t.detail||'')}</div>
        </div>
        <div class="crm-task-agent">${esc(t.agent||'—')}</div>
        <div class="crm-task-priority ${t.priority >= 8 ? 'score-high' : t.priority >= 6 ? 'score-med' : 'score-low'}" style="background:${t.priority >= 8 ? '#dc2626' : t.priority >= 6 ? '#ea580c' : '#2563eb'}">${t.priority}</div>
      </div>`).join('') : '<p class="muted small" style="padding:20px;">No tasks match the current filters.</p>';
  } catch (err) { $('#crm-tasks-status').textContent = '❌ ' + err.message; }
}

$('#crm-tasks-refresh').addEventListener('click', crmLoadTasks);
$('#crm-task-agent-filter').addEventListener('change', crmLoadTasks);
$('#crm-task-type-filter').addEventListener('change', crmLoadTasks);

// ── Outreach Drafts view ──────────────────────────────────────────────────────
async function crmLoadDraftsList() {
  $('#crm-drafts-body').innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const data = await crmFetch('/api/crm/outreach-drafts');
    const groups = data.groups || [];
    if (!groups.length) {
      $('#crm-drafts-body').innerHTML = '<div style="text-align:center;padding:40px 20px;"><div style="font-size:2em;margin-bottom:12px;">✉️</div><p class="muted">No pending outreach drafts across all properties.</p></div>';
      return;
    }
    const statusLine = `<p class="small muted" style="margin-bottom:12px;">${data.total} draft(s) across ${groups.length} propert${groups.length === 1 ? 'y' : 'ies'}</p>`;
    $('#crm-drafts-body').innerHTML = statusLine + groups.map(g => {
      const assignees = [g.assigned_to, g.dm_assignee].filter(Boolean).join(' / ') || '—';
      const draftsHtml = g.drafts.map(d => {
        const preview = (d.body || '').slice(0, 100);
        const truncated = (d.body||'').length > 100;
        return `<div class="crm-draft-card" style="margin:0;">
          <div class="crm-draft-meta">
            <span class="crm-draft-channel">${esc(d.channel||'—')}</span>
            <span class="crm-draft-date">${fmtDate(d.created_at)}</span>
          </div>
          ${d.subject ? `<div class="crm-draft-subject">${esc(d.subject)}</div>` : ''}
          ${preview ? `<div class="crm-draft-body-text">${esc(preview)}${truncated ? '…' : ''}</div>` : ''}
        </div>`;
      }).join('');
      return `<div class="crm-global-draft-group">
        <div class="crm-global-draft-group-header">
          <div>
            <div class="crm-global-draft-group-name">${esc(g.property_name)}</div>
            <div class="crm-global-draft-group-meta">${esc(assignees)} · ${g.drafts.length} draft(s)</div>
          </div>
          <button class="btn-sm crm-global-draft-open" data-pid="${esc(g.property_id)}">Open Property →</button>
        </div>
        <div class="crm-global-draft-items">${draftsHtml}</div>
      </div>`;
    }).join('');

    $$('.crm-global-draft-open').forEach(btn =>
      btn.addEventListener('click', () => {
        crmSetView('dashboard');
        crmOpenModal(btn.dataset.pid);
      })
    );
  } catch (err) { $('#crm-drafts-body').innerHTML = `<p class="muted small">Error: ${esc(err.message)}</p>`; }
}
$('#crm-drafts-refresh').addEventListener('click', crmLoadDraftsList);

// ── Settings view ─────────────────────────────────────────────────────────────
$('#crm-settings-save').addEventListener('click', () => {
  const name = $('#crm-settings-username').value.trim();
  if (name) localStorage.setItem('crm_username', name);
  showToast('Settings saved', 'success');
});
$('#crm-targeted-save').addEventListener('click', () => {
  const list = $('#crm-targeted-companies').value;
  localStorage.setItem('crm_targeted_cos', list);
  showToast('Targeted companies saved', 'success');
});

// Restore settings from localStorage
const savedName = localStorage.getItem('crm_username');
if (savedName) $('#crm-settings-username').value = savedName;
const savedCos = localStorage.getItem('crm_targeted_cos');
if (savedCos) $('#crm-targeted-companies').value = savedCos;

// CoStar import
$('#crm-costar-import').addEventListener('click', async () => {
  const fileInput = $('#crm-costar-file');
  const resultEl  = $('#crm-costar-result');
  if (!fileInput.files.length) { resultEl.innerHTML = '<p class="small muted">Select a .xlsx file first.</p>'; return; }
  const file = fileInput.files[0];
  resultEl.innerHTML = '<p class="small muted">Importing… this may take a moment.</p>';
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await fetch('/api/crm/import-costar', { method: 'POST', body: form });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const { matched, updated, skipped, unmatched } = data.results;
    resultEl.innerHTML = `
      <div class="crm-import-result">
        <div class="crm-import-stat crm-import-ok">✅ Matched: ${matched}</div>
        <div class="crm-import-stat crm-import-ok">📝 Updated: ${updated}</div>
        <div class="crm-import-stat">⏭ Skipped (no changes): ${skipped}</div>
        <div class="crm-import-stat ${unmatched.length ? 'crm-import-warn' : ''}">❓ Unmatched: ${unmatched.length}</div>
      </div>
      ${unmatched.length ? `<details style="margin-top:8px;"><summary class="small muted pointer">Show unmatched (${unmatched.length})</summary><ul class="small" style="margin-top:4px;padding-left:18px;">${unmatched.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}`;
    if (updated > 0) crmLoadProperties();
  } catch (err) { resultEl.innerHTML = `<p class="small" style="color:red;">❌ ${esc(err.message)}</p>`; }
});

// ── Filter/search wiring ──────────────────────────────────────────────────────
$('#crm-refresh-btn').addEventListener('click', () => { crmLoadMeta(); crmLoadProperties(); });

let crmSearchTimer;
$('#crm-search').addEventListener('input', e => {
  clearTimeout(crmSearchTimer);
  crmSearchTimer = setTimeout(() => { crmState.search = e.target.value.trim(); crmState.page = 1; crmLoadProperties(); }, 350);
});

[
  ['#crm-filter-submarket', 'submarket'],
  ['#crm-filter-assigned',  'assigned_to'],
  ['#crm-filter-status',    'rop_status'],
  ['#crm-filter-class',     'asset_class'],
  ['#crm-filter-mgmt',      'mgmt_type'],
].forEach(([sel, key]) => {
  $(sel)?.addEventListener('change', e => { crmState[key] = e.target.value; crmState.page = 1; crmLoadProperties(); });
});

$('#crm-sort')?.addEventListener('change', e => { crmState.sort = e.target.value; crmLoadProperties(); });

// ── End BD CRM Phase 2 module ─────────────────────────────────────────────────

// =====================================================================
// MAINTENANCE TAB — sub-navigation
// =====================================================================

let maintTaskCache = [];
let maintNavWired = false;
let activeMaintenanceView = null;

function switchMaintenanceView(view) {
  activeMaintenanceView = view;
  $$('.maint-view').forEach(el => el.classList.add('hidden'));
  $(`#maint-view-${view}`)?.classList.remove('hidden');
  $$('#maintenance-subnav [data-maint-view]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.maintView === view));
  const loaders = {
    'asana':          loadMaintenanceAsana,
    'daily-ops':      loadMaintenanceTasks,
    'appfolio':       loadMaintenanceAppFolio,
    'eod':            loadMaintenanceEodSummary,
    'report':         loadMaintenanceDailyReport,
    'sops':           loadMaintenanceSops,
    // Technicians first: loadPropertyAssignments() builds the tech-name datalist
    // from techCache, so it needs the roster already in hand.
    'properties':     async () => { await loadTechnicians(); loadPropertyAssignments(); },
    'coverage':       loadMaintenanceCoverage,
    'efficiency':     loadEfficiency,
    'technician':     loadTechActivity,
    'reports-sync':   loadReportsSync,
    'command-center': loadLyndsayCommandCenter,
  };
  loaders[view]?.();

  // AppFolio-backed extras layered onto views that have their own loader.
  // Defined in reports-sync.js / appfolio-views.js, which load after app.js.
  // The Coverage Map's WO badges are NOT triggered here — they need the Leaflet
  // markers to exist, so loadMaintenanceCoverage() fires them once the map is
  // actually built. A timer here raced the first-time CDN load and lost.
  if (view === 'coverage')       loadOpenWoTable();
  if (view === 'appfolio')       loadBillableFeed();
  if (view === 'command-center') loadUrgentFeed();
}

async function loadMaintenance() {
  const subnav = $('#maintenance-subnav');
  const caret  = $('#maint-subnav-caret');
  if (subnav) subnav.classList.remove('hidden');
  if (caret)  caret.textContent = '▾';

  if (!maintNavWired) {
    maintNavWired = true;
    $$('#maintenance-subnav [data-maint-view]').forEach(btn =>
      btn.addEventListener('click', () => switchMaintenanceView(btn.dataset.maintView)));

    $('#maint-task-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/api/operational', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: fd.get('title'), priority: fd.get('priority'), source: fd.get('source') || '' }),
      });
      e.target.reset();
      loadMaintenanceTasks();
    });

    wireAppfolioDropZone();
    $('#maint-asana-refresh')?.addEventListener('click',      loadMaintenanceAsana);
    $('#maint-tasks-refresh')?.addEventListener('click',      loadMaintenanceTasks);
    $('#maint-appfolio-refresh')?.addEventListener('click',   loadMaintenanceAppFolio);
    $('#maint-eod-refresh')?.addEventListener('click',        loadMaintenanceEodSummary);
    $('#maint-report-refresh')?.addEventListener('click',     loadMaintenanceDailyReport);
    $('#maint-eod-copy')?.addEventListener('click', () => {
      if (!lastEodSummary) return toast('Nothing to copy yet', 'error');
      copyToClipboard(eodSummaryToText(lastEodSummary));
    });
    $('#maint-report-copy')?.addEventListener('click', () => {
      if (!lastDailyReport) return toast('Nothing to copy yet', 'error');
      copyToClipboard(dailyReportToText(lastDailyReport));
    });
    $('#maint-sops-refresh')?.addEventListener('click',       loadMaintenanceSops);
    $('#maint-properties-refresh')?.addEventListener('click', async () => { await loadTechnicians(); loadPropertyAssignments(); });
    $('#techRefreshBtn')?.addEventListener('click', loadTechnicians);
    $('#tcShowInactive')?.addEventListener('change', loadTechnicians);
    $('#techAddBtn')?.addEventListener('click', () => $('#techAddForm')?.classList.toggle('hidden'));
    $('#techAddCancel')?.addEventListener('click', () => $('#techAddForm')?.classList.add('hidden'));
    $('#techAddForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/technicians', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name:        fd.get('full_name'),
            position:         fd.get('position'),
            appfolio_aliases: fd.get('appfolio_aliases') || '',
            // Sent as-is; the server turns '' into NULL and rejects non-numbers.
            home_zip:         fd.get('home_zip') || null,
            home_lat:         fd.get('home_lat') || '',
            home_lng:         fd.get('home_lng') || '',
            show_on_map:      fd.get('show_on_map') === 'on',
          }),
        });
        e.target.reset();
        e.target.classList.add('hidden');
        toast('Technician added', 'success');
        loadTechnicians();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#maint-lyndsay-refresh')?.addEventListener('click',    loadLyndsayCommandCenter);
    $('#maint-sops-search')?.addEventListener('input', e => loadMaintenanceSops(e.target.value));
  }

  switchMaintenanceView(activeMaintenanceView || 'daily-ops');
}

// ── Asana Tasks ──────────────────────────────────────────────────────
// This view shows ERICK's Asana board, not Arturo's. ASANA_TOKEN belongs to
// support@livewithmetric.com and can only ever see Arturo's tasks, which is why
// the tab read "No open Asana tasks" — it was querying the wrong account.
// ?owner=erick makes the server use ASANA_TOKEN_ERICK instead.
async function loadMaintenanceAsana() {
  const el = $('#maint-asana-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const data = await api('/api/asana/tasks?owner=erick');

    if (data.notConfigured) {
      el.innerHTML = `
        <div class="banner banner-warn">
          🔌 <b>${esc(data.message || "Connect Erick's Asana token to see his tasks.")}</b>
          <div class="small" style="margin-top:6px">
            Add <code>ASANA_TOKEN_ERICK</code> to the Render environment with a personal
            access token from Erick's Asana account, then redeploy. Until then this view
            stays empty — it is not querying Arturo's board.
          </div>
        </div>`;
      return;
    }

    const tasks = Array.isArray(data) ? data : (data.tasks || data.data || []);
    if (!tasks.length) {
      el.innerHTML = `<p class="small muted">No open Asana tasks for Erick${data.stale ? ' (showing stale data)' : ''}.</p>`;
      return;
    }

    el.innerHTML =
      (data.stale ? '<div class="banner banner-warn">⚠ Asana unreachable — showing the last known list.</div>' : '') +
      tasks.map(t => `
        <div class="card" style="margin-bottom:8px">
          <div class="card-title">${esc(t.name || t.title || '')}</div>
          <div class="card-meta small muted">
            ${t.due_on ? `<span>📅 ${esc(t.due_on)}</span>` : ''}
            ${t.assignee ? `<span>👤 ${esc(t.assignee)}</span>` : ''}
            ${t.project ? `<span>📁 ${esc(t.project)}</span>` : ''}
          </div>
          ${t.notes_preview ? `<div class="card-notes">${esc(t.notes_preview)}</div>` : ''}
          ${t.permalink_url ? `<a class="btn-sm" href="${esc(t.permalink_url)}" target="_blank" rel="noopener">Open in Asana ↗</a>` : ''}
        </div>`).join('');
  } catch (err) { el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`; }
}

// ── AppFolio Analyzer ─────────────────────────────────────────────────
// Ported from metric-dashboard MODULE 8. CSV only here: that dashboard also
// accepts PDF and images via tesseract.js + pdf-parse, which this repo does not
// carry, and /api/appfolio/upload reads the file as UTF-8 before CSV-parsing it
// — so a PDF would be parsed as garbage rather than rejected.

const AF_GROUP_META = {
  urgent:   { icon: '🔴', label: 'Urgent actions' },
  followup: { icon: '🟡', label: 'Follow-up needed' },
  ready:    { icon: '🟢', label: 'Ready for QC / Billing' },
  none:     { icon: '✅', label: 'No action needed' },
};

let appfolioData = null;

function renderWoCard(wo) {
  const pill = a =>
    `<span class="action-pill ${a.tier === 'urgent' ? 'urgent' : a.tier === 'ready' ? 'ready' : ''}">${esc(a.action)}</span>`;

  const recs = (wo.actions || []).map(a =>
    `<li class="rec rec-${esc(a.tier)}"><b>${esc(a.action)}</b> — ${esc(a.recommendation || '')}</li>`).join('');

  const fieldRows = wo.fields
    ? Object.entries(wo.fields).map(([k, v]) =>
        `<tr><td class="fkey">${esc(k)}</td><td>${esc(v || '—')}</td></tr>`).join('')
    : '';

  return `
    <div class="card wo-card">
      <div class="card-meta" style="justify-content:space-between">
        <b>WO ${esc(wo.wo)}</b>
        <span class="badge badge-gray">${esc(wo.status)}</span>
      </div>
      <div class="card-title" style="font-size:14px">${esc(wo.property)}${wo.unit ? ' · ' + esc(wo.unit) : ''}</div>
      <div class="card-meta">
        <span>👤 ${esc(wo.assignee || 'Unassigned')}</span>
        ${wo.ageDays != null ? `<span>⏱ ${wo.ageDays} days</span>` : ''}
        <span>${wo.hasPhotos ? '📷 Has photos' : '🚫 No photos'}</span>
        ${wo.isSpanish ? '<span>🌐 Spanish</span>' : ''}
      </div>
      ${wo.description
        ? `<div class="card-notes">${esc(wo.description)}</div>`
        : '<div class="card-notes muted">No description</div>'}
      <div class="wo-actions-row">${(wo.actions || []).map(pill).join('')}</div>
      <div class="recs">
        <div class="recs-title">💡 Recommendations</div>
        <ul>${recs}</ul>
      </div>
      <details class="comments">
        <summary>🔎 All fields from the CSV row</summary>
        <table class="field-table">${fieldRows || '<tr><td>—</td></tr>'}</table>
      </details>
    </div>`;
}

function renderAppfolio(data) {
  const g = data.groups || { urgent: [], followup: [], ready: [], none: [] };

  const summary = $('#appfolioSummary');
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="stat"><div class="stat-num">${data.totalWorkOrders || 0}</div><div class="stat-label">Total WOs</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--red)">${g.urgent.length}</div><div class="stat-label">Urgent</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--amber)">${g.followup.length}</div><div class="stat-label">Follow-up</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--green)">${g.ready.length}</div><div class="stat-label">Ready QC</div></div>
    ${data.analyzedAt ? `<div class="stat"><div class="stat-num" style="font-size:15px">${esc(new Date(data.analyzedAt).toLocaleString())}</div><div class="stat-label">Analyzed</div></div>` : ''}`;

  $('#appfolioGroups').innerHTML = ['urgent', 'followup', 'ready', 'none'].map(key => {
    const items = g[key] || [];
    if (!items.length) return '';
    const meta = AF_GROUP_META[key];
    return `
      <div class="group">
        <div class="group-head">${meta.icon} ${meta.label} <span class="group-count">${items.length}</span></div>
        <div class="card-grid">${items.map(renderWoCard).join('')}</div>
      </div>`;
  }).join('') || '<div class="empty-state">No work orders parsed from this file.</div>';

  $('#exportAppfolioBtn').disabled = false;
}

async function loadMaintenanceAppFolio() {
  const groups = $('#appfolioGroups');
  if (!groups) return;
  try {
    const data = await api('/api/appfolio/latest');
    if (!data || !data.analyzedAt) {
      $('#appfolioSummary')?.classList.add('hidden');
      groups.innerHTML = '<div class="empty-state">No analysis yet — drop a Work Orders CSV above.</div>';
      return;
    }
    appfolioData = data;
    renderAppfolio(data);
  } catch (err) {
    groups.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

async function uploadAppfolioCsv(file) {
  if (!/\.csv$/i.test(file.name)) return toast('Upload a .csv file', 'error');
  const label = $('#afDropLabel');
  const original = label.textContent;
  label.textContent = 'Analyzing…';
  const fd = new FormData();
  fd.append('csv', file);
  try {
    appfolioData = await api('/api/appfolio/upload', { method: 'POST', body: fd });
    renderAppfolio(appfolioData);
    toast(`Analyzed ${appfolioData.totalWorkOrders} work orders`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    label.textContent = original;
  }
}

function wireAppfolioDropZone() {
  const zone = $('#afDropZone');
  const input = $('#afCsvInput');
  if (!zone || !input) return;

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer.files.length) uploadAppfolioCsv(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', e => { if (e.target.files.length) uploadAppfolioCsv(e.target.files[0]); });

  $('#exportAppfolioBtn')?.addEventListener('click', () => {
    if (!appfolioData) return;
    const blob = new Blob([JSON.stringify(appfolioData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `appfolio_actions_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── SOPs Library ──────────────────────────────────────────────────────
async function loadMaintenanceSops(query = '') {
  const el = $('#maint-sops-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const url = query
      ? `/api/maintenance/sops/search/${encodeURIComponent(query)}`
      : '/api/maintenance/sops';
    const data = await api(url);
    const sops = Array.isArray(data) ? data : (data.sops || []);
    if (!sops.length) { el.innerHTML = '<p class="small muted">No SOPs found.</p>'; return; }
    el.innerHTML = sops.map(s => `
      <div class="card" style="margin-bottom:8px">
        <div class="card-title">${esc(s.title || '')}</div>
        ${s.category ? `<span class="badge badge-blue">${esc(s.category)}</span>` : ''}
        ${s.text ? `<div class="card-meta small muted" style="margin-top:6px;white-space:pre-wrap">${esc(s.text.slice(0, 200))}${s.text.length > 200 ? '…' : ''}</div>` : ''}
      </div>`).join('');
  } catch (err) { el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`; }
}

// ── Coverage Map ─────────────────────────────────────────────────────
// Ported from metric-dashboard/public/app.js (MODULE 9). Coordinates are
// hardcoded there and copied verbatim here — edit the two arrays below to
// move a pin. Phase 3 replaces both with a Supabase `technicians` table.

const MAP_PROPERTIES = [
  { id: 'hyde-park',       name: 'Hyde Park Square',    address: '206 W. 38th St, Austin, TX 78705',           lat: 30.3065, lng: -97.7434 },
  { id: 'chateau',         name: 'The Chateau',          address: '1211 W. 8th St, Austin, TX 78703',            lat: 30.2699, lng: -97.7608 },
  { id: 'highlander',      name: 'The Highlander',       address: '803 Tirado St, Austin, TX 78703',             lat: 30.2805, lng: -97.7652 },
  { id: 'ascent',          name: 'Ascent at Northgate',  address: '9315 Northgate Blvd, Austin, TX 78758',       lat: 30.3927, lng: -97.7077 },
  { id: 'sidney',          name: 'The Sidney',           address: '4605 Avenue A, Austin, TX 78751',             lat: 30.3125, lng: -97.7245 },
  { id: 'sunset',          name: 'Sunset Palms',         address: '902 Romeria Drive, Austin, TX 78757',          lat: 30.3620, lng: -97.7355 },
  { id: 'windy-hill',      name: 'Windy Hill',           address: '1049 Windy Hill Road, Kyle, TX 78640',        lat: 29.9897, lng: -97.8763 },
  { id: 'iconic-rr',       name: 'iConic Round Rock',    address: '105 Gattis School Rd, Round Rock, TX 78664',  lat: 30.5175, lng: -97.6947 },
  { id: 'iconic-downtown', name: 'iConic Downtown',      address: '301 S. Burnet St, Austin, TX 78703',          lat: 30.2549, lng: -97.7673 },
];

// Technician pins now come from the Supabase `technicians` table (Phase 3) —
// rows with show_on_map and a home ZIP centroid. Still the home AREA, not an
// address. Empty until loadMapTechs() runs; the map degrades to properties-only
// if the table hasn't been migrated yet.
let MAP_TECHS = [];
let mapTechsLoaded = false;

const TECH_POSITION_LABEL = {
  field_supervisor:  'Field Supervisor',
  senior_maint_tech: 'Senior Maint Tech',
  maint_tech:        'Maint Tech',
  make_ready:        'Make Ready',
  housekeeper:       'Housekeeper',
  grounds:           'Grounds',
  other:             'Staff',
};

async function loadMapTechs() {
  if (mapTechsLoaded) return;
  try {
    const rows = await api('/api/technicians?map=1');
    MAP_TECHS = (rows || [])
      .filter(t => t.home_lat != null && t.home_lng != null)
      .map(t => ({
        id:   t.id,
        name: t.full_name,
        zip:  t.home_zip,
        role: TECH_POSITION_LABEL[t.position] || t.position,
        lat:  t.home_lat,
        lng:  t.home_lng,
      }));
    mapTechsLoaded = true;
  } catch {
    MAP_TECHS = [];   // table not migrated yet — properties still render
  }
}

let coverageMap = null;
let covPropMarkers = [];
let covTechMarkers = [];
let covTechCircles = [];
let leafletPromise = null;

// Leaflet is loaded on demand rather than from a <script> tag in index.html:
// Maintenance is admin-only, so every other role would pay ~150 KB for a view
// they can't open — and a CDN hiccup degrades to just this pane instead of
// blocking page load for everyone.
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve();
    js.onerror = () => { leafletPromise = null; reject(new Error('Leaflet CDN unreachable')); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// `openWos` renders the red count badge. Phase 1 always passes 0 (no AppFolio
// backend yet); Phase 2 fills it from /api/appfolio/feed/wo-by-property.
function covPropIcon(pending, star, openWos = 0) {
  const badge = openWos > 0 ? `<span class="cov-wo-badge">${openWos}</span>` : '';
  return L.divIcon({
    className: '',
    html: `<div class="cov-marker cov-marker-prop${pending ? ' cov-marker-pending' : ''}" style="position:relative">${star ? '⭐' : '🏢'}${badge}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -18]
  });
}

function covTechIcon(active) {
  return L.divIcon({
    className: '',
    html: `<div class="cov-marker cov-marker-tech${active ? ' cov-marker-active' : ''}">🔧</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -18]
  });
}

function initCoverageMap() {
  // Re-entering the view: Leaflet mis-measures a container that was display:none
  // when it initialised, so re-measure instead of rebuilding.
  if (coverageMap) { coverageMap.invalidateSize(); return; }

  coverageMap = L.map('covMap', { zoomControl: true }).setView([30.30, -97.73], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(coverageMap);

  MAP_PROPERTIES.forEach(p => {
    const m = L.marker([p.lat, p.lng], { icon: covPropIcon(p.pending, false, p.openWos || 0) })
      .addTo(coverageMap)
      .bindPopup(`<strong>${esc(p.name)}</strong><br><span style="font-size:12px;color:#666">${esc(p.address)}</span>${p.pending ? '<br><em style="color:#e67e22;font-size:11px">⚠ Address pending — approximate location</em>' : ''}`);
    covPropMarkers.push({ prop: p, marker: m });
  });

  MAP_TECHS.filter(t => t.lat && t.lng).forEach(t => {
    const m = L.marker([t.lat, t.lng], { icon: covTechIcon(false) })
      .addTo(coverageMap)
      .bindPopup(`<strong>${esc(t.name)}</strong><br><span style="font-size:12px;color:#555">${esc(t.role)} · ZIP ${esc(t.zip)}</span>`);
    covTechMarkers.push({ tech: t, marker: m });
  });

  const techsEl = $('#covTechs');
  if (techsEl) {
    techsEl.innerHTML = '';
    MAP_TECHS.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'cov-tech-btn' + (t.lat ? '' : ' unavailable');
      btn.dataset.techId = t.id;
      btn.textContent = t.name + (t.lat ? '' : ' (zone N/A)');
      if (!t.lat) btn.disabled = true;
      btn.addEventListener('click', () => covSelect(t.id));
      techsEl.appendChild(btn);
    });
  }

  setTimeout(() => coverageMap.invalidateSize(), 150);
}

function covTravelMin(dist_mi) {
  return Math.round(dist_mi * 1.3 / 28 * 60);
}

function covSelect(techId) {
  const tech = MAP_TECHS.find(t => t.id === techId);
  if (!tech || !tech.lat) return;

  $$('.cov-tech-btn').forEach(b => b.classList.toggle('active', b.dataset.techId === techId));
  covTechMarkers.forEach(({ tech: t, marker }) => marker.setIcon(covTechIcon(t.id === techId)));

  $('#covLocSelector').innerHTML = `
    <div class="cov-loc-selector">
      <span class="cov-loc-label">Where is ${esc(tech.name)} right now?</span>
      <select class="cov-loc-select" id="covLocSelect">
        <option value="home">🏠 Home (default)</option>
        ${MAP_PROPERTIES.map(p => `<option value="${esc(p.id)}">🏢 ${esc(p.name)}</option>`).join('')}
      </select>
    </div>`;

  $('#covLocSelect').addEventListener('change', function () {
    if (this.value === 'home') {
      covRenderFrom(tech, tech.lat, tech.lng, null);
    } else {
      const prop = MAP_PROPERTIES.find(p => p.id === this.value);
      covRenderFrom(tech, prop.lat, prop.lng, prop.id);
    }
  });

  covRenderFrom(tech, tech.lat, tech.lng, null);
}

function covRenderFrom(tech, originLat, originLng, originPropId) {
  covTechCircles.forEach(c => coverageMap.removeLayer(c));
  covTechCircles = [];
  // 5 mi and 10 mi rings, in metres.
  covTechCircles.push(
    L.circle([originLat, originLng], { radius: 8046.72, color: '#2d6cdf', weight: 1.5, fillOpacity: 0.06, dashArray: '6,5' }).addTo(coverageMap),
    L.circle([originLat, originLng], { radius: 16093.4, color: '#2d6cdf', weight: 1,   fillOpacity: 0.03, dashArray: '3,7' }).addTo(coverageMap)
  );

  const propsToRank = originPropId
    ? MAP_PROPERTIES.filter(p => p.id !== originPropId)
    : MAP_PROPERTIES;

  const sorted = propsToRank
    .map(p => ({ ...p, dist: haversineM(originLat, originLng, p.lat, p.lng) }))
    .sort((a, b) => a.dist - b.dist);

  covPropMarkers.forEach(({ prop, marker }) => {
    if (prop.id === originPropId) {
      marker.setIcon(L.divIcon({
        className: '',
        html: '<div class="cov-marker cov-marker-here">📍</div>',
        iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -18]
      }));
    } else {
      const rank = sorted.findIndex(s => s.id === prop.id);
      marker.setIcon(covPropIcon(prop.pending, rank === 0, prop.openWos || 0));
    }
  });

  coverageMap.panTo([originLat, originLng]);

  const originLabel = originPropId
    ? MAP_PROPERTIES.find(p => p.id === originPropId).name
    : `home zone (ZIP ${tech.zip})`;

  $('#covDistList').innerHTML = `
    <div class="cov-tech-head-label">📍 From: ${esc(originLabel)}</div>
    ${sorted.map((p, i) => `
      <div class="cov-dist-row">
        <span class="cov-rank">${i + 1}</span>
        <div class="cov-dist-info">
          <div class="cov-dist-name">${esc(p.name)}${p.pending ? ' <span class="cov-pending-badge">⚠</span>' : ''}</div>
          <div class="cov-dist-addr">${esc(p.address)}</div>
        </div>
        <div class="cov-dist-right">
          <span class="cov-dist-mi">${p.dist.toFixed(1)} mi</span>
          <span class="cov-dist-time">~${covTravelMin(p.dist)} min</span>
        </div>
      </div>`).join('')}
    <p class="cov-travel-note">Estimated drive time — approximate, does not account for real-time traffic</p>`;
}

async function loadMaintenanceCoverage() {
  const status = $('#maint-coverage-status');
  if (status) status.innerHTML = '';
  try {
    await loadLeaflet();
  } catch {
    if (status) status.innerHTML = '<p class="small muted">Could not load the map library (unpkg CDN unreachable). Check the connection and switch back to this view to retry.</p>';
    return;
  }
  // Technician pins must be in hand before initCoverageMap(), which builds the
  // markers and the tech buttons once and then short-circuits on re-entry.
  await loadMapTechs();
  if (status && !MAP_TECHS.length) {
    status.innerHTML = '<p class="small muted">No technicians are flagged for the map. ' +
      'Set <b>show_on_map</b> and a home ZIP under Properties ▸ Technician Capabilities.</p>';
  }
  initCoverageMap();
  // initCoverageMap() builds the markers synchronously, so the open-WO badges
  // can be filled in immediately — no timer, no race with the CDN load.
  // Defined in reports-sync.js, which loads after this file.
  if (typeof loadCoverageWoCounts === 'function') loadCoverageWoCounts();
}

// ── 1. Property Assignments ──────────────────────────────────────────
async function loadPropertyAssignments() {
  const el = $('#maint-assignments-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const rows = await api('/api/assignments');
    if (!rows.length) { el.innerHTML = '<p class="small muted">No assignments found.</p>'; return; }

    const headers = ['Property', 'Units', 'Pool', 'Grounds Tech', 'Frequency', 'Maint. Tech', 'Pest Control', 'Landscaping'];

    // The tech columns stay free text — vendors and crews appear here too, and a
    // hard foreign key would reject existing rows. Backing them with a datalist
    // steers new edits toward the technicians table without discarding anything.
    const techNames = (techCache.length ? techCache : [])
      .filter(t => t.active).map(t => t.full_name);
    const datalist = `<datalist id="tech-names">${techNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;

    let html = `${datalist}<div style="overflow-x:auto"><table class="crm-table">
      <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}<th></th></tr></thead>
      <tbody>`;

    // GET /api/assignments runs rows through assignmentToCamel, so every field
    // is camelCase — including the name, which is `property`. The PUT handler
    // keys its fieldMap on those same camelCase names, so the data-field values
    // below must match them exactly or the update is silently dropped.
    rows.forEach(r => {
      const prop = r.property || '';
      html += `<tr data-prop="${esc(prop)}">
        <td class="mono small">${esc(prop)}</td>
        <td><input class="crm-input maint-edit" data-field="units" type="number" min="0" style="width:70px" value="${esc(r.units ?? '')}"></td>
        <td class="mid"><input class="maint-edit" data-field="hasPool" type="checkbox"${r.hasPool ? ' checked' : ''}></td>
        <td><input class="crm-input maint-edit" list="tech-names" data-field="groundsTech" value="${esc(r.groundsTech ?? '')}"></td>
        <td><input class="crm-input maint-edit" data-field="groundsFrequency" value="${esc(r.groundsFrequency ?? '')}"></td>
        <td><input class="crm-input maint-edit" list="tech-names" data-field="maintenanceTech" value="${esc(r.maintenanceTech ?? '')}"></td>
        <td><input class="crm-input maint-edit" data-field="pestControl" value="${esc(r.pestControl ?? '')}"></td>
        <td><input class="crm-input maint-edit" data-field="landscaping" value="${esc(r.landscaping ?? '')}"></td>
        <td><button class="btn-sm primary maint-save-assignment">Save</button></td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    el.innerHTML = html;

    el.querySelectorAll('.maint-save-assignment').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const prop = tr.dataset.prop;
        if (!prop) return toast('This row has no property name — reload and try again', 'error');

        const update = {};
        tr.querySelectorAll('.maint-edit').forEach(inp => {
          const f = inp.dataset.field;
          if (inp.type === 'checkbox') { update[f] = inp.checked; return; }
          const v = inp.value.trim();
          // units is an INTEGER column: '' would be rejected outright.
          update[f] = (f === 'units') ? (v === '' ? null : Number(v)) : v;
        });
        if (update.units !== null && update.units !== undefined && Number.isNaN(update.units)) {
          return toast('Units must be a number', 'error');
        }

        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await api(`/api/assignments/${encodeURIComponent(prop)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update)
          });
          toast(`Saved — ${prop}`, 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

// ── Technicians ──────────────────────────────────────────────────────
// Renders the Make Ready chips and the capabilities matrix from the Supabase
// `technicians` table, replacing the two hardcoded HTML blocks in the original
// metric-dashboard. Editable in place so Erick can maintain it without a deploy.

const TECH_CAPS = [
  { key: 'cap_ac',          label: 'AC' },
  { key: 'cap_electrical',  label: 'Electrical' },
  { key: 'cap_plumbing',    label: 'Plumbing' },
  { key: 'cap_pool',        label: 'Pool' },
  { key: 'cap_welding',     label: 'Welding' },
  { key: 'cap_painting',    label: 'Painting' },
  { key: 'cap_resurfacing', label: 'Resurfacing' },
  { key: 'cap_cleaning',    label: 'Cleaning' },
];

const CAP_VALUES = [
  { v: 'highest', label: 'Highest', cls: 'tc-highest' },
  { v: 'yes',     label: 'Yes',     cls: 'tc-yes' },
  { v: 'minor',   label: 'Minor',   cls: 'tc-minor' },
  { v: 'maybe',   label: 'Maybe',   cls: 'tc-maybe' },
  { v: 'no',      label: 'No',      cls: 'tc-no' },
  { v: 'na',      label: '—',       cls: 'tc-na' },
];
const CAP_CLASS = Object.fromEntries(CAP_VALUES.map(c => [c.v, c.cls]));

let techCache = [];

async function loadTechnicians() {
  const table = $('#tcTable');
  if (!table) return;
  const showInactive = $('#tcShowInactive')?.checked;
  table.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    techCache = await api('/api/technicians?active=' + (showInactive ? 'all' : '1'));
  } catch (err) {
    table.innerHTML = `<p class="small muted">Could not load technicians: ${esc(err.message)}<br>` +
      `Run <code>supabase/migrations/002_technicians.sql</code> in the Supabase SQL editor.</p>`;
    $('#mrTechGrid').innerHTML = '';
    return;
  }
  renderMakeReadyChips();
  renderTechCapabilities();
}

function renderMakeReadyChips() {
  const grid = $('#mrTechGrid');
  if (!grid) return;
  const mr = techCache.filter(t => t.shows_in_make_ready);
  grid.innerHTML = mr.length
    ? mr.map(t => `<div class="mr-tech-chip${t.make_ready_note ? ' mr-tech-chip-cleaning' : ''}">
         <span>${esc(t.full_name)}</span>
         ${t.make_ready_note ? `<span class="mr-tech-role">${esc(t.make_ready_note)}</span>` : ''}
       </div>`).join('')
    : '<p class="small muted">No technicians flagged for Make Ready.</p>';
}

function renderTechCapabilities() {
  const el = $('#tcTable');
  if (!el) return;
  if (!techCache.length) { el.innerHTML = '<p class="small muted">No technicians yet.</p>'; return; }

  $('#tcSub').textContent =
    `${techCache.length} technicians · ${techCache.filter(t => t.expect_daily_hours).length} on the daily-hours alert · edit inline, save per row`;

  const positions = Object.entries(TECH_POSITION_LABEL);
  const capSelect = (t, cap) =>
    `<select class="tc-cap-select ${CAP_CLASS[t[cap.key]] || ''}" data-field="${cap.key}">` +
    CAP_VALUES.map(c => `<option value="${c.v}"${t[cap.key] === c.v ? ' selected' : ''}>${esc(c.label)}</option>`).join('') +
    '</select>';

  el.innerHTML = `<div class="tc-table-wrap"><table class="tc-table">
    <thead><tr>
      <th>Technician</th><th style="width:150px">Position</th><th style="width:170px">Properties</th>
      <th style="width:150px">AppFolio name(s)</th>
      <th title="Expected to log hours daily — drives the zero-hours alert">Daily</th>
      <th title="Show as a pin on the Coverage Map">Map</th>
      <th style="width:190px" title="ZIP centroid used for the map pin — home area, not a street address">Home ZIP / lat / lng</th>
      <th title="Show in the Make Ready roster">MR</th>
      ${TECH_CAPS.map(c => `<th>${esc(c.label)}</th>`).join('')}
      <th></th>
    </tr></thead><tbody>
    ${techCache.map(t => `<tr data-id="${esc(t.id)}"${t.active ? '' : ' class="tc-inactive"'}>
      <td class="tc-name">${esc(t.full_name)}${t.notes ? `<div class="tc-note" title="${esc(t.notes)}">${esc(t.notes)}</div>` : ''}</td>
      <td><select class="tc-in" data-field="position">
        ${positions.map(([v, label]) => `<option value="${v}"${t.position === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select></td>
      <td><input class="tc-in" data-field="properties_label" value="${esc(t.properties_label ?? '')}"></td>
      <td><input class="tc-in" data-field="appfolio_aliases" value="${esc((t.appfolio_aliases || []).join(', '))}"></td>
      <td class="tc-mid"><input type="checkbox" class="tc-in" data-field="expect_daily_hours"${t.expect_daily_hours ? ' checked' : ''}></td>
      <td class="tc-mid"><input type="checkbox" class="tc-in" data-field="show_on_map"${t.show_on_map ? ' checked' : ''}></td>
      <td class="tc-home">
        <input class="tc-in tc-zip" data-field="home_zip" value="${esc(t.home_zip ?? '')}" placeholder="ZIP">
        <input class="tc-in tc-coord" data-field="home_lat" value="${esc(t.home_lat ?? '')}" placeholder="lat" inputmode="decimal">
        <input class="tc-in tc-coord" data-field="home_lng" value="${esc(t.home_lng ?? '')}" placeholder="lng" inputmode="decimal">
      </td>
      <td class="tc-mid"><input type="checkbox" class="tc-in" data-field="shows_in_make_ready"${t.shows_in_make_ready ? ' checked' : ''}></td>
      ${TECH_CAPS.map(c => `<td class="tc-mid">${capSelect(t, c)}</td>`).join('')}
      <td class="tc-actions">
        <button class="btn-sm primary tech-save">Save</button>
        <button class="btn-sm tech-toggle">${t.active ? 'Deactivate' : 'Reactivate'}</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;

  // Recolour a capability cell as soon as it's changed, before saving.
  el.querySelectorAll('.tc-cap-select').forEach(sel => {
    sel.addEventListener('change', () => {
      sel.className = 'tc-cap-select ' + (CAP_CLASS[sel.value] || '');
    });
  });

  el.querySelectorAll('.tech-save').forEach(btn => {
    btn.addEventListener('click', () => saveTechnicianRow(btn.closest('tr')));
  });

  el.querySelectorAll('.tech-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const current = techCache.find(t => t.id === tr.dataset.id);
      try {
        await api(`/api/technicians/${encodeURIComponent(tr.dataset.id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !current.active }),
        });
        toast(current.active ? 'Technician deactivated' : 'Technician reactivated', 'success');
        mapTechsLoaded = false;   // roster changed — refetch pins next time
        loadTechnicians();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

async function saveTechnicianRow(tr) {
  const payload = {};
  tr.querySelectorAll('[data-field]').forEach(inp => {
    payload[inp.dataset.field] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
  });

  // Blank coordinates are valid (the pin is simply skipped), but pairing them
  // with "Map" checked is the silent failure this column exists to prevent:
  // the row saves, the map stays unchanged, and nothing says why.
  const missingCoords = payload.show_on_map &&
    (payload.home_lat === '' || payload.home_lng === '');

  try {
    await api(`/api/technicians/${encodeURIComponent(tr.dataset.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast(missingCoords
      ? 'Saved — but no map pin: add a home lat and lng'
      : 'Saved', missingCoords ? 'error' : 'success');
    mapTechsLoaded = false;   // show_on_map or the coordinates may have changed
    loadTechnicians();
  } catch (err) { toast(err.message, 'error'); }
}

// ── 2. Operational Tasks Kanban ──────────────────────────────────────
const MAINT_COLUMNS = [
  { key: '🔴 Critical',   header: '🔴 Critical',   cls: 'col-critical' },
  { key: '🟡 Follow-up',  header: '🟡 Follow-up',  cls: 'col-followup' },
  { key: '🟢 In Progress',header: '🟢 In Progress',cls: 'col-inprogress' },
  { key: '📅 Daily Task', header: '📅 Daily Task', cls: 'col-daily' },
  { key: '✅ Done',        header: '✅ Done',        cls: 'col-done' },
];

async function loadMaintenanceTasks() {
  const el = $('#maint-tasks-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    maintTaskCache = await api('/api/operational');
    renderMaintenanceKanban();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

function renderMaintenanceKanban() {
  const el = $('#maint-tasks-body');
  if (!el) return;

  const grouped = {};
  MAINT_COLUMNS.forEach(c => { grouped[c.key] = []; });
  maintTaskCache.forEach(t => {
    const col = grouped[t.priority] != null ? t.priority : '🟢 In Progress';
    if (grouped[col]) grouped[col].push(t);
  });

  el.className = 'kanban';

  if (!maintTaskCache.length) {
    el.innerHTML = '<div class="empty-state">No tasks. Add one above ☝</div>';
    return;
  }

  el.innerHTML = MAINT_COLUMNS.map(col => {
    const tasks = grouped[col.key] || [];
    return `<div class="kanban-column ${col.cls}" data-col-key="${esc(col.key)}">
      <div class="kanban-col-head">
        <span>${esc(col.header)}<span class="col-toggle">▾</span></span>
        <span class="kanban-col-count">${tasks.length}</span>
      </div>
      <div class="kanban-col-body">
        ${tasks.length ? tasks.map(t => {
          const done = !!t.completed_at;
          return `<div class="card ${done ? 'completed' : ''}" data-id="${esc(t.id)}">
            <div class="card-title">${esc(t.title)}</div>
            ${t.source ? `<div class="card-meta small muted">👤 ${esc(t.source)}</div>` : ''}
            ${t.notes ? `<div class="card-notes">${esc(t.notes.length > 100 ? t.notes.slice(0,100) + '…' : t.notes)}</div>` : ''}
            <div class="card-actions">
              ${!done ? `<button class="btn-sm primary maint-task-done" data-id="${esc(t.id)}">✓ Done</button>` : `<button class="btn-sm maint-task-undone" data-id="${esc(t.id)}">Undo</button>`}
              <select class="crm-select maint-task-prio" data-id="${esc(t.id)}" style="font-size:0.78rem">
                ${MAINT_COLUMNS.map(c => `<option${t.priority === c.key ? ' selected' : ''}>${esc(c.key)}</option>`).join('')}
              </select>
              <button class="btn-sm btn-danger maint-task-del" data-id="${esc(t.id)}">🗑</button>
            </div>
          </div>`;
        }).join('') : '<p class="kanban-col-empty">No tasks</p>'}
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.kanban-col-head').forEach(head => {
    head.addEventListener('click', e => {
      if (e.target.closest('button, select')) return;
      head.closest('.kanban-column').classList.toggle('col-collapsed');
    });
  });

  el.querySelectorAll('.maint-task-done').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/operational/${btn.dataset.id}/done`, { method: 'POST' });
      loadMaintenanceTasks();
    });
  });
  el.querySelectorAll('.maint-task-undone').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/operational/${btn.dataset.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed_at: null })
      });
      loadMaintenanceTasks();
    });
  });
  el.querySelectorAll('.maint-task-prio').forEach(sel => {
    sel.addEventListener('change', async () => {
      await api(`/api/operational/${sel.dataset.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: sel.value })
      });
      loadMaintenanceTasks();
    });
  });
  el.querySelectorAll('.maint-task-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      await api(`/api/operational/${btn.dataset.id}`, { method: 'DELETE' });
      loadMaintenanceTasks();
    });
  });
}

// ── 3 & 4. Daily Work Report + EOD Summary ───────────────────────────
// Both endpoints return structured JSON, not markdown — these used to dump
// JSON.stringify into a <pre>. The card layout is ported from
// metric-dashboard, but mapped onto OUR payload: buildMaintenanceSummary and
// buildDailyWorkReport have no Asana blocks, so the local renderers would have
// thrown on s.asana.completedToday.

const cardList = (items, fn, empty = 'None') =>
  items && items.length ? items.map(fn).join('') : `<li class="summary-empty">${esc(empty)}</li>`;

// h4, not h3 — styles.css styles `.summary-card h4`, matching the EOD tab.
const summaryCard = (title, inner) =>
  `<div class="summary-card"><h4>${title}</h4>${inner}</div>`;

let lastEodSummary = null;
let lastDailyReport = null;

function appfolioCard(af, emptyMsg) {
  return summaryCard('📄 AppFolio Today', af
    ? `<ul>
         <li>Analyzed <b>${af.totalWorkOrders}</b> work orders</li>
         <li>🔴 Urgent: <b>${af.urgent}</b></li>
         <li>🟡 Follow-up: <b>${af.followup}</b></li>
         <li>🟢 Ready for QC: <b>${af.ready}</b></li>
       </ul>`
    : `<p class="summary-empty">${esc(emptyMsg)}</p>`);
}

function renderEodSummary(s) {
  $('#maint-eod-date').textContent =
    `For ${s.date} · generated ${new Date(s.generatedAt).toLocaleTimeString()}`;

  $('#maint-eod-body').innerHTML =
    summaryCard('📋 Top Priorities for Tomorrow',
      (s.topPriorities || []).length
        ? s.topPriorities.map((p, i) => `
            <div class="priority-item">
              <span class="priority-rank">${i + 1}</span>
              <div><b>${esc(p.label)}</b><br><span class="muted small">${esc(p.source)} · ${esc(p.reason)}</span></div>
            </div>`).join('')
        : '<p class="summary-empty">Nothing flagged — all clear! 🎉</p>') +

    summaryCard(`✅ Completed Today (${(s.operational?.completedToday || []).length})`,
      `<ul>${cardList(s.operational?.completedToday,
        t => `<li>${esc(t.title)} <span class="muted small">(${esc(t.type)})</span></li>`)}</ul>`) +

    summaryCard(`🗂️ Still Open (${(s.operational?.open || []).length})`,
      `<ul>${cardList(s.operational?.open,
        t => `<li>${esc(t.priority)} ${esc(t.title)}</li>`)}</ul>`) +

    appfolioCard(s.appfolio, 'No report analyzed today.');
}

function renderDailyReport(r) {
  $('#maint-report-date').textContent =
    `${esc(r.person || 'Maintenance')} · ${r.date} · generated ${new Date(r.generatedAt).toLocaleTimeString()}`;

  const dailyTotal = (r.dailyTasksDone || []).length + (r.dailyTasksPending || []).length;

  $('#maint-report-body').innerHTML =
    summaryCard(`🔁 Daily Tasks Done (${(r.dailyTasksDone || []).length}/${dailyTotal})`,
      `<ul>${cardList(r.dailyTasksDone, t => `<li>${esc(t.title)}</li>`)}</ul>` +
      ((r.dailyTasksPending || []).length
        ? `<p class="muted small">Pending: ${r.dailyTasksPending.map(t => esc(t.title)).join(', ')}</p>`
        : '')) +

    summaryCard(`🗂️ Operational Tasks Completed (${(r.operationalDone || []).length})`,
      `<ul>${cardList(r.operationalDone, t => `
        <li>${esc(t.title)} <span class="muted small">(${esc(t.type)})</span>
          ${(t.noteHistory || []).length ? `
            <div class="note-history" style="margin-top:4px;max-height:none">
              ${[...t.noteHistory].reverse().map(n => `
                <div class="note-entry">
                  <span class="note-time">${new Date(n.createdAt).toLocaleString()}</span>
                  <span>${esc(n.text)}</span>
                </div>`).join('')}
            </div>` : ''}
        </li>`)}</ul>`) +

    ((r.notesToday || []).length
      ? summaryCard(`📝 Notes Added Today (${r.notesToday.length})`,
          `<ul>${r.notesToday.map(n => `
            <li><b>${esc(n.taskTitle)}</b>
              <span class="muted small"> · ${new Date(n.createdAt).toLocaleTimeString()}</span>
              <br><span style="font-size:12.5px">${esc(n.text)}</span></li>`).join('')}</ul>`)
      : '') +

    appfolioCard(r.appfolio, 'No report analyzed today.');
}

async function loadMaintenanceEodSummary() {
  const el = $('#maint-eod-body');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Building summary…</div>';
  try {
    lastEodSummary = await api('/api/maintenance/summary');
    renderEodSummary(lastEodSummary);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

async function loadMaintenanceDailyReport() {
  const el = $('#maint-report-body');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Generating report…</div>';
  try {
    lastDailyReport = await api('/api/report');
    renderDailyReport(lastDailyReport);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

// Plain-text versions are built here rather than server-side: the original
// dashboard has /api/summary/export and /api/report/export, which this app
// never ported.
function eodSummaryToText(s) {
  const L = [`END OF DAY — ${s.date}`, ''];
  L.push('TOP PRIORITIES FOR TOMORROW');
  L.push(...((s.topPriorities || []).length
    ? s.topPriorities.map((p, i) => `  ${i + 1}. ${p.label} (${p.source} — ${p.reason})`)
    : ['  Nothing flagged.']));
  L.push('', `COMPLETED TODAY (${(s.operational?.completedToday || []).length})`);
  L.push(...((s.operational?.completedToday || []).map(t => `  - ${t.title} (${t.type})`) || []));
  L.push('', `STILL OPEN (${(s.operational?.open || []).length})`);
  L.push(...((s.operational?.open || []).map(t => `  - ${t.priority} ${t.title}`) || []));
  if (s.appfolio) {
    L.push('', 'APPFOLIO TODAY',
      `  ${s.appfolio.totalWorkOrders} work orders — ${s.appfolio.urgent} urgent, ${s.appfolio.followup} follow-up, ${s.appfolio.ready} ready`);
  }
  return L.join('\n');
}

function dailyReportToText(r) {
  const L = [`DAILY WORK REPORT — ${r.person || 'Maintenance'} — ${r.date}`, ''];
  L.push(`DAILY TASKS DONE (${(r.dailyTasksDone || []).length}/${(r.dailyTasksDone || []).length + (r.dailyTasksPending || []).length})`);
  L.push(...((r.dailyTasksDone || []).map(t => `  - ${t.title}`) || []));
  if ((r.dailyTasksPending || []).length) {
    L.push('  Pending: ' + r.dailyTasksPending.map(t => t.title).join(', '));
  }
  L.push('', `OPERATIONAL TASKS COMPLETED (${(r.operationalDone || []).length})`);
  for (const t of (r.operationalDone || [])) {
    L.push(`  - ${t.title} (${t.type})`);
    for (const n of [...(t.noteHistory || [])].reverse()) L.push(`      · ${n.text}`);
  }
  if ((r.notesToday || []).length) {
    L.push('', `NOTES ADDED TODAY (${r.notesToday.length})`);
    L.push(...r.notesToday.map(n => `  - [${n.taskTitle}] ${n.text}`));
  }
  if (r.appfolio) {
    L.push('', 'APPFOLIO TODAY',
      `  ${r.appfolio.totalWorkOrders} work orders — ${r.appfolio.urgent} urgent, ${r.appfolio.followup} follow-up, ${r.appfolio.ready} ready`);
  }
  return L.join('\n');
}

// ── 5. Lyndsay Command Center (readonly) ─────────────────────────────
async function loadLyndsayCommandCenter() {
  const el = $('#maint-lyndsay-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const data = await api('/api/lyndsay/tasks');
    const tasks = data.tasks || data || [];
    if (!tasks.length) { el.innerHTML = '<p class="small muted">No tasks in snapshot.</p>'; return; }

    const done = tasks.filter(t => t.completed);
    const pending = tasks.filter(t => !t.completed);
    let html = `<p class="small muted">${pending.length} pending · ${done.length} done</p>`;

    html += '<div class="task-list" style="margin-top:8px;">';
    [...pending, ...done].forEach(t => {
      html += `<div class="card${t.completed ? ' done' : ''}" style="margin-bottom:6px;padding:10px 14px;">
        <span>${t.completed ? '✅' : '⬜'} ${esc(t.title || t.task || '')}</span>
        ${t.category ? `<span class="badge badge-blue" style="margin-left:8px;">${esc(t.category)}</span>` : ''}
      </div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

// Boot — verify session, gate tabs, then load initial tab
initAuth();
