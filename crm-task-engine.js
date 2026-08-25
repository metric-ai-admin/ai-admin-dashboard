/**
 * crm-task-engine.js
 * BD CRM task queue — priority engine ported from the original
 * "Business Development CRM.html" (computeTasks / propertyPriority /
 * readyChecklist / computeLeadScore).
 *
 * Deliberately pure: computeTasks(properties) takes fully hydrated property
 * objects and returns tasks. No database access, so the scoring rules can be
 * exercised against fixed input — which matters, because these numbers decide
 * what the team works on.
 *
 * PHASE A. Five of the original's seven task types are implemented. The gaps
 * are data, not logic, and each is marked TODO(phase-b) below:
 *   - owner_response  — needs properties.owner_response {date, handled}
 *   - contact_update  — needs properties.needs_contact_update
 *   - G&B weekly call rotation — phase C
 *
 * Four scoring terms are intentionally inert rather than guessed. Approved by
 * Arturo 2026-08-25: a wrong mapping is worse than a missing one, because a
 * wrong one is invisible.
 */

'use strict';

// ── Small helpers (ported) ───────────────────────────────────────────────────

const num = v => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };

/** Vacancy % -> occupancy %. The source data stores vacancy. */
const occ = v => { const n = num(v); return n === null ? null : Math.round(100 - n); };

const todayISO = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr, n) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

const dateOf = v => (v ? String(v).slice(0, 10) : null);

/**
 * phone_shops.notes holds a JSON string — {"connection":…,"appointment_set":…}.
 * online_shops.notes is plain text. Same tolerant parse the UI uses.
 */
function parseNotes(n) {
  if (!n) return {};
  if (typeof n === 'object') return n;
  try {
    const parsed = JSON.parse(n);
    return (parsed && typeof parsed === 'object') ? parsed : { text: String(parsed) };
  } catch { return { text: n }; }
}

// ── Connection vocabulary ────────────────────────────────────────────────────
// Two vocabularies coexist. Production rows were written by the original tool
// (surveyed 2026-08-25: `answered_agent`, `not_working`), while our own
// phone-shop form offers a different set. Both are accepted so a row written
// from either side scores the same.
//
//   original : answered_agent, no_answer_vm, no_answer_no_vm, not_working
//   ours     : answered_agent, answered_ai, voicemail, no_answer, wrong_number
//
// `no_answer_no_vm` — a call with no way to leave a message — carries the
// largest call-based bonus in the original (+2.5 score, +200 priority). Only
// the original's vocabulary can express it: our `no_answer` does not record
// whether voicemail was available, so it deliberately does NOT trigger the
// bonus. The term is live for rows that can prove it and silent for rows that
// cannot, rather than guessed either way.
// TODO(phase-b): add the voicemail distinction to our phone-shop form.

const CONN_SUCCESS = 'answered_agent';
const NO_VOICEMAIL = 'no_answer_no_vm';
const UNANSWERED = new Set([
  'no_answer_vm', 'no_answer_no_vm', 'not_working',   // original
  'no_answer', 'voicemail', 'wrong_number',           // ours
]);

const isSuccess     = c => c === CONN_SUCCESS;
const isUnanswered  = c => UNANSWERED.has(c);
const isNoVoicemail = c => c === NO_VOICEMAIL;

/** Phone shops that actually recorded an outcome, newest-last. */
function connectedShops(p) {
  return (p.phone_shops || [])
    .map(s => ({ ...s, conn: parseNotes(s.notes).connection, date: dateOf(s.shop_date) }))
    .filter(s => s.conn)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

// ── Digital marketing ────────────────────────────────────────────────────────

/**
 * Scale of dm_reviews.overall_score is undetermined: every row in production
 * today has it null, with all five section objects empty. Detect at runtime
 * per Arturo's call — anything above 1 can only be a 0-100 percentage.
 */
function dmPct(overallScore) {
  const n = num(overallScore);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * The original walks a DM_SECTIONS criteria tree and requires every criterion
 * answered. We store five section objects instead, so "complete" means all
 * five carry at least one answer. Today they are all `{}`, so this is false
 * everywhere and the DM task fires for every property — which is accurate.
 */
function dmComplete(p) {
  const dm = p.dm_review;
  if (!dm) return false;
  const sections = ['website_scores', 'floorplan_scores', 'gbp_scores', 'facebook_scores', 'ils_scores'];
  return sections.every(s => {
    const v = dm[s];
    return v && typeof v === 'object' && Object.keys(v).length > 0;
  });
}

// ── Missed tours ─────────────────────────────────────────────────────────────

/**
 * Rewritten, not ported. The original reads appointmentSet /
 * appointmentDateTime / apptFollowUpResult off each phone shop; we keep a
 * separate `appointments` table.
 *
 * A tour counts as missed when its time has passed, it did not complete, and
 * no follow-up was logged afterwards. Per Arturo: our statuses are `no_show`
 * and `pending`, so anything past-due that is not `completed` is a candidate.
 */
function missedTourAppointments(p) {
  const now = Date.now();
  const followUps = (p.follow_ups || []).map(f => dateOf(f.follow_up_date)).filter(Boolean);
  return (p.appointments || []).filter(a => {
    if (!a.appointment_at) return false;
    const at = new Date(a.appointment_at);
    if (Number.isNaN(at.getTime()) || at.getTime() >= now) return false;
    if (a.status === 'completed') return false;
    // A follow-up logged on or after the appointment day closes it out.
    const apptDay = dateOf(a.appointment_at);
    return !followUps.some(f => f >= apptDay);
  });
}

const missedTour = p => missedTourAppointments(p).length > 0;

// ── Lead score (ported) ──────────────────────────────────────────────────────

function computeLeadScore(p) {
  if (p.management_type === 'owner-managed') {
    return { score: null, viable: false, breakdown: ['Owner-managed — not a viable lead. Retained for market analysis only.'] };
  }

  let s = 0;
  const notes = [];

  const o = occ(p.vacancy_pct);
  if (o !== null) {
    if (o <= 70)      { s += 4;   notes.push(`+4 — occupancy ${o}% (severe underperformance)`); }
    else if (o <= 80) { s += 3;   notes.push(`+3 — occupancy ${o}% (low)`); }
    else if (o <= 88) { s += 2;   notes.push(`+2 — occupancy ${o}% (below market)`); }
    else if (o <= 92) { s += 1;   notes.push(`+1 — occupancy ${o}% (slightly soft)`); }
  }

  const age = p.year_built ? (new Date().getFullYear() - parseInt(p.year_built, 10)) : null;
  if (age !== null && !Number.isNaN(age)) {
    if (age >= 40)      { s += 1.5;  notes.push(`+1.5 — built ${p.year_built} (${age}y, likely capital/marketing neglect)`); }
    else if (age >= 20) { s += 0.75; notes.push(`+0.75 — built ${p.year_built} (${age}y)`); }
  }

  if (p.asset_class === 'C')      { s += 1;   notes.push('+1 — Class C'); }
  else if (p.asset_class === 'B') { s += 0.5; notes.push('+0.5 — Class B'); }

  // TODO(phase-b): the original adds up to +1.5 for open code violations.
  // properties has no open_violations column; adding one needs Lyndsay's input,
  // so the term is omitted. Scores therefore run slightly below the original's,
  // which lowers the HOT LEADS (7+) count. Deliberate and visible.

  const shops = connectedShops(p);
  if (shops.length) {
    const noVm = shops.filter(s2 => isNoVoicemail(s2.conn)).length;
    const unanswered = shops.filter(s2 => isUnanswered(s2.conn)).length;
    if (noVm > 0)              { s += 2.5; notes.push(`+2.5 — ${noVm} call(s) with no way to leave a message (critical)`); }
    else if (unanswered >= 2)  { s += 1.5; notes.push(`+1.5 — ${unanswered} unanswered call(s)`); }
    else if (unanswered === 1) { s += 0.5; notes.push('+0.5 — 1 unanswered call'); }

    const anyFailed = shops.some(s2 => !isSuccess(s2.conn));
    if (anyFailed && !(p.follow_ups || []).length) {
      s += 0.5; notes.push('+0.5 — no callback/follow-up ever received');
    }
  }

  if (missedTour(p)) { s += 1.5; notes.push('+1.5 — tour appointment missed with no agent follow-up'); }

  const pct = dmPct(p.dm_review && p.dm_review.overall_score);
  if (pct !== null) {
    if (pct < 0.5)      { s += 1;   notes.push('+1 — digital marketing audit below 50%'); }
    else if (pct < 0.7) { s += 0.5; notes.push('+0.5 — digital marketing audit below 70%'); }
  }

  // TODO(phase-b): the original adds +1 when ropStatus === 'yes' ("Repeat
  // Offender list"). Our rop_status carries different values ("unknown",
  // "Active", "Closed", "Prospect") with different meaning. Left at 0 until
  // the mapping is settled with Lyndsay.

  return { score: Math.max(1, Math.min(10, Math.round(s))), viable: true, breakdown: notes };
}

function getLeadScore(p) {
  const auto = computeLeadScore(p);
  const ov = p.lead_score_override;
  if (ov !== null && ov !== undefined && ov !== '') {
    return { score: parseInt(ov, 10), viable: auto.viable, breakdown: auto.breakdown, overridden: true, auto: auto.score };
  }
  return { ...auto, overridden: false };
}

// ── Ready for Lyndsay (ported) ───────────────────────────────────────────────

function readyChecklist(p) {
  const shops = connectedShops(p);
  const success = shops.some(s => isSuccess(s.conn));
  const unsuccessful = shops.filter(s => !isSuccess(s.conn));
  const lastDate = shops.map(s => s.date).filter(Boolean).sort().pop();
  const phoneDone = success || (unsuccessful.length >= 3 && lastDate && daysSince(lastDate) >= 3);

  const os = p.online_shops || [];
  const lastOnline = os.map(s => dateOf(s.shop_date)).filter(Boolean).sort().pop();
  const onlineDone = os.length > 0 && lastOnline && daysSince(lastOnline) >= 3;

  const done = dmComplete(p);
  return { phoneDone, onlineDone, dmDone: done, ready: phoneDone && onlineDone && done };
}

// ── Priority engine (ported) ─────────────────────────────────────────────────

const isActive = p => p.management_type !== 'owner-managed';

function propertyPriority(p) {
  let pr = 0;
  const reasons = [];

  // TODO(phase-b): +1000 "Owner responded" needs properties.owner_response.

  if (missedTour(p)) { pr += 300; reasons.push('Missed tour, no follow-up'); }

  const shops = connectedShops(p);
  if (shops.some(s => isNoVoicemail(s.conn))) {
    pr += 200; reasons.push('Negative shop: no voicemail option');
  } else if (shops.filter(s => !isSuccess(s.conn)).length >= 2) {
    pr += 150; reasons.push('Repeated unanswered calls');
  }

  // TODO(phase-b): +150 "🎯 Targeted company" needs the targeted-companies list,
  // which lived in the original's local settings and has no home in Supabase
  // yet. This is the second-strongest term, so ordering will not match the
  // original until it exists.

  if (shops.length || (p.online_shops || []).length) { pr += 100; reasons.push('Contact started'); }

  const ls = getLeadScore(p);
  pr += (ls.score || 0);

  return { priority: pr, reasons, leadScore: ls.score };
}

// ── Task engine (ported, five of seven types) ────────────────────────────────

const TASK_TARGET_MINUTES = { phone: 5, online: 2, dm: 12, contact_update: 4, appt_check: 3, owner_response: 10, ready: 10 };

function computeTasks(properties) {
  const tasks = [];
  const today = todayISO();

  for (const p of (properties || [])) {
    if (!isActive(p)) continue;

    const pri = propertyPriority(p);
    const rc = readyChecklist(p);
    const base = {
      property_id: p.id,
      property_name: p.property_name,
      reasons: pri.reasons,
      lead_score: pri.leadScore,
    };

    // TODO(phase-b): owner_response task (+500) goes here.

    if (rc.ready && !p.lyndsay_reviewed) {
      tasks.push({ ...base, type: 'ready', label: '⭐ Ready for Lyndsay — review & draft outreach',
        agent: 'Lyndsay', tab: 'outreach', minutes: TASK_TARGET_MINUTES.ready, due: today, priority: pri.priority + 250 });
    }

    const shops = connectedShops(p);
    const success = shops.some(s => isSuccess(s.conn));

    // TODO(phase-b): holdShops — the original suppresses shops while contact
    // details are stale (needs_contact_update). Without that column nothing is
    // held back.
    if (!success && shops.length < 3) {
      const n = shops.length + 1;
      const agent = n === 3 ? (p.phone_assignee3 || 'Katie') : (p.phone_assignee || 'Erick');
      const lastDate = shops.map(s => s.date).filter(Boolean).sort().pop();
      // Next attempt is due two days after the last one, not immediately.
      const due = shops.length && lastDate ? addDays(lastDate, 2) : today;
      tasks.push({ ...base, type: 'phone', label: `Phone shop — attempt ${n} of 3`,
        agent, tab: 'phone', minutes: TASK_TARGET_MINUTES.phone, due, priority: pri.priority });
    }

    for (const a of missedTourAppointments(p)) {
      tasks.push({ ...base, type: 'appt_check', label: 'Confirm: did the property follow up on the missed tour?',
        agent: a.agent_name || p.phone_assignee || 'Erick', tab: 'appointments',
        minutes: TASK_TARGET_MINUTES.appt_check, due: addDays(dateOf(a.appointment_at), 1),
        priority: pri.priority + 120 });
    }

    const os = p.online_shops || [];
    if (os.length === 0) {
      tasks.push({ ...base, type: 'online', label: 'Online shop',
        agent: p.online_dm_assignee || 'Erick', tab: 'online', minutes: TASK_TARGET_MINUTES.online,
        due: today, priority: pri.priority });
    } else if (os.length === 1 && (p.follow_ups || []).length === 0) {
      tasks.push({ ...base, type: 'online', label: 'Online shop — 2nd attempt (no response after a week)',
        agent: p.online_dm_assignee || 'Erick', tab: 'online', minutes: TASK_TARGET_MINUTES.online,
        due: addDays(dateOf(os[0].shop_date), 7), priority: pri.priority });
    }

    if (!rc.dmDone) {
      tasks.push({ ...base, type: 'dm', label: 'Digital marketing review',
        agent: p.online_dm_assignee || 'Erick', tab: 'dm', minutes: TASK_TARGET_MINUTES.dm,
        due: today, priority: pri.priority });
    }

    // TODO(phase-b): contact_update task (+180) goes here.
  }

  tasks.sort((a, b) => (b.priority - a.priority) || String(a.due || '').localeCompare(String(b.due || '')));
  return tasks;
}

/** Per-agent rollup for the queue header: how many tasks and how many minutes. */
function agentSummary(tasks) {
  const by = {};
  for (const t of tasks) {
    const a = t.agent || 'Unassigned';
    by[a] = by[a] || { agent: a, tasks: 0, minutes: 0, overdue: 0 };
    by[a].tasks += 1;
    by[a].minutes += t.minutes || 0;
    if (t.due && t.due < todayISO()) by[a].overdue += 1;
  }
  return Object.values(by).sort((x, y) => y.minutes - x.minutes);
}

module.exports = {
  computeTasks,
  agentSummary,
  propertyPriority,
  readyChecklist,
  computeLeadScore,
  getLeadScore,
  missedTour,
  dmComplete,
  TASK_TARGET_MINUTES,
  // exported for tests
  _internals: { occ, num, addDays, daysSince, parseNotes, dmPct, connectedShops, isActive },
};
