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

// ---- Tabs -------------------------------------------------------------------
$$('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#tabs button').forEach(b => b.classList.remove('active'));
    $$('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    loadTab(btn.dataset.tab);
  });
});

function loadTab(tab) {
  if (tab === 'tasks') loadTasks();
  if (tab === 'sops') loadSops();
  if (tab === 'platform') loadPlatform();
  if (tab === 'email') loadEmail();
  if (tab === 'eod') loadEod();
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

function renderMeetings(list, isLyndsay) {
  if (!list || !list.length) return '<p class="muted small">No meetings today (or stub mode).</p>';
  return list.map((m, i) => `
    <div class="card" style="margin-bottom:8px">
      <div class="card-title" style="font-size:13.5px">${esc(m.subject)}${m.conflict ? ' <span class="badge badge-red">⚠ CONFLICT</span>' : ''}${m.isCancelled ? ' <span class="badge badge-gray">Cancelled</span>' : ''}</div>
      <div class="card-meta">
        <span class="mono small">🕐 ${formatDualTime(m.start)}</span>
        <span class="badge badge-blue">${esc(m.platform || '—')}</span>
        ${m.attendees && m.attendees.length ? `<span class="muted small">${m.attendees.length} attendee(s)</span>` : ''}
      </div>
      ${isLyndsay && !m.isCancelled ? `<div class="card-actions"><button class="btn-sm add-reminder-btn" data-idx="${i}">+ Add Reminder</button></div>` : ''}
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

  $('#meetings-lyndsay-today').innerHTML = renderMeetings(lyndsayTodayCache, true);
  $$('#meetings-lyndsay-today .add-reminder-btn').forEach(btn =>
    btn.addEventListener('click', () => addReminderForMeeting(lyndsayTodayCache[+btn.dataset.idx])));

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
  // AI dossier
  const { score, breakdown } = computeLeadScore(p);
  const angles = [];
  if (p.vacancy_pct && parseFloat(p.vacancy_pct) > 12) angles.push(`📉 Vacancy at ${parseFloat(p.vacancy_pct).toFixed(1)}% — underperforming`);
  if ((p.phone_shops||[]).length === 0) angles.push('📞 No phone shops on record — unreachable?');
  else if ((p.phone_shops||[]).some(s => { try { return JSON.parse(s.notes)?.connection === 'no_answer'; } catch { return false; } })) angles.push('📞 Phone shop — no answer logged');
  if (breakdown.length) angles.push(...breakdown.map(b => `📊 ${b}`));
  const dossierBody = angles.length ? `<ul>${angles.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="muted small">No strong lead signals detected yet.</p>';
  $('#crm-dossier-body').innerHTML = dossierBody;

  // Drafts
  crmRenderDraftList(p.outreach_drafts);

  // Notes
  $('#crm-notes-display').textContent = p.notes || '(no notes)';
}

function crmRenderDraftList(drafts) {
  $('#crm-draft-list').innerHTML = drafts.length ? drafts.map(d => `
    <div class="crm-draft-card">
      <div class="crm-draft-meta">${esc(d.channel||'—')} · <span class="crm-status-badge">${esc(d.status)}</span> · ${fmtDate(d.created_at)}</div>
      ${d.subject ? `<div class="crm-draft-subject">${esc(d.subject)}</div>` : ''}
      ${d.body ? `<div class="crm-draft-body-text">${esc(d.body)}</div>` : ''}
    </div>`).join('') : '<p class="muted small">No drafts yet.</p>';
}

$('#crm-draft-add-btn').addEventListener('click', () => $('#crm-draft-form').classList.toggle('hidden'));
$('#crm-draft-cancel').addEventListener('click', () => $('#crm-draft-form').classList.add('hidden'));
$('#crm-draft-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const body = { channel: $('#df-channel').value, status: $('#df-status').value, subject: $('#df-subject').value, body: $('#df-body').value, notes: $('#df-notes').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/outreach-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderDraftList(updated.outreach_drafts);
    $('#crm-draft-form').classList.add('hidden');
  } catch (err) { showToast(err.message, 'error'); }
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
    // Pull properties with outreach drafts
    const data = await crmFetch('/api/crm/properties?limit=500');
    const props = data.properties || [];
    // Fetch full details for props that have drafts — use a small subset
    // (for performance, just show a count and link to property)
    $('#crm-drafts-body').innerHTML = `<p class="muted small">${props.length} properties loaded. Open a property → Outreach tab to view and edit drafts.</p>`;
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

// ── Load CRM when tab first activated ────────────────────────────────────────
let crmLoaded = false;
$$('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'crm' && !crmLoaded) {
      crmLoaded = true;
      crmLoadMeta();
      crmLoadProperties();
    }
  });
});

// ── End BD CRM Phase 2 module ─────────────────────────────────────────────────

// Initial load
loadTasks();
