// Activity logging — the queue, the redaction rules, and nothing else.
//
// PURE. No database and no clock of its own: the flush function and `now` are
// injected, so every rule below is testable without Supabase and without
// waiting for a timer.
//
// THE ONE RULE THAT MATTERS: logging must never affect the user's action.
// Not slow it down, not fail it, not throw past it. Everything here is built
// around that:
//
//   * enqueue() is synchronous and returns nothing. There is no promise to
//     await, so no caller can accidentally wait on it.
//   * enqueue() cannot throw. A bug in redaction must not take down the route
//     that called it.
//   * the queue is BOUNDED. If Supabase is down the rows are dropped, not
//     accumulated. Losing an audit row is annoying; an unbounded queue in a
//     long-lived process is an outage.
//
// WHAT IS NEVER RECORDED: request bodies, query strings, resident names,
// amounts, note text. A row says which kind of thing was touched and which
// one. The redaction is done HERE rather than at each call site, because a
// rule applied in twenty places is a rule that will be forgotten in one.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActivityLog = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_ROWS = 500;
  var FLUSH_MS = 10000;

  // The section is the first path segment after /api/. Deriving it rather than
  // listing it means a new route is logged the day it is added instead of the
  // day somebody remembers to register it.
  function sectionOf(path) {
    var p = String(path || '').split('?')[0].split('#')[0];
    var m = /^\/api\/([A-Za-z0-9_-]+)/.exec(p);
    return m ? m[1].toLowerCase() : null;
  }

  // The id in the route, if there is one. Everything that is not an id shape
  // is dropped: a route segment can be a name, and a name can be a resident.
  var ID_RE = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,}|task_[0-9]+_[0-9]+|[A-Za-z0-9_-]{16,})$/;
  function resourceOf(path) {
    var p = String(path || '').split('?')[0].split('#')[0];
    var parts = p.split('/').filter(Boolean);
    for (var i = parts.length - 1; i >= 2; i--) {
      if (ID_RE.test(parts[i])) return parts[i].slice(0, 120);
    }
    return null;
  }

  // Only these keys ever reach the table. Anything else a caller passes is
  // discarded rather than stored — an allowlist, so a new field has to be
  // added here on purpose.
  var ALLOWED = ['user_email', 'user_name', 'user_role', 'event', 'section',
    'resource', 'method', 'status_code', 'view_bucket', 'at',
    // 079. property_name is a business fact — it is on the sign outside — and
    // without it "Updated CRM property" cannot be acted on. Resident names,
    // notes and amounts stay forbidden.
    'action', 'entity_type', 'entity_id', 'property_name'];

  // Fields that must never appear, checked by name as a backstop. If a caller
  // ever passes one the row is dropped whole rather than partially stored:
  // a truncated row that looks fine is worse than a missing one.
  var FORBIDDEN = /^(body|payload|query|params|notes?|note_text|subject|tenant|resident|applicant|name|email|phone|address|amount|rent|balance|password|token|cookie|authorization)$/i;

  function clean(row) {
    if (!row || typeof row !== 'object') return null;
    for (var k in row) {
      // user_email / user_name are the two identity fields that ARE wanted;
      // anything else matching the forbidden list kills the row.
      if (k === 'user_email' || k === 'user_name' || k === 'user_role') continue;
      if (FORBIDDEN.test(k)) return null;
    }
    var out = {};
    for (var i = 0; i < ALLOWED.length; i++) {
      var key = ALLOWED[i];
      if (row[key] === undefined || row[key] === null) continue;
      out[key] = typeof row[key] === 'string' ? row[key].slice(0, 300) : row[key];
    }
    if (!out.user_email || !out.event) return null;   // the two non-null columns
    return out;
  }

  // The section name a VIEW beacon claims, sanitised.
  //
  // Phase 1 derives the section from the route, which the client cannot
  // influence. A view beacon is the first thing in this table whose section
  // comes from the BROWSER, so it is the first thing that could be used to put
  // arbitrary text — a resident's name, a note — into a column that is meant
  // to hold 'leasing'. Lowercased, and anything outside [a-z0-9_-] rejects the
  // whole value rather than being stripped out of it: a name with the letters
  // removed is still a leak, and a dropped beacon costs nothing.
  //
  // Deliberately NOT an allowlist of known tabs. A new tab would then be
  // invisible until somebody remembered to register it, which is the failure
  // sectionOf() was written to avoid.
  var SECTION_RE = /^[a-z0-9_-]{1,40}$/;
  function normalizeSection(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toLowerCase();
    return SECTION_RE.test(s) ? s : null;
  }

  // An OPEN beacon's entity type and id.
  //
  // Same reasoning as normalizeSection: these come from the BROWSER, so they
  // are the second thing in this table the client can influence. A type is a
  // short slug and an id is an id; anything else rejects the whole value
  // rather than being stripped, because a resident name with the letters
  // removed is still a leak and a dropped beacon costs nothing.
  var ENTITY_TYPE_RE = /^[a-z0-9_-]{1,40}$/;
  function normalizeEntityType(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toLowerCase();
    return ENTITY_TYPE_RE.test(s) ? s : null;
  }
  function normalizeEntityId(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    return ID_RE.test(s) ? s.slice(0, 120) : null;
  }

  // The property a beacon claims.
  //
  // CHECKED AGAINST THE REAL LIST, not sanitised into shape. property_name is
  // the one column where a free-text value would look completely normal —
  // "Hyde Park Square" and "Maria Gonzalez, unit 112" are both just strings —
  // so a pattern test would not protect it. The caller injects the names that
  // exist and anything else is dropped.
  //
  // Matched case-insensitively and returned in the stored spelling, so the
  // column stays joinable.
  function normalizeProperty(raw, allowed) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toLowerCase();
    if (!s) return null;
    var list = allowed || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).trim().toLowerCase() === s) return list[i];
    }
    return null;
  }

  // ---- collapsing a sync burst ------------------------------------------
  //
  // One click on the Command Center's sync fires SEVEN separate endpoints —
  // /api/maintenance/sync plus six under /sync/<what> — and each was logged as
  // its own write. Erick's "36 actions in Maintenance" was that: five rows
  // sharing the timestamp 14:43:16, four sharing 14:43:26. The number counted
  // requests, not things he did.
  //
  // So a sync row gets ONE canonical label and the burst collapses to one row.
  // Only sync rows: collapsing writes in general would hide somebody marking
  // five tasks done, which is five things they did.
  //
  // The window is two minutes because the observed burst spanned thirty
  // seconds and the endpoints are rate-limited against AppFolio; a second
  // deliberate sync three minutes later is a second row, which is correct.
  var SYNC_LABEL = 'Synced from AppFolio';
  var COLLAPSE_MS = 120000;

  function isSync(row) {
    return !!row && row.entity_type === 'sync';
  }

  // What makes two sync rows "the same burst": the same person, in the same
  // section. Not the label — the seven endpoints carry seven different ones,
  // and collapsing them is the entire point.
  function collapseKey(row) {
    return String(row.user_email || '') + '|' + String(row.section || '');
  }

  // The 30-minute bucket a view falls in, as an ISO string. Phase 2 uses it;
  // it lives here so both phases round the same way.
  function viewBucket(date) {
    var d = new Date(date);
    if (isNaN(d.getTime())) return null;
    d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    return d.toISOString();
  }

  /**
   * @param {function(rows): Promise} flush  writes a batch; may reject
   * @param {object} opts  { maxRows, flushMs, onError, setInterval, now }
   */
  function createLogger(flush, opts) {
    var o = opts || {};
    var maxRows = o.maxRows || MAX_ROWS;
    var flushMs = o.flushMs || FLUSH_MS;
    var onError = o.onError || function () {};
    var queue = [];
    var stats = { queued: 0, written: 0, dropped: 0, failures: 0, collapsed: 0 };
    var inFlight = false;
    // Kept OUTSIDE the queue on purpose: the queue flushes every ten seconds
    // and a burst can straddle a flush, so an in-queue check would miss half
    // of it. Bounded for the same reason the queue is.
    var lastSync = new Map();
    var now = o.now || function () { return Date.now(); };

    function drain() {
      if (inFlight || !queue.length) return;
      inFlight = true;
      var batch = queue;
      queue = [];                      // taken off the queue BEFORE the write,
                                       // so a slow write cannot block new rows
      var p;
      try { p = flush(batch); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () {
        stats.written += batch.length;
      }, function (err) {
        // Dropped, not requeued. Requeuing a failing batch is how a queue
        // grows without bound while the thing it writes to stays down.
        stats.dropped += batch.length;
        stats.failures++;
        try { onError(err, batch.length); } catch (e2) { /* nothing left to do */ }
      }).then(function () { inFlight = false; });
    }

    var timer = (o.setInterval || setInterval)(drain, flushMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // never hold the process open

    return {
      /** Synchronous, returns nothing, cannot throw. */
      log: function (row) {
        try {
          var c = clean(row);
          if (!c) return;
          if (isSync(c)) {
            // One label for all seven endpoints, then one row per burst.
            c.action = SYNC_LABEL;
            var k = collapseKey(c);
            var t = now();
            var prev = lastSync.get(k);
            if (prev !== undefined && t - prev < COLLAPSE_MS) {
              lastSync.set(k, prev);   // the burst keeps the FIRST timestamp,
              stats.collapsed++;       // so a long one cannot extend itself
              return;
            }
            lastSync.set(k, t);
            if (lastSync.size > 200) {
              // Oldest first. A map that only grows is the same bug as an
              // unbounded queue, just slower.
              var cutoff = t - COLLAPSE_MS;
              lastSync.forEach(function (v, kk) { if (v < cutoff) lastSync.delete(kk); });
            }
          }
          if (queue.length >= maxRows) {
            // Drop the OLDEST. The newest rows are the ones somebody is about
            // to ask about.
            queue.shift();
            stats.dropped++;
          }
          queue.push(c);
          stats.queued++;
          if (queue.length >= maxRows) drain();
        } catch (e) { /* logging must never reach the caller */ }
      },
      flushNow: drain,
      stats: function () { return Object.assign({ pending: queue.length }, stats); },
      stop: function () { if (timer && timer.unref) clearInterval(timer); },
    };
  }

  return {
    createLogger: createLogger,
    sectionOf: sectionOf,
    resourceOf: resourceOf,
    viewBucket: viewBucket,
    SYNC_LABEL: SYNC_LABEL,
    COLLAPSE_MS: COLLAPSE_MS,
    isSync: isSync,
    collapseKey: collapseKey,
    normalizeSection: normalizeSection,
    normalizeEntityType: normalizeEntityType,
    normalizeEntityId: normalizeEntityId,
    normalizeProperty: normalizeProperty,
    SECTION_RE: SECTION_RE,
    clean: clean,
    ALLOWED: ALLOWED,
    FORBIDDEN: FORBIDDEN,
    MAX_ROWS: MAX_ROWS,
    FLUSH_MS: FLUSH_MS,
  };
}));
