/* AI Admin Dashboard — Maintenance ▸ Reports Sync (AppFolio Reports API v2, read-only)
   Ported from metric-dashboard/public/reports-sync.js.

   Loaded after app.js, so $ / $$ / esc / toast / api and the Coverage Map
   globals (coverageMap, covPropMarkers, covPropIcon) already exist.

   Differences from the source file:
   - "Sync all" is fire-and-poll instead of one long blocking request. Eight
     reports paced by a 7-req/15s limiter take 30-60s, which risks a gateway
     timeout behind Render's proxy.
   - The .nav-item hooks are gone; switchMaintenanceView() in app.js dispatches.
   - No feed calls at page load — these endpoints are admin-only, so firing them
     for every role would just produce 401 noise. */

let rsOverview = null;
let rsPollTimer = null;

function rsAgo(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function rsStamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString() + ' (' + rsAgo(iso) + ')';
}

// Map an HTTP status to the plain-language cause shown on the card.
function rsErrorHint(status) {
  if (status === 401 || status === 403) return 'Invalid credentials — check APPFOLIO_* in the Render environment';
  if (status === 429) return 'Rate limit — 7 requests / 15s exceeded, wait and retry';
  if (status === 404) return 'Report not found or not enabled for this account';
  if (status >= 500) return 'Temporary AppFolio error — safe to retry';
  return null;
}

async function loadReportsSync() {
  try {
    rsOverview = await api('/api/appfolio/reports');
  } catch (err) {
    $('#rsCards').innerHTML = '<p class="muted">Could not load sync status: ' + esc(err.message) + '</p>';
    return;
  }

  const banner = $('#rsConfigBanner');
  if (!rsOverview.configured) {
    banner.className = 'banner banner-warn';
    banner.innerHTML = '⚠ AppFolio API not configured. Set <code>APPFOLIO_CLIENT_ID</code>, ' +
      '<code>APPFOLIO_CLIENT_SECRET</code> and <code>APPFOLIO_SUBDOMAIN</code> in the Render ' +
      'environment, then redeploy.';
  } else {
    banner.className = 'banner banner-warn hidden';
  }

  $('#rsGlobalMsg').textContent =
    rsOverview.reports.length + ' reports · rate limit ' + rsOverview.rateLimit;
  renderReportCards();

  // A sync started earlier may still be running — pick the progress back up
  // instead of leaving the button looking idle.
  try {
    const job = await api('/api/appfolio/reports/sync-all/status');
    if (job.running) rsPollSyncAll();
  } catch { /* status unavailable — nothing to resume */ }
}

function renderReportCards() {
  $('#rsCards').innerHTML = rsOverview.reports.map(r => {
    const hasErr = !!r.lastError;
    const hint = hasErr ? rsErrorHint(r.lastErrorStatus) : null;
    const paramStr = Object.keys(r.params || {}).length
      ? Object.entries(r.params).map(([k, v]) => k + '=' + v).join(' · ')
      : 'no filters';

    const lastSuccess = r.lastSuccessAt
      ? '<b class="rs-ok">' + esc(rsStamp(r.lastSuccessAt)) + '</b>'
      : '<span class="rs-never">never synced</span>';

    const truncatedBox = r.truncated
      ? '<div class="rs-error-box rs-warn-box"><b>⚠ Truncated</b>Hit the page cap — not all rows were pulled.</div>'
      : '';

    const errorBox = hasErr
      ? '<div class="rs-error-box"><b>✕ Last attempt failed' +
        (r.lastErrorStatus ? ' (HTTP ' + r.lastErrorStatus + ')' : '') +
        ' — ' + esc(rsAgo(r.lastErrorAt) || '') + '</b>' + esc(r.lastError) +
        (hint ? '<div style="margin-top:5px;font-weight:600">→ ' + esc(hint) + '</div>' : '') +
        '</div>'
      : '';

    // CSV/PDF are generated server-side from the synced rows — the Reports API
    // itself only returns JSON.
    const base = '/api/appfolio/reports/' + encodeURIComponent(r.id);
    const viewBtn = r.lastSuccessAt
      ? '<a class="btn btn-sm" href="' + base + '/data?limit=50" target="_blank" rel="noopener" title="View the raw synced JSON">View</a>' +
        '<a class="btn btn-sm" href="' + base + '/export.csv" title="Download all rows as CSV">⬇ CSV</a>' +
        '<a class="btn btn-sm" href="' + base + '/export.pdf" title="Download a printable PDF table">⬇ PDF</a>'
      : '';

    return '' +
      '<div class="rs-card ' + (hasErr ? 'rs-err' : '') + '" data-report="' + esc(r.id) + '">' +
        '<div class="rs-card-top">' +
          '<div>' +
            '<div class="rs-title">' + esc(r.label) + '</div>' +
            '<div class="rs-group">' + esc(r.group) + '</div>' +
          '</div>' +
          '<span class="rs-prio">P' + r.priority + '</span>' +
        '</div>' +
        '<div class="rs-feeds"><b>Feeds:</b> ' + esc(r.feeds) + '</div>' +
        '<div class="rs-params">' + esc(r.resource || r.id) + '.json · ' + esc(paramStr) + '</div>' +
        '<div class="rs-meta">' +
          '<span>Last success: ' + lastSuccess + '</span>' +
          (r.rowCount != null ? '<span>Rows: <b>' + r.rowCount.toLocaleString() + '</b></span>' : '') +
          (r.pages ? '<span>Pages: <b>' + r.pages + '</b></span>' : '') +
        '</div>' +
        truncatedBox +
        errorBox +
        '<div class="rs-actions">' +
          '<button class="btn btn-sm btn-primary rs-sync-one" data-report="' + esc(r.id) + '">⟳ Actualizar ahora</button>' +
          viewBtn +
        '</div>' +
      '</div>';
  }).join('');

  $$('.rs-sync-one').forEach(btn => {
    btn.addEventListener('click', () => rsSyncOne(btn.dataset.report, btn));
  });
}

async function rsSyncOne(id, btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="rs-spin">⟳</span> Syncing…';
  try {
    const res = await fetch('/api/appfolio/reports/' + encodeURIComponent(id) + '/sync', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (data.ok) toast(id + ': ' + (data.rowCount ?? 0).toLocaleString() + ' rows synced', 'success');
    else toast(id + ' failed: ' + (data.error || 'unknown error'), 'error');
  } catch (err) {
    toast(id + ' failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    await loadReportsSync();
    refreshAppfolioFeeds();
  }
}

// ---------------------------------------------------------------------
// Sync all — start the job, then poll it
// ---------------------------------------------------------------------

function rsResetSyncAllBtn() {
  const btn = $('#rsSyncAllBtn');
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = '⟳ Sync all reports';
}

async function rsStartSyncAll() {
  const btn = $('#rsSyncAllBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="rs-spin">⟳</span> Starting…';
  try {
    const res = await fetch('/api/appfolio/reports/sync-all', { method: 'POST' });
    if (res.status === 409) {
      toast('A sync is already running', 'error');
    } else if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || 'HTTP ' + res.status);
    }
    rsPollSyncAll();
  } catch (err) {
    toast('Sync all failed: ' + err.message, 'error');
    rsResetSyncAllBtn();
  }
}

async function rsPollSyncAll() {
  clearTimeout(rsPollTimer);

  let job;
  try { job = await api('/api/appfolio/reports/sync-all/status'); }
  catch { rsResetSyncAllBtn(); return; }

  const btn = $('#rsSyncAllBtn');
  const msg = $('#rsGlobalMsg');

  if (job.running) {
    if (btn) btn.innerHTML = '<span class="rs-spin">⟳</span> ' + job.done + '/' + job.total + '…';
    if (msg) {
      msg.textContent = 'Syncing ' + Math.min(job.done + 1, job.total) + '/' + job.total +
        (job.current ? ' — ' + job.current : '') + ' · rate-limited to 7 req / 15s';
    }
    rsPollTimer = setTimeout(rsPollSyncAll, 2000);
    return;
  }

  rsResetSyncAllBtn();
  if (job.finishedAt && job.results.length) {
    const ok = job.results.filter(r => r.ok).length;
    toast(ok + '/' + job.results.length + ' reports synced',
          ok === job.results.length ? 'success' : 'error');
  }
  await loadReportsSync();
  refreshAppfolioFeeds();
}

$('#rsSyncAllBtn')?.addEventListener('click', rsStartSyncAll);
$('#rsRefreshBtn')?.addEventListener('click', loadReportsSync);

// ---------------------------------------------------------------------
// Feeds into existing sections
// ---------------------------------------------------------------------

// AppFolio Analyzer ← Billable Detail + Labor Summary
async function loadBillableFeed() {
  const host = $('#afBillableFeed');
  if (!host) return;
  let d;
  try { d = await api('/api/appfolio/feed/billable'); }
  catch { host.innerHTML = ''; return; }

  const propRows = d.topProperties.map(p =>
    '<div class="af-wo-row">' +
      '<span class="af-wo-prop">' + esc(p.name) + '</span>' +
      '<span class="af-wo-desc"></span>' +
      '<span class="af-wo-num">$' + p.amount.toLocaleString() + '</span>' +
    '</div>').join('');

  host.innerHTML = '' +
    '<div class="af-feed">' +
      '<div class="af-feed-head">' +
        '<span class="af-feed-title">🔗 Billable Labor — live from AppFolio API</span>' +
        '<span class="af-feed-stamp">synced ' + esc(rsAgo(d.fetchedAt) || '—') + '</span>' +
      '</div>' +
      '<div class="af-feed-stats">' +
        '<div class="af-stat"><b>$' + d.billableTotal.toLocaleString() + '</b>Billable total</div>' +
        '<div class="af-stat"><b>' + d.laborHours.toLocaleString() + '</b>Labor hours</div>' +
        '<div class="af-stat"><b>' + d.detailRows.toLocaleString() + '</b>Detail rows</div>' +
        '<div class="af-stat"><b>' + d.laborRows.toLocaleString() + '</b>Labor rows</div>' +
      '</div>' +
      (propRows ? '<div class="af-wo-list">' + propRows + '</div>' : '') +
    '</div>';
}

// Command Center ← work_order (Urgent + Open)
async function loadUrgentFeed() {
  const host = $('#afUrgentFeed');
  if (!host) return;
  let d;
  try { d = await api('/api/appfolio/feed/urgent-wos'); }
  catch { host.innerHTML = ''; return; }

  const rows = d.items.slice(0, 60).map(w =>
    '<div class="af-wo-row">' +
      '<span class="af-wo-num">#' + esc(w.number ?? '—') + '</span>' +
      '<span class="af-wo-prop">' + esc(w.property) + (w.unit ? ' · ' + esc(w.unit) : '') + '</span>' +
      '<span class="af-wo-desc">' + esc(w.summary || '') + '</span>' +
      '<span class="muted small">' + esc(w.assigned || 'unassigned') + '</span>' +
    '</div>').join('');

  const body = d.count
    ? '<div class="af-wo-list">' + rows + '</div>' +
      (d.count > 60 ? '<p class="muted small" style="margin-top:6px">Showing first 60 of ' + d.count + '.</p>' : '')
    : '<p class="muted small">No urgent open work orders. 🎉</p>';

  host.innerHTML = '' +
    '<div class="af-feed af-feed-red">' +
      '<div class="af-feed-head">' +
        '<span class="af-feed-title">🔴 Urgent &amp; Open Work Orders — live from AppFolio API (' + d.count + ')</span>' +
        '<span class="af-feed-stamp">synced ' + esc(rsAgo(d.fetchedAt) || '—') + '</span>' +
      '</div>' +
      body +
    '</div>';
}

// Coverage Map ← open-WO counts per property (red badge on each pin)
async function loadCoverageWoCounts() {
  if (typeof coverageMap === 'undefined' || !coverageMap || !covPropMarkers.length) return;
  let d;
  try { d = await api('/api/appfolio/feed/wo-by-property'); }
  catch { return; }

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries = Object.entries(d.counts).map(([name, n]) => ({ key: norm(name), n }));

  covPropMarkers.forEach(({ prop, marker }) => {
    const pk = norm(prop.name);
    // Match either direction — AppFolio names carry suffixes like
    // "Apartments" / "LLC" that our short names don't.
    const hit = entries.find(e => e.key === pk || e.key.includes(pk) || pk.includes(e.key));
    prop.openWos = hit ? hit.n : 0;
    marker.setIcon(covPropIcon(prop.pending, false, prop.openWos));
  });
}

function refreshAppfolioFeeds() {
  loadBillableFeed();
  loadUrgentFeed();
  loadCoverageWoCounts();
}
