// The Lyndsay Message Queue, DERIVED from her calendar instead of accumulated.
//
// WHAT WAS WRONG. The queue was a JSON file that reminders were pushed into and
// never taken out of: a row left when it was marked sent, or 24 hours after
// that. Every symptom on 2026-10-06 came from that one decision.
//
//   * Tomorrow's meetings were queued today as a heads-up, so "Tomorrow
//     reminder: Metric unknown charges review" sat in a list of things to send
//     now.
//   * A reminder queued at T-30 stayed after the meeting started, after it
//     ended, and all day — nothing expired it. The 9:30s were still there in
//     the afternoon.
//   * "Discovery Session — Kara & Arturo" moved to tomorrow and the row stayed
//     at 1:00 PM today, because nothing ever re-read the calendar.
//   * The text was written once, at queue time, from the meeting's CLASSIFIED
//     lead time — so it said "starts in 4 minutes" whatever the clock said.
//
// So nothing is stored. build() takes the calendar and the time and returns
// what should be on screen right now; a moved meeting moves, a cancelled one
// disappears, and a finished one expires on its own. The only thing that
// persists is which reminders have been marked sent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LyndsayQueue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Thirty minutes before the start, and not one second after it.
  //
  // The upper bound is the fix for the 9:30s. A reminder is a thing to send
  // BEFORE a meeting; once it has started, sending it is noise and leaving it
  // on screen makes the queue a list of things that no longer matter.
  var WINDOW_MINUTES = 30;

  // Identity across a rebuild: the event plus its start. The start has to be in
  // the key — a meeting moved from 1pm to 3pm is a different reminder to send,
  // and keeping "sent" against the event alone would silence the new time.
  function keyOf(m) {
    var id = String((m && (m.id || m.eventId)) || '').trim();
    var start = String((m && (m.start || m.meetingTime)) || '').trim();
    if (!id && !start) return null;
    return id + '|' + start;
  }

  function minutesUntil(startIso, now) {
    var s = new Date(startIso).getTime();
    var n = (now instanceof Date ? now : new Date(now)).getTime();
    if (isNaN(s) || isNaN(n)) return null;
    return (s - n) / 60000;
  }

  // Is this meeting on the given Central day? The comparison is on the Central
  // calendar date, never on a UTC one: a 7pm Austin meeting is today, and in
  // UTC it is tomorrow.
  function isOnDay(startIso, ymdCentral, toCentralYMD) {
    var d = toCentralYMD(new Date(startIso));
    return !!d && d === ymdCentral;
  }

  /**
   * What belongs on screen right now.
   *
   * @param {Array}  meetings     Lyndsay's calendar, already filtered to the
   *                              ones that are hers (the Morning Report's
   *                              ownership rule — the caller applies it, so
   *                              this module stays pure).
   * @param {Object} opts
   *   now           Date
   *   todayCentral  'YYYY-MM-DD' in Central
   *   toCentralYMD  fn(Date) -> 'YYYY-MM-DD'
   *   sent          { key: true }  marks that survive the rebuild
   *   leadFor       fn(meeting) -> minutes, for the message text only
   */
  function build(meetings, opts) {
    var o = opts || {};
    var now = o.now instanceof Date ? o.now : new Date(o.now || Date.now());
    var sent = o.sent || {};
    var toYMD = o.toCentralYMD;
    var out = [];

    (meetings || []).forEach(function (m) {
      if (!m || m.isCancelled) return;             // cancelled disappears
      if (!m.start) return;

      // TODAY ONLY, in Central. Tomorrow's meetings are not something to send
      // now, and that whole reminder type is gone.
      if (toYMD && o.todayCentral && !isOnDay(m.start, o.todayCentral, toYMD)) return;

      var mins = minutesUntil(m.start, now);
      if (mins === null) return;
      // (start - 30min, start]. Past the start it expires by itself, whether or
      // not anybody marked it sent.
      if (mins > WINDOW_MINUTES || mins <= 0) return;

      var key = keyOf(m);
      out.push({
        key: key,
        eventId: m.id || null,
        meetingTitle: m.subject || '(no subject)',
        meetingTime: m.start,
        minutesUntil: Math.max(0, Math.round(mins)),
        platform: m.platform || null,
        joinUrl: m.joinUrl || null,
        attendees: (m.attendees || []).length,
        leadMinutes: o.leadFor ? o.leadFor(m) : null,
        sent: !!(key && sent[key]),
      });
    });

    // Soonest first: the one about to start is the one to send.
    out.sort(function (a, b) { return new Date(a.meetingTime) - new Date(b.meetingTime); });
    return out;
  }

  /**
   * The text, built AT COPY TIME so the number is the real one.
   *
   * The old message baked the classified lead time in when the row was created,
   * which is why every reminder said "starts in 4 minutes" regardless of the
   * clock. The time is included too, so a stale paste is self-evidently stale.
   */
  function messageFor(item, now, ctTime) {
    var mins = item && item.minutesUntil != null
      ? item.minutesUntil
      : Math.max(0, Math.round(minutesUntil(item.meetingTime, now) || 0));
    var when = mins <= 1 ? 'starts in 1 minute' : 'starts in ' + mins + ' minutes';
    var lines = ['📅 Reminder: ' + (item.meetingTitle || '') + ' ' + when + ' (' + ctTime + ' CT).'];
    lines.push('🕐 ' + ctTime + ' CT' + (item.platform ? ' — ' + item.platform : ''));
    lines.push('👥 ' + (item.attendees || 0) + ' attendee(s)');
    if (item.joinUrl) lines.push(item.joinUrl);
    return lines.join('\n');
  }

  return {
    build: build,
    messageFor: messageFor,
    keyOf: keyOf,
    minutesUntil: minutesUntil,
    WINDOW_MINUTES: WINDOW_MINUTES,
  };
}));
