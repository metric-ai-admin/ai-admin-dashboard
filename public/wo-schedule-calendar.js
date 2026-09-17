/* AI Admin Dashboard — Maintenance ▸ WO Scheduling, Phase 2
   Tech workload panel + weekly drag-to-schedule calendar.

   Loaded after wo-scheduling.js, which owns the feed (woSchedData), the age
   helpers and loadWoScheduling(). Split into its own file for the same reason
   reports-sync.js and command-center.js are separate: one view module per
   concern, rather than one growing file.

   AppFolio cannot store a scheduled date — its Reports API is read-only — so
   the schedule lives in Supabase behind /api/appfolio/schedule and is joined to
   the AppFolio WO list on work_order_number. The two load separately on
   purpose: a Supabase outage must not blank the WO table, and an AppFolio sync
   must not touch the schedule. */

let woSchedRows = [];      // wo_schedule rows for the visible week
let woSchedByWo = {};      // same, keyed by work_order_number
let woWeekStart = null;    // Monday of the displayed week
let woDragWo = null;
const WO_DEFAULT_HOURS = 2;

// ---- date helpers ----
function woMonday(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // getDay() is 0 for Sunday, so shift the week to start on Monday.
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
// Local calendar date. NOT toISOString(), which converts to UTC and in US
// timezones turns an evening date into the next day.
function woISO(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function woAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function woWeekDays() {
  if (!woWeekStart) woWeekStart = woMonday(new Date());
  return Array.from({ length: 7 }, (_, i) => woAddDays(woWeekStart, i));
}

async function loadWoSchedule() {
  const days = woWeekDays();
  try {
    const r = await api('/api/appfolio/schedule?from=' + woISO(days[0]) + '&to=' + woISO(days[6]));
    woSchedRows = r.rows || [];
  } catch (err) {
    woSchedRows = [];
    const cal = $('#woCalendar');
    if (cal) {
      cal.innerHTML = '<div class="banner banner-warn">Schedule unavailable: ' + esc(err.message) +
        (/wo_schedule/i.test(err.message)
          ? '<br>Run <code>supabase/migrations/052_wo_schedule.sql</code> in the Supabase SQL editor, then refresh.'
          : '') + '</div>';
    }
    return false;
  }
  woSchedByWo = {};
  for (const r of woSchedRows) woSchedByWo[r.work_order_number] = r;
  return true;
}

// ---- Tech workload panel ----
function renderTechPanel() {
  const techs = (woSchedData?.techs || []).filter(t => t.hours90 > 0 || t.openWos > 0);
  const el = $('#woTechPanel');
  if (!el) return;
  if (!techs.length) { el.innerHTML = '<p class="muted">No technician hours in the window.</p>'; return; }
  const maxAvg = Math.max.apply(null, techs.map(t => t.avgWeekly).concat([1]));

  el.innerHTML =
    '<div class="me-table-wrap"><table class="me-table wo-tech-table">' +
    '<thead><tr><th>Technician</th><th>7d</th><th>30d</th><th>90d</th><th>Avg/week</th>' +
    '<th>Open WOs</th><th>Load</th></tr></thead><tbody>' +
    techs.map(function (t) {
      // Capacity is measured against the tech's OWN 90-day weekly average, not
      // a fixed 40h target. These techs split time across other properties, so
      // the iConic slice is never a full week and a shared target would make
      // everyone look idle.
      const pct = t.avgWeekly > 0 ? Math.round(100 * t.hours7 / t.avgWeekly) : null;
      const barPct = Math.min(100, Math.round(100 * t.avgWeekly / maxAvg));
      const cls = pct === null ? '' : pct > 120 ? 'wo-cap-over' : pct >= 60 ? 'wo-cap-ok' : 'wo-cap-under';
      // A tech carrying WOs but logging no hours cannot be sized by hours. Say
      // so, rather than rendering a 0% bar that reads as "available".
      const note = t.hours90 === 0
        ? '<span class="badge badge-amber" title="Carrying work orders but logs no labour in this report, so capacity cannot be estimated from hours">no logged hours</span>'
        : (pct === null ? '' : '<span class="wo-cap-pct ' + cls + '">' + pct + '% of usual</span>');
      return '<tr>' +
        '<td><strong>' + esc(t.tech) + '</strong>' +
          (t.topProperty ? '<div class="muted small">' + esc(t.topProperty) + '</div>' : '') + '</td>' +
        '<td>' + t.hours7 + 'h</td><td>' + t.hours30 + 'h</td><td>' + t.hours90 + 'h</td>' +
        '<td>' + t.avgWeekly + 'h</td>' +
        '<td>' + (t.openWos ? '<span class="badge badge-blue">' + t.openWos + '</span>' : '<span class="muted">0</span>') + '</td>' +
        '<td><div class="wo-cap-wrap"><div class="wo-cap-bar" style="width:' + barPct + '%"></div></div>' + note + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<p class="muted small" style="margin-top:8px;">Hours are iConic only, from the 90-day labor window. ' +
    'Load compares the last 7 days to that technician&rsquo;s own 90-day weekly average.</p>';
}

// ---- Weekly calendar ----
function woUnscheduled() {
  return (woSchedData?.openWos || []).filter(w => !woSchedByWo[w.wo]);
}

function woTechOptions(selected) {
  const names = (woSchedData?.techs || []).map(t => t.tech);
  return ['<option value="">&mdash; tech &mdash;</option>'].concat(
    names.map(n => '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>')
  ).join('');
}

function woCardHtml(w, sched) {
  const wo = sched ? sched.work_order_number : w.wo;
  const age = w ? w.ageDays : null;
  const prop = (sched && sched.property_name) || (w && w.property) || '';
  const unit = (sched && sched.unit_name) || (w && w.unit) || '';
  return '<div class="wo-card" draggable="true" data-wo="' + esc(wo) + '">' +
    '<div class="wo-card-head"><strong>' + esc(wo) + '</strong>' +
      (age !== null && age !== undefined ? '<span class="wo-age ' + woAgeClass(age) + '">' + age + 'd</span>' : '') +
    '</div>' +
    '<div class="wo-card-prop">' + esc(prop) + (unit ? ' &middot; ' + esc(unit) : '') + '</div>' +
    (w && w.issue ? '<div class="wo-card-issue" title="' + esc(w.issue) + '">' +
      esc(String(w.issue).replace(/\s+/g, ' ').slice(0, 44)) + '</div>' : '') +
    (sched
      ? '<div class="wo-card-ctl">' +
          '<select class="wo-card-tech" data-wo="' + esc(wo) + '">' + woTechOptions(sched.scheduled_tech) + '</select>' +
          '<input class="wo-card-hours" type="number" min="0.5" max="24" step="0.5" value="' +
            (sched.estimated_hours === null || sched.estimated_hours === undefined ? WO_DEFAULT_HOURS : sched.estimated_hours) +
            '" data-wo="' + esc(wo) + '" title="Estimated hours">' +
          '<button class="wo-card-x" data-wo="' + esc(wo) + '" title="Unschedule">&times;</button>' +
        '</div>'
      : '') +
  '</div>';
}

function renderCalendar() {
  const cal = $('#woCalendar');
  if (!cal) return;
  const days = woWeekDays();
  const byWo = {};
  for (const w of (woSchedData?.openWos || [])) byWo[w.wo] = w;

  const head = '<div class="wo-cal-head">' +
    '<button class="btn-sm" id="woWeekPrev">&lsaquo; Prev</button>' +
    '<strong>' + days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' &ndash; ' +
      days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + '</strong>' +
    '<button class="btn-sm" id="woWeekNext">Next &rsaquo;</button>' +
    '<button class="btn-sm" id="woWeekToday">Today</button></div>';

  const todayISO = woISO(new Date());
  const cols = days.map(function (d) {
    const iso = woISO(d);
    const rows = woSchedRows.filter(r => r.scheduled_date === iso);
    const hours = rows.reduce((s, r) => s + Number(r.estimated_hours || 0), 0);
    return '<div class="wo-cal-col' + (iso === todayISO ? ' wo-cal-today' : '') + '" data-date="' + iso + '">' +
      '<div class="wo-cal-daylabel">' + d.toLocaleDateString(undefined, { weekday: 'short' }) +
        ' <span class="muted">' + d.getDate() + '</span>' +
        (hours ? '<span class="wo-cal-hours">' + (Math.round(hours * 10) / 10) + 'h</span>' : '') +
      '</div>' +
      '<div class="wo-cal-drop">' + rows.map(r => woCardHtml(byWo[r.work_order_number], r)).join('') + '</div>' +
    '</div>';
  }).join('');

  // Backlog grouped by property: the simple form of "reduce trips". Every open
  // WO at one address sits together, so they can be dropped on the same day
  // without hunting through a flat list.
  const un = woUnscheduled();
  const groups = {};
  for (const w of un) (groups[w.property] || (groups[w.property] = [])).push(w);
  const backlog = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([prop, list]) =>
      '<div class="wo-backlog-group"><div class="wo-backlog-prop">' + esc(prop) +
        ' <span class="badge badge-gray">' + list.length + '</span></div>' +
        list.map(w => woCardHtml(w, null)).join('') + '</div>')
    .join('') || '<p class="muted small">Everything open is scheduled.</p>';

  cal.innerHTML = head + '<div class="wo-cal-grid">' + cols + '</div>';
  const bl = $('#woBacklog');
  if (bl) {
    bl.innerHTML = '<h3 class="wo-backlog-title">Unscheduled <span class="badge badge-gray">' + un.length + '</span></h3>' +
      '<p class="muted small">Drag onto a day. Grouped by property so one trip can cover several.</p>' + backlog;
  }
  wireCalendarEvents();
}

function wireCalendarEvents() {
  const reload = async fn => { fn(); await loadWoSchedule(); renderCalendar(); };
  $('#woWeekPrev')?.addEventListener('click',  () => reload(() => { woWeekStart = woAddDays(woWeekStart, -7); }));
  $('#woWeekNext')?.addEventListener('click',  () => reload(() => { woWeekStart = woAddDays(woWeekStart, 7); }));
  $('#woWeekToday')?.addEventListener('click', () => reload(() => { woWeekStart = woMonday(new Date()); }));

  $$('.wo-card').forEach(function (card) {
    card.addEventListener('dragstart', function (e) {
      woDragWo = card.dataset.wo;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag unless some data is set.
      e.dataTransfer.setData('text/plain', woDragWo);
      card.classList.add('wo-card-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('wo-card-dragging'));
  });

  $$('.wo-cal-col').forEach(function (col) {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('wo-cal-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('wo-cal-over'));
    col.addEventListener('drop', async function (e) {
      e.preventDefault();
      col.classList.remove('wo-cal-over');
      const wo = woDragWo || e.dataTransfer.getData('text/plain');
      woDragWo = null;
      if (wo) await woSchedSave(wo, { scheduled_date: col.dataset.date });
    });
  });

  $$('.wo-card-x').forEach(b => b.addEventListener('click', () => woSchedRemove(b.dataset.wo)));
  $$('.wo-card-tech').forEach(s => s.addEventListener('change', () => woSchedSave(s.dataset.wo, { scheduled_tech: s.value })));
  $$('.wo-card-hours').forEach(i => i.addEventListener('change', () => woSchedSave(i.dataset.wo, { estimated_hours: i.value })));
}

// The save is an upsert, so every column has to be resent or the ones left out
// would be nulled. Merge the change onto whatever the row already holds, falling
// back to the AppFolio WO for a card being scheduled for the first time.
async function woSchedSave(wo, patch) {
  const existing = woSchedByWo[wo] || {};
  const src = (woSchedData?.openWos || []).find(w => w.wo === wo) || {};
  const body = Object.assign({
    work_order_number: wo,
    property_name:  existing.property_name  || src.property || null,
    unit_name:      existing.unit_name      || src.unit     || null,
    scheduled_date: existing.scheduled_date || null,
    scheduled_tech: existing.scheduled_tech || src.tech     || null,
    estimated_hours: existing.estimated_hours === null || existing.estimated_hours === undefined
      ? WO_DEFAULT_HOURS : existing.estimated_hours,
    notes: existing.notes || null,
  }, patch);
  try {
    await api('/api/appfolio/schedule', { method: 'POST', body: JSON.stringify(body) });
    await loadWoSchedule();
    renderCalendar();
    toast('Saved ' + wo);
  } catch (err) {
    toast('Could not save: ' + err.message, 'warn');
  }
}

async function woSchedRemove(wo) {
  try {
    await api('/api/appfolio/schedule/' + encodeURIComponent(wo), { method: 'DELETE' });
    await loadWoSchedule();
    renderCalendar();
    toast('Unscheduled ' + wo);
  } catch (err) {
    toast('Could not unschedule: ' + err.message, 'warn');
  }
}
