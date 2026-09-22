// =====================================================================
// Collections Decision Queue — escalation rules.
//
// Bekah (Regional Director) oversees collections but should not have to read
// every account. This decides which ones need HER decision rather than
// something Karla or Rocío handles alone.
//
// Pure functions, no I/O. Same reasoning as vacancy-rules.js: this is
// deterministic filtering over eviction-adjacent data, so it lives in code
// where it can be unit-tested rather than described to a model.
//
// DATA SOURCE — the delinquency_as_of report, verified against 72 live rows on
// 2026-09-22.
//
//     00_to30 / 30_to60 / 60_to90 / 90_plus — aging buckets. "90+ days
//     delinquent" is 90_plus > 0; there is no days-delinquent field.
//     Buckets go NEGATIVE when an account holds a credit (live data had
//     -33.56 and -250.00), which is why every threshold is "> 0", not "!= 0".
//
// THE TRAP, worth recording because it nearly shipped: this_month / last_month
// / month_before_last look like month-over-month balance history. They are not.
// They are aging by CHARGE PERIOD — this_month equalled the 00_to30 bucket in
// 70 of 72 rows, and the three sum to amount_receivable in 61 of 72. So
// "last_month = 0" means "nothing still owed from last month's charges", i.e.
// the resident is current apart from this month. That is the OPPOSITE of a
// warning sign, and 63 of 72 accounts had it — reading them as history flagged
// 63 of 65 accounts as needing the Regional Director's attention.
//
// Real month-over-month comparison needs separate as-of snapshots, the same way
// /api/collections/generate pulls today and a month ago. The caller supplies
// them via opts.priorBalances; without them the two history triggers DO NOT
// EVALUATE rather than defaulting to zero and firing on everyone.
// =====================================================================

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// AppFolio's tenant_status on this report returned only "Current" and "Notice"
// across all 72 live rows. "Eviction" is handled because the eviction workflow
// may set it, but nothing in this data source has produced it yet — see
// TRIGGER_READY_TO_FILE below.
function statusLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown';
  const l = s.toLowerCase();
  if (/evict/.test(l)) return 'Eviction';
  if (/notice/.test(l)) return 'Notice';
  if (/current|active/.test(l)) return 'Current';
  return s;
}

// Identity across snapshots. occupancy_id is stable per tenancy; the composite
// is the fallback for rows that lack it.
const accountKey = a => String(a.occupancyId || `${a.property}|${a.unit}|${a.name}`).toLowerCase();

const BIG_BALANCE = 1500;

// A brand-new delinquency only reaches the Regional Director if it is material.
// Without a floor this trigger fires on every resident who is simply late with
// this month's rent — which is Karla's daily work by definition, and would put
// most of the portfolio on a queue whose whole value is being short. 500 is a
// judgment call, not something Bekah specified: confirm it with her and change
// it here.
const NEW_DELINQUENCY_FLOOR = 500;

// Every trigger is a named predicate so the card can say WHICH one fired, and
// so each is independently testable. `reason` is what Bekah reads.
const TRIGGERS = [
  {
    id: 'big_balance_at_risk',
    label: 'Large balance, at risk',
    test: a => a.balance > BIG_BALANCE && (a.status === 'Eviction' || a.status === 'Notice'),
    reason: a => `$${Math.round(a.balance).toLocaleString()} owed and the resident is on ${a.status}`,
  },
  {
    id: 'rising_two_months',
    // Strictly rising across three as-of snapshots. needsHistory: skipped
    // entirely when the caller could not supply prior months, so a failed pull
    // produces a short queue rather than a wrong one.
    needsHistory: true,
    test: a => a.monthBeforeLastBalance < a.lastMonthBalance && a.lastMonthBalance < a.balance,
    label: 'Growing two months running',
    reason: a => `Balance rose two months running: $${Math.round(a.monthBeforeLastBalance)} → $${Math.round(a.lastMonthBalance)} → $${Math.round(a.balance)}`,
  },
  {
    id: 'aged_90',
    // Requires an overall balance too. Live data had an account with $450 sitting
    // in the 90+ bucket but a $0 total balance — an old charge offset by a credit
    // elsewhere. They are not delinquent, and a card for them is noise on a queue
    // whose whole purpose is to be short.
    test: a => a.aged90Plus > 0 && a.balance > 0,
    label: '90+ days delinquent',
    reason: a => `$${Math.round(a.aged90Plus).toLocaleString()} has been outstanding 90+ days`,
  },
  {
    id: 'new_delinquency',
    // Owed nothing a month ago, owes something now. Compares two as-of
    // snapshots, NOT the this_month/last_month aging columns.
    needsHistory: true,
    test: a => a.lastMonthBalance <= 0 && a.balance > NEW_DELINQUENCY_FLOOR,
    label: 'New this cycle',
    reason: a => `Owed nothing a month ago, now $${Math.round(a.balance).toLocaleString()}`,
  },
  {
    // NOT FIRING TODAY, deliberately kept.
    //
    // The requested trigger was eviction status = "Ready to File" or similar.
    // delinquency_as_of returns NO eviction-status column: checked all 37
    // columns on 2026-09-22 and nothing matches /evict/. server.js's map lists
    // 'Eviction Status' among the fields the endpoint does not return, and the
    // live data agrees. The Eviction Tracker's own `stage` is no better — for
    // API syncs it falls back to 'BALANCE_ONLY' for every row.
    //
    // Left in place reading an optional field so that the day the data appears
    // — a new column, or the tracker carrying real stages — this lights up
    // without anyone having to remember it was missing.
    id: 'ready_to_file',
    test: a => /ready\s*to\s*file|ready\s*for\s*filing/i.test(a.evictionStatus || ''),
    label: 'Ready to file',
    reason: a => `Eviction status is "${a.evictionStatus}"`,
  },
];

/**
 * Normalise one delinquency_as_of row into the shape the triggers read.
 * Keeping the mapping in one place means a column rename breaks in exactly one
 * spot rather than inside five predicates.
 */
function shapeAccount(row) {
  return {
    unitId: row.unit_id ?? null,
    occupancyId: row.occupancy_id ?? null,
    name: row.name || '',
    unit: row.unit || '',
    property: row.property_name || row.property || '',
    status: statusLabel(row.tenant_status),
    balance: num(row.delinquent_rent),
    receivable: num(row.amount_receivable),
    // Aging by charge period — NOT balance history. See the header note.
    agedThisPeriod: num(row.this_month),
    agedLastPeriod: num(row.last_month),
    agedPriorPeriod: num(row.month_before_last),
    aged90Plus: num(row['90_plus']),
    aged60to90: num(row['60_to90']),
    aged30to60: num(row['30_to60']),
    // Not in this report today — see the ready_to_file trigger.
    evictionStatus: row.eviction_status || row['Eviction Status'] || '',
    notes: row.delinquency_notes || '',
    phones: String(row.phone_numbers || ''),
    moveOut: row.move_out || null,
  };
}

// AppFolio returns every number on the account in one string, labelled and
// comma-separated: "Phone: (512) 673-9783, Mobile: (737) 393-1285". Verified
// 2026-09-22 against 72 live rows — 100% populated, 71 of 72 already in
// (512) 555-1234 form, labels Mobile (56), Phone (27), Office (1). Most
// residents have one number; 10 of 72 have two or three.
//
// Mobile first, because this feeds collections calls and a mobile is the one
// likely to be answered. Office last for the same reason.
const PHONE_LABEL_PRIORITY = ['mobile', 'cell', 'phone', 'home', 'office'];

/**
 * The one number to call, from AppFolio's combined phone string.
 * @returns {{label, display, tel}|null} display is "(512) 555-1234";
 *          tel is "+15125551234" for a tel: href.
 */
function primaryPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const found = [];
  // Split on commas, but only those separating entries — a number never
  // contains one. Each entry is "Label: number" or a bare number.
  for (const part of s.split(',')) {
    const m = part.match(/^\s*([A-Za-z ]+)\s*:\s*(.+)$/);
    const label = m ? m[1].trim().toLowerCase() : '';
    const digits = String(m ? m[2] : part).replace(/\D/g, '');
    if (digits.length < 10) continue;
    // Drop a leading country code: "+1 (512) 507-4916" -> 5125074916.
    const ten = digits.slice(-10);
    found.push({ label, ten });
  }
  if (!found.length) return null;
  found.sort((a, b) => {
    const ia = PHONE_LABEL_PRIORITY.indexOf(a.label);
    const ib = PHONE_LABEL_PRIORITY.indexOf(b.label);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const best = found[0];
  return {
    label: best.label ? best.label.charAt(0).toUpperCase() + best.label.slice(1) : '',
    display: `(${best.ten.slice(0, 3)}) ${best.ten.slice(3, 6)}-${best.ten.slice(6)}`,
    tel: '+1' + best.ten,
  };
}

/** Digits of every phone on the account, last 10, for matching call records. */
function phoneDigits(account) {
  const out = new Set();
  for (const m of String(account.phones || '').matchAll(/\d[\d\s().-]{6,}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 10) out.add(d.slice(-10));
  }
  return [...out];
}

/**
 * Build the queue.
 *
 * @param {Array<object>} rows  delinquency_as_of rows
 * @param {object} opts
 * @param {Function} [opts.isExcludedProperty]  injected, so the one exclusion
 *        list in server.js stays the only one (Brazos et al. appear in this
 *        data — verified 2026-09-22).
 * @param {Map<string,string>} [opts.lastInboundByPhone]  last-10-digits -> ISO date
 * @param {Function} [opts.isExternallyManaged]  properties with no SimpleVOIP —
 *        their call history is unknowable, which is different from empty.
 */
function buildDecisionQueue(rows, opts = {}) {
  const isExcludedProperty = opts.isExcludedProperty || (() => false);
  const lastInbound = opts.lastInboundByPhone || new Map();
  // { lastMonth: Map(key->balance), monthBeforeLast: Map(key->balance) }.
  // Absent => the two history triggers are skipped entirely.
  const prior = opts.priorBalances || null;
  const isExternallyManaged = opts.isExternallyManaged || (() => false);
  const hasHistory = !!(prior && prior.lastMonth && prior.monthBeforeLast);

  const queue = [];
  let considered = 0;

  for (const row of rows || []) {
    const account = shapeAccount(row);
    if (isExcludedProperty(account.property)) continue;
    considered++;

    // An account missing from an older snapshot owed nothing then.
    const k = accountKey(account);
    account.lastMonthBalance = hasHistory ? num(prior.lastMonth.get(k) ?? 0) : null;
    account.monthBeforeLastBalance = hasHistory ? num(prior.monthBeforeLast.get(k) ?? 0) : null;

    const fired = TRIGGERS.filter(t => {
      if (t.needsHistory && !hasHistory) return false;
      try { return t.test(account); } catch { return false; }
    });
    if (!fired.length) continue;

    // Properties outside Metric's phone system have no call history to look up.
    // Left null with a flag so the card can say 'no phone system' rather than
    // 'none on record', which would read as nobody having called them.
    const external = isExternallyManaged(account.property);
    let lastContact = null;
    if (!external) {
      for (const p of phoneDigits(account)) {
        const d = lastInbound.get(p);
        if (d && (!lastContact || d > lastContact)) lastContact = d;
      }
    }

    queue.push({
      ...account,
      triggers: fired.map(t => ({ id: t.id, label: t.label, reason: t.reason(account) })),
      // Balance change vs last month, for the card.
      change: hasHistory ? account.balance - account.lastMonthBalance : null,
      phone: primaryPhone(account.phones),
      lastInboundCall: lastContact,
      externallyManaged: external,
    });
  }

  // Highest balance first, then name so the order is stable between loads.
  queue.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));

  return {
    queue,
    stats: {
      inputRows: (rows || []).length,
      hasHistory,
      considered,
      flagged: queue.length,
      eviction: queue.filter(a => a.status === 'Eviction').length,
      notice: queue.filter(a => a.status === 'Notice').length,
      byTrigger: TRIGGERS.reduce((acc, t) => {
        acc[t.id] = queue.filter(a => a.triggers.some(x => x.id === t.id)).length;
        return acc;
      }, {}),
    },
  };
}

module.exports = {
  buildDecisionQueue, shapeAccount, statusLabel, phoneDigits, accountKey, primaryPhone,
  TRIGGERS, BIG_BALANCE, NEW_DELINQUENCY_FLOOR, num,
};
