// Command Center cards that close themselves.
//
// Erick is handed ~240 cards a day and ticks none of them, which is the only
// sane response to being asked to confirm 240 things a person already knows.
// Most of those cards are about a work order AppFolio has already closed, so
// the tick asks him for information he does not have and the system does.
//
// Three rules, and everything else stays manual on purpose:
//
//   a work order  -> Completed / Completed No Need To Bill / Canceled
//   an inspection -> status DONE
//   a duplicates card -> only when EVERY work order under it is closed
//
// WHAT DELIBERATELY DOES NOT AUTO-CLOSE
//
//   Work Done and Ready to Bill. They are not finished — they are precisely
//   the work the "QC & bill" card is asking for, and closing on them would
//   delete the task at the moment it became due.
//
//   "Unknown — not in feed". That is the absence of an answer, not a closure.
//   27 work orders sit in it; treating missing data as done is how a board
//   quietly empties itself.
//
//   inspreview. The card exists because someone other than the Coordinator
//   marked the inspection done, and it would resolve when he re-marks it. But
//   marked_done_by holds no "Erick" in any of the 628 inspections on file, so
//   that signal has never once fired. Automating on a field that has never
//   moved would produce a rule nobody could tell apart from a broken one.
//
//   hours. Per tech per day, with no work order and nothing to close against.
//
// THE OVERRIDE
//
// checks[id] carries three states, not two, and the third is what makes an
// auto-tick safe to disagree with:
//
//   1          ticked by a person
//   0          a person explicitly un-ticked it, auto or not
//   absent     nobody has expressed an opinion
//
// 0 is falsy, so every existing `!!checks[id]` reader already treats it as not
// done. No migration, and an untick that would otherwise be overwritten by the
// next auto pass survives.

// Cards that are never closed by this module, whatever else is true.
const NEVER_AUTO = new Set(['inspreview', 'hours']);

// Statuses that count as closed, and how each one reads.
//
// Canceled is a closure, not an achievement: separated here so the board can
// say "cancelled in AppFolio" in grey rather than claim the work was done.
function closureKind(status) {
  const s = String(status || '').trim();
  if (!s) return null;
  if (/^\s*cancel/i.test(s)) return 'cancelled';
  if (/^\s*complet/i.test(s)) return 'closed';
  return null;
}

// The work orders a card is about.
//
// wo.woId joins maintenance_work_orders on work_order_id — NOT on
// work_order_number. woId 24231 is the work order, service_request_id 22847 is
// the request behind it, and "22847-1" is the number. Matching on the number
// matches nothing at all, which looks exactly like "no card ever closes".
//
// A duplicates card has no wo object; it carries several ids in its own id,
// "dup:24231_24232", and is only finished when all of them are.
function cardWorkOrderIds(task) {
  if (!task) return [];
  const id = String(task.id || '');
  if (task.cat === 'duplicates') {
    return id.slice(id.indexOf(':') + 1).split('_').map(x => x.trim()).filter(Boolean);
  }
  const v = task.wo && task.wo.woId;
  return v ? [String(v).trim()] : [];
}

// The inspection a card is about.
//
// Read from the id, because the inspection cards carry no wo object — but only
// for the two categories that are built from the inspections report. Reading
// it from any card would join "pest:24231" to inspection 24231, two unrelated
// records that happen to share a number.
function cardInspectionId(task) {
  if (!task) return null;
  const id = String(task.id || '');
  if (!/^insppend:|^insprev:/.test(id)) return null;
  const rest = id.slice(id.indexOf(':') + 1).trim();
  // Falls back to property+unit+template when AppFolio gave no id, and that
  // is not something to look up.
  return /^\d+$/.test(rest) ? rest : null;
}

// Why a card is considered done, or null.
//
// `wos` and `inspections` are Maps keyed by work_order_id and inspection_id.
// `on` is the board's date: a work order closed AFTER the day being looked at
// did not close that day's card, which matters for history and for any replay.
function autoFor(task, { wos, inspections, on } = {}) {
  if (!task || NEVER_AUTO.has(task.cat)) return null;

  const insp = cardInspectionId(task);
  if (insp) {
    const r = inspections && inspections.get(insp);
    if (!r || !/^\s*done\s*$/i.test(String(r.status || ''))) return null;
    const at = ymd(r.marked_done_on);
    if (on && at && at > on) return null;
    return { kind: 'closed', reason: 'inspection', at: at || null, status: r.status };
  }

  const ids = cardWorkOrderIds(task);
  if (!ids.length) return null;

  const rows = ids.map(i => (wos && wos.get(i)) || null);
  // A duplicates card with one unknown work order is not finished; it is
  // unknown. Same for any card whose work order is not on file.
  if (rows.some(r => !r)) return null;

  const kinds = rows.map(r => closureKind(r.status));
  if (kinds.some(k => !k)) return null;

  const dates = rows.map(r => ymd(r.completed_on)).filter(Boolean);
  const at = dates.length === rows.length ? dates.sort()[dates.length - 1] : null;
  if (on && at && at > on) return null;
  // Without a date there is nothing to show and nothing to check against the
  // board's day, so it is not treated as closed.
  if (!at) return null;

  // Cancelled only when EVERY one of them was cancelled. A duplicate pair of
  // one completed and one cancelled is a completion.
  const kind = kinds.every(k => k === 'cancelled') ? 'cancelled' : 'closed';
  return { kind, reason: 'work_order', at, status: rows.map(r => r.status).join(' + ') };
}

function ymd(v) {
  return v ? String(v).slice(0, 10) : null;
}

// The whole board at once: { [taskId]: {kind, reason, at, status} }.
function autoMap(tasks, sources) {
  const out = {};
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || !t.id) continue;
    const a = autoFor(t, sources);
    if (a) out[t.id] = a;
  }
  return out;
}

// What is done, split by who decided it.
//
// completed_tasks has read 0 every single day, and the counting was never the
// problem: the only boxes ticked are the fixed routine checklist, whose ids are
// "routine:*" and are not in tasks at all, so tasks.filter(t => checks[t.id])
// could only ever be zero. Counted separately now, so the routines stop being
// invisible and an automatic 45 is never mistaken for 45 decisions by a person.
function countsFor(tasks, checks, auto) {
  const list = Array.isArray(tasks) ? tasks : [];
  const ck = checks && typeof checks === 'object' ? checks : {};
  const am = auto || {};
  let manual = 0, autoDone = 0;
  for (const t of list) {
    if (!t || !t.id) continue;
    if (ck[t.id]) { manual++; continue; }
    // An explicit 0 is a person disagreeing with the automatic tick, and it
    // wins. Only an ABSENT key lets the automatic one through.
    if (Object.prototype.hasOwnProperty.call(ck, t.id)) continue;
    if (am[t.id]) autoDone++;
  }
  const ids = new Set(list.map(t => t && t.id).filter(Boolean));
  const routine = Object.keys(ck).filter(k => ck[k] && !ids.has(k)).length;
  return {
    completed_tasks: manual + autoDone,
    completed_manual: manual,
    completed_auto: autoDone,
    completed_routine: routine,
  };
}

// Is this card done, and why — the single answer the UI renders from.
function stateOf(task, checks, auto) {
  const id = task && task.id;
  const ck = checks || {};
  if (!id) return { done: false, by: null };
  if (ck[id]) return { done: true, by: 'manual' };
  if (Object.prototype.hasOwnProperty.call(ck, id)) return { done: false, by: 'override' };
  const a = (auto || {})[id];
  if (a) return { done: true, by: 'auto', kind: a.kind, at: a.at, status: a.status };
  return { done: false, by: null };
}

module.exports = {
  NEVER_AUTO, closureKind, cardWorkOrderIds, cardInspectionId,
  autoFor, autoMap, countsFor, stateOf,
};
