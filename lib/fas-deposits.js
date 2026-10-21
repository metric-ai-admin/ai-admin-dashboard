// Final Account Statements, measured through the deposit.
//
// Kara approved "deposit settled" as the signal for "FAS sent" on 2026-10-20.
// It is a STAND-IN and the brief says so: a deposit settled on day 14 does not
// prove the statement went out on day 3. What it does prove is that nothing
// has been settled at all after N days, which is the alert she asked for.
//
// Pure: handed today's feed, the stored rows, today and the deadline, it
// returns the counts. No I/O, no clock of its own.

'use strict';

const clean = s => String(s === null || s === undefined ? '' : s).trim();
const ymd = v => clean(v).slice(0, 10);

// Calendar or business days — Kara has not said which, so it is a parameter
// with the safer default. Calendar days is the shorter clock: it calls
// something overdue sooner, which is the direction that gets looked at rather
// than the direction that gets missed.
const DEFAULT_DEADLINE = { days: 15, basis: 'calendar' };

function daysBetween(fromYmd, toYmd, basis) {
  const a = Date.parse(ymd(fromYmd) + 'T00:00:00Z');
  const b = Date.parse(ymd(toYmd) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return null;
  const calendar = Math.round((b - a) / 86400000);
  if (basis !== 'business') return calendar;
  // Whole weeks, then the remainder, counting the days actually worked. The
  // start day is not counted: a move-out on Friday is day 0 on Friday.
  if (calendar <= 0) return calendar;
  let n = 0;
  for (let i = 1; i <= calendar; i++) {
    const d = new Date(a + i * 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

// Has this deposit stopped being held?
//
// NEVER FROM ONE DATE. last_seen_on and gone_first_seen_on bracket it, and the
// width of that bracket is however long passed between the two runs — a day
// normally, three days if the sync did not run for two of them.
function settlement(row) {
  const gone = ymd(row.gone_first_seen_on);
  if (!gone) return null;
  const last = ymd(row.last_seen_on) || gone;
  // spanDays, NOT a boolean called "exact". With the sync running daily the
  // bracket is one day wide and that IS the normal case; calling it "not
  // exact" would make every ordinary settlement look uncertain, and calling
  // it exact would hide the days when the sync did not run.
  const span = daysBetween(last, gone, 'calendar');
  return { from: last, to: gone, spanDays: span === null ? null : span };
}

/**
 * Classify one move-out.
 *
 * Returns a bucket and the facts behind it. The buckets are deliberately five,
 * not three: "we cannot tell" and "we could not place it" are answers, and
 * folding either into a count of good or bad invents a result.
 */
function classify(row, todayYmd, deadline) {
  const d = deadline || DEFAULT_DEADLINE;
  const moveOut = ymd(row.move_out);

  if (!moveOut) return { bucket: 'noMoveOut' };

  // A MOVE-OUT IN THE FUTURE IS NOT A MOVE-OUT. unit_turn_detail and this
  // report both carry scheduled dates, and a scheduled move-out cannot be
  // overdue — the clock has not started. (A probe sorted by this column once
  // reported a move-out "-251 days ago", which is what a negative age is: an
  // error wearing a number.)
  const age = daysBetween(moveOut, todayYmd, d.basis);
  if (age === null) return { bucket: 'noMoveOut' };
  if (age < 0) return { bucket: 'future', moveOut, inDays: -age };

  // No deposit to settle. Kara has not said whether this counts as done; until
  // she does it is its own bucket, because calling it settled would invent a
  // statement nobody sent and calling it overdue would accuse somebody of not
  // sending one that was never owed.
  const amount = Number(row.amount);
  const hasDeposit = isFinite(amount) && Math.abs(amount) > 0;

  const done = settlement(row);
  if (done) {
    // Settled. Days measured to the EARLIER end of the bracket, so a
    // settlement is never reported as later than it might have been.
    const inDays = daysBetween(moveOut, done.from, d.basis);
    return {
      bucket: inDays !== null && inDays <= d.days ? 'settledInTime' : 'settledLate',
      moveOut, days: inDays, settled: done, hasDeposit,
    };
  }

  if (!hasDeposit) return { bucket: 'noDeposit', moveOut, days: age };
  return {
    bucket: age > d.days ? 'overdue' : 'withinWindow',
    moveOut, days: age, deadline: d.days,
  };
}

const EMPTY = () => ({
  settledInTime: 0, settledLate: 0, withinWindow: 0, overdue: 0,
  noDeposit: 0, future: 0, noMoveOut: 0,
  overdueUnits: [], withinUnits: [], noDepositUnits: [],
});

/**
 * Every move-out with a deposit row, grouped by property.
 *
 * @param {object[]} rows   deposit_held rows
 * @param {string} todayYmd
 * @param {object} opts     { deadline, snapshotsStart }
 */
function byProperty(rows, todayYmd, opts) {
  const o = opts || {};
  const deadline = o.deadline || DEFAULT_DEADLINE;
  const out = {};
  const unresolved = EMPTY();
  let unresolvedCount = 0;

  (rows || []).forEach(r => {
    const c = classify(r, todayYmd, deadline);
    // Neither a move-out nor a thing to measure. Counted so the totals add up
    // to the rows we hold, never silently skipped.
    const name = clean(r.property);
    const placed = name && clean(r.property_source) !== 'unresolved';
    const b = placed ? (out[name] = out[name] || EMPTY()) : unresolved;
    if (!placed) unresolvedCount++;

    b[c.bucket] = (b[c.bucket] || 0) + 1;
    const unit = clean(r.unit) || '(no unit)';
    if (c.bucket === 'overdue') b.overdueUnits.push({ unit, days: c.days });
    if (c.bucket === 'withinWindow') b.withinUnits.push({ unit, days: c.days, of: deadline.days });
    if (c.bucket === 'noDeposit') b.noDepositUnits.push({ unit, days: c.days });
  });

  Object.values(out).forEach(b => {
    b.overdueUnits.sort((a, c) => c.days - a.days);
    b.withinUnits.sort((a, c) => c.days - a.days);
  });

  return { properties: out, unresolved, unresolvedCount };
}

/**
 * What the section cannot answer yet, in words.
 *
 * THE COLD START IS THE WHOLE PROBLEM for the first weeks. A deposit settled
 * before the first snapshot left no trace anywhere we can read, so it is in no
 * bucket at all — and "3 settled in time" computed over two days of history
 * reads exactly like one computed over a year.
 *
 * Overdue, by contrast, works from the first run: the deposit is still in the
 * list and the move-out was N days ago, which needs no history at all.
 */
function caveats(opts) {
  const o = opts || {};
  const L = [];
  L.push('"Deposit settled" stands in for "FAS sent" — approved by Kara 2026-10-20. '
    + 'A deposit settled on day 14 does not prove the statement went out on day 3.');
  if (o.snapshotsStart) {
    L.push('Snapshots start ' + ymd(o.snapshotsStart) + '. A deposit settled before that '
      + 'has no date and is in none of the counts above. OVERDUE is complete from day '
      + 'one — it needs no history — but "settled within the deadline" only becomes '
      + 'meaningful after a few weeks of snapshots.');
  }
  const runs = o.runs || {};
  if (runs.missedDays) {
    L.push(runs.missedDays + ' day(s) since ' + ymd(o.snapshotsStart) + ' have no snapshot, '
      + 'so a settlement on one of them is dated to the next run that did happen.');
  }
  if (runs.lastStatus && runs.lastStatus !== 'ok') {
    L.push('THE LAST SNAPSHOT WAS NOT USED (' + runs.lastStatus + '). Nothing was settled '
      + 'from it, so these counts are as of the last good run'
      + (runs.lastGoodOn ? ' on ' + ymd(runs.lastGoodOn) : '') + '.');
  }
  return L;
}

/**
 * Is this feed safe to settle from?
 *
 * A run that returns nothing settles everything. The guard is a fraction of
 * the previous good count, and it refuses rather than guessing: a day not
 * measured costs a day, and a day of false settlements costs the alert.
 */
function feedGuard(rowsReturned, previousRows, maxDropPct) {
  const limit = typeof maxDropPct === 'number' ? maxDropPct : 20;
  // NOT Number(x) ALONE. Number(null) is 0 and Number('') is 0, so a fetch
  // that never came back arrived here as "the feed returned zero rows" and was
  // reported as a suspect feed rather than as a failure. They are different
  // facts: one means AppFolio answered oddly, the other that it did not answer.
  const missing = rowsReturned === null || rowsReturned === undefined
    || String(rowsReturned).trim() === '';
  const n = missing ? NaN : Number(rowsReturned);
  if (!isFinite(n)) return { ok: false, status: 'failed', dropPct: null, reason: 'no row count' };
  const prev = Number(previousRows);
  // Nothing to compare against — the first run ever. It establishes the
  // baseline and settles nothing, because everything is "new" to it.
  if (!isFinite(prev) || prev <= 0) {
    return { ok: true, status: 'ok', first: true, dropPct: null, reason: null };
  }
  const dropPct = ((prev - n) / prev) * 100;
  if (dropPct > limit) {
    return {
      ok: false,
      status: 'suspect',
      dropPct: Math.round(dropPct * 10) / 10,
      reason: 'the feed returned ' + n + ' rows against ' + prev + ' — a '
        + Math.round(dropPct) + '% fall. Nothing was settled: a feed that comes '
        + 'back short settles every deposit missing from it.',
    };
  }
  return { ok: true, status: 'ok', dropPct: Math.round(dropPct * 10) / 10, reason: null };
}

// Counts by tenant_status, so "does this include current residents?" is on the
// record. Counts only — the report carries residents and units.
function statusCounts(feedRows) {
  const out = {};
  (feedRows || []).forEach(r => {
    const k = clean(r.tenant_status) || '(blank)';
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

// What of this report reaches the disk.
//
// DROP FIRST AND DROP WINS, the shape lib/tenant-directory.js and
// lib/safe-print.js both use: the dangerous answer must not depend on a keep
// list staying complete. A column nobody has seen yet that looks like a name
// or an email is dropped without anybody editing this file.
//
// tenant-directory's own projection CANNOT be reused here, and the reason is
// worth writing down: its drop list includes /amount|deposit/, because the
// directory's copy of a balance is a stale second answer. Here the deposit
// amount is the measurement. The same word, opposite decision, two reports.
const FEED_DROP = [
  /name/i,                       // tenant_name, co_tenant_name, anything _name
  /e[-_\s]*mail/i,
  /phone|mobile|cell/i,
  /ssn|social[_\s-]*security|tax[_\s-]*id/i,
  /date[_\s-]*of[_\s-]*birth|birth[_\s-]*date/i,
  /emergency/i,
  /address|street/i,
];

// property_name is dropped by /name/ above and that is correct: this report
// does not carry one, and if a future column appeared we would still resolve
// the property through occupancy_id rather than trusting a new column nobody
// has looked at.
function projectFeedRow(row) {
  const out = {};
  Object.keys(row || {}).forEach(k => {
    if (FEED_DROP.some(re => re.test(k))) return;
    out[k] = row[k];
  });
  return out;
}

module.exports = {
  DEFAULT_DEADLINE, FEED_DROP, projectFeedRow,
  daysBetween, settlement, classify, byProperty, caveats, feedGuard, statusCounts,
  EMPTY,
};
