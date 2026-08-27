/* AI Admin Dashboard — Maintenance ▸ Efficiency, Technician Activity, Open WOs
   Ported from metric-dashboard/public/appfolio-views.js.

   Loaded after reports-sync.js, so rsAgo() exists, and after app.js for
   $ / $$ / esc / api / toast.

   Difference from the source file: the .nav-item hooks are gone —
   switchMaintenanceView() in app.js dispatches these loaders instead. */

// =====================================================================
// MAINTENANCE EFFICIENCY — the 9 numbers for Lyndsay's Excel tracker
// =====================================================================

// All 9 metrics come from just these three pulls — the per-status variants
// were dropped because AppFolio ignores the status filter.
const ME_SOURCES = ['wo_all', 'work_order_billable_detail', 'work_order_labor_summary'];

const ME_BADGE = {
  exact:       { cls: 'me-conf-exact',  text: 'exact' },
  approx:      { cls: 'me-conf-approx', text: 'approx' },
  unavailable: { cls: 'me-conf-unavail', text: 'not available via API' },
};

let meLast = null;

function meFormat(m) {
  if (m.value === null) return '—';
  return m.unit === 'currency'
    ? '$' + m.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : m.value.toLocaleString();
}

async function loadEfficiency() {
  let d;
  try { d = await api('/api/appfolio/feed/efficiency'); }
  catch (err) {
    $('#meTable').innerHTML = '<p class="muted">Could not calculate: ' + esc(err.message) + '</p>';
    return;
  }
  meLast = d;

  const warn = $('#meWarn');
  const notes = [];
  if (d.missingCount) notes.push('<b>' + d.missingCount + '</b> metric(s) have no synced data yet — click <b>Sync sources &amp; recalculate</b>. A blank is unknown, not zero.');
  if (d.approxCount) notes.push('<b>' + d.approxCount + '</b> metric(s) are <b>approximate</b>: AppFolio ignores the status filter on <code>work_order.json</code>, so they are counted from work orders that have logged labor and will undercount.');
  if (d.unavailableCount) notes.push('<b>' + d.unavailableCount + '</b> metric(s) <b>cannot be pulled</b> with the current API access — run those in AppFolio manually.');
  if (notes.length) {
    warn.className = 'banner banner-warn';
    warn.innerHTML = '⚠ ' + notes.join('<br>⚠ ');
  } else {
    warn.className = 'banner banner-warn hidden';
  }

  $('#meStamp').innerHTML = 'Values for <b>' + esc(d.date) + '</b>' +
    (d.newestFetchedAt ? ' · data synced ' + esc(rsAgo(d.oldestFetchedAt) || '') +
      ' → ' + esc(rsAgo(d.newestFetchedAt) || '') : '');

  $('#meTable').innerHTML =
    '<div class="me-table-wrap"><table class="me-table">' +
      '<thead><tr>' +
        '<th style="width:70px">Excel row</th>' +
        '<th>Metric</th>' +
        '<th style="width:150px">Value</th>' +
        '<th style="width:190px">Source report</th>' +
      '</tr></thead><tbody>' +
      d.metrics.map(m => {
        const b = ME_BADGE[m.confidence] || ME_BADGE.exact;
        const cell = m.confidence === 'unavailable'
          ? '<span class="me-unavail">—</span>'
          : (m.missing
              ? '<span class="me-needs">needs sync</span>'
              : '<span class="me-num">' + esc(meFormat(m)) + '</span>');
        return '<tr class="' + (m.missing || m.confidence === 'unavailable' ? 'me-missing' : '') + '">' +
          '<td class="me-row-num">' + m.row + '</td>' +
          '<td class="me-label">' + esc(m.label) +
            (m.note ? '<div class="me-note">' + esc(m.note) + '</div>' : '') + '</td>' +
          '<td class="me-value">' + cell +
            '<div class="me-conf ' + b.cls + '">' + b.text + '</div></td>' +
          '<td class="me-src"><code>' + esc(m.source) + '</code></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
}

$('#meRefreshBtn')?.addEventListener('click', loadEfficiency);

$('#meCopyBtn')?.addEventListener('click', async () => {
  if (!meLast) return;
  // One value per line, in row order — pastes straight down the day's column.
  // Unavailable/unsynced metrics copy as a blank line so the rows stay aligned
  // and those get filled in by hand.
  const text = meLast.metrics.map(m => (m.value === null ? '' : m.value)).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const blanks = meLast.metrics.filter(m => m.value === null).length;
    const total = meLast.metrics.length;
    toast(blanks
      ? `Copied — ${total - blanks} values, ${blanks} left blank for manual entry`
      : `${total} values copied — paste into the day's column`, 'success');
  } catch {
    toast('Clipboard blocked by the browser', 'error');
  }
});

$('#meSyncBtn')?.addEventListener('click', async () => {
  const btn = $('#meSyncBtn');
  btn.disabled = true;
  const original = btn.innerHTML;
  let done = 0;
  for (const id of ME_SOURCES) {
    btn.innerHTML = '<span class="rs-spin">⟳</span> Syncing ' + (++done) + '/' + ME_SOURCES.length + '…';
    try { await fetch('/api/appfolio/reports/' + id + '/sync', { method: 'POST' }); } catch {}
  }
  btn.disabled = false;
  btn.innerHTML = original;
  await loadEfficiency();
  toast('Efficiency sources synced', 'success');
});

// =====================================================================
// TECHNICIAN ACTIVITY TODAY
// =====================================================================

// "1h 23m", "45m", "2h" on the hour. Null passes through untouched, which is
// what a multi-session work order and one still running both send.
function taFormatDuration(mins) {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return m + 'm';
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

// AppFolio sends these as UTC with an explicit Z — 8:04 AM in Austin arrives as
// "2026-08-27T13:04:00Z". Formatting that in the browser's own zone printed the
// right instant in the wrong place: an hour late from Venezuela, and further off
// from anywhere else. These are Austin work orders and AppFolio shows them in
// Austin time, so the zone is pinned rather than left to wherever the dashboard
// happens to be open.
//
// Pinning applies only when the string actually carries a zone. A bare clock
// reading has none to convert — its digits are already the wall time — and
// putting it through a Date would invent an offset and shift it.
//
// One function for both ends: the two columns come from the same report in the
// same shape.
function taFormatTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Explicit zone (Z or ±HH:MM) — a real instant, rendered in Austin's zone.
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    });
  }

  // ISO with no zone — JS parses it as local, so the digits pass through.
  if (/\d{4}-\d{2}-\d{2}/.test(s) || /T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Bare clock reading — no Date involved at all.
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s*m\.?$/i)
         || s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?()$/);
  if (m) {
    const h = parseInt(m[1], 10), min = m[2];
    // Meridiem normalised, so "8:32 a.m." prints like every other row.
    if (m[3]) return (h % 12 || 12) + ':' + min + ' ' + (/p/i.test(m[3]) ? 'PM' : 'AM');
    if (h < 0 || h > 23) return null;
    return (h % 12 || 12) + ':' + min + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  return null;
}

async function loadTechActivity() {
  const day = $('#taDate')?.value;
  let d;
  try { d = await api('/api/appfolio/feed/tech-activity' + (day ? '?date=' + day : '')); }
  catch (err) {
    $('#taList').innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    $('#taAlerts').innerHTML = '';
    $('#taStats').innerHTML = '';
    return;
  }

  if ($('#taDate') && !$('#taDate').value) $('#taDate').value = d.date;

  // ---- Alerts ----
  let alerts = '';
  if (d.zeroHours.length) {
    alerts += '<div class="ta-alert ta-alert-red">' +
      '<b>⚠ ' + d.zeroHours.length + ' technician' + (d.zeroHours.length === 1 ? '' : 's') +
      ' with ZERO hours logged on ' + esc(d.date) + '</b>' +
      '<div class="ta-zero-chips">' +
        d.zeroHours.map(n => '<span class="ta-zero-chip">' + esc(n) + '</span>').join('') +
      '</div></div>';
  } else {
    alerts += '<div class="ta-alert ta-alert-green"><b>✓ Every technician on the roster has logged hours.</b></div>';
  }
  if (d.overlaps.length) {
    alerts += '<div class="ta-alert ta-alert-amber">' +
      '<b>⚠ ' + d.overlaps.length + ' unit' + (d.overlaps.length === 1 ? '' : 's') +
      ' worked by more than one technician — possible duplicate/overlap</b>' +
      d.overlaps.map(o =>
        '<div class="ta-overlap"><span class="ta-overlap-unit">' + esc(o.unit) + '</span> — ' +
        esc(o.techs.join(', ')) + '</div>').join('') +
      '</div>';
  }
  $('#taAlerts').innerHTML = alerts;

  // ---- Totals ----
  $('#taStats').innerHTML =
    '<div class="af-stat"><b>' + d.totalHours.toLocaleString() + '</b>Total hours</div>' +
    '<div class="af-stat"><b>' + d.totalBillableHours.toLocaleString() + '</b>Billable hours</div>' +
    '<div class="af-stat"><b>' + d.technicians.length + '</b>Techs with activity</div>' +
    '<div class="af-stat"><b>' + d.rowsToday.toLocaleString() + '</b>Labor entries</div>' +
    '<div class="af-stat"><b>' + esc(rsAgo(d.fetchedAt) || '—') + '</b>Last sync</div>';

  // ---- Per-tech cards ----
  if (!d.technicians.length) {
    $('#taList').innerHTML = '<p class="muted">No labor logged on ' + esc(d.date) + ' yet.</p>';
    return;
  }

  $('#taList').innerHTML = '<div class="ta-grid">' + d.technicians.map(t =>
    '<div class="ta-card">' +
      '<div class="ta-card-head">' +
        '<span class="ta-name">' + esc(t.name) + '</span>' +
        '<span class="ta-hours">' + t.hours + ' h</span>' +
      '</div>' +
      '<div class="ta-sub">' + t.billableHours + ' billable · ' + t.wos.length +
        ' WO' + (t.wos.length === 1 ? '' : 's') + '</div>' +
      '<div class="ta-wos">' +
        t.wos.map(w => {
          const started = taFormatTime(w.startTime);
          const finished = taFormatTime(w.endTime);
          const dur = taFormatDuration(w.durationMin);
          return '<div class="ta-wo">' +
            '<span class="ta-wo-num">#' + esc(w.wo) + '</span>' +
            '<span class="ta-wo-prop">' + esc(w.property) + (w.unit ? ' · ' + esc(w.unit) : '') + '</span>' +
            '<span class="ta-wo-hrs">' + w.hours + 'h</span>' +
            (started ? '<span class="ta-wo-start">Started: ' + esc(started) + '</span>' : '') +
            (finished
              ? '<span class="ta-wo-start">Finished: ' + esc(finished) +
                  (dur ? ' · ' + esc(dur) : '') + '</span>'
              : '') +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>').join('') + '</div>';
}

$('#taRefreshBtn')?.addEventListener('click', loadTechActivity);
$('#taDate')?.addEventListener('change', loadTechActivity);

$('#taSyncBtn')?.addEventListener('click', async () => {
  const btn = $('#taSyncBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="rs-spin">⟳</span> Syncing…';
  try {
    await fetch('/api/appfolio/reports/work_order_labor_summary/sync', { method: 'POST' });
  } catch {}
  btn.disabled = false;
  btn.innerHTML = original;
  await loadTechActivity();
});

// =====================================================================
// COVERAGE MAP — open work orders table (deep links into AppFolio)
// =====================================================================

let cwoData = null;

async function loadOpenWoTable() {
  try { cwoData = await api('/api/appfolio/feed/open-wos'); }
  catch (err) {
    $('#cwoTable').innerHTML = '<p class="muted small">' + esc(err.message) + '</p>';
    $('#cwoSub').textContent = 'not synced';
    return;
  }

  const sel = $('#cwoProperty');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All properties (' + cwoData.count + ')</option>' +
    cwoData.properties.map(p => {
      const n = cwoData.items.filter(i => i.property === p).length;
      return '<option value="' + esc(p) + '">' + esc(p) + ' (' + n + ')</option>';
    }).join('');
  sel.value = keep;

  $('#cwoSub').innerHTML = cwoData.count + ' open work orders · synced ' +
    esc(rsAgo(cwoData.fetchedAt) || '—') + ' · click a WO number to open it in AppFolio';

  renderOpenWoTable();
}

function renderOpenWoTable() {
  if (!cwoData) return;
  const prop = $('#cwoProperty').value;
  const sort = $('#cwoSort').value;

  let rows = prop ? cwoData.items.filter(i => i.property === prop) : cwoData.items.slice();

  if (sort === 'oldest') {
    rows.sort((a, b) => String(a.created || '9999').localeCompare(String(b.created || '9999')));
  } else if (sort === 'number') {
    rows.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  } else {
    rows.sort((a, b) => a.property.localeCompare(b.property) ||
      String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  }

  if (!rows.length) {
    $('#cwoTable').innerHTML = '<p class="muted small">No open work orders.</p>';
    return;
  }

  // Group headers only make sense when the list is ordered by property.
  const grouped = sort === 'property' && !prop;
  let lastProp = null;

  $('#cwoTable').innerHTML =
    '<div class="cwo-table-wrap"><table class="cwo-table">' +
      '<thead><tr>' +
        '<th>Property</th><th style="width:95px">WO #</th><th style="width:90px">Unit</th>' +
        '<th>Description</th><th style="width:110px">Status</th><th style="width:95px">Created</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => {
        let head = '';
        if (grouped && r.property !== lastProp) {
          lastProp = r.property;
          const n = cwoData.items.filter(i => i.property === r.property).length;
          head = '<tr class="cwo-group"><td colspan="6">' + esc(r.property) +
                 ' <span class="cwo-group-n">' + n + '</span></td></tr>';
        }
        const num = r.url
          ? '<a class="cwo-link" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.number) + ' ↗</a>'
          : '<span class="cwo-nolink" title="Missing work_order_id / service_request_id">' + esc(r.number) + '</span>';
        return head +
          '<tr>' +
            '<td class="cwo-prop">' + esc(r.property) + '</td>' +
            '<td>' + num + '</td>' +
            '<td>' + esc(r.unit || '—') + '</td>' +
            '<td class="cwo-desc" title="' + esc(r.description) + '">' + esc(r.description || '—') + '</td>' +
            '<td><span class="cwo-status">' + esc(r.status) + '</span></td>' +
            '<td class="cwo-date">' + esc(r.created || '—') + '</td>' +
          '</tr>';
      }).join('') +
    '</tbody></table></div>';
}

$('#cwoProperty')?.addEventListener('change', renderOpenWoTable);
$('#cwoSort')?.addEventListener('change', renderOpenWoTable);

$('#cwoSyncBtn')?.addEventListener('click', async () => {
  const btn = $('#cwoSyncBtn');
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="rs-spin">⟳</span>';
  try { await fetch('/api/appfolio/reports/wo_all/sync', { method: 'POST' }); } catch {}
  btn.disabled = false;
  btn.innerHTML = orig;
  await loadOpenWoTable();
  loadCoverageWoCounts();
});
