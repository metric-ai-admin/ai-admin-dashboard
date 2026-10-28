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

// KARA CONFIRMED THIS ON 2026-10-28: five BUSINESS days from the move-out for
// the Final Account Statement.
//
// It is the default rather than an environment variable because it is now a
// decided rule, and a rule that lives in config is a rule that silently
// reverts the first time somebody deploys somewhere the variable is not set.
// readDeadline still honours an override, so a future change needs no deploy.
const DEFAULT_DEADLINE = { days: 5, basis: 'business' };

// THE TWO CLOCKS ARE NOT TWO READINGS OF ONE RULE, which is how this file
// described them while the question was open. Kara's answer was that both are
// real and they measure different things:
//
//   5 business days   the STATEMENT must be sent      <- what this alert is
//   15 calendar days  the REFUND must be issued       <- a different deadline
//
// So the second is no longer offered as an alternative the same move-outs
// could be sorted under. It is named in the caveat so a reader who knows the
// 15 does not think the section is using the wrong number.
const REFUND_DEADLINE = { days: 15, basis: 'calendar',
  source: 'Kara 2026-10-14, confirmed 2026-10-28 — the refund, not the statement' };

// Kept for the unconfirmed path: a deadline that came from somewhere other
// than Kara's answer still prints what she actually said beside it.
const DEADLINE_CANDIDATES = [
  { days: 5, basis: 'business', source: 'Kara, confirmed 2026-10-28, for the statement' },
  { days: 15, basis: 'calendar', source: 'Kara 2026-10-14, for the refund' },
];

const sameDeadline = (a, b) => !!a && !!b
  && Number(a.days) === Number(b.days) && String(a.basis) === String(b.basis);

// A deadline from anywhere — a flag, an environment variable, a default —
// normalised, so a typo becomes the default rather than NaN days.
function readDeadline(days, basis, fallback) {
  const f = fallback || DEFAULT_DEADLINE;
  const n = Number(days);
  const b = String(basis || '').trim().toLowerCase();
  return {
    days: isFinite(n) && n > 0 ? Math.floor(n) : f.days,
    basis: b === 'business' || b === 'calendar' ? b : f.basis,
  };
}

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

  // No deposit to settle. KARA ANSWERED THIS ON 2026-10-28: these stay in the
  // alert, because the statement is still owed — the charges go to
  // collections. So it keeps its own bucket rather than being folded into
  // overdue: there is no deposit whose settlement could ever clear it, so the
  // deposit signal cannot answer for it either way, and counting it as overdue
  // would put a number on a clock this data cannot read.
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
  // THE CLOCK, AND THE ONE IT IS NOT. Until Kara confirms, the same rows
  // produce two different answers and the reader has to know which they are
  // looking at.
  const d = o.deadline || DEFAULT_DEADLINE;
  L.push('Deadline used: ' + d.days + ' ' + d.basis + ' days from move-out'
    + (o.deadlineUnconfirmed ? '.' : ', confirmed by Kara on 2026-10-28.'));
  if (!o.deadlineUnconfirmed) {
    // SAY THE OTHER NUMBER OUT LOUD. Kara named 15 as well, and a reader who
    // remembers that and sees a 5 here will reasonably wonder whether the
    // section is using the wrong rule. They are two deadlines, not two
    // readings of one.
    L.push('The ' + REFUND_DEADLINE.days + ' ' + REFUND_DEADLINE.basis
      + ' days is the REFUND deadline and is not what this section measures. '
      + 'A move-out can be inside that one and overdue here.');
  }
  if (o.deadlineUnconfirmed) {
    const other = DEADLINE_CANDIDATES.filter(c => !sameDeadline(c, d));
    // NAME THE ONE IN FORCE, not its position in a list. "the first of those
    // two" was wrong the moment the default was the second one, and a caveat
    // that misreports which clock it used is worse than no caveat.
    L.push('NOT CONFIRMED YET. Kara named ' + DEADLINE_CANDIDATES
      .map(c => c.days + ' ' + c.basis + ' (' + c.source + ')').join(' and ')
      + '. These counts use ' + d.days + ' ' + d.basis
      + (other.length ? '; under ' + other.map(c => c.days + ' ' + c.basis).join(' or ')
        + ' the same move-outs sort differently' : '') + '.');
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

/**
 * THE GUARD THE PERCENTAGE CANNOT BE. Did a whole tenant_status disappear?
 *
 * feedGuard() measures the total and trips at a 20% fall. On 2026-10-27 the
 * deposit feed gained tenant_statuses and went 216 -> 258. That is safe going
 * up. Going back down is NOT: losing the parameter again takes 258 -> 216, a
 * 16.3% fall, which passes a 20% threshold and settles 42 deposits in one
 * morning. The fix moved the most likely failure INTO the blind spot.
 *
 * So this looks at the shape instead of the size. A status that had rows in
 * the last good run and returns none today is not a quiet day for that
 * category — it is the category no longer being asked for.
 *
 * WHY ZERO AND NOT A PERCENTAGE: statuses here are small (Evict 7, Notice 4)
 * and genuinely bounce. Seven becoming three is a Tuesday; seven becoming
 * none, on the same day Past also becomes none, is a parameter. Zero is the
 * only threshold that is about the mechanism rather than about the weather.
 *
 * @param {object} today     statusCounts of the feed now
 * @param {object} previous  status_counts stored with the last good run
 * @returns {{ok:boolean, vanished:string[], reason:(string|null)}}
 */
function compositionGuard(today, previous) {
  const prev = previous && typeof previous === 'object' ? previous : null;
  // Nothing to compare against: the first run, or a run recorded before
  // status_counts existed. It cannot be evidence of anything either way.
  if (!prev || !Object.keys(prev).length) {
    return { ok: true, vanished: [], reason: null };
  }
  const now = today && typeof today === 'object' ? today : {};
  const vanished = Object.keys(prev)
    .filter(k => Number(prev[k]) > 0 && !(Number(now[k]) > 0))
    .sort();
  if (!vanished.length) return { ok: true, vanished: [], reason: null };
  return {
    ok: false,
    vanished,
    reason: vanished.map(k => k + ' (' + prev[k] + ' last time, none now)').join(', ')
      + ' — a whole tenant status stopped coming back. That is what a dropped '
      + 'tenant_statuses parameter looks like, and it settles every deposit in '
      + 'those statuses. Nothing was settled.',
  };
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
  DEFAULT_DEADLINE, REFUND_DEADLINE, DEADLINE_CANDIDATES, readDeadline, sameDeadline,
  FEED_DROP, projectFeedRow,
  daysBetween, settlement, classify, byProperty, caveats, feedGuard, compositionGuard, statusCounts,
  EMPTY,
};
