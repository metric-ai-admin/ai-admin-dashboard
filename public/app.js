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

// Initial load
loadTasks();
