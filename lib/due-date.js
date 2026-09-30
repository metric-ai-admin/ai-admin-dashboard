// What counts as a due date, in one place.
//
// due_on has been on tasks for a long time and both /api/tasks routes already
// accepted it — but neither checked it, so "next friday", "10/03/2026" and
// "2026-13-45" all went into tasks.json and on to Asana, where an unparseable
// date is silently dropped. A due date that quietly does not exist is worse
// than one the API refuses.
//
// Pure, and shared by the REST routes, the MCP tools and the backfill so they
// cannot disagree about what a date is.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetricDue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * Is this a real calendar date written as YYYY-MM-DD?
   *
   * The round-trip is what rejects 2026-02-30 and 2026-13-45: Date rolls those
   * forward into March and 2027 rather than complaining, so the only way to know
   * the input was real is to format the result and compare.
   */
  function isValidDueOn(v) {
    const m = YMD.exec(String(v == null ? '' : v));
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toISOString().slice(0, 10) === String(v);
  }

  /**
   * Normalise what a caller sent into what gets stored.
   *
   * @returns {{ok:true, value:string|null}|{ok:false, error:string}}
   *
   * THREE CASES, and the difference between the first two is the whole point:
   *   absent  — the caller said nothing; leave the existing value alone
   *   null/'' — the caller is CLEARING it
   *   a date  — set it
   *
   * An update that treats "absent" as "clear" wipes dates whenever a caller sends
   * a partial patch, which is what the MCP edit tool sends on every call.
   */
  function parseDueOn(raw) {
    if (raw === undefined) return { ok: true, value: undefined };   // not supplied
    if (raw === null || String(raw).trim() === '') return { ok: true, value: null };  // cleared
    const v = String(raw).trim();
    if (!isValidDueOn(v)) {
      return { ok: false, error: `due_on must be YYYY-MM-DD (got ${JSON.stringify(raw)})` };
    }
    return { ok: true, value: v };
  }

  /**
   * How a due date should read on a card.
   *
   * overdue  — before today, and not done
   * soon     — today or tomorrow, and not done
   * none     — everything else, including anything on a completed task
   *
   * Tomorrow counts as soon because the point of the colour is "this needs
   * attention before you close the laptop", and a task due tomorrow morning does.
   * A completed task is never late: the colour would be scolding someone for
   * work they have already done.
   */
  function dueState(dueOn, todayYMD, isDone) {
    if (!dueOn || isDone) return 'none';
    if (!isValidDueOn(dueOn) || !isValidDueOn(todayYMD)) return 'none';
    if (dueOn < todayYMD) return 'overdue';
    const t = new Date(todayYMD + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + 1);
    const tomorrow = t.toISOString().slice(0, 10);
    return (dueOn === todayYMD || dueOn === tomorrow) ? 'soon' : 'none';
  }

  return { isValidDueOn: isValidDueOn, parseDueOn: parseDueOn, dueState: dueState };
}));
