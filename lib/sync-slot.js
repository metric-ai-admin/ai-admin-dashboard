// Did a scheduled sync miss its slot, or has it simply not come round yet?
//
// WHY THIS IS A LIB. The 05:30 leasing sync answered this with twenty lines
// inlined in the EOD gatherer. The 05:00 occupancy sync needs the same answer,
// and the obvious move — copy the block and change 30 to 0 — is how two
// schedules end up disagreeing about what "missed" means. The one that loses
// is the one nobody is looking at, which is the whole category of bug this
// alert exists to catch.
//
// THE DISTINCTION IS THE POINT. "Has not run yet" and "ran and failed" and
// "should have run and wrote nothing" are three different states and only one
// of them is an alarm. A service deployed at 09:00 has not missed the 05:00
// slot; one that has been up since yesterday and wrote nothing has. Both have
// no state file, and reporting them the same way either cries wolf every
// deploy or stays quiet through a real outage.
'use strict';

/**
 * The most recent occurrence of hh:mm in `timezone`, as a real instant.
 *
 * The offset is undone rather than assumed: toLocaleString gives wall-clock
 * Central expressed as if it were local, so the difference from now() is the
 * correction. Doing this with a fixed -5 or -6 breaks twice a year, and it
 * breaks at 05:00, which is when every one of these jobs runs.
 */
function lastSlot(hour, minute, timezone, now) {
  const nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
  const nowCT = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: timezone }));
  const slot = new Date(nowCT);
  slot.setHours(hour, minute, 0, 0);
  if (slot > nowCT) slot.setDate(slot.getDate() - 1);   // today's has not arrived
  return new Date(slot.getTime() + (nowMs - nowCT.getTime()));
}

/**
 * What to report for a sync whose state file is ABSENT.
 *
 * `startedAt` is when this process came up — not a 24-hour window. The
 * question is whether this process was alive when the slot passed, because a
 * state file only exists if the process that writes it was running.
 */
function missedSlotState(opts) {
  const o = opts || {};
  const timezone = o.timezone || 'America/Chicago';
  const now = o.now || Date.now();
  const last = lastSlot(o.hour, o.minute || 0, timezone, now);
  const next = new Date(last.getTime() + 24 * 3600 * 1000);
  const missed = o.startedAt < last.getTime();
  const label = String(o.hour).padStart(2, '0') + ':' + String(o.minute || 0).padStart(2, '0');
  return {
    missedItsSlot: missed,
    nextRunLabel: next.toLocaleDateString('en-US',
      { timeZone: timezone, month: 'short', day: 'numeric' }),
    // Null, not a cheerful string. A caller that renders whatever is in
    // `error` must show nothing when there is nothing wrong.
    error: missed ? 'The ' + label + ' run did not happen and wrote no state.' : null,
  };
}

module.exports = { lastSlot, missedSlotState };
