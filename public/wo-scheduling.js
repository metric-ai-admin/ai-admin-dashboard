/* AI Admin Dashboard — Maintenance ▸ WO Scheduling (iConic pilot)

   Phase 1 MVP: the open work-order table and the insights banner. The tech
   workload panel and the drag-to-schedule calendar are Phase 2 and are stubbed
   below with what they are waiting on.

   Loaded after app.js, so $ / esc / api / toast already exist.
   switchMaintenanceView() in app.js calls loadWoScheduling().

   All numbers come from ONE call to /api/appfolio/feed/wo-scheduling, which
   filters and aggregates server-side. Pulling the three export.csv files
   straight into the browser would be ~3 MB per tab open, most of it to produce
   two summary figures. */

let woSchedData = null;
let woSchedSort = { key: 'ageDays', dir: 'desc' };
// Default ON: the 5 WOs with no internal tech are the point of the pilot, so
// they lead the table regardless of the sort the user picks.
let woSchedUnassignedFirst = true;

// Age thresholds, shared by the row colour and the banner counts so the two can
// never disagree.
const WO_AGE_RED = 30;    // older than this = red
const WO_AGE_AMBER = 15;  // 15..30 = amber, under = green

function woAgeClass(days) {
  if (days === null || days === undefined) return '';
  if (days > WO_AGE_RED) return 'wo-age-red';
  if (days >= WO_AGE_AMBER) return 'wo-age-amber';
  return 'wo-age-green';
}

function woFmtDate(raw) {
  if (!raw) return '—';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return esc(String(raw).slice(0, 10));
  return new Date(t).toLocaleDateString();
}

function woPriorityBadge(p) {
  const v = String(p || '').trim();
  if (!v) return '<span class="muted">—</span>';
  const cls = /urgent|emergency/i.test(v) ? 'badge-red' : /high/i.test(v) ? 'badge-amber' : 'badge-gray';
  return '<span class="badge ' + cls + '">' + esc(v) + '</span>';
}

// A WO with no assigned_user but a real vendor is not a gap — it sits with an
// outside company. Saying "unassigned" for both would send Erick chasing work
// that is already placed, so the two are labelled differently.
function woTechCell(w) {
  if (w.tech) return esc(w.tech);
  if (w.vendor) return '<span class="badge badge-blue" title="No internal tech — handled by an outside vendor">🏢 ' + esc(w.vendor) + '</span>';
  return '<span class="badge badge-red">⚠ Unassigned</span>';
}

function woSortedRows() {
  const rows = (woSchedData?.openWos || []).slice();
  const { key, dir } = woSchedSort;
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'ageDays') { x = x ?? -1; y = y ?? -1; return (x - y) * mul; }
    x = String(x || '').toLowerCase(); y = String(y || '').toLowerCase();
    return x < y ? -1 * mul : x > y ? 1 * mul : 0;
  });
  if (woSchedUnassignedFirst) {
    const gap = r => (!r.tech && !r.vendor) ? 0 : (!r.tech ? 1 : 2);
    rows.sort((a, b) => gap(a) - gap(b));   // stable: keeps the sort above within each group
  }
  return rows;
}

function renderWoSchedBanner() {
  const i = woSchedData?.insights;
  const el = $('#woSchedBanner');
  if (!i) { el.innerHTML = ''; return; }

  const top = i.topIssues?.[0];
  const chips = [
    ['red',   i.over30,     'WOs over 30 days old'],
    ['amber', i.between15and30, 'WOs 15–30 days'],
    ['green', i.under15,    'WOs under 15 days'],
    ['red',   i.unassigned, 'with no internal tech'],
  ].map(([c, n, label]) =>
    '<div class="kpi-chip kpi-chip-' + c + '"><span class="kpi-num">' + n + '</span> ' + esc(label) + '</div>'
  );

  if (top) {
    chips.push('<div class="kpi-chip kpi-chip-blue"><span class="kpi-num">' + top.count + '</span> top issue: '
      + esc(top.issue) + ' <span class="muted small">(90d)</span></div>');
  }
  if (i.cycle?.medianDays !== null && i.cycle?.medianDays !== undefined) {
    chips.push('<div class="kpi-chip kpi-chip-gray"><span class="kpi-num">' + i.cycle.medianDays
      + 'd</span> median cycle time <span class="muted small">(n=' + i.cycle.n + ')</span></div>');
  }
  el.innerHTML = chips.join('');

  // The wait/work split. Worth its own line: of the 7-day median, only ~2 days
  // is field work — the rest is closeout. A scheduling tool moves the first
  // number; the second is an admin problem and should not be mistaken for one
  // this tool can fix.
  const c = woSchedData.insights.cycle;
  const split = $('#woSchedSplit');
  if (c && c.medianWork !== null && c.medianAdmin !== null) {
    split.className = 'banner';
    split.innerHTML = '⏱ <strong>Cycle time breakdown</strong> — median <strong>' + c.medianDays
      + 'd</strong> from created to completed splits into <strong>' + c.medianWork
      + 'd</strong> created → work done and <strong>' + c.medianAdmin
      + 'd</strong> work done → closed out. Scheduling moves the first figure; the second is billing/closeout lag.';
  } else {
    split.className = 'banner hidden';
  }

  // Say plainly when a panel is thin because a report has not synced.
  const warn = $('#woSchedWarn');
  const bits = [];
  if (i.missing?.length) {
    bits.push('Not synced yet: <code>' + i.missing.map(esc).join('</code>, <code>') + '</code>. '
      + 'Sync them in Reports Sync — until then the affected figures are missing, not zero.');
  }
  if (i.scheduled !== undefined && i.openCount) {
    bits.push('Only <strong>' + i.scheduled + ' of ' + i.openCount + '</strong> open WOs carry a scheduled date in AppFolio ('
      + Math.round(100 * i.scheduled / i.openCount) + '%), so the Schedule column is mostly empty by fact, not by bug.');
  }
  warn.className = bits.length ? 'banner banner-warn' : 'banner hidden';
  warn.innerHTML = bits.join('<br>');
}

function renderWoSchedTable() {
  const rows = woSortedRows();
  const el = $('#woSchedTable');
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No open work orders for “' + esc(woSchedData?.match || '') + '”.</p>';
    return;
  }
  const arrow = k => woSchedSort.key === k ? (woSchedSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const th = (k, label) => '<th class="wo-sortable" data-sort="' + k + '">' + esc(label) + arrow(k) + '</th>';

  el.innerHTML =
    '<div class="me-table-wrap"><table class="me-table wo-sched-table">' +
      '<thead><tr>' +
        th('wo', 'WO #') + th('property', 'Property') + th('unit', 'Unit') +
        th('issue', 'Issue') + th('type', 'Type') + th('ageDays', 'Age') +
        th('priority', 'Priority') + th('tech', 'Assigned') + th('scheduledStart', 'Scheduled') +
      '</tr></thead><tbody>' +
      rows.map(w => {
        const gap = !w.tech && !w.vendor;
        return '<tr class="' + (gap ? 'wo-row-gap' : '') + '">' +
          '<td><strong>' + esc(w.wo) + '</strong></td>' +
          '<td>' + esc(w.property) + '</td>' +
          '<td>' + (w.unit ? esc(w.unit) : '<span class="muted">—</span>') + '</td>' +
          '<td class="wo-issue" title="' + esc(w.issue) + '">' + esc(String(w.issue).replace(/\s+/g, ' ').slice(0, 70)) + '</td>' +
          '<td>' + (w.type ? esc(w.type) : '<span class="muted">—</span>') + '</td>' +
          '<td><span class="wo-age ' + woAgeClass(w.ageDays) + '">' +
            (w.ageDays === null ? '—' : w.ageDays + 'd') + '</span></td>' +
          '<td>' + woPriorityBadge(w.priority) + '</td>' +
          '<td>' + woTechCell(w) + '</td>' +
          '<td>' + (w.scheduledStart ? woFmtDate(w.scheduledStart) : '<span class="muted">not scheduled</span>') + '</td>' +
        '</tr>';
      }).join('') +
    '</tbody></table></div>' +
    '<p class="muted small" style="margin-top:8px;">' + rows.length + ' open work order' + (rows.length === 1 ? '' : 's') +
      ' · red &gt; ' + WO_AGE_RED + 'd · amber ' + WO_AGE_AMBER + '–' + WO_AGE_RED + 'd · green &lt; ' + WO_AGE_AMBER + 'd</p>';

  el.querySelectorAll('.wo-sortable').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    if (woSchedSort.key === k) woSchedSort.dir = woSchedSort.dir === 'asc' ? 'desc' : 'asc';
    else woSchedSort = { key: k, dir: k === 'ageDays' ? 'desc' : 'asc' };
    renderWoSchedTable();
  }));
}

function renderWoSchedMeta() {
  const s = woSchedData?.syncedAt || {};
  const i = woSchedData?.insights || {};
  const ago = iso => {
    if (!iso) return 'never';
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  };
  $('#woSchedMeta').innerHTML =
    'Open WOs synced ' + esc(ago(s.open)) +
    ' · labor ' + esc(ago(s.labor)) +
    ' · completed ' + esc(ago(s.completed)) +
    (i.laborFrom ? ' · labor window ' + esc(i.laborFrom) + ' → ' + esc(i.laborTo) : '');
}

async function loadWoScheduling() {
  const table = $('#woSchedTable');
  if (table) table.innerHTML = '<p class="muted">Loading…</p>';
  try {
    woSchedData = await api('/api/appfolio/feed/wo-scheduling');
  } catch (err) {
    woSchedData = null;
    if (table) {
      table.innerHTML = '<p class="muted">Could not load: ' + esc(err.message) + '</p>';
    }
    $('#woSchedBanner').innerHTML = '';
    return;
  }
  renderWoSchedBanner();
  renderWoSchedTable();
  renderWoSchedMeta();
}

function wireWoScheduling() {
  $('#woSchedRefresh')?.addEventListener('click', () => loadWoScheduling());
  const cb = $('#woSchedUnassignedFirst');
  if (cb) {
    cb.checked = woSchedUnassignedFirst;
    cb.addEventListener('change', () => {
      woSchedUnassignedFirst = cb.checked;
      renderWoSchedTable();
    });
  }
  $('#woSchedExport')?.addEventListener('click', () => {
    const rows = woSortedRows();
    if (!rows.length) return toast('Nothing to export', 'warn');
    const cols = ['wo', 'property', 'unit', 'issue', 'type', 'ageDays', 'priority', 'tech', 'vendor', 'scheduledStart', 'created'];
    const cell = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = '﻿' + [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'iconic_open_wos_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireWoScheduling);
else wireWoScheduling();
