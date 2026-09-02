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
// This gate is convenience, not security — it hides tabs the role cannot use.
// The data itself is protected server-side (requireAuth + the agent filter on
// the CRM routes), so a hidden tab is never the only thing standing in the way.
const TAB_ACCESS = {
  // 'reports' is the Unified Daily Operations Report: admin gets the whole thing
  // including the confidential panels, operations gets the report and its own
  // sign-off row. Deliberately not given to maintenance or bd_agent.
  // Bekah, Kara and Rocío are named on the report but have no account yet, so
  // there is no role to grant — revisit when Jay confirms theirs.
  admin:       ['tasks', 'sops', 'platform', 'email', 'eod', 'maintenance', 'crm', 'reports', 'sixpm', 'calls', 'evictions', 'accounting', 'leasing'],
  ceo:         ['crm', 'platform', 'eod', 'reports'],
  operations:  ['tasks', 'platform', 'email', 'eod', 'reports', 'sixpm', 'calls'],
  // Erick: the Maintenance tab and its twelve sub-views, nothing else.
  maintenance: ['maintenance'],
  bd_agent:    ['crm'],
  // Confirmed by Jay 2026-08-27. None of these three exist in dashboard_users
  // yet — Arturo creates the accounts once passwords are agreed — so the entries
  // sit here inert until then rather than needing a deploy on the day.
  regional_director:   ['maintenance', 'reports'],   // Rebekah Tuckner
  resident_success:    ['maintenance', 'reports'],   // Kara Garst
  collections_leasing: ['reports'],                  // Rocío Hunsberger
  // Claudia Villalobos (Accounting/QC). No account in dashboard_users yet, so
  // this sits inert until Arturo creates it — mirrors the three roles above.
  accounting:  ['accounting'],
  // Katie — submits the Weekly Leasing Goal Board. Can submit but not
  // review/approve (that gate is by role inside the Leasing tab). Lyndsay/Kara/
  // Bekah get review access via their own roles once those accounts exist.
  leasing:     ['leasing'],
};

// Maintenance is read-only for these two: they consult the board, they do not
// work it. Erick and Arturo keep every control.
//
// This hides the controls; it does not defend the endpoints. /api/operational
// and the technician routes take no auth at all today, so anyone with the URL
// can still write. Closing that is a server-side change and is not part of this
// one — see the note in the commit message.
const MAINT_VIEW_ONLY_ROLES = ['regional_director', 'resident_success'];

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

  // Read-only Maintenance. Set alongside the tab gating so it is in place before
  // any maintenance render runs, and on the section itself so the CSS cannot
  // reach controls in other tabs that share class names.
  $('#tab-maintenance')?.classList.toggle('maint-readonly',
    MAINT_VIEW_ONLY_ROLES.includes(currentUser.role));

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
  return {
    admin: 'AI Admin', ceo: 'CEO', operations: 'Operations Manager',
    maintenance: 'Maintenance Coordinator', bd_agent: 'BD Agent',
    regional_director: 'Regional Director', resident_success: 'Resident Success',
    collections_leasing: 'Collections & Leasing',
  }[role] || role;
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
  if (tab === 'crm') { crmApplyUserRole(); crmLoadMeta(); crmLoadProperties(); if (crmCanSeeRoster()) crmLoadRoster(); }
  if (tab === 'reports') reportLoad();
  if (tab === 'sixpm') sixpmLoad();
  if (tab === 'calls') loadCallAnalyzer();
  if (tab === 'evictions') loadEvictions();
  if (tab === 'accounting') loadAccounting();
  if (tab === 'leasing') loadLeasing();
  if (window.innerWidth <= 820) $('#sidebar').classList.remove('open');
}

// The eviction app is a self-contained React tool in an iframe. Load it lazily
// the first time the tab opens so its CDN scripts aren't fetched on every page
// load. The frame itself is same-origin, so its /api/evictions/* fetches carry
// the session cookie; access is enforced server-side regardless of the nav.
function loadEvictions() {
  const frame = $('#evictions-frame');
  if (frame && !frame.getAttribute('src')) frame.setAttribute('src', '/evictions/app');
}

// ── Leasing — Weekly Goal Board (Katie) ─────────────────────────────────────
// Panel A is the submission history (review/approve). Panel B embeds Lyndsay's
// standalone tool in a same-origin iframe; "Submit to Dashboard" reads the
// tool's own snapshot()/compute() through contentWindow and POSTs a snapshot.
const leasingState = { subs: [], wired: false, expandedId: null, detail: {} };
// Who may change status / add reviewer notes. Only admin today; Lyndsay, Kara
// and Bekah get their own roles here once those accounts exist.
const LEASING_REVIEW_ROLES = ['admin'];
const leasingCanReview = () => LEASING_REVIEW_ROLES.includes(currentUser?.role);

// The week this report covers — the upcoming Sunday (today if today is Sunday).
function leasingNextSunday() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function loadLeasing() {
  if (!$('#leasing-history')) return;
  if (!leasingState.wired) {
    $('#leasing-refresh')?.addEventListener('click', leasingLoadHistory);
    $('#leasing-submit')?.addEventListener('click', leasingSubmit);
    const wk = $('#leasing-week'); if (wk) wk.textContent = leasingNextSunday();
    leasingState.wired = true;
  }
  // Lazy-load the tool iframe (its ExcelJS/fonts aren't fetched until needed).
  const frame = $('#leasing-frame');
  if (frame && !frame.getAttribute('src')) frame.setAttribute('src', '/tools/weekly_leasing_goal_board.html');
  leasingLoadHistory();
}

const LEASING_STATUS_BADGE = {
  submitted: 'badge-blue', reviewed: 'badge-yellow', approved: 'badge-green',
};
function leasingStatusBadge(st) {
  return `<span class="badge ${LEASING_STATUS_BADGE[st] || 'badge-gray'}">${esc(st || 'submitted')}</span>`;
}

async function leasingLoadHistory() {
  const el = $('#leasing-history');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const d = await api('/api/leasing/submissions');
    leasingState.subs = d.submissions || [];
    leasingRenderHistory();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

function leasingKpiCell(k) {
  if (!k) return '<span class="muted small">—</span>';
  const bits = [];
  if (k.occupancy_pct != null) bits.push(`${k.occupancy_pct}% occ`);
  if (k.traffic_target != null) bits.push(`${k.traffic_target} traffic`);
  if (k.net_moveins_needed != null) bits.push(`${k.net_moveins_needed} net`);
  return bits.length ? `<span class="small">${esc(bits.join(' · '))}</span>` : '<span class="muted small">—</span>';
}

function leasingRenderHistory() {
  const el = $('#leasing-history');
  if (!el) return;
  if (!leasingState.subs.length) {
    el.innerHTML = '<div class="empty-state">No submissions yet.</div>';
    return;
  }
  const canReview = leasingCanReview();
  el.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
    <thead><tr><th>Week Ending</th><th>Submitted By</th><th>Submitted At</th><th>Status</th><th>KPI snapshot</th><th></th></tr></thead>
    <tbody>${leasingState.subs.map(s => {
      const expanded = leasingState.expandedId === s.id;
      const statusCell = canReview
        ? `<select class="crm-select leasing-status" data-id="${esc(s.id)}">
             ${['submitted', 'reviewed', 'approved'].map(v =>
               `<option value="${v}"${v === s.status ? ' selected' : ''}>${v}</option>`).join('')}
           </select>`
        : leasingStatusBadge(s.status);
      return `<tr class="leasing-row${expanded ? ' expanded' : ''}" data-id="${esc(s.id)}">
        <td class="mono small">${esc(s.week_ending || '')}</td>
        <td>${esc(s.submitted_by || '')}</td>
        <td class="small muted">${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : ''}</td>
        <td>${statusCell}</td>
        <td>${leasingKpiCell(s.kpi_json)}</td>
        <td><button class="btn-sm leasing-expand" data-id="${esc(s.id)}">${expanded ? 'Hide' : 'View'}</button></td>
      </tr>${expanded ? `<tr class="leasing-detail-row"><td colspan="6"><div class="leasing-detail" id="leasing-detail-${esc(s.id)}"><p class="small muted">Loading…</p></div></td></tr>` : ''}`;
    }).join('')}</tbody></table></div>`;

  el.querySelectorAll('.leasing-expand').forEach(b =>
    b.addEventListener('click', () => leasingToggle(b.dataset.id)));
  el.querySelectorAll('.leasing-status').forEach(sel =>
    sel.addEventListener('change', () => leasingSetStatus(sel.dataset.id, sel.value)));

  if (leasingState.expandedId) leasingRenderDetail(leasingState.expandedId);
}

async function leasingToggle(id) {
  leasingState.expandedId = leasingState.expandedId === id ? null : id;
  leasingRenderHistory();
  if (leasingState.expandedId === id && !leasingState.detail[id]) {
    try {
      const d = await api(`/api/leasing/submissions/${encodeURIComponent(id)}`);
      leasingState.detail[id] = d.submission;
    } catch (err) {
      leasingState.detail[id] = { error: err.message };
    }
    leasingRenderDetail(id);
  }
}

function leasingRenderDetail(id) {
  const box = $(`#leasing-detail-${CSS.escape(id)}`);
  if (!box) return;
  const s = leasingState.detail[id];
  if (!s) { box.innerHTML = '<p class="small muted">Loading…</p>'; return; }
  if (s.error) { box.innerHTML = `<p class="small muted">Could not load: ${esc(s.error)}</p>`; return; }

  const k = s.kpi_json || {};
  const props = Array.isArray(k.properties) ? k.properties : [];
  const rollup = props.length ? `<div style="overflow-x:auto"><table class="crm-table">
      <thead><tr><th>Property</th><th>Units</th><th>Occupied</th><th>Occ %</th><th>Net Move-Ins</th><th>Traffic Target</th><th>Tours</th><th>Apps</th></tr></thead>
      <tbody>${props.map(p => `<tr>
        <td>${esc(p.property || '')}</td>
        <td>${esc(p.units ?? '')}</td>
        <td>${esc(p.occupied ?? '')}</td>
        <td>${p.occ_pct != null ? esc(p.occ_pct) + '%' : ''}</td>
        <td>${esc(p.net_moveins ?? '')}</td>
        <td>${esc(p.traffic_target ?? '')}</td>
        <td>${esc(p.tours ?? '')}</td>
        <td>${esc(p.apps ?? '')}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="small muted">No per-property KPI snapshot stored for this submission.</p>';

  const portfolio = (k.occupied != null || k.traffic_target != null) ? `
    <div class="leasing-kpis">
      ${k.occupancy_pct != null ? `<div class="leasing-kpi"><span class="lab">Occupancy</span><b>${esc(k.occupancy_pct)}%</b><span class="muted small">${esc(k.occupied ?? '')}/${esc(k.units ?? '')}</span></div>` : ''}
      ${k.net_moveins_needed != null ? `<div class="leasing-kpi"><span class="lab">Net Move-Ins Needed</span><b>${esc(k.net_moveins_needed)}</b></div>` : ''}
      ${k.traffic_target != null ? `<div class="leasing-kpi"><span class="lab">Traffic Target</span><b>${esc(k.traffic_target)}</b></div>` : ''}
      ${k.additional_traffic != null ? `<div class="leasing-kpi"><span class="lab">Additional Traffic</span><b>${esc(k.additional_traffic)}</b></div>` : ''}
    </div>` : '';

  const canReview = leasingCanReview();
  const notes = canReview
    ? `<div class="leasing-notes">
         <label class="small muted">Reviewer notes</label>
         <textarea id="leasing-notes-${esc(id)}" rows="3" class="crm-input" placeholder="Notes for Katie / the team…">${esc(s.notes || '')}</textarea>
         <button class="btn-sm primary" id="leasing-save-notes-${esc(id)}">Save notes</button>
       </div>`
    : (s.notes ? `<div class="leasing-notes"><label class="small muted">Reviewer notes</label><div class="report-group">${esc(s.notes)}</div></div>` : '');

  box.innerHTML = `
    ${portfolio}
    ${s.narrative ? `<div class="leasing-narrative"><label class="small muted">Narrative</label><div class="report-group">${esc(s.narrative)}</div></div>` : ''}
    <div class="leasing-sub-title">Per-property roll-up</div>
    ${rollup}
    ${notes}`;

  if (canReview) {
    $(`#leasing-save-notes-${CSS.escape(id)}`)?.addEventListener('click', () => {
      const val = $(`#leasing-notes-${CSS.escape(id)}`)?.value || '';
      leasingSaveNotes(id, val);
    });
  }
}

async function leasingSetStatus(id, status) {
  try {
    await api(`/api/leasing/submissions/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    const row = leasingState.subs.find(x => x.id === id); if (row) row.status = status;
    toast('Status updated', 'success');
  } catch (err) { toast(err.message, 'error'); leasingLoadHistory(); }
}

async function leasingSaveNotes(id, notes) {
  try {
    await api(`/api/leasing/submissions/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
    if (leasingState.detail[id]) leasingState.detail[id].notes = notes;
    toast('Notes saved', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// Read the tool's live state through the same-origin iframe (its getLeasingPayload
// bridge) and POST a snapshot for the current week.
async function leasingSubmit() {
  const frame = $('#leasing-frame');
  const win = frame?.contentWindow;
  if (!win || typeof win.getLeasingPayload !== 'function') {
    toast('The board is still loading — give it a moment and try again.', 'error');
    return;
  }
  const btn = $('#leasing-submit');
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    const captured = win.getLeasingPayload();
    const payload = {
      week_ending: leasingNextSunday(),
      submitted_by: currentUser?.name || 'Katie',
      narrative: captured.narrative || '',
      goals_json: captured.goals_json || null,
      data_json: captured.data_json || null,
      kpi_json: captured.kpi_json || null,
    };
    await api('/api/leasing/submissions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast('Weekly report submitted ✅', 'success');
    leasingState.detail = {};
    leasingLoadHistory();
  } catch (err) {
    toast('Submit failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ── Accounting / Billing (Claudia) ─────────────────────────────────────────
const acctState = { vendors: [], bills: [], tasks: [], vendorFilter: 'all', billFilter: 'all', wired: false };

async function loadAccounting() {
  if (!$('#acct-vendors-body')) return;
  if (!acctState.wired) {
    $('#acct-add-vendor')?.addEventListener('click', () => acctVendorModal());
    $('#acct-add-bill')?.addEventListener('click', () => acctBillModal());
    $('#acct-add-task')?.addEventListener('click', () => acctTaskModal());
    $('#acct-vendor-filter')?.addEventListener('change', e => { acctState.vendorFilter = e.target.value; acctRenderVendors(); });
    $('#acct-bill-filter')?.addEventListener('change', e => { acctState.billFilter = e.target.value; acctLoadBills(); });
    $('#acct-modal-close')?.addEventListener('click', acctCloseModal);
    $('#acct-modal-cancel')?.addEventListener('click', acctCloseModal);
    $('#acct-modal-overlay')?.addEventListener('click', acctCloseModal);
    acctState.wired = true;
  }
  await Promise.all([acctLoadVendors(), acctLoadBills(), acctLoadTasks()]);
}

const acctVendorName = id => acctState.vendors.find(v => v.id === id)?.name || '—';
const W9_BADGE = { on_file: 'badge-green', missing: 'badge-red', outdated: 'badge-yellow' };
const BILL_BADGE = { pending: 'badge-yellow', approved: 'badge-blue', paid: 'badge-green', disputed: 'badge-red' };
const PRIO_BADGE = { urgent: 'badge-red', normal: 'badge-gray', low: 'badge-gray' };

async function acctLoadVendors() {
  try { acctState.vendors = (await api('/api/accounting/vendors')).vendors || []; }
  catch (err) { $('#acct-vendors-body').innerHTML = `<tr><td colspan="8" class="small muted">${esc(err.message)}</td></tr>`; return; }
  acctRenderVendors();
}
function acctRenderVendors() {
  const body = $('#acct-vendors-body');
  const rows = acctState.vendorFilter === 'all'
    ? acctState.vendors : acctState.vendors.filter(v => v.w9_status === acctState.vendorFilter);
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="small muted">No vendors.</td></tr>'; return; }
  body.innerHTML = rows.map(v => `<tr>
    <td>${esc(v.name)}</td><td class="small">${esc(v.type || '—')}</td>
    <td><span class="badge ${W9_BADGE[v.w9_status] || 'badge-gray'}">${esc(v.w9_status || '—')}</span></td>
    <td class="small">${v.w9_year ?? '—'}</td>
    <td class="small">${esc(v.email || '—')}</td><td class="small">${esc(v.phone || '—')}</td>
    <td class="small">${esc((v.notes || '').slice(0, 50))}</td>
    <td><button class="btn-sm acct-edit-vendor" data-id="${v.id}">Edit</button></td></tr>`).join('');
  body.querySelectorAll('.acct-edit-vendor').forEach(b =>
    b.addEventListener('click', () => acctVendorModal(acctState.vendors.find(v => v.id === b.dataset.id))));
}

async function acctLoadBills() {
  const qs = acctState.billFilter === 'all' ? '' : `?status=${acctState.billFilter}`;
  try { acctState.bills = (await api('/api/accounting/bills' + qs)).bills || []; }
  catch (err) { $('#acct-bills-body').innerHTML = `<tr><td colspan="9" class="small muted">${esc(err.message)}</td></tr>`; return; }
  acctRenderBills();
}
function acctRenderBills() {
  const body = $('#acct-bills-body');
  if (!acctState.bills.length) { body.innerHTML = '<tr><td colspan="9" class="small muted">No bills.</td></tr>'; return; }
  const money = a => (a === null || a === undefined || a === '') ? '—' : '$' + Number(a).toLocaleString(undefined, { minimumFractionDigits: 2 });
  body.innerHTML = acctState.bills.map(b => `<tr>
    <td>${esc(acctVendorName(b.vendor_id))}</td><td class="small">${esc(b.property || '—')}</td>
    <td class="small">${esc(b.work_order_ref || '—')}</td><td class="small">${money(b.amount)}</td>
    <td><span class="badge ${BILL_BADGE[b.status] || 'badge-gray'}">${esc(b.status || '—')}</span></td>
    <td class="small">${esc(b.due_date || '—')}</td><td class="small">${esc(b.paid_date || '—')}</td>
    <td class="small">${esc((b.notes || '').slice(0, 40))}</td>
    <td><button class="btn-sm acct-edit-bill" data-id="${b.id}">Edit</button></td></tr>`).join('');
  body.querySelectorAll('.acct-edit-bill').forEach(btn =>
    btn.addEventListener('click', () => acctBillModal(acctState.bills.find(b => b.id === btn.dataset.id))));
}

async function acctLoadTasks() {
  try { acctState.tasks = (await api('/api/accounting/tasks')).tasks || []; }
  catch (err) { $('#acct-tasks-board').innerHTML = `<p class="small muted">${esc(err.message)}</p>`; return; }
  acctRenderTasks();
}
function acctRenderTasks() {
  const board = $('#acct-tasks-board');
  const cols = [['open', 'Open'], ['in_progress', 'In Progress'], ['done', 'Done']];
  board.innerHTML = cols.map(([key, label]) => {
    const items = acctState.tasks.filter(t => t.status === key);
    return `<div class="acct-col"><div class="acct-col-head">${label} <span class="muted small">(${items.length})</span></div>
      ${items.map(t => `<div class="acct-task-card">
        <div class="acct-task-title">${esc(t.title)}</div>
        <div class="acct-task-meta">
          ${t.type ? `<span class="badge badge-gray">${esc(t.type)}</span>` : ''}
          <span class="badge ${PRIO_BADGE[t.priority] || 'badge-gray'}">${esc(t.priority || 'normal')}</span>
          <span class="muted small">${esc(t.assigned_to || '')}</span>
          ${t.due_date ? `<span class="muted small">· due ${esc(t.due_date)}</span>` : ''}
        </div>
        ${t.notes ? `<div class="small muted" style="margin-top:4px">${esc(t.notes.slice(0, 80))}</div>` : ''}
        <div class="acct-task-actions">
          <button class="btn-sm acct-edit-task" data-id="${t.id}">Edit</button>
          ${t.status !== 'done' ? `<button class="btn-sm acct-done-task" data-id="${t.id}">✓ Done</button>` : ''}
        </div></div>`).join('') || '<p class="small muted">—</p>'}</div>`;
  }).join('');
  board.querySelectorAll('.acct-edit-task').forEach(b =>
    b.addEventListener('click', () => acctTaskModal(acctState.tasks.find(t => t.id === b.dataset.id))));
  board.querySelectorAll('.acct-done-task').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api(`/api/accounting/tasks/${b.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) }); acctLoadTasks(); }
      catch (err) { toast(err.message, 'error'); }
    }));
}

// ── Shared modal ───────────────────────────────────────────────────────────
// fields: [{ name, label, type:'text'|'number'|'date'|'select'|'textarea', options?, value? }]
function acctModal(title, fields, onSave) {
  $('#acct-modal-title').textContent = title;
  $('#acct-modal-fields').innerHTML = fields.map(f => {
    const v = f.value ?? '';
    if (f.type === 'select') {
      return `<label class="acct-field"><span>${esc(f.label)}</span>
        <select name="${f.name}" class="crm-select">${f.options.map(o =>
          `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="acct-field"><span>${esc(f.label)}</span><textarea name="${f.name}" class="crm-input" rows="2">${esc(v)}</textarea></label>`;
    }
    return `<label class="acct-field"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type || 'text'}" class="crm-input" value="${esc(v)}"></label>`;
  }).join('');
  const form = $('#acct-modal-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {};
    for (const f of fields) {
      let val = form.elements[f.name]?.value;
      if (val === '') val = '';
      payload[f.name] = f.type === 'number' && val !== '' ? Number(val) : val;
    }
    try { await onSave(payload); acctCloseModal(); }
    catch (err) { toast(err.message, 'error'); }
  };
  $('#acct-modal').classList.remove('hidden');
}
function acctCloseModal() { $('#acct-modal')?.classList.add('hidden'); }

function acctVendorModal(v) {
  const edit = !!v;
  acctModal(edit ? 'Edit Vendor' : 'Add Vendor', [
    { name: 'name', label: 'Name', value: v?.name },
    { name: 'type', label: 'Type', type: 'select', options: ['vendor', 'contractor', 'utility'], value: v?.type || 'vendor' },
    { name: 'w9_status', label: 'W9 Status', type: 'select', options: ['missing', 'on_file', 'outdated'], value: v?.w9_status || 'missing' },
    { name: 'w9_year', label: 'W9 Year', type: 'number', value: v?.w9_year },
    { name: 'email', label: 'Email', value: v?.email },
    { name: 'phone', label: 'Phone', value: v?.phone },
    { name: 'notes', label: 'Notes', type: 'textarea', value: v?.notes },
  ], async (payload) => {
    const url = edit ? `/api/accounting/vendors/${v.id}` : '/api/accounting/vendors';
    await api(url, { method: edit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    acctLoadVendors();
  });
}

function acctBillModal(b) {
  const edit = !!b;
  acctModal(edit ? 'Edit Bill' : 'Add Bill', [
    { name: 'vendor_id', label: 'Vendor', type: 'select',
      options: ['', ...acctState.vendors.map(v => v.id)], value: b?.vendor_id || '' },
    { name: 'property', label: 'Property', value: b?.property },
    { name: 'work_order_ref', label: 'WO Ref', value: b?.work_order_ref },
    { name: 'amount', label: 'Amount', type: 'number', value: b?.amount },
    { name: 'status', label: 'Status', type: 'select', options: ['pending', 'approved', 'paid', 'disputed'], value: b?.status || 'pending' },
    { name: 'due_date', label: 'Due Date', type: 'date', value: b?.due_date },
    { name: 'paid_date', label: 'Paid Date', type: 'date', value: b?.paid_date },
    { name: 'notes', label: 'Notes', type: 'textarea', value: b?.notes },
  ], async (payload) => {
    const url = edit ? `/api/accounting/bills/${b.id}` : '/api/accounting/bills';
    await api(url, { method: edit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    acctLoadBills();
  });
  // The vendor select shows ids; relabel its options to names after render.
  const sel = $('#acct-modal-form')?.elements['vendor_id'];
  if (sel) Array.from(sel.options).forEach(o => { o.textContent = o.value ? acctVendorName(o.value) : '— none —'; });
}

function acctTaskModal(t) {
  const edit = !!t;
  acctModal(edit ? 'Edit Task' : 'Add Task', [
    { name: 'title', label: 'Title', value: t?.title },
    { name: 'type', label: 'Type', type: 'select', options: ['qc_review', 'vendor_payment', 'utility_billing', 'w9_followup', 'other'], value: t?.type || 'qc_review' },
    { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'done'], value: t?.status || 'open' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['urgent', 'normal', 'low'], value: t?.priority || 'normal' },
    { name: 'assigned_to', label: 'Assigned to', value: t?.assigned_to || 'Claudia' },
    { name: 'due_date', label: 'Due Date', type: 'date', value: t?.due_date },
    { name: 'notes', label: 'Notes', type: 'textarea', value: t?.notes },
  ], async (payload) => {
    const url = edit ? `/api/accounting/tasks/${t.id}` : '/api/accounting/tasks';
    await api(url, { method: edit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    acctLoadTasks();
  });
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

// Task Manager ▸ Asana Tasks. Fetched on first switch rather than on page load:
// it is 183 tasks over the network and most visits to this tab never open it.
$$('#tasks-panel-switch .pill').forEach(p => p.addEventListener('click', () => {
  const panel = p.dataset.panel;
  $$('#tasks-panel-switch .pill').forEach(q => q.classList.toggle('active', q === p));
  $('#tasks-panel-own')?.classList.toggle('hidden', panel !== 'own');
  $('#tasks-panel-asana')?.classList.toggle('hidden', panel !== 'asana');
  if (panel === 'asana' && !asanaPanelLoaded) { asanaPanelLoaded = true; loadAsanaPanel(); }
}));
$('#asana-panel-refresh')?.addEventListener('click', loadAsanaPanel);
$$('#asana-panel-pills .pill').forEach(p => p.addEventListener('click', () => {
  asanaPanelFilter = p.dataset.time;
  $$('#asana-panel-pills .pill').forEach(q => q.classList.toggle('active', q === p));
  asanaBoardRender('default');
}));
$$('#task-status-pills .pill').forEach(p => p.addEventListener('click', () => { taskStatusFilter = p.dataset.status; renderTasks(); }));

// =====================================================================
// SOPs — expandable cards with formatted content + Slab links
// =====================================================================

// ── SOPs library — grouped by category, collapsible, archivable ────────────
const SOP_CATEGORY_ORDER = ['Email Management', 'Calendar Management', 'Operations', 'Platform Build', 'SimpleVOIP / Call Analyzer', 'Technical Setup', 'Executive Operations'];
const SOP_CAT_ICON = { 'Email Management': '📧', 'Calendar Management': '📅', 'Operations': '⚙️', 'Platform Build': '🏗️', 'SimpleVOIP / Call Analyzer': '📞', 'Technical Setup': '🔧', 'Executive Operations': '👑', '(Uncategorized)': '📄' };
let sopAll = [];
let openSopId = null;
let sopQuery = '';
let sopServerTextIds = new Set();
const sopDetailCache = {};
const sopCatCollapsed = {};        // category -> collapsed? (absent/true = collapsed by default)
const sopIsAdmin = () => currentUser?.role === 'admin';

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

// esc + wrap query matches in <mark>. q is a lowercased plain string.
function sopHighlight(text, q) {
  const s = esc(String(text ?? ''));
  if (!q) return s;
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return s.replace(re, '<mark>$1</mark>');
}

async function loadSops() {
  const list = $('#sop-list');
  if (!list) return;
  // Fetch everything (archived included, each flagged) and filter client-side,
  // so the "Show archived" toggle and search are instant. Wrapped so a failure
  // shows a message instead of a blank page.
  try {
    const resp = await api('/api/sops?include_archived=true');
    // The endpoint returns a plain array. Coerce defensively so a wrapped shape
    // ({sops:[...]}) or an empty non-array response can never leave the list at 0.
    sopAll = Array.isArray(resp) ? resp : (resp?.sops || resp?.rows || []);
  } catch (err) {
    list.innerHTML = `<p class="hint">Could not load SOPs: ${esc(err.message)}</p>`;
    return;
  }
  renderSops();
}

const sopCatOf = (s) => (s.category || '').trim() || '(Uncategorized)';
const sopClientMatch = (s, q) =>
  [s.title, s.source, (s.tags || []).join(' '), s.category].filter(Boolean).join(' ').toLowerCase().includes(q);

function sopCardHtml(s, q, admin) {
  const isOpen = s.id === openSopId;
  const detail = sopDetailCache[s.id];
  const tags = (s.tags || []).map(t => `<span class="sop-pill">${sopHighlight(t, q)}</span>`).join('');
  const dateStr = s.uploadedAt ? new Date(s.uploadedAt).toLocaleDateString() : '';
  const meta = [s.source ? sopHighlight(s.source, q) : '', dateStr].filter(Boolean).join(' · ');
  return `<div class="sop-card project-card${isOpen ? ' open' : ''}${s.archived ? ' sop-archived' : ''}" data-id="${s.id}">
    <div class="project-head" data-sop-toggle="${s.id}">
      <div>
        <div class="project-title">${sopHighlight(s.title, q)} ${s.archived ? '<span class="badge badge-gray">Archived</span>' : ''}</div>
        ${meta ? `<div class="muted small" style="margin-top:3px">${meta}</div>` : ''}
        ${tags ? `<div style="margin-top:5px">${tags}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${admin ? `<button class="btn-sm sop-edit" data-id="${s.id}">Edit</button>
                   <button class="btn-sm sop-archive" data-id="${s.id}">${s.archived ? 'Unarchive' : 'Archive'}</button>` : ''}
        <span class="muted small">${s.chars}c</span>
        <span class="project-toggle">▶</span>
      </div>
    </div>
    <div class="project-body">
      ${isOpen ? (detail ? `
        ${s.slab_url ? `<a class="btn-sm primary slab-link" href="${esc(s.slab_url)}" target="_blank" rel="noopener">Open in Slab →</a>` : ''}
        <div class="sop-content">${q ? sopHighlight(detail.text, q) : formatSopContent(detail.text)}</div>
        <p class="muted small" style="margin-top:12px">Last updated: ${detail.uploadedAt ? new Date(detail.uploadedAt).toLocaleString() : '—'}</p>
      ` : '<p class="muted small">Loading...</p>') : ''}
    </div>
  </div>`;
}

function renderSops() {
  const list = $('#sop-list');
  if (!list) return;
  const showArchived = $('#sop-show-archived')?.checked;
  const q = sopQuery.trim().toLowerCase();

  $('#sop-total').textContent = sopAll.length;
  let items = sopAll.slice();
  if (!showArchived) items = items.filter(s => !s.archived);
  if (q) items = items.filter(s => sopClientMatch(s, q) || sopServerTextIds.has(s.id));

  // Category datalist for the edit modal.
  const dl = $('#sop-cat-list');
  if (dl) dl.innerHTML = [...new Set([...SOP_CATEGORY_ORDER, ...sopAll.map(sopCatOf)])]
    .filter(c => c !== '(Uncategorized)').map(c => `<option value="${esc(c)}">`).join('');

  if (!items.length) { list.innerHTML = `<p class="hint">${q ? 'No SOPs match your search.' : 'No SOPs yet.'}</p>`; return; }

  const groups = new Map();
  for (const s of items) { const c = sopCatOf(s); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(s); }
  const orderedCats = [
    ...SOP_CATEGORY_ORDER.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !SOP_CATEGORY_ORDER.includes(c) && c !== '(Uncategorized)').sort(),
    ...(groups.has('(Uncategorized)') ? ['(Uncategorized)'] : []),
  ];

  const admin = sopIsAdmin();
  list.innerHTML = orderedCats.map(cat => {
    const sops = groups.get(cat).slice().sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)); // active first
    const collapsed = q ? false : (sopCatCollapsed[cat] !== false);   // searching forces expand
    const icon = SOP_CAT_ICON[cat] || '📄';
    return `<div class="sop-cat">
      <div class="sop-cat-head" data-cat-toggle="${esc(cat)}">
        <span>${collapsed ? '▶' : '▼'} ${icon} ${esc(cat)} <span class="muted">(${sops.length})</span></span>
      </div>
      <div class="sop-cat-body${collapsed ? ' hidden' : ''}">
        ${sops.map(s => sopCardHtml(s, q, admin)).join('')}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-cat-toggle]').forEach(h => h.addEventListener('click', () => {
    const cat = h.getAttribute('data-cat-toggle');
    sopCatCollapsed[cat] = !(sopCatCollapsed[cat] !== false);   // flip; default (absent) = collapsed
    renderSops();
  }));
  list.querySelectorAll('[data-sop-toggle]').forEach(h => h.addEventListener('click', (e) => {
    if (e.target.closest('.sop-edit') || e.target.closest('.sop-archive')) return;   // buttons handle themselves
    toggleSop(h.getAttribute('data-sop-toggle'));
  }));
  list.querySelectorAll('.sop-edit').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); sopEditModal(sopAll.find(s => s.id === b.dataset.id)); }));
  list.querySelectorAll('.sop-archive').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const s = sopAll.find(x => x.id === b.dataset.id);
    try {
      await api(`/api/sops/${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: !s.archived }) });
      toast(s.archived ? 'Unarchived' : 'Archived', 'success');
      loadSops();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

async function toggleSop(id) {
  if (openSopId === id) { openSopId = null; renderSops(); return; }
  openSopId = id;
  if (!sopDetailCache[id]) {
    renderSops();   // show "Loading..." immediately
    try { sopDetailCache[id] = await api(`/api/sops/${encodeURIComponent(id)}`); }
    catch (err) { toast(err.message, 'error'); return; }
  }
  renderSops();
}

// ── Search ──────────────────────────────────────────────────────────────────
$('#sop-search')?.addEventListener('input', async (e) => {
  sopQuery = e.target.value;
  const q = sopQuery.trim();
  // The list only carries title/source/tags/category; hit the server's
  // full-text search too so the query also matches SOP body text.
  if (q.length >= 2) {
    try { const { results } = await api(`/api/sops/search/${encodeURIComponent(q)}`); sopServerTextIds = new Set((results || []).map(r => r.id)); }
    catch { sopServerTextIds = new Set(); }
  } else {
    sopServerTextIds = new Set();
  }
  renderSops();
});
$('#sop-show-archived')?.addEventListener('change', renderSops);

// ── Edit modal (admin) ────────────────────────────────────────────────────
let sopEditId = null;
function sopEditModal(s) {
  if (!s) return;
  sopEditId = s.id;
  const f = $('#sop-edit-form');
  f.elements.title.value = s.title || '';
  f.elements.category.value = s.category || '';
  f.elements.tags.value = (s.tags || []).join(', ');
  $('#sop-edit-modal').classList.remove('hidden');
}
function sopEditClose() { $('#sop-edit-modal')?.classList.add('hidden'); sopEditId = null; }
$('#sop-edit-close')?.addEventListener('click', sopEditClose);
$('#sop-edit-cancel')?.addEventListener('click', sopEditClose);
$('#sop-edit-overlay')?.addEventListener('click', sopEditClose);
$('#sop-edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    title: f.elements.title.value.trim(),
    category: f.elements.category.value.trim() || null,
    tags: f.elements.tags.value.split(',').map(t => t.trim()).filter(Boolean),
  };
  try {
    await api(`/api/sops/${encodeURIComponent(sopEditId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    sopEditClose();
    toast('SOP updated', 'success');
    loadSops();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Add SOP (unchanged behavior) ────────────────────────────────────────────
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

// A meeting is past once it has ENDED, so one in progress still counts as
// upcoming. The comparison is instant against instant — the calendar sends
// absolute times, so this is correct from a browser in Venezuela reading a
// Central calendar without consulting the server's clock. Comparing wall-clock
// strings is what would have needed a timezone.
function meetingHasEnded(m, now) {
  const e = Date.parse(m.end || '');
  // No end time: fall back to the start, so an undated meeting still sorts and
  // groups rather than silently landing in Upcoming forever.
  return (Number.isFinite(e) ? e : Date.parse(m.start || '')) < now;
}

function meetingCard(m, i, isLyndsay, isPast) {
  return `
    <div class="card meeting-card${isPast ? ' meeting-past' : ''}" style="margin-bottom:8px" data-start="${esc(m.start || '')}" data-subject="${esc(m.subject || '')}">
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
      ${isLyndsay && !m.isCancelled && !isPast ? `
        <div class="card-actions">
          <button class="btn-sm add-reminder-btn" data-idx="${i}">+ Add Reminder</button>
          <span class="meeting-action-btns"></span>
        </div>` : ''}
    </div>`;
}

function renderMeetings(list, isLyndsay) {
  if (!list || !list.length) return '<p class="muted small">No meetings today (or stub mode).</p>';
  const now = Date.now();

  // The original index travels with each meeting. The Add Reminder button
  // carries it in data-idx and the click handler reads it straight back out of
  // lyndsayTodayCache, so reordering without keeping it would schedule a
  // reminder for whichever meeting happened to land in that slot.
  const rows = list.map((m, i) => ({ m, i, past: meetingHasEnded(m, now) }));
  const byStart = (a, b) => (Date.parse(a.m.start || '') || 0) - (Date.parse(b.m.start || '') || 0);
  const upcoming = rows.filter(r => !r.past).sort(byStart);
  const past = rows.filter(r => r.past).sort(byStart);

  const group = (title, items, isPast) => items.length ? `
    <div class="meeting-group">
      <div class="meeting-group-head">${title} <span class="muted small">(${items.length})</span></div>
      ${items.map(r => meetingCard(r.m, r.i, isLyndsay, isPast)).join('')}
    </div>` : '';

  // With nothing upcoming the "Past" heading is the only one, and with nothing
  // past there is no second group to distinguish it from — a lone header over
  // the only list is noise either way.
  if (!upcoming.length) return past.map(r => meetingCard(r.m, r.i, isLyndsay, true)).join('');
  if (!past.length) return upcoming.map(r => meetingCard(r.m, r.i, isLyndsay, false)).join('');
  return group('Upcoming', upcoming, false) + group('Past', past, true);
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

// Writes today's unread counts into the SharePoint "Inbox Tracking" sheet.
// Admin-only server-side (requireMetricAdmin); the result names how many rows
// were written and which were skipped (label missing from column A, etc.).
$('#inbox-tracking-sync-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const btn = $('#inbox-tracking-sync-btn');
  const out = $('#inbox-tracking-sync-result');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '⏳ Syncing…';
  if (out) out.textContent = '';
  try {
    const r = await api('/api/email/inbox-tracking/sync-excel', { method: 'POST' });
    const results = r.results || [];
    const written = results.filter(x => x.unread !== undefined && x.skipped === undefined && x.error === undefined);
    const skipped = results.filter(x => x.skipped !== undefined);
    const errored = results.filter(x => x.error !== undefined);
    let msg = `✅ ${written.length} row${written.length === 1 ? '' : 's'} written to column ${esc(r.column || '?')}`;
    if (skipped.length) msg += ` · ⏭️ ${skipped.length} skipped`;
    if (errored.length) msg += ` · ⚠️ ${errored.length} errored`;
    const detail = [...skipped, ...errored]
      .map(x => `${esc(x.rowLabel || x.email || '?')}: ${esc(x.skipped || x.error)}`);
    if (out) out.innerHTML = msg + (detail.length ? `<br><span class="muted">${detail.join('<br>')}</span>` : '');
    loadInboxTracking();
  } catch (err) {
    if (out) out.innerHTML = `<span class="badge badge-red">Sync failed</span> ${esc(err.message)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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

  loadAutoMove();
}

// ── Auto-Move Controls (admin only) ────────────────────────────────────────
// The panel stays hidden for non-admins. Even if it were shown, the toggle and
// status routes are requireMetricAdmin server-side, so hiding is convenience,
// not the access control.
let autoMoveWired = false;

async function loadAutoMove() {
  const panel = $('#automove-panel');
  if (!panel) return;
  if (currentUser?.role !== 'admin') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!autoMoveWired) {
    $('#automove-enabled').addEventListener('click', () => autoMoveToggle('enabled'));
    $('#automove-dryrun').addEventListener('click', () => autoMoveToggle('dryRun'));
    $('#automove-refresh')?.addEventListener('click', loadAutoMove);
    autoMoveWired = true;
  }

  try {
    const s = await api('/api/email/auto-move/status');
    autoMoveRenderState(s);
  } catch (err) {
    $('#automove-status').innerHTML = `<span class="badge badge-red">Status unavailable</span> <span class="small muted">${esc(err.message)}</span>`;
  }
  autoMoveLoadLog();
  amWireRules();
}

// ── Auto-Move Rules manager (Phase 2) ──────────────────────────────────────
const AM_MATCH_TYPES = ['sender_exact', 'sender_domain', 'header', 'subject_contains', 'subject_startswith'];
const AM_ACTIONS = ['move', 'move_read', 'archive', 'archive_read', 'move_unsubscribe'];
let amRules = [], amRulesWired = false, amRulesLoaded = false;

// Wires the collapsible section and its controls once. The rules table is not
// fetched until the section is first expanded (default collapsed).
function amWireRules() {
  if (amRulesWired) return;
  const toggle = $('#am-rules-toggle');
  toggle?.addEventListener('click', () => {
    const box = $('#am-rules-collapse');
    const collapsed = box.classList.toggle('hidden');
    $('#am-rules-caret').textContent = collapsed ? '▶' : '▼';
    if (!collapsed && !amRulesLoaded) amLoadRules();   // load on first expand
  });
  $('#am-rule-add')?.addEventListener('click', () => amRuleModal());
  $('#am-rules-refresh')?.addEventListener('click', amLoadRules);
  $('#am-rule-modal-close')?.addEventListener('click', amRuleCloseModal);
  $('#am-rule-cancel')?.addEventListener('click', amRuleCloseModal);
  $('#am-rule-modal-overlay')?.addEventListener('click', amRuleCloseModal);
  amRulesWired = true;
}

async function amLoadRules() {
  const body = $('#am-rules-body');
  if (!body) return;
  try {
    amRules = (await api('/api/email/auto-move/rules')).rules || [];
    amRulesLoaded = true;
  } catch (err) { body.innerHTML = `<tr><td colspan="9" class="small muted">${esc(err.message)}</td></tr>`; return; }
  amRenderRules();
}

function amRenderRules() {
  const body = $('#am-rules-body');
  if (!amRules.length) { body.innerHTML = '<tr><td colspan="9" class="small muted">No rules yet.</td></tr>'; return; }
  body.innerHTML = amRules.map(r => `<tr${r.active ? '' : ' style="opacity:.5"'}>
    <td class="small">${r.priority}</td>
    <td class="small">${esc(r.match_type)}</td>
    <td class="small">${esc(r.match_value)}</td>
    <td class="small">${esc(r.action)}</td>
    <td class="small">${esc(r.target_folder || '—')}</td>
    <td class="small">${r.mark_read ? '✓' : ''}</td>
    <td><button class="btn-sm am-rule-toggle" data-id="${r.id}">${r.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Off</span>'}</button></td>
    <td class="small">${esc((r.notes || '').slice(0, 40))}</td>
    <td><button class="btn-sm am-rule-edit" data-id="${r.id}">Edit</button></td></tr>`).join('');
  body.querySelectorAll('.am-rule-edit').forEach(b => b.addEventListener('click', () => amRuleModal(amRules.find(r => r.id === b.dataset.id))));
  body.querySelectorAll('.am-rule-toggle').forEach(b => b.addEventListener('click', async () => {
    const r = amRules.find(x => x.id === b.dataset.id);
    try {
      // Toggle: reactivating uses PATCH active:true; deactivating uses the soft-delete route.
      if (r.active) await api(`/api/email/auto-move/rules/${r.id}`, { method: 'DELETE' });
      else await api(`/api/email/auto-move/rules/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) });
      amLoadRules();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

function amRuleCloseModal() { $('#am-rule-modal')?.classList.add('hidden'); }

function amRuleModal(rule) {
  const edit = !!rule;
  $('#am-rule-modal-title').textContent = edit ? 'Edit Rule' : 'Add Rule';
  const field = (label, name, type, value, options) => {
    if (type === 'select') return `<label class="acct-field"><span>${label}</span><select name="${name}" class="crm-select">${options.map(o => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (type === 'checkbox') return `<label class="acct-field" style="flex-direction:row;align-items:center;gap:8px"><input name="${name}" type="checkbox"${value ? ' checked' : ''}><span>${label}</span></label>`;
    return `<label class="acct-field"><span>${label}</span><input name="${name}" type="${type}" class="crm-input" value="${esc(value ?? '')}"></label>`;
  };
  $('#am-rule-fields').innerHTML =
    field('Priority (lower = first)', 'priority', 'number', rule?.priority ?? 50)
    + field('Match Type', 'match_type', 'select', rule?.match_type || 'sender_domain', AM_MATCH_TYPES)
    + field('Match Value', 'match_value', 'text', rule?.match_value)
    + field('Action', 'action', 'select', rule?.action || 'move', AM_ACTIONS)
    + field('Target Folder (blank for archive)', 'target_folder', 'text', rule?.target_folder)
    + field('Mark read', 'mark_read', 'checkbox', rule?.mark_read)
    + field('Active', 'active', 'checkbox', rule ? rule.active : true)
    + field('Notes', 'notes', 'text', rule?.notes);
  const form = $('#am-rule-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      priority: Number(form.elements.priority.value) || 50,
      match_type: form.elements.match_type.value,
      match_value: form.elements.match_value.value.trim(),
      action: form.elements.action.value,
      target_folder: form.elements.target_folder.value.trim() || null,
      mark_read: form.elements.mark_read.checked,
      active: form.elements.active.checked,
      notes: form.elements.notes.value.trim() || null,
    };
    try {
      const url = edit ? `/api/email/auto-move/rules/${rule.id}` : '/api/email/auto-move/rules';
      await api(url, { method: edit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      amRuleCloseModal(); amLoadRules();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#am-rule-modal').classList.remove('hidden');
}

function autoMoveRenderState(s) {
  if ($('#automove-interval')) $('#automove-interval').textContent = s.intervalMinutes ?? 15;

  const enBtn = $('#automove-enabled');
  const dryBtn = $('#automove-dryrun');
  // Buttons show the CURRENT state; clicking flips it. data-next carries the
  // value the toggle will send, so the handler never re-reads the label.
  enBtn.textContent = s.enabled ? 'ON' : 'OFF';
  enBtn.className = 'toggle-btn ' + (s.enabled ? 'toggle-on' : 'toggle-off');
  enBtn.dataset.next = s.enabled ? 'false' : 'true';
  enBtn.disabled = false;

  // Dry Run only means anything while enabled. When disabled, grey it out so
  // nobody reads a stale "ON"/"OFF" as if it were doing something.
  dryBtn.textContent = s.dryRun ? 'ON' : 'OFF';
  dryBtn.className = 'toggle-btn ' + (!s.enabled ? 'toggle-muted' : (s.dryRun ? 'toggle-warn' : 'toggle-live'));
  dryBtn.dataset.next = s.dryRun ? 'false' : 'true';
  dryBtn.disabled = false;

  const status = $('#automove-status');
  if (!s.enabled) {
    status.innerHTML = `<span class="badge badge-gray">OFF</span> <span class="small muted">Auto-Move is disabled — nothing is evaluated or moved.</span>`;
  } else if (s.dryRun) {
    status.innerHTML = `<span class="badge badge-yellow">DRY RUN</span> <span class="small">Running in dry run — logging only, no emails moved.</span>`;
  } else {
    status.innerHTML = `<span class="badge badge-green">LIVE</span> <span class="small">LIVE — emails are being moved automatically.</span>`;
  }

  const fmt = ts => ts ? new Date(ts).toLocaleString() : '—';
  // Last checked = the cron heartbeat (every ~15 min even when disabled). If it
  // is stale by much more than the interval, the scheduler stopped — distinct
  // from Last run, which only advances when the runner actually executes.
  let meta = `Last run: ${fmt(s.lastRun)} · Last checked: ${fmt(s.lastTick)} · Actions logged today: ${s.processedToday ?? 0}`;
  if (s.lastTick) {
    const mins = Math.round((Date.now() - new Date(s.lastTick).getTime()) / 60000);
    const stale = mins > (s.intervalMinutes || 15) * 2 + 2;
    if (stale) meta += ` · ⚠️ scheduler may be stalled (${mins}m since last check)`;
  }
  if (s.lastError) meta += ` · last error: ${s.lastError}`;
  $('#automove-meta').textContent = meta;
}

async function autoMoveToggle(setting) {
  const btn = setting === 'enabled' ? $('#automove-enabled') : $('#automove-dryrun');
  const value = btn.dataset.next === 'true';

  // Turning dry run OFF while enabled means real mail starts moving. Confirm.
  if (setting === 'dryRun' && value === false && $('#automove-enabled').textContent === 'ON') {
    if (!confirm('Turn OFF dry run?\n\nAuto-Move will start moving real emails in Lyndsay\'s inbox automatically on its next run.')) return;
  }

  btn.disabled = true;
  try {
    await api('/api/email/auto-move/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setting, value }),
    });
  } catch (err) {
    alert('Could not change the setting: ' + err.message);
  }
  loadAutoMove();
}

const AM_PAGE = 25;
let amOffset = 0;
let amLogWired = false;

// Reads the filter controls into a query string shared by the log fetch and the
// CSV export, so what you see is exactly what you download.
function amFilterParams() {
  const p = new URLSearchParams();
  const from = $('#am-f-from')?.value, to = $('#am-f-to')?.value;
  const action = $('#am-f-action')?.value, dry = $('#am-f-dry')?.value;
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (action && action !== 'all') p.set('action', action);
  if (dry && dry !== 'all') p.set('dryRun', dry);
  return p;
}

// Move verification state. Dry-run rows made no move, so verification is N/A.
// verified true = confirmed in the destination folder; false = landed elsewhere
// (also carries an error); null = moved but the folder could not be confirmed
// (and legacy rows from before verification existed).
function amVerifiedCell(r) {
  if (r.dry_run) return '<span class="muted">—</span>';
  if (r.verified === true) return '<span class="badge badge-green" title="Confirmed in destination folder">✓ Verified</span>';
  if (r.verified === false) return '<span class="badge badge-red" title="Landed in the wrong folder">✗ Unverified</span>';
  if (r.error) return '';   // the Error column already explains it
  return '<span class="badge badge-gray" title="Moved, folder not confirmed">? Unconfirmed</span>';
}

function amRenderRows(rows, append) {
  const body = $('#automove-log-body');
  if (!body) return;
  const html = rows.map(r => `<tr>
    <td class="mono small">${r.executed_at ? new Date(r.executed_at).toLocaleString() : '—'}</td>
    <td class="small">${esc(r.sender || '—')}</td>
    <td class="small">${esc((r.subject || '').slice(0, 60))}</td>
    <td class="small">${esc(r.action || '—')}</td>
    <td class="small">${esc(r.target_folder || 'Archive')}</td>
    <td class="small">${r.dry_run ? '✓' : ''}</td>
    <td class="small">${amVerifiedCell(r)}</td>
    <td class="small">${r.error ? `<span class="badge badge-red">${esc(r.error.slice(0, 40))}</span>` : ''}</td>
  </tr>`).join('');
  if (append) body.insertAdjacentHTML('beforeend', html);
  else body.innerHTML = html || `<tr><td colspan="8" class="small muted">No actions match these filters.</td></tr>`;
}

// reset=true starts a fresh query (offset 0, replaces rows); false appends the
// next page for "Load more".
async function autoMoveLoadLog(reset = true) {
  const body = $('#automove-log-body');
  if (!body) return;

  if (!amLogWired) {
    $('#am-f-apply')?.addEventListener('click', () => autoMoveLoadLog(true));
    $('#am-f-clear')?.addEventListener('click', () => {
      ['am-f-from', 'am-f-to'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; });
      $('#am-f-action').value = 'all'; $('#am-f-dry').value = 'all';
      autoMoveLoadLog(true);
    });
    $('#am-load-more')?.addEventListener('click', () => autoMoveLoadLog(false));
    $('#am-export')?.addEventListener('click', () => {
      const p = amFilterParams(); p.set('format', 'csv');
      window.location.href = '/api/email/auto-move/log?' + p.toString();
    });
    amLogWired = true;
  }

  if (reset) amOffset = 0;
  const p = amFilterParams();
  p.set('limit', AM_PAGE); p.set('offset', amOffset);

  try {
    const d = await api('/api/email/auto-move/log?' + p.toString());
    if (reset && d.summary) {
      $('#automove-summary').innerHTML =
        `<span class="am-stat"><b>${d.summary.today}</b> moved today</span>`
        + `<span class="am-stat"><b>${d.summary.week}</b> this week</span>`
        + `<span class="am-stat"><b>${d.summary.month}</b> this month</span>`
        + `<span class="small muted">(live moves only)</span>`;
    }
    amRenderRows(d.entries || [], !reset);

    const total = d.page?.total ?? (d.entries || []).length;
    amOffset += (d.entries || []).length;
    const more = $('#am-load-more');
    if (more) more.style.display = amOffset < total ? '' : 'none';
    const cnt = $('#am-log-count');
    if (cnt) cnt.textContent = total ? `Showing ${Math.min(amOffset, total)} of ${total}` : '';
  } catch (err) {
    if (reset) body.innerHTML = `<tr><td colspan="6" class="small muted">Log unavailable: ${esc(err.message)}</td></tr>`;
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
  // Blank until chosen. It used to default to 'Lyndsay', which quietly credited
  // her with whatever anyone else logged — and Team Performance reads exactly
  // this field.
  agent: '',
  // Active property in modal
  activeProperty: null,
  activeModalTab: 'overview',
  // DM review in-progress scores
  dmScores: { website: {}, floorplan: {}, gbp: {}, facebook: {}, ils: {} },
};

// Returned the parsed body whatever the status, so a failed request arrived as
// { error: '…' } and read like data. Callers went on to their success path: the
// online shop form closed and re-rendered as if the row had been written, when
// the insert had in fact been rejected and every shop logged through it was
// lost. Errors now throw, which is what the catch around every call site was
// already written for.
async function crmFetch(path, opts) {
  const r = await fetch(path, opts);
  // Parsed first: the error message is in the body, and a 500 from a proxy may
  // not carry JSON at all, in which case the status is all there is to report.
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || r.statusText || `Request failed (${r.status})`);
  return data;
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
  if (view === 'settings') {
    crmLoadTargeted();
    if (crmCanAssign()) crmLoadAssignments();
    if (crmIsAdmin()) crmLoadGbRotation();
  }
  if (view === 'roster' && crmCanSeeRoster()) crmLoadRoster();
  if (view === 'performance' && crmCanSeePerformance()) crmLoadTeamPerformance();
}

$$('.crm-nav-btn').forEach(btn =>
  btn.addEventListener('click', () => crmSetView(btn.dataset.crmView))
);

function crmMarkAgentChoice() {
  const sel = $('#crm-agent-select');
  // Not while it is pinned: a locked role has no choice to make, and outlining
  // a control they cannot use would read as an error.
  if (sel) sel.classList.toggle('needs-choice', !sel.value && !sel.disabled);
}
$('#crm-agent-select').addEventListener('change', e => {
  crmState.agent = e.target.value;
  crmMarkAgentChoice();
});
crmMarkAgentChoice();

// Mirrors the server guard on GET /api/crm/bd-agents. An allowlist, not a list of
// roles to exclude: a role added later is hidden by default rather than shown
// until someone remembers to add it here.
const CRM_ROSTER_ROLES = ['admin', 'operations'];
const crmCanSeeRoster = () => CRM_ROSTER_ROLES.includes(currentUser?.role);

// Resolves who to attribute an activity row to: the form's own selector where it
// has one, otherwise the "Working as" choice. Returns null and says so rather
// than writing a row nobody can be credited with — an unattributed row is
// invisible to Team Performance and cannot be fixed afterwards from the UI.
function crmResolveAgent(explicit) {
  const agent = String(explicit || crmState.agent || '').trim();
  if (!agent) {
    toast('Please select an agent before logging activity.', 'error');
    return null;
  }
  return agent;
}

function crmApplyUserRole() {
  if (!currentUser) return;

  // Runs for every role, so it sits above the early return below — that only
  // concerns the two roles pinned to a single agent. The roster carries internal
  // staff emails and phone numbers, so anyone the server would refuse is not
  // offered the button either: a nav item that answers "Access denied" reads as
  // broken rather than as restricted.
  if (!crmCanSeeRoster()) {
    $('.crm-nav-btn[data-crm-view="roster"]')?.classList.add('hidden');
    if (crmState.view === 'roster') crmSetView('dashboard');
  }
  if (!crmCanSeePerformance()) {
    $('.crm-nav-btn[data-crm-view="performance"]')?.classList.add('hidden');
    if (crmState.view === 'performance') crmSetView('dashboard');
  }
  // Settings itself stays open to everyone who reaches the CRM; only the
  // assignment panel inside it is gated, so it is unhidden rather than hidden.
  if (crmCanAssign()) $('#crm-assign-panel')?.classList.remove('hidden');
  // Admin only — one step tighter than the assignment panel above it.
  if (crmIsAdmin()) $('#crm-gb-panel')?.classList.remove('hidden');
  if (crmIsAdmin()) $('#crm-ghl-panel')?.classList.remove('hidden');

  const lockedRoles = ['bd_agent', 'maintenance'];
  if (!lockedRoles.includes(currentUser.role) || !currentUser.agentName) return;
  const me = currentUser.agentName;

  const sel = $('#crm-agent-select');
  if (sel) { sel.value = me; sel.disabled = true; }
  crmState.agent = me;
  crmMarkAgentChoice();

  // The Task Queue has its own agent dropdown. The server already restricts
  // these roles to properties they shop, so leaving it open is not a data leak
  // — but offering colleagues' names that can only ever return an empty queue
  // reads as a bug. Pin it to the one name that means anything here.
  const taskSel = $('#crm-task-agent-filter');
  if (taskSel) {
    taskSel.innerHTML = `<option value="${esc(me)}">${esc(me)}</option>`;
    taskSel.value = me;
    taskSel.disabled = true;
  }
}

// ── Agent Roster ──────────────────────────────────────────────────────────────
let crmRosterCache = [];
let crmRosterFilter = '';
const crmIsAdmin = () => currentUser?.role === 'admin';

// Unknown is a real state, not a missing value: five of these are names we have
// without knowing whether they still work with us. It gets its own badge rather
// than being folded into either of the other two.
const ROSTER_BADGE = {
  active:   '<span class="badge badge-green">Active</span>',
  inactive: '<span class="badge badge-gray">Inactive</span>',
  unknown:  '<span class="badge badge-amber">Unknown</span>',
};
// Placeholder for the fields we simply do not have for the unnamed half of the
// roster — distinct from an empty cell, which reads as a rendering fault.
const tbd = v => (v && String(v).trim())
  ? esc(v) : '<span class="muted small">TBD</span>';

async function crmLoadRoster() {
  const el = $('#crm-roster-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    crmRosterCache = await api('/api/crm/bd-agents');
    crmRenderRoster();
    crmPopulateAgentSelects();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
    $('#crm-roster-status').textContent = 'Could not load the roster';
  }
}

function crmRenderRoster() {
  const el = $('#crm-roster-body');
  if (!el) return;
  const admin = crmIsAdmin();
  $('#crm-roster-add')?.classList.toggle('hidden', !admin);

  const rows = crmRosterCache.filter(a => !crmRosterFilter || a.status === crmRosterFilter);
  const counts = crmRosterCache.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
  $('#crm-roster-status').textContent =
    `${crmRosterCache.length} agents · ${counts.active || 0} active · ${counts.inactive || 0} inactive · ${counts.unknown || 0} unknown`
    + (admin ? '' : ' · read-only');

  if (!rows.length) {
    el.innerHTML = crmRosterCache.length
      ? '<div class="empty-state">No agents with that status.</div>'
      : '<div class="empty-state">No agents yet.</div>';
    return;
  }

  el.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
    <thead><tr>
      <th>Name</th><th>Email</th><th>Role</th><th>Phone</th>
      <th title="The short name the CRM stores on properties — what the Task Queue filter matches">CRM name</th>
      <th>Status</th>${admin ? '<th></th>' : ''}
    </tr></thead><tbody>
    ${rows.map(a => `<tr data-id="${esc(a.id)}">
      ${admin ? `
        <td><input class="crm-input" data-field="name" value="${esc(a.name ?? '')}"></td>
        <td><input class="crm-input" data-field="email" value="${esc(a.email ?? '')}"></td>
        <td><input class="crm-input" data-field="role" value="${esc(a.role ?? '')}"></td>
        <td><input class="crm-input" data-field="phone" value="${esc(a.phone ?? '')}"></td>
        <td><input class="crm-input" data-field="crm_alias" value="${esc(a.crm_alias ?? '')}"></td>`
      : `
        <td>${tbd(a.name)}</td><td>${tbd(a.email)}</td>
        <td>${tbd(a.role)}</td><td>${tbd(a.phone)}</td><td>${tbd(a.crm_alias)}</td>`}
      <td>${ROSTER_BADGE[a.status] || esc(a.status)}</td>
      ${admin ? `<td class="row-actions">
        ${ROW_EDIT_BUTTONS}
        <button class="btn-sm crm-roster-toggle">${a.status === 'active' ? 'Deactivate' : 'Activate'}</button>
      </td>` : ''}
    </tr>`).join('')}
  </tbody></table></div>`;

  if (!admin) return;
  // Same locked-by-default rows as the Properties tab, for the same reason: a
  // table you opened to read should not be one keystroke from being written.
  el.querySelectorAll('tbody tr').forEach(tr => wireRowEditing(tr, crmSaveRosterRow));
  el.querySelectorAll('.crm-roster-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      btn.disabled = true;
      try {
        await api(`/api/crm/bd-agents/${encodeURIComponent(id)}/status`, { method: 'PATCH' });
        toast('Status updated', 'success');
        crmLoadRoster();
      } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
    });
  });
}

async function crmSaveRosterRow(tr, btn) {
  const payload = {};
  tr.querySelectorAll('[data-field]').forEach(i => { payload[i.dataset.field] = i.value.trim(); });
  if (!payload.name) { toast('Name is required', 'error'); return false; }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api(`/api/crm/bd-agents/${encodeURIComponent(tr.dataset.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast('Agent saved', 'success');
    crmLoadRoster();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;   // not saved — closing the row would imply it was
  } finally { btn.disabled = false; btn.textContent = original; }
}

// The Task Queue filter compares against the assignee strings stored on
// properties, which are short names — 'Rhoxie', not 'Roxanne De Vero'. So the
// option value is crm_alias and only the label is the full name. An agent with
// no alias is left out: it could only ever return an empty queue.
function crmPopulateAgentSelects() {
  const sel = $('#crm-task-agent-filter');
  // crmApplyUserRole pins and disables this for bd_agent and maintenance. Do not
  // undo that by repopulating it underneath them.
  if (!sel || sel.disabled) return;
  const cur = sel.value;
  const withAlias = crmRosterCache.filter(a => a.crm_alias);
  sel.innerHTML = '<option value="">All Agents</option>' +
    withAlias.map(a => `<option value="${esc(a.crm_alias)}"${a.crm_alias === cur ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
}

$('#crm-roster-refresh')?.addEventListener('click', crmLoadRoster);
$$('#crm-roster-pills .pill').forEach(p => p.addEventListener('click', () => {
  crmRosterFilter = p.dataset.status;
  $$('#crm-roster-pills .pill').forEach(q => q.classList.toggle('active', q === p));
  crmRenderRoster();
}));
$('#crm-roster-add')?.addEventListener('click', () => $('#crm-roster-form')?.classList.toggle('hidden'));
$('#crm-roster-cancel')?.addEventListener('click', () => {
  $('#crm-roster-form')?.classList.add('hidden');
  $('#crm-roster-form')?.reset();
});
$('#crm-roster-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/crm/bd-agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(fd)),
    });
    toast('Agent added', 'success');
    e.target.reset();
    e.target.classList.add('hidden');
    crmLoadRoster();
  } catch (err) { toast(err.message, 'error'); }
});



// ── Property Assignments (CRM Settings) ───────────────────────────────────────
// Same allowlist as the roster and Team Performance: this reassigns people's
// work, and operations is as far down as it should go.
const crmCanAssign = () => CRM_ROSTER_ROLES.includes(currentUser?.role);

// The column is phone_assignee3. There has never been a phone_assignee2, so the
// label says 3 — a tool for editing a field should name the field it writes, or
// the next person to read the data will not find what the UI promised.
const CA_FIELDS = {
  phone_assignee: 'Phone Assignee',
  phone_assignee3: 'Phone Assignee 3',
};

let caProps = [];          // every property, fetched once
let caAgents = [];         // active agents that have a CRM alias
let caSelected = new Set();

async function crmLoadAssignments() {
  const el = $('#ca-body');
  if (!el || !crmCanAssign()) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    // GET /api/crm/properties caps limit at 200 and there are 251 rows, so the
    // "one view, no pagination" this panel wants still takes two requests.
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const d = await api(`/api/crm/properties?page=${page}&limit=200`);
      const batch = d.properties || [];
      all.push(...batch);
      if (all.length >= (d.total || 0) || !batch.length) break;
    }
    caProps = all;

    // Assignments are stored as the short name, so the dropdown's value has to
    // be crm_alias and only its label is the full name.
    const roster = await api('/api/crm/bd-agents').catch(() => []);
    caAgents = (Array.isArray(roster) ? roster : [])
      .filter(a => a.status === 'active' && a.crm_alias)
      .map(a => ({ value: a.crm_alias, label: a.name }));

    caBuildFilters();
    crmRenderAssignments();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

// Filter options come from the rows actually present, not a hardcoded list, so a
// new submarket or a class nobody anticipated cannot make properties
// unreachable through this panel.
function caBuildFilters() {
  const uniq = key => [...new Set(caProps.map(p => (p[key] || '').trim()).filter(Boolean))].sort();
  const fill = (sel, values, firstLabel) => {
    const el = $(sel); if (!el) return;
    const cur = el.value;
    el.innerHTML = `<option value="">${firstLabel}</option>` +
      values.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  };
  fill('#ca-class', uniq('asset_class'), 'All');
  fill('#ca-submarket', uniq('submarket'), 'All');
  fill('#ca-mgmt', uniq('management_type'), 'All');

  // Current-assignee filter spans both columns, plus an explicit "unassigned"
  // — the case most likely to need fixing is the one with no name in it.
  const assignees = [...new Set(caProps.flatMap(p => [p.phone_assignee, p.phone_assignee3])
    .map(v => (v || '').trim()).filter(Boolean))].sort();
  const sel = $('#ca-assignee');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">All</option><option value="__none__">— Unassigned —</option>' +
      assignees.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  }

  const bulk = $('#ca-bulk-agent');
  if (bulk) {
    bulk.innerHTML = '<option value="">— Unassign —</option>' +
      caAgents.map(a => `<option value="${esc(a.value)}">${esc(a.label)}</option>`).join('');
  }
}

function caFiltered() {
  const cls = $('#ca-class')?.value || '';
  const sub = $('#ca-submarket')?.value || '';
  const mgmt = $('#ca-mgmt')?.value || '';
  const who = $('#ca-assignee')?.value || '';
  const q = ($('#ca-search')?.value || '').trim().toLowerCase();

  return caProps.filter(p => {
    if (cls && (p.asset_class || '') !== cls) return false;
    if (sub && (p.submarket || '') !== sub) return false;
    if (mgmt && (p.management_type || '') !== mgmt) return false;
    if (who === '__none__') {
      if ((p.phone_assignee || '').trim() || (p.phone_assignee3 || '').trim()) return false;
    } else if (who) {
      if ((p.phone_assignee || '') !== who && (p.phone_assignee3 || '') !== who) return false;
    }
    if (q) {
      const hay = `${p.property_name || ''} ${p.address || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function caAgentSelect(prop, field) {
  const cur = (prop[field] || '').trim();
  // An assignment that is not on the roster still has to show, or editing one
  // row would silently blank a name nobody meant to touch.
  const known = caAgents.some(a => a.value === cur);
  const extra = (cur && !known) ? `<option value="${esc(cur)}" selected>${esc(cur)} (not on roster)</option>` : '';
  return `<select class="crm-select ca-one" data-id="${esc(prop.id)}" data-field="${field}" style="font-size:.8rem">
    <option value="">— none —</option>${extra}
    ${caAgents.map(a => `<option value="${esc(a.value)}"${a.value === cur ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
  </select>`;
}

function crmRenderAssignments() {
  const el = $('#ca-body');
  if (!el) return;
  const rows = caFiltered();
  const ids = new Set(rows.map(p => p.id));
  // Selection follows the filter: narrowing the list must not leave rows
  // selected that nobody can see, or Confirm would reassign them unseen.
  for (const id of [...caSelected]) if (!ids.has(id)) caSelected.delete(id);

  $('#ca-status').textContent =
    `${rows.length} of ${caProps.length} properties shown` +
    (caSelected.size ? ` · ${caSelected.size} selected` : '');
  caSyncBulkBar();

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">No properties match these filters.</div>';
    return;
  }
  const allShown = rows.every(p => caSelected.has(p.id));
  el.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
    <thead><tr>
      <th style="width:28px"><input type="checkbox" id="ca-all"${allShown ? ' checked' : ''}></th>
      <th>Property</th><th>Address</th><th>Class</th><th>Submarket</th>
      <th>${esc(CA_FIELDS.phone_assignee)}</th><th>${esc(CA_FIELDS.phone_assignee3)}</th>
    </tr></thead><tbody>
    ${rows.map(p => `<tr${caSelected.has(p.id) ? ' class="ca-sel"' : ''}>
      <td><input type="checkbox" class="ca-pick" data-id="${esc(p.id)}"${caSelected.has(p.id) ? ' checked' : ''}></td>
      <td>${esc(p.property_name || '—')}</td>
      <td class="small muted">${esc(p.address || '')}</td>
      <td>${esc(p.asset_class || '')}</td>
      <td class="small muted">${esc(p.submarket || '')}</td>
      <td>${caAgentSelect(p, 'phone_assignee')}</td>
      <td>${caAgentSelect(p, 'phone_assignee3')}</td>
    </tr>`).join('')}
  </tbody></table></div>`;

  $('#ca-all')?.addEventListener('change', e => {
    // Selects every filtered row, not only what a page would show — there is no
    // pagination here, but the intent is "all matches" either way.
    rows.forEach(p => e.target.checked ? caSelected.add(p.id) : caSelected.delete(p.id));
    crmRenderAssignments();
  });
  el.querySelectorAll('.ca-pick').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? caSelected.add(cb.dataset.id) : caSelected.delete(cb.dataset.id);
    cb.closest('tr').classList.toggle('ca-sel', cb.checked);
    $('#ca-status').textContent =
      `${rows.length} of ${caProps.length} properties shown` +
      (caSelected.size ? ` · ${caSelected.size} selected` : '');
    caSyncBulkBar();
  }));
  el.querySelectorAll('.ca-one').forEach(sel => sel.addEventListener('change', async () => {
    const { id, field } = sel.dataset;
    const prev = caProps.find(p => p.id === id)?.[field] ?? '';
    sel.disabled = true;
    try {
      await api(`/api/crm/properties/${encodeURIComponent(id)}/assign`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, agent_name: sel.value || null }),
      });
      const p = caProps.find(x => x.id === id);
      if (p) p[field] = sel.value || null;
      toast('Assignment saved', 'success');
      caBuildFilters();
    } catch (err) {
      sel.value = prev || '';   // put the row back to what the database still holds
      toast(err.message, 'error');
    } finally { sel.disabled = false; }
  }));
}

function caSyncBulkBar() {
  const bar = $('#ca-bulk');
  if (!bar) return;
  bar.classList.toggle('hidden', caSelected.size === 0);
  const c = $('#ca-count');
  if (c) c.textContent = `${caSelected.size} propert${caSelected.size === 1 ? 'y' : 'ies'} selected`;
}

['#ca-class', '#ca-submarket', '#ca-mgmt', '#ca-assignee'].forEach(sel =>
  $(sel)?.addEventListener('change', crmRenderAssignments));
$('#ca-search')?.addEventListener('input', crmRenderAssignments);
$('#ca-reload')?.addEventListener('click', crmLoadAssignments);
$('#ca-bulk-clear')?.addEventListener('click', () => { caSelected.clear(); crmRenderAssignments(); });

$('#ca-bulk-apply')?.addEventListener('click', async () => {
  const ids = [...caSelected];
  if (!ids.length) return;
  const field = $('#ca-bulk-field').value;
  const agent = $('#ca-bulk-agent').value || null;
  const label = agent || 'nobody';
  // Bulk reassignment is not something to do by a mis-click, and it cannot be
  // undone from here.
  if (!confirm(`Set ${CA_FIELDS[field]} to ${label} on ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}?`)) return;

  const btn = $('#ca-bulk-apply');
  btn.disabled = true; btn.textContent = 'Applying…';
  try {
    const r = await api('/api/crm/properties/bulk-assign', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_ids: ids, field, agent_name: agent }),
    });
    ids.forEach(id => { const p = caProps.find(x => x.id === id); if (p) p[field] = agent; });
    caSelected.clear();
    // The server counts rows it actually wrote, so a mismatch is worth showing
    // rather than reporting the number that was asked for.
    toast(r.updated === r.requested
      ? `${r.updated} properties updated`
      : `${r.updated} of ${r.requested} updated — reload to see the rest`,
      r.updated === r.requested ? 'success' : 'error');
    caBuildFilters();
    crmRenderAssignments();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Confirm'; }
});

// ── G&B Rotation (CRM Settings) ───────────────────────────────────────────────
// Admin only, tighter than the assignment panel beside it: this decides who
// calls a management company, not who is listed against a property.
let crmGbData = null;

async function crmLoadGbRotation() {
  const el = $('#crm-gb-body');
  if (!el || !crmIsAdmin()) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    crmGbData = await api('/api/crm/gb-rotation');
    crmRenderGbRotation();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
    $('#crm-gb-status').textContent = 'Could not load the rotation';
  }
}

function crmRenderGbRotation() {
  const el = $('#crm-gb-body');
  if (!el || !crmGbData) return;
  const { properties = [], agents = [], overdue = 0, unassigned = 0, rotateDays } = crmGbData;

  $('#crm-gb-status').textContent = agents.length
    ? `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} · ${agents.length} in rotation (${agents.join(', ')}) · every ${rotateDays} days`
    : 'Nobody is in the rotation — tick in_gb_rotation on bd_agents.';

  // No G&B properties at all is the real empty state. Properties that exist but
  // have never been assigned still get a row: seeing what is about to be
  // rotated is the point of pressing the button.
  if (!properties.length) {
    el.innerHTML = '<div class="empty-state">No properties are managed by G&amp;B.</div>';
    return;
  }

  el.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
    <thead><tr>
      <th>Property</th><th>Current agent</th><th>Assigned</th><th>Rotate after</th><th>Days left</th>
    </tr></thead><tbody>
    ${properties.map(p => {
      const never = !p.assigned_agent;
      const late = p.days_left != null && p.days_left < 0;
      return `<tr>
        <td>${esc(p.property_name || '—')}${p.address ? `<div class="muted small">${esc(p.address)}</div>` : ''}</td>
        <td>${never ? '<span class="muted small">not assigned yet</span>' : `<b>${esc(p.assigned_agent)}</b>`}</td>
        <td class="small muted">${p.assigned_at ? new Date(p.assigned_at).toLocaleDateString() : '—'}</td>
        <td class="small muted">${p.rotate_after ? esc(p.rotate_after) : '—'}</td>
        <td>${never ? '—'
          : late ? `<span class="badge badge-red">${Math.abs(p.days_left)}d overdue</span>`
          : `<span class="muted small">${p.days_left}d</span>`}</td>
      </tr>`;
    }).join('')}
  </tbody></table></div>
  ${unassigned || overdue ? `<p class="muted small" style="margin-bottom:0">${
    [unassigned ? `${unassigned} never assigned` : null,
     overdue ? `${overdue} past its rotation date` : null].filter(Boolean).join(' · ')}</p>` : ''}`;
}

$('#crm-gb-refresh')?.addEventListener('click', crmLoadGbRotation);

// GHL export — navigate to the endpoint; Content-Disposition makes the browser
// download it, and the session cookie satisfies requireMetricAdmin.
$('#crm-ghl-download')?.addEventListener('click', () => {
  window.location.href = '/api/bd-crm/export/csv';
});
$('#crm-gb-rotate')?.addEventListener('click', async () => {
  const n = crmGbData?.properties?.length || 0;
  // It appends rather than overwriting, so this is undoable by rotating again —
  // but it changes who is expected to make a call, which is worth one pause.
  if (!confirm(`Rotate ${n} G&B propert${n === 1 ? 'y' : 'ies'} to their next agent?`)) return;
  const btn = $('#crm-gb-rotate');
  btn.disabled = true; btn.textContent = 'Rotating…';
  try {
    const r = await api('/api/crm/gb-rotation/assign', { method: 'POST' });
    const per = Object.entries(r.perAgent || {}).map(([a, c]) => `${a}: ${c}`).join(' · ');
    toast(r.assigned ? `${r.assigned} assigned${per ? ' — ' + per : ''}` : (r.message || 'Nothing to rotate'),
          r.assigned ? 'success' : 'info');
    crmLoadGbRotation();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Assign / Rotate'; }
});

// ── Team Performance ──────────────────────────────────────────────────────────
// Same allowlist as the roster: both are per-person data about colleagues.
const crmCanSeePerformance = () => CRM_ROSTER_ROLES.includes(currentUser?.role);

let crmTpRange = 'week';
let crmTpData = null;

// Six chips, in the order the spec lists them. `key` reads the agent row for the
// selected range; `cov` is which coverage flag decides whether the number means
// anything yet.
const CRM_TP_CHIPS = [
  { label: 'Tasks Completed',  cov: 'tasks_completed', key: a => a[`tasks_completed_${crmTpRange}`] },
  { label: 'HOT Leads',        cov: 'hot_leads',       key: a => a.hot_leads_contacted },
  { label: 'Phone Shops',      cov: 'phone_shops',     key: a => a.phone_shops },
  { label: 'Online Shops',     cov: 'online_shops',    key: a => a.online_shops },
  { label: 'Follow-ups',       cov: 'follow_ups',      key: a => a.follow_ups },
  { label: 'Outreach Drafts',  cov: 'outreach_drafts', key: a => a.outreach_drafts },
];

const CRM_TP_RANGE_LABEL = { today: 'today', week: 'this week', month: 'this month' };

// Two letters from the name — "Roxanne De Vero" gives RD, "Katie" gives KA.
function crmTpInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function crmLoadTeamPerformance() {
  const el = $('#crm-tp-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    crmTpData = await api(`/api/crm/team-performance?range=${encodeURIComponent(crmTpRange)}`);
    crmRenderTeamPerformance();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
    $('#crm-tp-status').textContent = 'Could not load team performance';
  }
}

function crmRenderTeamPerformance() {
  const el = $('#crm-tp-body');
  if (!el || !crmTpData) return;
  const { agents = [], coverage = {} } = crmTpData;

  const untracked = CRM_TP_CHIPS.filter(c => !coverage[c.cov]).length;
  $('#crm-tp-status').textContent =
    `${agents.length} active agents · ranked by phone shops ${CRM_TP_RANGE_LABEL[crmTpRange]}`
    + (untracked ? ` · ${untracked} of ${CRM_TP_CHIPS.length} metrics not tracked yet` : '');

  if (!agents.length) {
    el.innerHTML = '<div class="empty-state">No active agents with a CRM name. Add one under Agent Roster.</div>';
    return;
  }

  el.innerHTML = `<div class="tp-grid">${agents.map(a => {
    // Only the metrics that are actually being recorded count towards "no data".
    // An agent with nothing logged is different from a board that logs nothing.
    const tracked = CRM_TP_CHIPS.filter(c => coverage[c.cov]);
    const anyData = tracked.some(c => (c.key(a) || 0) > 0);
    return `
    <div class="tp-card">
      <div class="tp-head">
        <span class="tp-avatar">${esc(crmTpInitials(a.agent_name))}</span>
        <span class="tp-name">
          ${esc(a.agent_name)}
          <span class="muted small">${esc(a.crm_alias || '')}</span>
        </span>
        ${a.rank && a.rank <= 3 ? `<span class="tp-rank tp-rank-${a.rank}" title="Ranked by phone shops ${esc(CRM_TP_RANGE_LABEL[crmTpRange])}">#${a.rank}</span>` : ''}
      </div>
      ${!anyData && tracked.length
        ? '<p class="small muted tp-empty">No data yet for this period.</p>' : ''}
      <div class="tp-chips">
        ${CRM_TP_CHIPS.map(c => coverage[c.cov]
          ? `<span class="tp-chip"><b>${c.key(a) ?? 0}</b> ${esc(c.label)}</span>`
          : `<span class="tp-chip tp-chip-untracked" title="Will count once agent_name is recorded">${esc(c.label)}: not tracked yet</span>`
        ).join('')}
      </div>
    </div>`;
  }).join('')}</div>`;
}

$('#crm-tp-refresh')?.addEventListener('click', crmLoadTeamPerformance);
$$('#crm-tp-pills .pill').forEach(p => p.addEventListener('click', () => {
  crmTpRange = p.dataset.range;
  $$('#crm-tp-pills .pill').forEach(q => q.classList.toggle('active', q === p));
  // Refetched rather than re-bucketed on the client: the period is part of the
  // query, and the counts for it are the server's to decide.
  crmLoadTeamPerformance();
}));

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
// `tab` lets a caller land the user where the work is. Task Queue passes the
// tab matching the task type, so clicking "2/3 calls logged" opens on Phone
// Shop instead of Overview — which read as "the calls are missing".
async function crmOpenModal(id, tab = 'overview') {
  const modal = $('#crm-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#crm-modal-name').textContent = 'Loading…';
  $('#crm-modal-address').textContent = '';
  $('#crm-modal-score-badge').textContent = '…';
  $('#crm-modal-score-badge').className = 'crm-score-badge score-none';

  try {
    const p = await crmFetch(`/api/crm/properties/${id}`);
    if (p.error) { toast('Error: ' + p.error, 'error'); crmCloseModal(); return; }
    crmState.activeProperty = p;
    crmRenderModalHeader(p);
    crmSwitchModalTab(tab);
  } catch (err) {
    toast('Failed to load property: ' + err.message, 'error');
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
// phone_shops.notes is stored as a JSON string — {"connection":…,"text":…} —
// while online_shops.notes is plain text. Reading .connection straight off the
// string silently yielded undefined, so every call rendered as "—" in the
// no-answer style even when it had been answered, and the raw JSON was printed
// as the note body. Accept a string, an object, or JSON either way.
function parseNotes(n) {
  if (!n) return {};
  if (typeof n === 'object') return n;
  try {
    const parsed = JSON.parse(n);
    return (parsed && typeof parsed === 'object') ? parsed : { text: String(parsed) };
  } catch {
    return { text: n };
  }
}

function crmRenderPhoneList(shops) {
  const connLabel = { answered_agent: 'Answered', answered_ai: 'AI/Service', voicemail: 'Voicemail', no_answer: 'No Answer', wrong_number: 'Wrong #' };
  const connCls   = { answered_agent: 'conn-answered', answered_ai: 'conn-answered', voicemail: 'conn-voicemail', no_answer: 'conn-noanswer', wrong_number: 'conn-noanswer' };
  $('#crm-phone-count').textContent = `${shops.length} call(s) logged`;
  $('#crm-phone-list').innerHTML = shops.length ? shops.map(s => {
    const nt = parseNotes(s.notes);
    return `
    <div class="crm-entry-card">
      <div class="crm-entry-card-head">
        <span class="crm-entry-meta">${fmtDate(s.shop_date)} · ${esc(s.agent_name||'—')}</span>
        <span class="crm-connection-badge ${connCls[nt.connection] || 'conn-noanswer'}">${esc(nt.connection ? (connLabel[nt.connection] || nt.connection) : '—')}</span>
      </div>
      <div class="crm-entry-card-head" style="margin-top:2px">
        ${s.score != null ? `<span class="crm-entry-meta">Score: ${s.score}</span>` : '<span></span>'}
        ${nt.appointment_set === 'yes' ? '<span class="crm-entry-meta">📅 Appointment set</span>' : ''}
      </div>
      ${nt.text ? `<p class="small" style="margin-top:4px;">${esc(nt.text)}</p>` : ''}
    </div>`;
  }).join('') : '<p class="muted small">No calls logged yet.</p>';
}

$('#crm-phone-add-btn').addEventListener('click', () => {
  $('#crm-phone-form').classList.toggle('hidden');
});
$('#crm-phone-cancel').addEventListener('click', () => $('#crm-phone-form').classList.add('hidden'));
$('#crm-phone-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const agent = crmResolveAgent($('#pf-agent').value);
  if (!agent) return;
  const body = {
    shop_date: $('#pf-date').value || new Date().toISOString().slice(0,10),
    agent_name: agent,
    score: parseFloat($('#pf-score').value) || null,
    notes: JSON.stringify({ connection: $('#pf-connection').value, text: $('#pf-notes').value }),
  };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/phone-shops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderPhoneList(updated.phone_shops);
    $('#crm-phone-form').classList.add('hidden');
  } catch (err) { toast(err.message, 'error'); }
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
      ${parseNotes(s.notes).text ? `<p class="small" style="margin-top:4px;">${esc(parseNotes(s.notes).text)}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No online shops yet.</p>';
}

$('#crm-online-add-btn').addEventListener('click', () => $('#crm-online-form').classList.toggle('hidden'));
$('#crm-online-cancel').addEventListener('click', () => $('#crm-online-form').classList.add('hidden'));
$('#crm-online-save').addEventListener('click', async () => {
  const p = crmState.activeProperty;
  if (!p) return;
  const agent = crmResolveAgent($('#of-agent').value);
  if (!agent) return;
  const body = { shop_date: $('#of-date').value || new Date().toISOString().slice(0,10), agent_name: agent, platform: $('#of-platform').value, score: parseFloat($('#of-score').value) || null, notes: $('#of-notes').value };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/online-shops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderOnlineList(updated.online_shops);
    $('#crm-online-form').classList.add('hidden');
  } catch (err) { toast(err.message, 'error'); }
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
  } catch (err) { toast(err.message, 'error'); }
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
  // Attribution for Team Performance. crmState.agent is the "Working as"
  // selector, which is already how the CRM knows who is at the keyboard.
  const agent = crmResolveAgent();
  if (!agent) return;
  const body = { method: $('#ff-method').value, follow_up_date: $('#ff-date').value || new Date().toISOString().slice(0,10), completed: $('#ff-completed').value === 'true', outcome: $('#ff-outcome').value, next_action: $('#ff-next').value, agent_name: agent };
  try {
    await crmFetch(`/api/crm/properties/${p.id}/follow-ups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderFUList(updated.follow_ups);
    $('#crm-fu-form').classList.add('hidden');
  } catch (err) { toast(err.message, 'error'); }
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
  } catch (err) { toast(err.message, 'error'); }
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
  const agent = crmResolveAgent();
  if (!agent) return;
  try {
    await crmFetch(`/api/crm/properties/${p.id}/dm-review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...crmState.dmScores, audit_notes: $('#crm-dm-audit-notes').value, agent_name: agent }),
    });
    toast('DM Review saved ✅', 'success');
  } catch (err) { toast(err.message, 'error'); }
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
  else if ((p.phone_shops||[]).some(s => parseNotes(s.notes).connection === 'no_answer')) angles.push('📞 Phone shop — no answer logged');
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
  if (!body.body.trim()) { toast('Body is required', 'error'); return; }
  try {
    await crmFetch(`/api/crm/properties/${p.id}/outreach-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await crmFetch(`/api/crm/properties/${p.id}`);
    crmState.activeProperty = updated;
    crmRenderDraftList(updated.outreach_drafts);
    $('#crm-draft-form').classList.add('hidden');
    ['#df-channel','#df-subject','#df-body','#df-notes'].forEach(id => $(id).value = '');
    toast('Draft saved ✅', 'success');
  } catch (err) { toast(err.message, 'error'); }
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
// Tasks come from crm-task-engine.js server-side — a port of the original CRM's
// priority engine. Each carries its own target tab, so no icon-to-tab map here.

const CRM_TYPE_ICON = { ready: '⭐', phone: '📞', online: '📧', dm: '📈', appt_check: '⏰',
                        owner_response: '🔥', contact_update: '✏️' };

// The 1-10 lead score, not the raw priority — priority runs past 1,000 and only
// matters for ordering, while the score is the number the team reasons about.
const crmScoreClass = s =>
  s >= 8 ? { cls: 'score-high', bg: '#dc2626' }
  : s >= 6 ? { cls: 'score-med',  bg: '#ea580c' }
  : { cls: 'score-low', bg: '#2563eb' };

async function crmLoadTasks() {
  $('#crm-tasks-status').textContent = 'Loading…';
  const agentFilter  = $('#crm-task-agent-filter').value;
  const typeFilter   = $('#crm-task-type-filter').value;
  const overdueOnly  = $('#crm-task-overdue-only')?.checked;
  const today = todayStr();

  try {
    const data = await crmFetch(`/api/crm/tasks${agentFilter ? '?agent=' + encodeURIComponent(agentFilter) : ''}`);
    let tasks = data.tasks || [];
    if (typeFilter)  tasks = tasks.filter(t => t.type === typeFilter);
    if (overdueOnly) tasks = tasks.filter(t => t.due && t.due < today);

    const mins = tasks.reduce((s, t) => s + (t.minutes || 0), 0);
    const overdue = tasks.filter(t => t.due && t.due < today).length;
    const hot = new Set(tasks.filter(t => (t.lead_score || 0) >= 7).map(t => t.property_id)).size;
    $('#crm-tasks-status').textContent =
      `${tasks.length} task(s) · ${Math.round(mins / 60 * 10) / 10} h estimated` +
      (overdue ? ` · ${overdue} overdue` : '');

    // Per-agent workload + hot leads, from the engine's own rollup.
    const kpis = $('#crm-task-kpis');
    if (kpis) {
      const perAgent = (data.summary || []).filter(a => !agentFilter || a.agent.toLowerCase().includes(agentFilter.toLowerCase()));
      kpis.innerHTML =
        `<div class="crm-kpi crm-kpi-hot"><b>${hot}</b>HOT LEADS <span class="muted">(score 7+)</span></div>` +
        perAgent.map(a => `
          <div class="crm-kpi">
            <b>${a.tasks}</b>${esc(a.agent)}
            <span class="muted">${Math.round(a.minutes / 60 * 10) / 10} h${a.overdue ? ` · ${a.overdue} overdue` : ''}</span>
          </div>`).join('');
    }

    $('#crm-tasks-body').innerHTML = tasks.length ? tasks.map(t => {
      const sc = crmScoreClass(t.lead_score || 0);
      const isOverdue = t.due && t.due < today;
      return `
      <div class="crm-task-card" data-pid="${esc(t.property_id || '')}" data-tab="${esc(t.tab || 'overview')}">
        <div class="crm-task-type-icon">${CRM_TYPE_ICON[t.type] || '📋'}</div>
        <div class="crm-task-body">
          <div class="crm-task-title">${esc(t.property_name || '—')}</div>
          <div class="crm-task-detail">${esc(t.label || '')}</div>
          ${(t.reasons || []).length
            ? `<div class="crm-task-reasons">${t.reasons.map(r => `<span class="crm-reason">${esc(r)}</span>`).join('')}</div>`
            : ''}
        </div>
        <div class="crm-task-meta">
          <span class="crm-task-mins">${t.minutes}m</span>
          <span class="crm-task-due${isOverdue ? ' crm-task-overdue' : ''}">${isOverdue ? '⚠ ' : ''}${esc(t.due || '—')}</span>
        </div>
        <div class="crm-task-agent">${esc(t.agent || '—')}</div>
        <div class="crm-task-priority ${sc.cls}" style="background:${sc.bg}" title="Lead score ${t.lead_score} · priority ${t.priority}">${t.lead_score ?? '—'}</div>
      </div>`;
    }).join('') : '<p class="muted small" style="padding:20px;">No tasks match the current filters.</p>';

    // Every task is derived from a property, so clicking one opens that
    // property — on the tab the engine says the work lives on.
    $$('#crm-tasks-body .crm-task-card').forEach(card => {
      if (!card.dataset.pid) { card.classList.add('crm-task-card-nolink'); return; }
      card.addEventListener('click', () => crmOpenModal(card.dataset.pid, card.dataset.tab || 'overview'));
    });
  } catch (err) { $('#crm-tasks-status').textContent = '❌ ' + err.message; }
}

$('#crm-tasks-refresh').addEventListener('click', crmLoadTasks);
$('#crm-task-overdue-only')?.addEventListener('change', crmLoadTasks);
$('#crm-task-agent-filter').addEventListener('change', crmLoadTasks);
$('#crm-task-type-filter').addEventListener('change', crmLoadTasks);

// ── Outreach Drafts view ──────────────────────────────────────────────────────
async function crmLoadDraftsList() {
  $('#crm-drafts-body').innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const data = await crmFetch('/api/crm/outreach-drafts');
    const groups = data.groups || [];
    if (!groups.length) {
      $('#crm-drafts-body').innerHTML = `<div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 48 36" aria-hidden="true">
          <rect x="1.5" y="1.5" width="45" height="33" rx="3"/>
          <path d="M2 4l22 16L46 4"/>
        </svg>
        <div>No pending outreach drafts across all properties.</div>
      </div>`;
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
  toast('Settings saved', 'success');
});
// Targeted companies live in Supabase now, not localStorage. They were
// per-browser before, so each person saw a different list and the task engine
// — which awards +150 for a targeted company — could not see any of them.
const CRM_TARGETED_LS_KEY = 'crm_targeted_cos';

async function crmLoadTargeted() {
  const box = $('#crm-targeted-companies');
  if (!box) return;
  try {
    const data = await crmFetch('/api/crm/targeted-companies');
    if (data.error) throw new Error(data.error);
    box.value = (data.companies || []).join('\n');
    crmOfferTargetedImport((data.companies || []).length === 0);
  } catch (err) {
    box.placeholder = 'Could not load: ' + err.message;
  }
}

/**
 * One-time bridge: the old list may still be sitting in this browser. Offered
 * as a button rather than merged silently — the local copy could be a stale
 * experiment, and overwriting a shared list from one person's browser without
 * asking is exactly the kind of surprise worth avoiding.
 */
function crmOfferTargetedImport(serverListEmpty) {
  const host = $('#crm-targeted-import-host');
  if (!host) return;
  const local = (localStorage.getItem(CRM_TARGETED_LS_KEY) || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  if (!serverListEmpty || !local.length) { host.innerHTML = ''; return; }
  host.innerHTML =
    `<button class="btn-sm" id="crm-targeted-import">📥 Import ${local.length} compan${local.length === 1 ? 'y' : 'ies'} saved in this browser</button>`;
  $('#crm-targeted-import').addEventListener('click', () => {
    $('#crm-targeted-companies').value = local.join('\n');
    toast('Loaded from this browser — review, then press Save', 'success');
    host.innerHTML = '';
  });
}

$('#crm-targeted-save').addEventListener('click', async () => {
  const companies = $('#crm-targeted-companies').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  try {
    const data = await crmFetch('/api/crm/targeted-companies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies }),
    });
    if (data.error) throw new Error(data.error);
    $('#crm-targeted-companies').value = (data.companies || []).join('\n');
    toast(`${data.count} targeted compan${data.count === 1 ? 'y' : 'ies'} saved — shared with the team`, 'success');
    crmOfferTargetedImport(false);
  } catch (err) { toast(err.message, 'error'); }
});

// Restore the working-user name — still per-person, so localStorage is right.
const savedName = localStorage.getItem('crm_username');
if (savedName) $('#crm-settings-username').value = savedName;

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
// 'all' rather than the Task Manager's 'today'. Erick's board is a curated
// working set of a few dozen items, not a stream: defaulting to today would hide
// every follow-up carried over from earlier in the week.
let maintTimeFilter = 'all';
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
    $$('#maint-asana-pills .pill').forEach(p => p.addEventListener('click', () => {
      maintAsanaFilter = p.dataset.time;
      $$('#maint-asana-pills .pill').forEach(q => q.classList.toggle('active', q === p));
      asanaBoardRender('erick');
    }));
    $('#maint-tasks-refresh')?.addEventListener('click',      loadMaintenanceTasks);
    // Re-render only — the filter is applied to maintTaskCache, so switching
    // ranges does not need another round trip.
    $$('#maint-time-pills .pill').forEach(p => p.addEventListener('click', () => {
      maintTimeFilter = p.dataset.time;
      renderMaintenanceKanban();
    }));
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

// ── Shared Asana Kanban ──────────────────────────────────────────────
// One renderer for both boards — Arturo's under the Task Manager and Erick's
// under Maintenance — so the two cannot drift apart the way MAINT_COLUMNS drifted
// from OPS_PRIORITIES. Four columns: nothing in Asana maps to a Daily Task.
// Cached per board so the pills re-render without another round trip — Arturo's
// board is 183 tasks and refetching on every pill click would be wasteful.
let maintAsanaCache = [], maintAsanaStale = false, maintAsanaFilter = 'all';
let asanaPanelCache = [], asanaPanelStale = false, asanaPanelFilter = 'all';
let asanaPanelLoaded = false;

const ASANA_COLUMNS = [
  { key: 'critical', header: '🔴 Critical',    cls: 'col-critical' },
  { key: 'followup', header: '🟡 Follow-up',   cls: 'col-followup' },
  { key: 'progress', header: '🟢 In Progress', cls: 'col-inprogress' },
  { key: 'done',     header: '✅ Done',         cls: 'col-done' },
];

// Overdue outranks everything. A task explicitly marked LOW that is now past due
// would otherwise sit in In Progress, where the column gives no hint that it has
// slipped — the red badge on the card was the only signal, and only to whoever
// scrolled to it. Someone's estimate of a task's importance ages; the fact that
// the date has passed does not.
//
// After that, Asana's Priority custom field decides. It usually cannot: Priority
// is defined per project, so anything sitting in "My tasks" — 21 of Erick's 27 —
// belongs to no project and can carry no such field. Only 10 of the 210 tasks
// across both boards have one. The due date stands in for the rest, which is the
// only signal every task actually has.
function asanaColumn(t) {
  if (t.completed) return 'done';
  if (t.due_on && t.due_on < todayStr()) return 'critical';
  if (t.priority === 'HIGH')   return 'critical';
  if (t.priority === 'MEDIUM') return 'followup';
  if (t.priority === 'LOW')    return 'progress';
  if (!t.due_on) return 'progress';
  // Anything still here is due today or later — the overdue case returned above.
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  return t.due_on <= localDateStr(tomorrow) ? 'followup' : 'progress';
}

// Daily Operations filters on when a row was created, looking backwards. Due
// dates point the other way, so the same arithmetic runs forward: Today means
// due by end of today, This Week due within seven days. Two things are never
// filtered out — overdue work, which is the Critical column and the whole point
// of looking, and tasks with no due date, which cannot be placed on a timeline
// at all. Completed tasks keep the backward-looking rule, on completed_at.
function asanaInRange(t, filter) {
  if (filter === 'all') return true;
  if (t.completed) {
    if (!t.completed_at) return true;
    const back = new Date(); back.setDate(back.getDate() - (filter === 'week' ? 7 : 0));
    return localDateStr(t.completed_at) >= localDateStr(back);
  }
  if (!t.due_on) return true;
  if (t.due_on < todayStr()) return true;
  const horizon = new Date(); horizon.setDate(horizon.getDate() + (filter === 'week' ? 7 : 0));
  return t.due_on <= localDateStr(horizon);
}

// Edits are staged here, not sent as you type: picking a date or saving a note
// records the change and "Update Asana" is what actually writes it. Held outside
// the DOM so switching a pill — which rebuilds the board from cache — cannot
// silently discard something you typed but had not pushed yet.
const asanaPending = new Map();   // `${owner}:${gid}` → { due_on?, notes? }
// Comments are fetched per card on demand — one extra request per task would be
// 183 of them on Arturo's board before a single card is read.
const asanaComments = new Map();  // `${owner}:${gid}` → { open, loading, items, error, posting }
// A failed update belongs on the card that failed, not only in a toast that is
// gone in three seconds while the amber border stays with no explanation.
const asanaCardError = new Map(); // `${owner}:${gid}` → message
const pendKey = (owner, gid) => `${owner}:${gid}`;

// What the pending map should look like once a value is committed. A pure
// decision, kept out of the event wiring so it can be reasoned about — and
// tested — without a DOM, which is where the date bug hid. Setting a field back
// to what Asana already has is not a change to push, so it drops out, and a card
// with nothing left staged drops out with it.
function asanaStage(key, field, value, original) {
  const p = { ...(asanaPending.get(key) || {}) };
  if (value === original) delete p[field]; else p[field] = value;
  Object.keys(p).length ? asanaPending.set(key, p) : asanaPending.delete(key);
}

// The staged value where one exists, otherwise what Asana last told us.
function asanaEffective(t, owner) {
  const p = asanaPending.get(pendKey(owner, t.gid)) || {};
  return {
    due_on: 'due_on' in p ? p.due_on : t.due_on,
    notes: 'notes' in p ? p.notes : (t.notes || ''),
    dirty: Object.keys(p).length > 0,
  };
}

// Collapsed until asked for. The count only appears once the comments have been
// fetched, since claiming a number before knowing it would be a guess.
function asanaCommentsBlock(t, owner) {
  const c = asanaComments.get(pendKey(owner, t.gid)) || {};
  const toggle = c.open
    ? '💬 Hide comments'
    : `💬 Show comments${Array.isArray(c.items) ? ` (${c.items.length})` : ''}`;
  if (!c.open) {
    return `<div class="asana-comments"><button class="btn-sm" data-act="toggle-comments">${toggle}</button></div>`;
  }
  const body = c.loading ? '<p class="small muted">Loading…</p>'
    : c.error ? `<p class="small muted">⚠ ${esc(c.error)}</p>`
    : (c.items || []).length
      ? c.items.map(x => `
          <div class="note-entry">
            <span class="note-time">${esc(x.author)}${x.created_at ? ` · ${new Date(x.created_at).toLocaleString()}` : ''}</span>
            <span>${esc(x.text)}</span>
          </div>`).join('')
      : '<span class="muted small">No comments yet.</span>';
  return `
    <div class="asana-comments">
      <button class="btn-sm" data-act="toggle-comments">${toggle}</button>
      <div class="note-history asana-comment-list">${body}</div>
      <textarea class="crm-textarea asana-comment-input" rows="2" placeholder="Write a comment…"></textarea>
      <div class="asana-actions">
        <button class="btn-sm primary" data-act="add-comment"${c.posting ? ' disabled' : ''}>${c.posting ? 'Posting…' : 'Add Comment'}</button>
      </div>
    </div>`;
}

function asanaCard(t, today, owner) {
  const { due_on, notes, dirty } = asanaEffective(t, owner);
  const overdue = due_on && due_on < today && !t.completed;
  const preview = notes.length > 100 ? notes.slice(0, 100) + '…' : notes;
  return `
    <div class="card${t.completed ? ' completed' : ''}${dirty ? ' asana-dirty' : ''}" data-gid="${esc(t.gid)}">
      <div class="card-title">${esc(t.name || t.title || '')}</div>
      <div class="card-meta small muted">
        <span class="asana-due ${overdue ? 'badge badge-red' : ''}" data-act="edit-due" title="Click to change the due date">
          ${due_on ? `${overdue ? '⚠ ' : '📅 '}${esc(due_on)}` : '📅 <i>no due date</i>'}
        </span>
        ${t.assignee ? `<span>👤 ${esc(t.assignee)}</span>` : ''}
        ${t.project ? `<span>📁 ${esc(t.project)}</span>` : ''}
      </div>
      <div class="card-notes asana-notes" data-act="edit-notes" title="Click to edit the description">
        ${preview ? esc(preview) : '<i class="muted">no description</i>'}
      </div>
      ${asanaCommentsBlock(t, owner)}
      ${asanaCardError.has(pendKey(owner, t.gid))
        ? `<div class="asana-card-error small">⚠ ${esc(asanaCardError.get(pendKey(owner, t.gid)))}</div>` : ''}
      ${dirty ? `
        <div class="asana-actions">
          <button class="btn-sm primary" data-act="update">⬆ Update Asana</button>
          <button class="btn-sm" data-act="discard">Discard</button>
        </div>` : ''}
      ${t.permalink_url ? `<a class="btn-sm" href="${esc(t.permalink_url)}" target="_blank" rel="noopener">Open in Asana ↗</a>` : ''}
    </div>`;
}

function renderAsanaKanban(el, tasks, filter, stale, owner) {
  if (!el) return;
  const banner = stale
    ? '<div class="banner banner-warn">⚠ Asana unreachable — showing the last known list.</div>' : '';
  const list = tasks.filter(t => asanaInRange(t, filter));

  if (!list.length) {
    el.innerHTML = banner + (tasks.length
      ? '<div class="empty-state">Nothing due in this range. Try “All”.</div>'
      : '<div class="empty-state">No Asana tasks.</div>');
    return;
  }

  const grouped = {};
  ASANA_COLUMNS.forEach(c => { grouped[c.key] = []; });
  list.forEach(t => grouped[asanaColumn(t)].push(t));

  const today = todayStr();
  el.innerHTML = banner + '<div class="kanban">' + ASANA_COLUMNS.map(col => {
    const items = grouped[col.key];
    return `<div class="kanban-column ${col.cls}">
      <div class="kanban-col-head">
        <span>${col.header}<span class="col-toggle">▾</span></span>
        <span class="kanban-col-count">${items.length}</span>
      </div>
      <div class="kanban-col-body">
        ${items.length ? items.map(t => asanaCard(t, today, owner)).join('') : '<p class="kanban-col-empty">No tasks</p>'}
      </div>
    </div>`;
  }).join('') + '</div>';

  el.querySelectorAll('.kanban-col-head').forEach(head => {
    head.addEventListener('click', e => {
      if (e.target.closest('a, button')) return;
      head.closest('.kanban-column').classList.toggle('col-collapsed');
    });
  });
}

// The two boards differ only in where their state lives, so everything below
// works from this table instead of branching on owner in five places.
const ASANA_BOARDS = {
  erick:   { sel: '#maint-asana-body',
             get: () => ({ tasks: maintAsanaCache, filter: maintAsanaFilter, stale: maintAsanaStale }),
             reload: () => loadMaintenanceAsana() },
  default: { sel: '#asana-panel-body',
             get: () => ({ tasks: asanaPanelCache, filter: asanaPanelFilter, stale: asanaPanelStale }),
             reload: () => loadAsanaPanel() },
};

function asanaBoardRender(owner) {
  const b = ASANA_BOARDS[owner];
  if (!b) return;
  const { tasks, filter, stale } = b.get();
  renderAsanaKanban($(b.sel), tasks, filter, stale, owner);
}

async function asanaLoadComments(owner, gid) {
  const key = pendKey(owner, gid);
  asanaComments.set(key, { ...(asanaComments.get(key) || {}), open: true, loading: true, error: null });
  asanaBoardRender(owner);
  try {
    const q = owner === 'erick' ? '?owner=erick' : '';
    const data = await api(`/api/asana/tasks/${encodeURIComponent(gid)}/comments${q}`);
    asanaComments.set(key, { ...asanaComments.get(key), loading: false, items: data.comments || [] });
  } catch (err) {
    asanaComments.set(key, { ...asanaComments.get(key), loading: false, error: err.message });
  }
  asanaBoardRender(owner);
}

// Delegated, and bound once to containers that outlive every re-render — the
// board rebuilds its innerHTML on each pill click, so per-card listeners would
// pile up and leak.
function wireAsanaEditing(owner) {
  const b = ASANA_BOARDS[owner];
  const root = $(b.sel);
  if (!root) return;

  root.addEventListener('click', async ev => {
    const card = ev.target.closest('.card[data-gid]');
    if (!card) return;
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const gid = card.dataset.gid;
    const key = pendKey(owner, gid);
    const task = b.get().tasks.find(t => t.gid === gid);
    if (!task) return;
    const eff = asanaEffective(task, owner);

    if (act === 'edit-due') {
      const span = ev.target.closest('.asana-due');
      if (!span || span.querySelector('input')) return;
      span.className = 'asana-due';
      span.innerHTML = `<input type="date" class="asana-due-input" value="${esc(eff.due_on || '')}">`;
      const inp = span.querySelector('input');
      // Commit on change only. This also listened on blur, to catch a typed date
      // the user clicked away from — but showPicker() hands focus to the
      // calendar, so blur fired the instant the picker opened. It staged the
      // still-empty value and re-rendered the card, destroying the input while
      // the picker was open, so whatever date you then chose landed on a
      // detached element. Selecting a date appeared to do nothing at all.
      inp.addEventListener('change', () => {
        // Staged, not sent: "Update Asana" is what writes. Clearing the field
        // stages null, which is how a due date gets removed in Asana.
        asanaStage(key, 'due_on', inp.value || null, task.due_on || null);
        asanaBoardRender(owner);
      });
      inp.focus();
      if (inp.showPicker) { try { inp.showPicker(); } catch { /* not every browser allows it */ } }
      return;
    }

    if (act === 'edit-notes') {
      const box = ev.target.closest('.asana-notes');
      if (!box || box.querySelector('textarea')) return;
      box.innerHTML =
        `<textarea class="crm-textarea asana-notes-input" rows="5">${esc(eff.notes)}</textarea>
         <div class="asana-actions">
           <button class="btn-sm primary" data-act="notes-save">Save</button>
           <button class="btn-sm" data-act="notes-cancel">Cancel</button>
         </div>`;
      box.querySelector('textarea').focus();
      return;
    }

    if (act === 'notes-save') {
      const ta = card.querySelector('.asana-notes-input');
      if (!ta) return;
      asanaStage(key, 'notes', ta.value, task.notes || '');
      asanaBoardRender(owner);
      return;
    }

    if (act === 'notes-cancel') { asanaBoardRender(owner); return; }

    if (act === 'discard') {
      asanaPending.delete(key); asanaCardError.delete(key); asanaBoardRender(owner); return;
    }

    if (act === 'toggle-comments') {
      const c = asanaComments.get(key) || {};
      if (c.open) { asanaComments.set(key, { ...c, open: false }); asanaBoardRender(owner); return; }
      // Re-open without refetching if we already have them; the Update handler
      // is what refreshes, since that is when they can actually have changed.
      if (Array.isArray(c.items)) { asanaComments.set(key, { ...c, open: true }); asanaBoardRender(owner); return; }
      await asanaLoadComments(owner, gid);
      return;
    }

    if (act === 'add-comment') {
      const ta = card.querySelector('.asana-comment-input');
      const text = (ta?.value || '').trim();
      if (!text) return toast('Write a comment first', 'error');
      const c = asanaComments.get(key) || {};
      asanaComments.set(key, { ...c, posting: true, error: null });
      asanaBoardRender(owner);
      let posted = null;
      try {
        const q = owner === 'erick' ? '?owner=erick' : '';
        posted = await api(`/api/asana/tasks/${encodeURIComponent(gid)}/comments${q}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const cur = asanaComments.get(key) || {};
        asanaComments.set(key, { ...cur, posting: false, items: [...(cur.items || []), posted] });
        toast('Comment added', 'success');
      } catch (err) {
        asanaComments.set(key, { ...asanaComments.get(key), posting: false, error: err.message });
        toast(err.message, 'error');
      }
      asanaBoardRender(owner);
      // Re-rendering empties the textarea. That is what we want once the comment
      // is posted; when it failed, the text goes back so it is not lost with the
      // error message.
      const box = root.querySelector(`.card[data-gid="${CSS.escape(gid)}"] .asana-comment-input`);
      if (box && !posted) { box.value = text; box.focus(); }
      return;
    }

    if (act === 'update') {
      const patch = asanaPending.get(key);
      if (!patch || !Object.keys(patch).length) return;
      const btn = ev.target.closest('button');
      btn.disabled = true; btn.textContent = 'Updating…';
      try {
        const q = owner === 'erick' ? '?owner=erick' : '';
        const updated = await api(`/api/asana/tasks/${encodeURIComponent(gid)}${q}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        // Patch the cache in place rather than refetching: Arturo's board is 183
        // tasks and the response already carries the updated one, fully shaped.
        const list = b.get().tasks;
        const i = list.findIndex(t => t.gid === gid);
        if (i >= 0) list[i] = updated;
        asanaPending.delete(key);
        asanaCardError.delete(key);
        toast('Updated in Asana', 'success');
        asanaBoardRender(owner);
        // Editing a task adds a story to its stream, so an open comment list is
        // out of date the moment the update lands. Only refetched when it is
        // actually on screen.
        if (asanaComments.get(key)?.open) await asanaLoadComments(owner, gid);
      } catch (err) {
        // The staged edit stays put — it was not written, and dropping it here
        // would lose whatever the user typed along with the error. The message
        // goes on the card too: a toast disappears while the amber border does
        // not, leaving no sign of why it is still there.
        asanaCardError.set(key, err.message);
        toast(err.message, 'error');
        asanaBoardRender(owner);
      }
    }
  });
}

// Bound once each, to the containers rather than the cards inside them. Called
// here rather than up with the other wiring: ASANA_BOARDS is a const declared
// above this line, and reaching it from there would hit the temporal dead zone.
wireAsanaEditing('default');
wireAsanaEditing('erick');


// ── Call Analyzer (SimpleVOIP SimplyAI) ──────────────────────────────────────
// Roughly 40% of a day's rows have no transcript — missed calls, internal
// transfers — so the list shows every call and only offers the button where
// there is something to open. Hiding the rest would make the day look quieter
// than it was.

let svCalls = [];
let svUsersLoaded = false;
// Client-side filters over the already-loaded day. Persist across date/agent
// changes so the reviewer keeps their view.
let svFilters = { direction: 'all', status: 'all', phone: '' };

// The roster comes from simplevoip_users. It is empty until the ids are pulled
// from Kazoo, so the selector only appears once there is a choice to make —
// until then the module uses SIMPLEVOIP_USER_ID and the control would be a
// dropdown with one disabled option in it.
//
// Non-admins get no selector at all, and the server refuses a user_id from them
// regardless: hiding a control is not access control, and who may read whose
// calls is still an open question with Lyndsay.
// SmartPBX has 12 users. Only some are on the roster: the rest are held back
// until Lyndsay settles who may read whose calls, then read from the portal by
// hand. This is what the roster is measured against, so the "N pending" note
// shrinks on its own as rows are added and disappears at 12.
const SV_EXPECTED_USERS = 12;

async function svLoadUsers() {
  const sel = $('#sv-user');
  const note = $('#sv-roster-note');
  if (!sel || svUsersLoaded) return;
  const setNote = (msg) => { if (note) note.textContent = msg || ''; };
  try {
    const d = await api('/api/simplevoip/users');
    const users = d.users || [];
    const pending = Math.max(0, SV_EXPECTED_USERS - users.length);

    // Non-admins never get the selector, and the server refuses a user_id from
    // them regardless: hiding a control is not access control, and who may read
    // whose calls is still open with Lyndsay.
    if (!d.canChoose) {
      sel.classList.add('hidden');
      setNote('');
      svUsersLoaded = true;
      return;
    }

    // One user is not a choice — the module falls back to SIMPLEVOIP_USER_ID —
    // so the dropdown only earns its place at two or more.
    if (users.length < 2) {
      sel.classList.add('hidden');
    } else {
      sel.classList.remove('hidden');
      sel.innerHTML = users.map(u =>
        `<option value="${esc(u.user_id)}"${u.user_id === d.defaultUserId ? ' selected' : ''}>${esc(u.name)}${
          u.role ? ` — ${esc(u.role)}` : ''}</option>`).join('');
      // Default to the SIMPLEVOIP_USER_ID user (Rebekah), not whoever the roster
      // sorts first (Danny, alphabetically — and he often has no calls, which
      // read as an empty day). The `selected` attribute above should do this,
      // but set the value explicitly so a browser quirk or a default id that
      // sorts mid-list can't leave the first name showing. Fall back to the
      // first option only if the default isn't in the roster.
      if (d.defaultUserId && users.some(u => u.user_id === d.defaultUserId)) {
        sel.value = d.defaultUserId;
      }
      sel.addEventListener('change', loadCallAnalyzer);
    }

    // Say plainly that the roster is partial and why — otherwise a 5-name
    // dropdown reads as "these are all the users", not "these are the ones
    // approved so far".
    if (pending > 0) {
      setNote(`Showing ${users.length} of ${SV_EXPECTED_USERS} SimpleVOIP users. `
        + `${pending} more pending Lyndsay's access approval — they will be added once she confirms who can view whose calls.`);
    } else {
      setNote('');
    }
    svUsersLoaded = true;
  } catch {
    sel.classList.add('hidden');
    setNote('');
    svUsersLoaded = true;
  }
}

function svTime(unixSeconds) {
  if (!unixSeconds) return '—';
  // Unix SECONDS from the vendor; multiplying is what puts it in this century.
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function svDuration(sec) {
  const s = Number(sec) || 0;
  if (!s) return '—';
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

// The date the view is actually showing. Held here rather than read back off
// the input, because an incomplete entry leaves input.value as the empty
// string — and falling through to today is what made a half-typed date look
// like the picker had silently reset.
let svDate = null;

// input[type=date].value is always YYYY-MM-DD per the HTML spec, or '' when the
// entry is incomplete; MM/DD/YYYY is only how the browser draws it. So this
// mostly passes ISO straight through. The other branches are defensive: a value
// set from script, or a browser that ever hands back what it displayed.
//
// Note this cannot repair digits the widget assigned to the wrong segment —
// those are already wrong by the time .value exists. What it does do is refuse
// a value it cannot trust instead of quietly loading a different day.
function svNormalizeDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let y, m, d;
  let hit = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (hit) { [, y, m, d] = hit; }
  else {
    hit = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (hit) { [, m, d, y] = hit; }        // US order, matching how it is displayed
    else return null;
  }
  y = +y; m = +m; d = +d;
  // Round-trip through a real date so 2026-02-31 is rejected rather than
  // silently rolling into March.
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function loadCallAnalyzer() {
  const list = $('#sv-list');
  if (!list) return;
  const input = $('#sv-date');
  // First open only. Afterwards svDate is what the view is on, so Refresh
  // reloads the day being looked at rather than jumping back to today.
  if (!svDate) svDate = svNormalizeDate(input?.value) || todayStr();
  if (input) input.value = svDate;

  await svLoadUsers();
  list.innerHTML = '<p class="small muted">Loading calls…</p>';
  svClosePanel();
  try {
    const who = $('#sv-user')?.value || '';
    const d = await api(`/api/simplevoip/calls?date=${encodeURIComponent(svDate)}`
      + (who ? `&user_id=${encodeURIComponent(who)}` : ''));
    if (!d.configured) {
      list.innerHTML = `<div class="banner banner-warn">🔌 <b>SimpleVOIP is not configured.</b>
        <div class="small" style="margin-top:6px">${esc(d.message || '')}</div></div>`;
      $('#sv-meta').textContent = '';
      return;
    }
    svCalls = d.calls || [];
    const withT = svCalls.filter(c => c.has_transcript).length;
    $('#sv-meta').textContent =
      `${svCalls.length} call${svCalls.length === 1 ? '' : 's'} on ${d.date} · ${withT} with a transcript`
      + (d.user ? ` · ${d.user}` : '');
    svRender(d.error);
  } catch (err) {
    list.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

// A name coming back from the ring-group data is sometimes a raw 32-hex user id
// rather than a person — those don't identify an agent, so they read as unknown.
function svIsIdLike(s) { return /^[0-9a-f]{16,}$/i.test(String(s || '').trim()); }

// Coarse status buckets used by the filter and the sub-row labels. Kept tolerant
// of both machine keys ("answered_elsewhere") and human labels ("Answered
// Elsewhere") since the field is status_label || status_key.
function svStatusCat(c) {
  const st = String(c.status || '').toLowerCase();
  if (st.includes('elsewhere')) return 'answered_elsewhere';
  if (st.includes('missed') || st.includes('no answer') || st.includes('not answered')) return 'missed';
  if (st.includes('answered') || (c.has_transcript && c.duration > 0)) return 'answered';
  return 'other';
}

function svCallMatches(c) {
  const f = svFilters;
  if (f.direction !== 'all' && String(c.direction || '').toLowerCase() !== f.direction) return false;
  if (f.status !== 'all') {
    if (f.status === 'no_transcript') { if (c.has_transcript) return false; }
    else if (svStatusCat(c) !== f.status) return false;
  }
  if (f.phone) {
    const q = f.phone.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const hay = `${c.caller_number || ''} ${c.to_number || ''} ${c.caller || ''} ${c.to_name || ''}`.toLowerCase();
    const hayDigits = `${c.caller_number || ''} ${c.to_number || ''}`.replace(/\D/g, '');
    const ok = hay.includes(q) || (qDigits && hayDigits.includes(qDigits));
    if (!ok) return false;
  }
  return true;
}

function svRender(error) {
  const list = $('#sv-list');
  if (!list) return;
  if (!svCalls.length) {
    list.innerHTML = (error ? `<div class="banner banner-warn">${esc(error)}</div>` : '')
      + '<div class="empty-state">No calls found for this date.</div>';
    return;
  }

  const sel = (id, label, opts, cur) => `<label class="sv-filter"><span class="muted small">${label}</span>
    <select id="${id}">${opts.map(([v, t]) =>
      `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;

  list.innerHTML = (error ? `<div class="banner banner-warn">Partial results — ${esc(error)}</div>` : '')
    + `<div class="sv-filterbar">
        ${sel('sv-f-dir', 'Direction', [['all', 'All'], ['inbound', 'Inbound'], ['outbound', 'Outbound']], svFilters.direction)}
        ${sel('sv-f-status', 'Status', [['all', 'All'], ['answered', 'Answered'], ['missed', 'Missed'],
          ['answered_elsewhere', 'Answered Elsewhere'], ['no_transcript', 'No Transcript']], svFilters.status)}
        <label class="sv-filter"><span class="muted small">Phone</span>
          <input id="sv-f-phone" type="search" placeholder="number contains…" value="${esc(svFilters.phone)}"></label>
        <span class="sv-count muted small" id="sv-count"></span>
      </div>
      <div id="sv-table-wrap"></div>`;

  // Wire filters. The bar is rendered once; only the table + count re-render on
  // change, so the phone input keeps focus while typing.
  $('#sv-f-dir')?.addEventListener('change', e => { svFilters.direction = e.target.value; svApplyFilters(); });
  $('#sv-f-status')?.addEventListener('change', e => { svFilters.status = e.target.value; svApplyFilters(); });
  $('#sv-f-phone')?.addEventListener('input', e => { svFilters.phone = e.target.value; svApplyFilters(); });

  svApplyFilters();
}

// Re-render just the rows and the count from the current filters, and re-bind
// the per-row controls.
function svApplyFilters() {
  const wrap = $('#sv-table-wrap');
  if (!wrap) return;
  const rows = svCalls.filter(svCallMatches);
  const count = $('#sv-count');
  if (count) count.textContent = `Showing ${rows.length} of ${svCalls.length} call${svCalls.length === 1 ? '' : 's'}`;

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">No calls match the filters.</div>';
    return;
  }

  // The roster the dropdown actually offers — a name is only clickable-to-switch
  // if its user_id is a real option; otherwise the agent isn't in the roster yet
  // and switching would land nowhere, so it shows as a plain label.
  const rosterIds = new Set([...($('#sv-user')?.options || [])].map(o => o.value));

  wrap.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
      <thead><tr><th>Time</th><th>Caller</th><th>Direction</th><th>Duration</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(c => {
        const names = c.answered_elsewhere_user_names || [];
        const ids = c.answered_elsewhere_user_ids || [];
        // Drop id-looking "names" — they don't identify a person.
        const pairs = names.map((nm, i) => ({ nm, uid: ids[i] || '' })).filter(p => p.nm && !svIsIdLike(p.nm));
        const cat = svStatusCat(c);
        let aeInner = '';
        if (pairs.length) {
          aeInner = `<span class="muted small">→ Answered by:</span> ${pairs.map(p =>
            p.uid && rosterIds.has(p.uid)
              ? `<button class="sv-ae-chip" data-uid="${esc(p.uid)}" title="View ${esc(p.nm)}'s calls for this date">${esc(p.nm)}</button>`
              : `<span class="sv-ae-chip sv-ae-chip-static" title="${esc(p.nm)} isn't in the roster dropdown yet">${esc(p.nm)}</span>`
          ).join(' ')}`;
        } else if (cat === 'answered_elsewhere') {
          aeInner = '<span class="muted small">→ Answered elsewhere (unknown agent)</span>';
        } else if (cat === 'missed') {
          aeInner = '<span class="muted small">→ Not answered</span>';
        }
        const aeRow = aeInner ? `<tr class="sv-ae-row"><td colspan="6" class="sv-ae-cell">${aeInner}</td></tr>` : '';
        return `<tr class="${c.office_redirect ? 'sv-row-flagged' : ''}">
        <td class="mono small">${c.office_redirect
              ? '<span class="sv-flag-badge" title="Office Redirect policy violation — open transcript">🚨</span> ' : ''}${esc(svTime(c.datetime))}</td>
        <td>${esc(c.caller)}${c.caller_number && c.caller_number !== c.caller
              ? ` <span class="muted small">${esc(c.caller_number)}</span>` : ''}</td>
        <td class="small muted">${esc(c.direction || '')}</td>
        <td>${esc(svDuration(c.duration))}</td>
        <td class="small muted">${esc(c.status || '')}</td>
        <td>${c.has_transcript
              ? `<button class="btn-sm sv-view" data-id="${esc(c.recording_id)}">View Transcript</button>`
              : '<span class="muted small">no transcript</span>'}</td>
      </tr>${aeRow}`;
      }).join('')}</tbody></table></div>`;

  wrap.querySelectorAll('.sv-view').forEach(btn => btn.addEventListener('click', () => svOpen(btn)));
  wrap.querySelectorAll('.sv-ae-chip[data-uid]').forEach(btn => btn.addEventListener('click', () => {
    const sel = $('#sv-user');
    if (!sel) return;
    sel.value = btn.dataset.uid;   // same date is already held in svDate
    loadCallAnalyzer();
  }));
}

const SV_SENTIMENT_CLASS = { positive: 'badge-green', negative: 'badge-red', neutral: 'badge-gray' };

// SimplyAI returns the transcript as plain prose today — one paragraph, no
// labels. It renders speaker bubbles in its own UI, but the API does not send
// them, so the split is attempted and falls back rather than assumed: if labels
// ever appear the panel picks them up with no further change.
const SV_SPEAKER_RE = /^\s*((?:speaker|participant|agent|caller|customer)\s*\d*)\s*:\s*/i;

function svRenderTranscript(text) {
  const raw = String(text || '').trim();
  if (!raw) return '<i class="muted">Empty transcript.</i>';
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.some(l => SV_SPEAKER_RE.test(l))) return `<div class="sv-text">${esc(raw)}</div>`;
  let last = null;
  return `<div class="sv-turns">${lines.map(l => {
    const m = l.match(SV_SPEAKER_RE);
    const who = m ? m[1].trim() : last;
    const said = m ? l.slice(m[0].length) : l;
    const isNew = who !== last;
    last = who;
    // Alternating sides need a stable notion of "the other speaker"; the first
    // one seen owns the left.
    const side = who && who === lines[0].match(SV_SPEAKER_RE)?.[1]?.trim() ? 'a' : 'b';
    return `<div class="sv-turn sv-turn-${side}">
      ${isNew && who ? `<div class="sv-who">${esc(who)}</div>` : ''}
      <div class="sv-said">${esc(said)}</div></div>`;
  }).join('')}</div>`;
}

function svSection(title, body, open = true) {
  return `<details class="sv-sec"${open ? ' open' : ''}>
    <summary>${esc(title)}</summary><div class="sv-sec-body">${body}</div></details>`;
}

function svClosePanel() {
  const panel = $('#sv-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  panel.closest('.sv-split')?.classList.remove('has-panel');
  $('#sv-overlay')?.classList.add('hidden');
}

async function svOpen(btn) {
  const panel = $('#sv-panel');
  if (!panel) return;
  const id = btn.dataset.id;
  // Time and duration live on the list row, not in the transcript payload.
  const row = svCalls.find(c => c.recording_id === id) || {};
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Loading…';
  panel.classList.remove('hidden');
  panel.closest('.sv-split')?.classList.add('has-panel');
  $('#sv-overlay')?.classList.remove('hidden');
  panel.innerHTML = '<div class="sv-loading"><span class="sv-spinner"></span> Loading transcript…</div>';
  try {
    const who = $('#sv-user')?.value || '';
    const t = await api(`/api/simplevoip/calls/${encodeURIComponent(id)}/transcript`
      + (who ? `?user_id=${encodeURIComponent(who)}` : ''));

    // sentiment_pct is the model's confidence in the label it chose, pulled out
    // of the four-way breakdown server-side. Hidden entirely when absent rather
    // than shown as an empty badge.
    const sentiment = t.sentiment ? `
      <div class="sv-sentiment">
        <span class="badge ${SV_SENTIMENT_CLASS[String(t.sentiment).toLowerCase()] || 'badge-gray'}">${esc(t.sentiment)}</span>
        ${t.sentiment_pct != null ? `<span class="muted small">${t.sentiment_pct}% confidence</span>` : ''}
      </div>` : '';

    const meta = [
      t.word_count != null ? `${t.word_count} words` : null,
      t.tokens_used != null ? `${t.tokens_used} tokens` : null,
      t.recording_id,
    ].filter(Boolean).join(' · ');

    // Compliance — Office Redirect (Lyndsay 09/01). Shown prominently in red
    // with the exact quote, and phrased as the policy-violation action item.
    const or = t.compliance?.office_redirect;
    const agent = t.agent_name || $('#sv-user')?.selectedOptions?.[0]?.textContent || 'the agent';
    const compliance = or?.flagged ? `
      <div class="sv-compliance">
        <div class="sv-compliance-flag">🚨 Policy Violation — Office Redirect</div>
        <div class="sv-compliance-quote">“${esc(or.quote || '')}”</div>
        <div class="sv-compliance-action">POLICY VIOLATION: Agent directed resident/applicant to office — requires follow-up with ${esc(agent)}</div>
      </div>` : '';

    // Keep everything the transcript view needs so the panel can switch between
    // the transcript and the grade result without re-fetching.
    svPanelState = { t, row, agent, meta, compliance, sentiment, grade: null };
    svRenderTranscriptPanel();
    svLoadExistingGrade(t.recording_id || id);   // non-blocking: reveals a "View grade" chip if one exists
  } catch (err) {
    panel.innerHTML = `<div class="sv-panel-head"><span class="small muted">Could not load that transcript: ${esc(err.message)}</span>
      <button class="btn-sm" id="sv-close">✕</button></div>`;
    $('#sv-close')?.addEventListener('click', svClosePanel);
  } finally { btn.disabled = false; btn.textContent = original; }
}

// ── Call grading (Lyndsay's Call Quality Analyzer, server-side) ─────────────
// Holds the currently-open transcript so the panel can flip between the
// transcript and its grade without re-fetching.
let svPanelState = null;

const SVG_GRADE_COLORS = { A: '#16A34A', B: '#1D4ED8', C: '#A16207', D: '#C2410C', F: '#DC2626' };
const SVG_NS_COLOR = '#6B7280';   // neutral gray — not a grade
const svgGradeColor = g => SVG_GRADE_COLORS[g] || '#8A8578';
function svgScoreColor(s) { s = Number(s) || 0; return s >= 8 ? '#2ECC8A' : s >= 6 ? '#4A90D9' : s >= 4 ? '#F5A623' : '#E8455A'; }
const svgIsFlagged = g => !!(g && (g.legal_violation || g.fair_housing_flag || g.liability_flag || (Array.isArray(g.flags) && g.flags.length)));

// "Not Scoreable" — the AI flags a transcript that isn't the listed agent's call
// (a support call, a different speaker, no scoreable criteria). It comes back as
// F/low with a flag; we treat it as its own status so it doesn't read as a real F
// or pollute agent metrics. Detected from the stored flags — no re-grade needed.
const SVG_NS_PATTERNS = [/wrong\s*call/i, /no\s*scoreable\s*criteria\s*met/i];
function svgNotScoreable(g) {
  return Array.isArray(g?.flags) && g.flags.some(f => SVG_NS_PATTERNS.some(re => re.test(String(f || ''))));
}
// Badge letter and colour, honouring Not Scoreable.
const svgBadgeText = g => svgNotScoreable(g) ? 'N/S' : (g.overall_grade || '?');
const svgBadgeColor = g => svgNotScoreable(g) ? SVG_NS_COLOR : svgGradeColor(g.overall_grade);

// The transcript panel — identical to before, plus a Grade button in the header
// and a slot for an existing-grade chip. Rendered from svPanelState so "← Transcript"
// from the grade view can restore it without a refetch.
function svRenderTranscriptPanel() {
  const panel = $('#sv-panel');
  if (!panel || !svPanelState) return;
  const { t, row, compliance, sentiment, meta } = svPanelState;
  panel.innerHTML = `
    <div class="sv-panel-head">
      <div>
        <h4 style="margin:0">${esc(t.caller || row.caller || 'Call')}</h4>
        <p class="muted small" style="margin:2px 0 0">
          ${esc(row.datetime ? svTime(row.datetime) : '')}${row.duration ? ` · ${esc(svDuration(row.duration))}` : ''}
        </p>
      </div>
      <div class="sv-head-actions">
        <button class="btn-sm primary" id="sv-grade-btn">⭐ Grade This Call</button>
        <button class="btn-sm" id="sv-close" aria-label="Close">✕</button>
      </div>
    </div>
    <div id="sv-grade-chip"></div>
    ${compliance}
    ${sentiment}
    ${svSection('Summary', t.summary ? `<div class="sv-text">${esc(t.summary)}</div>`
                                     : '<i class="muted">No summary available.</i>')}
    <div class="sv-sec sv-sec-transcript">
      <div class="sv-sec-title">Transcript</div>
      <div class="sv-sec-body"><div class="sv-transcript-scroll">${svRenderTranscript(t.transcript_text)}</div></div>
    </div>
    <div class="sv-foot muted small">${esc(meta)}</div>`;
  $('#sv-close')?.addEventListener('click', svClosePanel);
  $('#sv-grade-btn')?.addEventListener('click', svGradeCurrent);
  svRenderGradeChip();
}

function svRenderGradeChip() {
  const chip = $('#sv-grade-chip');
  if (!chip) return;
  const g = svPanelState?.grade;
  if (!g) { chip.innerHTML = ''; return; }
  const ns = svgNotScoreable(g);
  chip.innerHTML = `<button class="sv-grade-chip" id="sv-view-grade">
    <span class="sv-grade-chip-badge" style="background:${svgBadgeColor(g)}">${esc(svgBadgeText(g))}</span>
    ${ns ? 'Not Scoreable' : ('Graded ' + (g.overall_score != null ? g.overall_score + '/100' : ''))} · view →</button>`;
  $('#sv-view-grade')?.addEventListener('click', () => svShowGrade(svPanelState.grade));
}

async function svLoadExistingGrade(recordingId) {
  if (!recordingId) return;
  try {
    const d = await api(`/api/calls/grades/${encodeURIComponent(recordingId)}`);
    if (d.grade && svPanelState && (svPanelState.t.recording_id === recordingId || svPanelState.row.recording_id === recordingId)) {
      svPanelState.grade = d.grade;
      svRenderGradeChip();
    }
  } catch { /* no existing grade / not configured — leave the chip empty */ }
}

async function svGradeCurrent() {
  if (!svPanelState) return;
  const panel = $('#sv-panel');
  const { t, row } = svPanelState;
  const recordingId = t.recording_id || row.recording_id;
  if (!recordingId) { toast('No recording id for this call', 'error'); return; }
  const transcript = t.transcript_text || '';
  if (!transcript.trim()) { toast('This call has no transcript to grade', 'error'); return; }

  const agent = t.agent_name
    || ($('#sv-user')?.selectedOptions?.[0]?.textContent || '').split('—')[0].trim()
    || null;

  // Grade view swaps in while we wait, so the click has immediate feedback.
  panel.innerHTML = `<div class="sv-panel-head">
      <div><h4 style="margin:0">Grading call…</h4></div>
      <button class="btn-sm" id="sv-close">✕</button>
    </div>
    <div class="sv-loading" style="flex:1 1 auto"><span class="sv-spinner"></span> Grading with Claude — this can take ~20s…</div>`;
  $('#sv-close')?.addEventListener('click', svClosePanel);

  try {
    const d = await api('/api/calls/grade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: recordingId,
        agent_name: agent,
        call_date: svDate || null,
        call_direction: row.direction || null,
        duration_seconds: row.duration || null,
        transcript,
      }),
    });
    svPanelState.grade = d.grade;
    svShowGrade(d.grade);
  } catch (err) {
    toast('Grading failed: ' + err.message, 'error');
    svRenderTranscriptPanel();   // restore the transcript view
  }
}

// The grade result, shown in the same panel with a back button. Reuses the
// transcript section's flex:1 scroll region so it scrolls to any length.
function svShowGrade(g) {
  const panel = $('#sv-panel');
  if (!panel || !g) return;
  const { row } = svPanelState || {};
  const metaLine = [
    g.agent_name || (svPanelState?.t?.agent_name),
    g.call_date, row?.direction,
    (g.duration_seconds != null ? svDuration(g.duration_seconds) : (row?.duration ? svDuration(row.duration) : null)),
    g.property_name && g.property_name !== 'Unidentified' ? '📍 ' + g.property_name : null,
  ].filter(Boolean).join(' · ');
  const ns = svgNotScoreable(g);
  panel.innerHTML = `
    <div class="sv-panel-head">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <div class="svg-grade-box${ns ? ' ns' : ''}" style="background:${svgBadgeColor(g)}">
          <div class="svg-grade-letter">${esc(svgBadgeText(g))}</div>
          ${ns ? '' : `<div class="svg-grade-score">${g.overall_score != null ? g.overall_score : ''}/100</div>`}
        </div>
        <div style="min-width:0">
          <h4 style="margin:0">${ns ? 'Not Scoreable' : 'Call Grade'}</h4>
          <p class="muted small" style="margin:2px 0 0">${esc(metaLine)}</p>
        </div>
      </div>
      <div class="sv-head-actions">
        <button class="btn-sm" id="sv-grade-back">← Transcript</button>
        <button class="btn-sm" id="sv-close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="sv-sec sv-sec-transcript">
      <div class="sv-sec-body"><div class="sv-transcript-scroll svg-fb">${svGradeFeedbackHtml(g)}</div></div>
    </div>`;
  $('#sv-close')?.addEventListener('click', svClosePanel);
  $('#sv-grade-back')?.addEventListener('click', svRenderTranscriptPanel);
}

// Ported from Lyndsay's renderFeedbackBody — alerts, summary, outcome, flags,
// scorecard, coaching, key moments. Namespaced under .svg-fb.
function svGradeFeedbackHtml(g) {
  let html = '';
  if (svgNotScoreable(g)) html += `<div class="svg-alert ns">🚫 <b>Not Scoreable</b> — this transcript doesn't reflect the listed agent's call (wrong call / no scoreable criteria). It's excluded from the agent's average and grade distribution.</div>`;
  if (g.legal_violation) html += `<div class="svg-alert legal">⚖️ Legal / liability language detected. Do not engage further without supervisor guidance — escalate to management immediately.</div>`;
  if (g.fair_housing_flag) html += `<div class="svg-alert amber">🏠 Possible Fair Housing concern detected on this call. Review required.</div>`;
  if (g.liability_flag && !g.legal_violation) html += `<div class="svg-alert amber">⚠️ Liability flag raised — threat of legal action or attorney mention. Escalate to management.</div>`;

  html += `<div class="svg-sec"><div class="svg-sec-title">Summary</div><div class="svg-text">${esc(g.summary || '—')}</div></div>`;
  html += `<div class="svg-sec"><div class="svg-sec-title">Outcome</div><div class="svg-text">${esc(g.outcome || '—')}</div></div>`;

  if (Array.isArray(g.flags) && g.flags.length) {
    html += `<div class="svg-sec"><div class="svg-sec-title">Flags</div>${g.flags.map(f => `<span class="svg-flag-chip">${esc(f)}</span>`).join('')}</div>`;
  }

  if (Array.isArray(g.categories) && g.categories.length) {
    html += `<div class="svg-sec"><div class="svg-sec-title">Scorecard</div>`;
    g.categories.forEach(cat => {
      html += `<div class="svg-cat"><div class="svg-cat-head"><span>${esc(cat.name)}</span>
        <span class="svg-cat-weight">Weight ${cat.weight != null ? cat.weight : '—'}% · Score ${cat.score != null ? cat.score : '—'}/10</span></div>`;
      (cat.items || []).forEach(item => {
        const s = Number(item.score) || 0;
        html += `<div class="svg-item">
          <span class="svg-item-label">${esc(item.label)}</span>
          <span class="svg-item-track"><span class="svg-item-fill" style="width:${Math.min(100, s * 10)}%;background:${svgScoreColor(s)}"></span></span>
          <span class="svg-item-num">${s}/10</span>
          <span class="svg-item-note">${esc(item.note || '')}</span></div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
  }

  if (Array.isArray(g.coaching) && g.coaching.length) {
    html += `<div class="svg-sec"><div class="svg-sec-title">Coaching Notes</div>`;
    g.coaching.forEach(co => {
      html += `<div class="svg-coach">
        <div class="svg-coach-cat">${esc(co.category || '')}</div>
        <div class="svg-coach-row strength">✅ <b>Strength:</b> ${esc(co.strength || '')}</div>
        <div class="svg-coach-row improve">🎯 <b>Improve:</b> ${esc(co.improve || '')}</div></div>`;
    });
    html += `</div>`;
  }

  if (Array.isArray(g.key_moments) && g.key_moments.length) {
    html += `<div class="svg-sec"><div class="svg-sec-title">Key Moments</div>
      <ul class="svg-moments">${g.key_moments.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
  }
  return html || '<div class="svg-sec"><span class="muted small">No grading detail.</span></div>';
}

// ── Grades dashboard (the "Grades" sub-view) ────────────────────────────────
const svgState = { grades: [], filters: { agent: 'All', grade: 'All', direction: 'All', flagged: false }, wired: false, loaded: false };

function svSetView(view) {
  $$('#sv-view-toggle .sv-vt-btn').forEach(b => b.classList.toggle('active', b.dataset.svView === view));
  $('#sv-view-calls')?.classList.toggle('hidden', view !== 'calls');
  $('#sv-view-grades')?.classList.toggle('hidden', view !== 'grades');
  if (view === 'grades') svgLoad();
}

async function svgLoad() {
  const el = $('#sv-view-grades');
  if (!el) return;
  if (!svgState.loaded) el.innerHTML = '<p class="small muted">Loading grades…</p>';
  try {
    const d = await api('/api/calls/grades');
    svgState.grades = d.grades || [];
    svgState.loaded = true;
    svgRender();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

function svgFiltered() {
  const f = svgState.filters;
  return svgState.grades.filter(g => {
    if (f.agent !== 'All' && (g.agent_name || 'Unidentified') !== f.agent) return false;
    const ns = svgNotScoreable(g);
    // Grade filters never surface Not Scoreable (it isn't a real grade); the
    // dedicated 'NS' filter shows only those, and 'All' shows everything.
    if (f.grade === 'NS') { if (!ns) return false; }
    else if (f.grade === 'DF') { if (ns || !['D', 'F'].includes(g.overall_grade)) return false; }
    else if (['A', 'B', 'C'].includes(f.grade)) { if (ns || g.overall_grade !== f.grade) return false; }
    if (f.direction !== 'All' && (g.call_direction || '') !== f.direction) return false;
    if (f.flagged && !svgIsFlagged(g)) return false;
    return true;
  });
}

// KPIs are computed over SCOREABLE calls only — Not Scoreable calls are counted
// separately so they never move the average, distribution, or coaching totals.
function svgKpis(list) {
  const scoreable = list.filter(c => !svgNotScoreable(c));
  const notScoreable = list.length - scoreable.length;
  const n = scoreable.length;
  const avg = n ? Math.round(scoreable.reduce((s, c) => s + (Number(c.overall_score) || 0), 0) / n) : 0;
  const aCount = scoreable.filter(c => c.overall_grade === 'A').length;
  const mix = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  scoreable.forEach(c => { if (mix[c.overall_grade] !== undefined) mix[c.overall_grade]++; });
  return {
    n, avg, aCount, aPct: n ? Math.round(aCount / n * 100) : 0, notScoreable,
    coaching: scoreable.filter(c => ['C', 'D', 'F'].includes(c.overall_grade)).length,
    flagged: scoreable.filter(svgIsFlagged).length, mix,
  };
}

function svgRender() {
  const el = $('#sv-view-grades');
  if (!el) return;
  const list = svgFiltered();
  const k = svgKpis(list);
  const maxMix = Math.max(1, k.mix.A, k.mix.B, k.mix.C, k.mix.D, k.mix.F);
  const bars = ['A', 'B', 'C', 'D', 'F'].map(g =>
    `<div class="svg-bar" style="height:${Math.round((k.mix[g] / maxMix) * 34) + 2}px;background:${svgGradeColor(g)}"></div>`).join('');

  const agents = ['All', ...Array.from(new Set(svgState.grades.map(g => g.agent_name || 'Unidentified'))).sort()];
  const nsTotal = svgState.grades.filter(svgNotScoreable).length;
  const pillDefs = [['All', 'All'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['DF', 'D/F']];
  if (nsTotal) pillDefs.push(['NS', 'Not Scoreable']);
  const gradePills = pillDefs.map(([v, t]) =>
    `<button class="svg-pill${v === 'NS' ? ' ns' : ''}${svgState.filters.grade === v ? ' active' : ''}" data-svg-grade="${v}">${t}</button>`).join('');

  el.innerHTML = `
    <div class="svg-kpis">
      <div class="svg-kpi"><div class="svg-kpi-lab">Avg Score</div><div class="svg-kpi-val">${k.avg}</div><div class="svg-kpi-sub">${k.n} scored${k.notScoreable ? ` · ${k.notScoreable} not scoreable` : ''}</div></div>
      <div class="svg-kpi"><div class="svg-kpi-lab">A-Grade %</div><div class="svg-kpi-val">${k.aPct}%</div><div class="svg-kpi-sub">${k.aCount} A grade${k.aCount === 1 ? '' : 's'}</div></div>
      <div class="svg-kpi"><div class="svg-kpi-lab">Coaching</div><div class="svg-kpi-val">${k.coaching}</div><div class="svg-kpi-sub">C / D / F</div></div>
      <div class="svg-kpi"><div class="svg-kpi-lab">Flagged</div><div class="svg-kpi-val">${k.flagged}</div><div class="svg-kpi-sub">Quality concerns</div></div>
      <div class="svg-kpi"><div class="svg-kpi-lab">Grade Mix</div><div class="svg-bars">${bars}</div>
        <div class="svg-bar-labels"><span>A</span><span>B</span><span>C</span><span>D</span><span>F</span></div></div>
    </div>
    <div class="svg-filters">
      ${gradePills}
      <button class="svg-pill flag${svgState.filters.flagged ? ' active' : ''}" data-svg-flagged>🚩 Flagged</button>
      <select class="crm-select" id="svg-f-agent">${agents.map(a => `<option value="${esc(a)}"${svgState.filters.agent === a ? ' selected' : ''}>${a === 'All' ? 'All agents' : esc(a)}</option>`).join('')}</select>
      <select class="crm-select" id="svg-f-dir">${[['All', 'All directions'], ['inbound', 'Inbound'], ['outbound', 'Outbound']].map(([v, t]) => `<option value="${v}"${svgState.filters.direction === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <span class="muted small" style="margin-left:auto">${list.length} of ${svgState.grades.length}</span>
    </div>
    <div class="svg-list">${svgListHtml(list)}</div>`;

  el.querySelectorAll('[data-svg-grade]').forEach(b => b.addEventListener('click', () => { svgState.filters.grade = b.dataset.svgGrade; svgRender(); }));
  el.querySelector('[data-svg-flagged]')?.addEventListener('click', () => { svgState.filters.flagged = !svgState.filters.flagged; svgRender(); });
  $('#svg-f-agent')?.addEventListener('change', e => { svgState.filters.agent = e.target.value; svgRender(); });
  $('#svg-f-dir')?.addEventListener('change', e => { svgState.filters.direction = e.target.value; svgRender(); });
  el.querySelectorAll('.svg-row').forEach(r => r.addEventListener('click', () => svgOpenDetail(r.dataset.rid)));
}

function svgListHtml(list) {
  if (!list.length) return '<div class="empty-state">No graded calls match these filters.</div>';
  return list.map(g => { const ns = svgNotScoreable(g); return `<div class="svg-row${ns ? ' ns' : ''}" data-rid="${esc(g.recording_id)}">
    <div class="svg-row-badge${ns ? ' ns' : ''}" style="background:${svgBadgeColor(g)}">${esc(svgBadgeText(g))}</div>
    <div class="svg-row-body">
      <div class="svg-row-agent">${esc(g.agent_name || 'Unidentified')}${ns ? '' : (svgIsFlagged(g) ? ' 🚩' : '')}</div>
      <div class="svg-row-meta">
        ${ns ? '<span class="svg-ns-tag">Not Scoreable</span> · ' : ''}
        ${g.call_direction ? `<span class="small muted">${esc(g.call_direction)}</span> · ` : ''}
        <span class="small muted">${esc(g.call_date || '')}</span>
        ${g.duration_seconds != null ? ` · <span class="small muted">${svDuration(g.duration_seconds)}</span>` : ''}
        ${g.property_name && g.property_name !== 'Unidentified' ? ` · <span class="small muted">📍 ${esc(g.property_name)}</span>` : ''}
      </div>
    </div>
    <div class="svg-row-score">${ns ? '' : (g.overall_score != null ? g.overall_score : '')}</div>
  </div>`; }).join('');
}

async function svgOpenDetail(recordingId) {
  try {
    const d = await api(`/api/calls/grades/${encodeURIComponent(recordingId)}`);
    if (!d.grade) { toast('Grade not found', 'error'); return; }
    svgShowModal(d.grade);
  } catch (err) { toast(err.message, 'error'); }
}

function svgShowModal(g) {
  let ov = $('#svg-modal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'svg-modal';
    ov.className = 'svg-modal-overlay';
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  }
  const metaLine = [g.agent_name, g.call_date, g.call_direction,
    g.duration_seconds != null ? svDuration(g.duration_seconds) : null,
    g.property_name && g.property_name !== 'Unidentified' ? '📍 ' + g.property_name : null].filter(Boolean).join(' · ');
  const ns = svgNotScoreable(g);
  ov.innerHTML = `<div class="svg-modal-card">
    <div class="svg-modal-head" style="background:${svgBadgeColor(g)}">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="svg-grade-box" style="background:rgba(0,0,0,.18)">
          <div class="svg-grade-letter">${esc(svgBadgeText(g))}</div>
          ${ns ? '' : `<div class="svg-grade-score">${g.overall_score != null ? g.overall_score : ''}/100</div>`}
        </div>
        <div><div style="font-weight:700;font-size:15px">${esc(g.agent_name || 'Unidentified')}</div>
          <div style="font-size:12px;opacity:.9">${esc(metaLine)}</div></div>
      </div>
      <button class="svg-modal-close" id="svg-modal-close">✕</button>
    </div>
    <div class="svg-modal-body svg-fb">${svGradeFeedbackHtml(g)}</div>
  </div>`;
  $('#svg-modal-close')?.addEventListener('click', () => ov.remove());
}

// Clicking away closes it. Bound once to a backdrop rather than to document, so
// a click inside the panel cannot bubble out and shut it mid-read.
$('#sv-overlay')?.addEventListener('click', svClosePanel);
$$('#sv-view-toggle .sv-vt-btn').forEach(b => b.addEventListener('click', () => svSetView(b.dataset.svView)));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sv-panel')?.classList.contains('hidden')) svClosePanel();
});

$('#sv-refresh')?.addEventListener('click', loadCallAnalyzer);
$('#sv-date')?.addEventListener('change', e => {
  const next = svNormalizeDate(e.target.value);
  if (!next) {
    // Half-typed or impossible. Put back the day being shown and say so,
    // rather than loading a different one and letting it pass for the ask.
    e.target.value = svDate || todayStr();
    return toast('That date could not be read — the day shown is unchanged.', 'error');
  }
  svDate = next;
  e.target.value = next;
  loadCallAnalyzer();
});

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

    // An empty list has two very different causes and they used to render the
    // same. Erick reading "no tasks" when the token is actually broken means the
    // tab quietly lies for as long as nobody checks the Render logs.
    if (!tasks.length && data.error) {
      el.innerHTML = `
        <div class="banner banner-warn">
          ⚠ <b>Could not connect to Asana — check token.</b>
          <div class="small" style="margin-top:6px">
            This is not an empty board: the request failed, so nothing could be loaded.
            Verify <code>ASANA_TOKEN_ERICK</code> in the Render environment.
            <div style="margin-top:4px">Asana said: <code>${esc(data.error)}</code></div>
          </div>
        </div>`;
      return;
    }

    if (!tasks.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div>No open Asana tasks assigned to Erick right now.</div>
          <div class="small muted" style="margin-top:6px">Tasks will appear here automatically when assigned.</div>
        </div>`;
      return;
    }

    maintAsanaCache = tasks;
    maintAsanaStale = !!data.stale;
    asanaBoardRender('erick');
  } catch (err) { el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`; }
}

// ── Arturo's Asana board, inside the Task Manager tab ────────────────
// Same renderer as Erick's, different endpoint: no owner param means the default
// token. His tasks come from the project boards in ASANA_EXTRA_PROJECTS rather
// than from anything assigned to him directly.
async function loadAsanaPanel() {
  const el = $('#asana-panel-body');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const data = await api('/api/asana/tasks');
    const tasks = Array.isArray(data) ? data : (data.tasks || data.data || []);

    if (!tasks.length && data.error) {
      el.innerHTML = `
        <div class="banner banner-warn">
          ⚠ <b>Could not connect to Asana — check token.</b>
          <div class="small" style="margin-top:6px">
            This is not an empty board: the request failed, so nothing could be loaded.
            <div style="margin-top:4px">Asana said: <code>${esc(data.error)}</code></div>
          </div>
        </div>`;
      return;
    }

    asanaPanelCache = tasks;
    asanaPanelStale = !!data.stale;
    asanaBoardRender('default');
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

// ── Row-level read / edit mode ───────────────────────────────────────
// Property Assignments and Technician Capabilities both rendered every field as
// a live input with a Save button always showing, so a table you had opened only
// to read was one stray keystroke and one click from being written. Rows now
// start locked; Edit opens one row, Cancel puts back what was there.
// Both tables mark their editable fields with data-field, so this is shared.
const rowFields = tr => [...tr.querySelectorAll('[data-field]')];
const rowSnapshot = tr => rowFields(tr).map(i => i.type === 'checkbox' ? i.checked : i.value);

function setRowLocked(tr, locked) {
  rowFields(tr).forEach(i => { i.disabled = locked; });
  tr.classList.toggle('row-editing', !locked);
  tr.querySelector('.row-edit')?.classList.toggle('hidden', !locked);
  tr.querySelector('.row-save')?.classList.toggle('hidden', locked);
  tr.querySelector('.row-cancel')?.classList.toggle('hidden', locked);
}

function rowRestore(tr, snap) {
  rowFields(tr).forEach((i, n) => {
    if (i.type === 'checkbox') i.checked = snap[n]; else i.value = snap[n];
    // The capability selects colour themselves on change; undoing the value has
    // to undo the colour too or a cancelled edit still looks changed.
    if (i.classList.contains('tc-cap-select')) i.className = 'tc-cap-select ' + (CAP_CLASS[i.value] || '');
  });
}

// onSave returns false to keep the row open — a validation error the user still
// has to fix. Anything else counts as done and re-locks the row.
function wireRowEditing(tr, onSave) {
  let snap = null;
  setRowLocked(tr, true);
  tr.querySelector('.row-edit')?.addEventListener('click', () => {
    snap = rowSnapshot(tr);
    setRowLocked(tr, false);
    rowFields(tr)[0]?.focus();
  });
  tr.querySelector('.row-cancel')?.addEventListener('click', () => {
    if (snap) rowRestore(tr, snap);
    setRowLocked(tr, true);
  });
  tr.querySelector('.row-save')?.addEventListener('click', async ev => {
    if (await onSave(tr, ev.currentTarget) === false) return;
    setRowLocked(tr, true);
  });
}

const ROW_EDIT_BUTTONS = `
  <button class="btn-sm row-edit">Edit</button>
  <button class="btn-sm primary row-save hidden">Save</button>
  <button class="btn-sm row-cancel hidden">Cancel</button>`;

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
        <td class="row-actions">${ROW_EDIT_BUTTONS}</td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    el.innerHTML = html;

    el.querySelectorAll('tbody tr').forEach(tr => wireRowEditing(tr, saveAssignmentRow));
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

async function saveAssignmentRow(tr, btn) {
  const prop = tr.dataset.prop;
  if (!prop) { toast('This row has no property name — reload and try again', 'error'); return false; }

  const update = {};
  tr.querySelectorAll('.maint-edit').forEach(inp => {
    const f = inp.dataset.field;
    if (inp.type === 'checkbox') { update[f] = inp.checked; return; }
    const v = inp.value.trim();
    // units is an INTEGER column: '' would be rejected outright.
    update[f] = (f === 'units') ? (v === '' ? null : Number(v)) : v;
  });
  if (update.units !== null && update.units !== undefined && Number.isNaN(update.units)) {
    toast('Units must be a number', 'error');
    return false;   // keep the row open — there is something to correct
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
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;   // the edit is not saved; closing the row would imply it was
  } finally {
    btn.disabled = false;
    btn.textContent = original;
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
    `${techCache.length} technicians · ${techCache.filter(t => t.expect_daily_hours).length} on the daily-hours alert · press Edit on a row to change it`;

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
        ${ROW_EDIT_BUTTONS}
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

  el.querySelectorAll('tbody tr').forEach(tr => wireRowEditing(tr, saveTechnicianRow));

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
    loadTechnicians();        // re-renders the table, so every row comes back locked
    return true;
  } catch (err) { toast(err.message, 'error'); return false; }
}

// ── 2. Operational Tasks Kanban ──────────────────────────────────────
const MAINT_COLUMNS = [
  { key: '🔴 Critical',   header: '🔴 Critical',   cls: 'col-critical' },
  { key: '🟡 Follow-up',  header: '🟡 Follow-up',  cls: 'col-followup' },
  { key: '🟢 In Progress',header: '🟢 In Progress',cls: 'col-inprogress' },
  // 🔁, not 📅 — this must match OPS_PRIORITIES / DAILY_STATUS in metric-routes.js.
  // It did not, so every Daily Task was grouped into In Progress and its select
  // fell through to the first option and read "Critical".
  { key: '🔁 Daily Task', header: '🔁 Daily Task', cls: 'col-daily' },
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

// The dropdown must never misreport a task's priority. With no matching option a
// browser selects the first one, so an unrecognised value silently displayed as
// "🔴 Critical" — and picking anything from that lying select wrote a real change,
// which for a Daily Task means losing the 🔁 that resetDailyTasks keys on. An
// unknown value is now shown as itself.
function maintPriorityOptions(priority) {
  const opts = MAINT_COLUMNS.map(c =>
    `<option value="${esc(c.key)}"${c.key === priority ? ' selected' : ''}>${esc(c.key)}</option>`);
  if (priority && !MAINT_COLUMNS.some(c => c.key === priority)) {
    opts.unshift(`<option value="${esc(priority)}" selected>${esc(priority)}</option>`);
  }
  return opts.join('');
}

// Two priorities ignore the date window entirely. A critical item stays on the
// board until it is dealt with, however long that takes — ageing out of "Today"
// is the opposite of what it needs. And a Daily Task is today's work by
// definition: resetDailyTasks clears its completed_at each morning but never
// touches created_at, so filtering on the creation date would quietly drop
// Erick's whole routine the day after it was set up.
function maintInRange(t) {
  if (maintTimeFilter === 'all') return true;
  if (t.priority === '🔴 Critical' || t.priority === '🔁 Daily Task') return true;
  let cutoff = todayStr();
  if (maintTimeFilter === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 7);
    cutoff = localDateStr(d);
  }
  if (t.completed_at) return localDateStr(t.completed_at) >= cutoff;
  return localDateStr(t.created_at) >= cutoff;
}

function renderMaintenanceKanban() {
  const el = $('#maint-tasks-body');
  if (!el) return;

  const baseList = maintTaskCache.filter(maintInRange);
  $$('#maint-time-pills .pill').forEach(p => p.classList.toggle('active', p.dataset.time === maintTimeFilter));

  const grouped = {};
  MAINT_COLUMNS.forEach(c => { grouped[c.key] = []; });
  // Unknown values still land somewhere rather than vanishing, but they no longer
  // do it silently: a mismatch between this list and the server's is exactly the
  // bug above, and it is invisible until someone notices the counts are wrong.
  const orphans = new Set();
  baseList.forEach(t => {
    let col = t.priority;
    if (grouped[col] == null) { orphans.add(t.priority); col = '🟢 In Progress'; }
    grouped[col].push(t);
  });
  if (orphans.size) console.warn('[maint-kanban] priority with no column:', [...orphans]);

  el.className = 'kanban';

  if (!baseList.length) {
    el.innerHTML = maintTaskCache.length
      ? '<div class="empty-state">Nothing in this range. Try “All”.</div>'
      : '<div class="empty-state">No tasks. Add one above ☝</div>';
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
                <button class="btn-sm maint-task-note" data-id="${esc(t.id)}">+ Add</button>
              </div>
            </details>
            <div class="card-actions">
              ${!done ? `<button class="btn-sm primary maint-task-done" data-id="${esc(t.id)}">✓ Done</button>` : `<button class="btn-sm maint-task-undone" data-id="${esc(t.id)}">Undo</button>`}
              <select class="crm-select maint-task-prio" data-id="${esc(t.id)}" style="font-size:0.78rem">
                ${maintPriorityOptions(t.priority)}
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
  el.querySelectorAll('.maint-task-note').forEach(btn => {
    btn.addEventListener('click', async () => {
      const input = btn.closest('.note-add').querySelector('[data-note-input]');
      const text = input.value.trim();
      if (!text) return toast('Write a note first', 'error');
      try {
        await api(`/api/operational/${btn.dataset.id}/notes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        toast('Note added', 'success');
        loadMaintenanceTasks();
      } catch (err) { toast(err.message, 'error'); }
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


// ============================================================================
// UNIFIED DAILY OPERATIONS REPORT
// ============================================================================
// Shell only. The seven sections render their structure and a placeholder; the
// content phase lands once the team confirms what each of them reports.

let reportState = { report: null, sections: [], signers: [], me: null };

// The spec calls for green/yellow/red. A freshly generated section is none of
// those — nobody has looked at it yet — so 'pending' gets its own grey badge
// rather than borrowing one of the three and implying a judgement.
const REPORT_STATUS_BADGE = {
  ok:        '<span class="badge badge-green">On track</span>',
  attention: '<span class="badge badge-amber">Needs attention</span>',
  urgent:    '<span class="badge badge-red">Urgent</span>',
  pending:   '<span class="badge badge-gray">Pending</span>',
};

async function reportLoad() {
  const el = $('#report-sections');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const data = await api('/api/reports/daily/today');
    reportState = { report: data.report, sections: data.sections || [], signers: data.signers || [], me: data.me };
    reportRenderSections();
    $('#report-views-panel')?.classList.toggle('hidden', !data.me?.isAdmin);

    if (!data.report) {
      $('#report-meta').textContent = 'No report generated for today yet.';
      $('#report-signoffs').innerHTML = '<p class="small muted">Generate the report before signing off.</p>';
      $('#report-views').innerHTML = '';
      return;
    }
    $('#report-meta').textContent =
      `${data.report.report_date} · generated ${new Date(data.report.created_at).toLocaleString()}`;

    // Logged before the sign-offs render, so opening the tab counts as a read
    // whether or not the person goes on to sign.
    api('/api/reports/daily/view', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_id: data.report.id }),
    }).catch(() => {});

    await reportLoadSignoffs();
    if (data.me?.isAdmin) await reportLoadViews();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

function reportRenderSections() {
  const el = $('#report-sections');
  if (!el) return;
  // Before the first generate there is no stored report, so the structure comes
  // from the server's section list — the shell is visible either way.
  const sections = reportState.report?.sections?.length
    ? reportState.report.sections : reportState.sections;
  if (!sections.length) { el.innerHTML = '<div class="empty-state">No sections defined.</div>'; return; }

  el.innerHTML = sections.map(s => `
    <details class="report-card" open>
      <summary class="report-card-head">
        <span class="report-card-title">${esc(s.icon || '')} ${esc(s.title || s.key)}${
          s.status === 'auto' && s.owner ? ' — ' + esc(s.owner) : ''}</span>
        ${s.status === 'auto' ? '<span class="badge badge-gray">Auto-updated</span>' : ''}
        ${reportSectionBadge(s)}
      </summary>
      <div class="report-card-body">${reportSectionBody(s)}</div>
    </details>`).join('');
}

// Only reached by reports stored before the three sources existed, where one
// source wrote the whole section and the label said which. Kept so those still
// render instead of throwing on a name that is no longer defined.
const REPORT_SOURCE_LABEL = {
  command_center: 'via Command Center',
  operational_tasks: "via Erick's board",
};

// An auto section's colour is read off its own numbers. 'auto' says where the
// data came from, not how bad it is, and a section holding six critical items
// should not sit under the same grey chip as one holding none.
function reportSectionBadge(s) {
  if (s.status !== 'auto') return REPORT_STATUS_BADGE[s.status] || REPORT_STATUS_BADGE.pending;
  const c = s.content || {};
  // Three-source shape: the server has already taken the worst of the three, so
  // no single source gets to call the day quiet on its own.
  if (c.severity) {
    return c.severity === 'red' ? REPORT_STATUS_BADGE.urgent
         : c.severity === 'amber' ? REPORT_STATUS_BADGE.attention
         : REPORT_STATUS_BADGE.ok;
  }
  // Reports generated before the three sources existed still render.
  if ((c.critical || []).length) return REPORT_STATUS_BADGE.urgent;
  if ((c.followup || []).length) return REPORT_STATUS_BADGE.attention;
  return REPORT_STATUS_BADGE.ok;
}

const reportList = items => `<ul class="report-list">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;

// Open by default: this is a report, and a reader should not have to click three
// times to find out whether the day is on fire.
const reportSub = (title, badge, body) => `
  <details class="report-sub" open>
    <summary><span>${esc(title)}</span>${badge || ''}</summary>
    <div class="report-sub-body">${body}</div>
  </details>`;

function reportBoardBlock(b) {
  if (!b || b.error) {
    return reportSub('Daily Operations Board', REPORT_STATUS_BADGE.pending,
      `<span class="muted small">Could not be read${b?.error ? ': ' + esc(b.error) : ''}.</span>`);
  }
  const crit = b.critical || [], fu = b.followup || [];
  const badge = b.severity === 'red' ? REPORT_STATUS_BADGE.urgent
              : b.severity === 'amber' ? REPORT_STATUS_BADGE.attention
              : REPORT_STATUS_BADGE.ok;
  return reportSub('Daily Operations Board', badge, `
    ${crit.length ? `<div class="report-group"><b>🔴 Critical (${crit.length}):</b>${reportList(crit)}</div>` : ''}
    ${fu.length ? `<div class="report-group"><b>🟡 Follow-up (${fu.length}):</b>${reportList(fu)}</div>` : ''}
    ${!crit.length && !fu.length ? '<p class="report-group">✅ No critical or follow-up items today</p>' : ''}
    <div class="report-counts small muted">
      <span>✅ Completed today: <b>${b.completed_today ?? 0}</b></span>
      <span>📋 Total open: <b>${b.total_open ?? 0}</b></span>
    </div>`);
}

function reportCommandCenterBlock(cc) {
  if (!cc || !cc.loaded) {
    return reportSub('Command Center (AppFolio)', REPORT_STATUS_BADGE.pending,
      '<span class="muted small">No Excel loaded today.</span>');
  }
  const cats = Object.entries(cc.byCategory || {}).sort((a, b) => b[1] - a[1]);
  const badge = cc.pct >= 100 ? REPORT_STATUS_BADGE.ok : REPORT_STATUS_BADGE.attention;
  return reportSub('Command Center (AppFolio)', badge, `
    <div class="report-group">
      <b>${cc.completed_tasks} of ${cc.total_tasks} done — ${cc.pct}%</b>
      <div class="cc-bar-track" style="max-width:260px"><div class="cc-bar-fill" style="width:${cc.pct}%"></div></div>
    </div>
    ${cats.length ? `<div class="report-counts small muted">${cats
      .map(([k, n]) => `<span>${esc(k)}: <b>${n}</b></span>`).join('')}</div>` : ''}`);
}

// Absent entirely when Asana could not be reached — the brief asks for it to
// disappear rather than explain itself, and an empty third of a report is worse
// than a report with two sources in it.
function reportAsanaBlock(a) {
  if (!a) return '';
  const badge = a.overdue > 0 ? REPORT_STATUS_BADGE.urgent
              : a.open > 0 ? REPORT_STATUS_BADGE.attention : REPORT_STATUS_BADGE.ok;
  return reportSub('Asana Tasks', badge, `
    <div class="report-counts small muted">
      <span>📋 Open: <b>${a.open}</b></span>
      <span>⚠ Overdue: <b>${a.overdue}</b></span>
      <span>✅ Completed today: <b>${a.completed_today}</b></span>
    </div>
    ${(a.titles || []).length ? reportList(a.titles) : ''}`);
}

function reportSectionBody(s) {
  if (s.status !== 'auto') {
    // A section whose owner typed something keeps showing it; the rest say who
    // it is waiting on rather than just that it is empty.
    return typeof s.content === 'string' && s.content
      ? esc(s.content)
      : `<span class="muted small">Pending data from ${esc(s.owner || 'the team')}</span>`;
  }
  const c = s.content || {};

  // Accounting roll-up (Claudia). Three counts; the badge comes from c.severity
  // via reportSectionAutoBadge above.
  if (c.accounting) {
    const money = n => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    return `<div class="report-counts small muted">
      <span>🗒️ Open tasks: <b>${(c.urgentTasks || 0) + (c.normalTasks || 0)}</b> (${c.urgentTasks || 0} urgent · ${c.normalTasks || 0} normal)</span>
      <span>💵 Bills pending approval: <b>${c.pendingBills || 0}</b> · ${money(c.pendingAmount)}</span>
      <span>📄 W9 issues: <b>${c.w9Issues || 0}</b> (missing + outdated)</span>
    </div>`;
  }

  // Weekly Leasing Board (Katie). Freshness message + the latest KPI snapshot.
  if (c.leasing_board) {
    const l = c.latest;
    if (!l) return `<p class="report-group">⚠️ ${esc(c.message || 'Not yet submitted this week')}</p>`;
    return `<div class="report-group"><b>${esc(c.message || '')}</b></div>
      <div class="report-counts small muted">
        <span>📅 Week ending: <b>${esc(l.week_ending || '—')}</b></span>
        <span>🙋 Submitted by: <b>${esc(l.submitted_by || '—')}</b></span>
        <span>🏷️ Status: <b>${esc(l.status || '—')}</b></span>
      </div>
      <div class="report-counts small muted">
        ${l.occupancy_pct != null ? `<span>🏠 Occupancy: <b>${esc(l.occupancy_pct)}%</b>${l.occupied != null ? ` (${esc(l.occupied)}/${esc(l.units)})` : ''}</span>` : ''}
        ${l.net_moveins_needed != null ? `<span>📈 Net move-ins needed: <b>${esc(l.net_moveins_needed)}</b></span>` : ''}
        ${l.traffic_target != null ? `<span>🎯 Traffic target: <b>${esc(l.traffic_target)}</b></span>` : ''}
      </div>`;
  }

  // Three sources, each with its own subsection. They used to share one block
  // and overwrite each other, so the report showed whichever had been touched
  // last and silently dropped the other two.
  if (c.board || c.commandCenter || c.asana) {
    return reportBoardBlock(c.board)
      + reportCommandCenterBlock(c.commandCenter)
      + reportAsanaBlock(c.asana)
      + `<div class="report-counts small muted">
           <span>Last updated: ${c.lastUpdated ? new Date(c.lastUpdated).toLocaleString() : '—'}</span>
         </div>`;
  }

  // Single-source shape, kept so reports generated before this still read.
  const crit = c.critical || [], fu = c.followup || [];
  return `
    ${crit.length ? `<div class="report-group"><b>🔴 Critical (${crit.length}):</b>${reportList(crit)}</div>` : ''}
    ${fu.length ? `<div class="report-group"><b>🟡 Follow-up (${fu.length}):</b>${reportList(fu)}</div>` : ''}
    ${!crit.length && !fu.length ? '<p class="report-group">✅ No critical or follow-up items today</p>' : ''}
    <div class="report-counts small muted">
      <span>✅ Completed today: <b>${c.completed_today ?? 0}</b></span>
      <span>📋 Total open: <b>${c.total_open ?? 0}</b></span>
      ${s.last_updated ? `<span>Updated ${new Date(s.last_updated).toLocaleTimeString()}</span>` : ''}
      ${c.source ? `<span>${esc(REPORT_SOURCE_LABEL[c.source] || c.source)}</span>` : ''}
    </div>`;
}

async function reportLoadSignoffs() {
  const el = $('#report-signoffs');
  if (!el || !reportState.report) return;
  try {
    const data = await api(`/api/reports/daily/signoffs/${encodeURIComponent(reportState.report.id)}`);
    const mine = reportState.me?.signer;
    $('#report-signoff-note').textContent = data.admin
      ? 'Everyone on the list, and who is still outstanding.'
      : (mine ? 'Your sign-off for today.' : 'You are not on the sign-off list for this report.');

    if (!data.rows.length) { el.innerHTML = '<p class="small muted">Nothing to sign.</p>'; return; }

    el.innerHTML = `<div style="overflow-x:auto"><table class="crm-table">
      <thead><tr><th>Name</th><th>Status</th><th>Confirmed</th><th></th></tr></thead><tbody>
      ${data.rows.map(r => {
        const isMe = mine && r.name === mine;
        return `<tr data-signer="${esc(r.name)}">
          <td>${esc(r.name)}${isMe ? ' <span class="muted small">(you)</span>' : ''}</td>
          <td>${r.signed ? '<span class="badge badge-green">✅ Confirmed</span>' : '<span class="badge badge-gray">Not signed</span>'}</td>
          <td class="small muted">${r.confirmed_at ? new Date(r.confirmed_at).toLocaleString() : '—'}</td>
          <td>${(!r.signed && isMe) ? `
            <input class="crm-input report-signoff-name" placeholder="Type your name" style="max-width:180px">
            <button class="btn-sm primary report-signoff-btn">Confirm</button>` : ''}</td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`;

    el.querySelectorAll('.report-signoff-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const typed = tr.querySelector('.report-signoff-name').value.trim();
        if (!typed) return toast('Type your name to confirm', 'error');
        // A sign-off cannot be undone, so it is worth one deliberate pause.
        if (!confirm('Sign off on today’s report? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          await api('/api/reports/daily/signoff', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_id: reportState.report.id, typed_name: typed }),
          });
          toast('Signed off', 'success');
          reportLoadSignoffs();
        } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

async function reportLoadViews() {
  const el = $('#report-views');
  if (!el || !reportState.report) return;
  try {
    const data = await api(`/api/reports/daily/views/${encodeURIComponent(reportState.report.id)}`);
    el.innerHTML = data.rows.length
      ? `<div style="overflow-x:auto"><table class="crm-table">
          <thead><tr><th>Name</th><th>First opened</th><th>Last opened</th><th>Views</th></tr></thead><tbody>
          ${data.rows.map(r => `<tr>
            <td>${esc(r.name)}</td>
            <td class="small muted">${new Date(r.first).toLocaleString()}</td>
            <td class="small muted">${new Date(r.last).toLocaleString()}</td>
            <td>${r.count}</td>
          </tr>`).join('')}
        </tbody></table></div>`
      : '<p class="small muted">Nobody has opened this report yet.</p>';
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
  }
}

$('#report-refresh')?.addEventListener('click', async () => {
  // Refresh re-reads the live section against Erick's board first, so the button
  // updates the data rather than just re-fetching the same stored copy.
  if (reportState.report) {
    try {
      await api(`/api/reports/daily/${encodeURIComponent(reportState.report.id)}/section`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'maintenance' }),
      });
    } catch (err) { toast(err.message, 'error'); }
  }
  reportLoad();
});
$('#report-generate')?.addEventListener('click', async () => {
  const btn = $('#report-generate');
  btn.disabled = true;
  try {
    const r = await api('/api/reports/daily/generate', { method: 'POST' });
    toast(r.created ? 'Report generated' : 'Report regenerated', 'success');
    reportLoad();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});


// ============================================================================
// DAILY 6 PM REPORT
// ============================================================================
// Two of the three inputs are not reachable from the server yet — Teams
// transcripts need a Graph application permission and a Teams access policy,
// and action-item extraction needs a model key the server does not have. The
// panel says so per source rather than showing an empty list, because "no
// action items today" and "nobody looked" are different reports and only one of
// them is safe to act on.

let sixpmReport = null;

const SIXPM_SOURCE_LABEL = {
  meetings: "Today's meetings",
  transcripts: 'Meeting transcripts',
  action_items: 'Action items',
  inbox: "Lyndsay's inbox",
};

async function sixpmLoad() {
  const el = $('#sixpm-meetings');
  if (!el) return;
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const data = await api('/api/reports/daily-6pm/latest');
    sixpmReport = data.report;
    sixpmRender();
  } catch (err) {
    el.innerHTML = `<p class="small muted">Error: ${esc(err.message)}</p>`;
    $('#sixpm-meta').textContent = 'Could not load the report';
  }
}

function sixpmRender() {
  const r = sixpmReport;
  if (!r) {
    $('#sixpm-meta').textContent = 'No report generated yet — it runs automatically at 6 PM Central.';
    $('#sixpm-sources').innerHTML = '';
    $('#sixpm-meetings').innerHTML = '<div class="empty-state">Nothing yet. Press Generate Now to build one for today.</div>';
    $('#sixpm-actions').innerHTML = '';
    $('#sixpm-inbox').innerHTML = '';
    return;
  }
  const s = r.sources || {};
  $('#sixpm-meta').textContent =
    `${r.report_date} · generated ${new Date(r.generated_at).toLocaleString()}`;

  // What the run could and could not see. Ordered so the unavailable ones are
  // not buried under the ones that worked.
  const rows = ['meetings', 'transcripts', 'action_items', 'inbox'].map(k => {
    const ok = s[k] === 'ok';
    const reason = s[k + '_reason'] || s[k + '_error'] || '';
    return `<div class="sixpm-src${ok ? '' : ' pending'}">
      <span class="badge ${ok ? 'badge-green' : 'badge-amber'}">${ok ? 'ok' : (s[k] || 'unknown')}</span>
      <b>${esc(SIXPM_SOURCE_LABEL[k] || k)}</b>
      ${reason ? `<span class="muted small">${esc(reason)}</span>` : ''}
    </div>`;
  }).join('');
  $('#sixpm-sources').innerHTML = `<div class="sixpm-sources">${rows}</div>`;

  // Meetings
  const meetings = r.meetings || [];
  $('#sixpm-meetings-note').textContent = s.categories
    ? `Categories: ${s.categories.join(' · ')}${s.meetings_other_today ? ` — ${s.meetings_other_today} other meeting${s.meetings_other_today === 1 ? '' : 's'} today carried none of them` : ''}`
    : '';
  $('#sixpm-meetings').innerHTML = meetings.length
    ? meetings.map(m => `
        <div class="card" style="margin-bottom:10px">
          <div class="card-meta" style="justify-content:space-between">
            <span class="badge badge-gray">${esc(m.category)}</span>
            <span class="muted small">${m.start ? new Date(m.start).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : ''}</span>
          </div>
          <div class="card-title">${esc(m.subject)}</div>
          <div class="card-meta small muted">
            ${m.organizer ? `<span>👤 ${esc(m.organizer)}</span>` : ''}
            ${m.attendees?.length ? `<span>${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'}</span>` : ''}
            ${m.joinUrl ? `<a href="${esc(m.joinUrl)}" target="_blank" rel="noopener">Open in Teams ↗</a>` : ''}
          </div>
          ${m.transcript
            ? `<div class="card-notes">${esc(m.transcript)}</div>`
            : '<div class="card-notes muted small"><i>No transcript — see the source list above.</i></div>'}
        </div>`).join('')
    : `<div class="empty-state">${s.meetings === 'error'
        ? 'The calendar could not be read: ' + esc(s.meetings_error || '')
        : 'No meetings today carried one of the three report categories.'}</div>`;

  // Action items
  const actions = r.action_items || [];
  $('#sixpm-actions').innerHTML = actions.length
    ? `<div style="overflow-x:auto"><table class="crm-table">
        <thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>From</th></tr></thead><tbody>
        ${actions.map(a => `<tr>
          <td>${esc(a.action || '')}</td>
          <td>${a.owner ? esc(a.owner) : '<span class="muted small">unassigned</span>'}</td>
          <td class="small muted">${esc(a.due || '—')}</td>
          <td class="small muted">${esc(a.meeting || '')}</td>
        </tr>`).join('')}
      </tbody></table></div>`
    : `<div class="empty-state">${s.action_items === 'ok'
        ? 'No action items came out of today\'s meetings.'
        : 'Not extracted — ' + esc(s.action_items_reason || 'source unavailable') }</div>`;

  // Inbox snapshot
  const ib = r.inbox_snapshot || {};
  const ly = ib.lyndsay;
  $('#sixpm-inbox').innerHTML = ly
    ? `<div class="card"><div class="card-meta">
         <span class="badge badge-amber">${ly.unread ?? '—'} unread</span>
         <span class="badge badge-gray">${ly.total ?? '—'} total</span>
         ${ib.lastChecked ? `<span class="muted small">as of ${new Date(ib.lastChecked).toLocaleTimeString()}</span>` : ''}
       </div>
       <p class="muted small" style="margin-bottom:0">Counts only. Her messages are deliberately not in this report.</p></div>`
    : '<div class="empty-state">No inbox snapshot on this run.</div>';
}

$('#sixpm-refresh')?.addEventListener('click', sixpmLoad);
$('#sixpm-generate')?.addEventListener('click', async () => {
  const btn = $('#sixpm-generate');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const r = await api('/api/reports/daily-6pm/generate', { method: 'POST' });
    sixpmReport = r.report;
    sixpmRender();
    toast('Report generated', 'success');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Generate Now'; }
});

// Boot — verify session, gate tabs, then load initial tab
initAuth();
