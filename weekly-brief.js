// =====================================================================
// Monday Morning Brief — what is happening this week, in one digest.
//
// Pure functions, no I/O, same as vacancy-rules.js / regional-performance.js.
// Everything here reads data that is already synced; no AppFolio calls.
//
// SOURCES AND WHAT EACH ONE ACTUALLY CONTAINS — checked live 2026-09-23,
// because three of the four sections do not come from where you would guess:
//
//   leasing_lease_history   move-ins. Runs FORWARD (to 2026-11-10 today), so
//                           scheduled move-ins are real. Carries no unit
//                           number, which is why move-ins are enriched from
//                           the tickler below where the two agree.
//   tenant_tickler          an EVENT LOG for the current month, not a
//                           schedule: 51 rows spanning 09-01..09-21, typed
//                           Move-in / Move-out / Notice. A Move-out row is a
//                           move-out that already HAPPENED. The forward-
//                           looking part is the `move_out_date` field, which
//                           Notice rows carry ahead of the event.
//   unit_vacancy            for Notice-* units, `last_move_out` is the
//                           SCHEDULED move-out date, weeks or months ahead
//                           (e.g. 2027-01-14). This is the better forward
//                           source and is merged with the tickler, deduped on
//                           unit, so a move-out on notice but not yet ticklered
//                           still shows.
//   leasing_showings        tours. Holds future rows and a status per row, so
//                           cancellations can be dropped.
//
//   rent_roll               lease expirations. One row per lease, every unit
//                           (438 today), so this is the complete set.
//   lease_expiration_detail  the renewal pipeline — Eligible / Pending /
//                           Renewed / Not Eligible. It omits units already on
//                           notice, so it is joined onto rent_roll for the
//                           status and never used to filter.
//
// =====================================================================

const iso = s => {
  const v = String(s == null ? '' : s).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '';
};

const clean = s => String(s == null ? '' : s).trim();

// The tickler gives "Mobile: (512) 775-4262, Mobile: (505) 545-7629". Only the
// first number is useful in a digest; the rest is noise at this density.
const firstPhone = s => {
  const m = String(s || '').match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0] : '';
};

const between = (d, a, b) => !!d && d >= a && d <= b;

const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

// Monday of the week containing `today`, and the Sunday that closes it.
function weekOf(today) {
  const d = new Date(today + 'T00:00:00');
  const start = addDays(today, -((d.getDay() + 6) % 7));
  return { start, end: addDays(start, 6) };
}

// Two properties are the same property if their names match once case and
// surrounding space are taken out. property_id is present on most sources but
// not all, so the name is the one key every source shares.
const propKey = s => clean(s).toLowerCase();

// A tour that was called off is not something to prepare for.
const DEAD_SHOWING = /cancel|no show/i;

/**
 * @param {object} src
 *   leaseHistory[]  leasing_lease_history rows
 *   tickler[]       tenant_tickler report rows
 *   vacancy[]       unit_vacancy report rows
 *   showings[]      leasing_showings rows
 *   rentRoll[]      rent_roll report rows
 *   leaseExpirations[]  lease_expiration_detail rows (renewal status only)
 * @param {object} opts
 *   today               YYYY-MM-DD, Central
 *   isExcludedProperty  injected, so server.js keeps the single exclusion list
 *   expiryDays          horizon for section 4 (default 30)
 */
function buildWeeklyBrief(src = {}, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const { start, end } = weekOf(today);
  const horizon = addDays(today, opts.expiryDays == null ? 30 : opts.expiryDays);
  const isExcluded = opts.isExcludedProperty || (() => false);
  const keep = name => clean(name) && !isExcluded(name);

  const tickler = src.tickler || [];
  const vacancy = src.vacancy || [];

  // ---- 1. Move-ins ---------------------------------------------------------
  // lease_history is the source of record for the date; the tickler supplies
  // the unit number it lacks. Matched on property + tenant + the same date,
  // so a coincidence of name alone never invents a unit.
  const ticklerUnits = new Map();
  tickler.forEach(r => {
    const d = iso(r.move_in_date);
    if (d) ticklerUnits.set(`${propKey(r.property_name)}|${propKey(r.tenant)}|${d}`, clean(r.unit));
  });

  const moveIns = (src.leaseHistory || [])
    .filter(r => keep(r.property_name) && between(iso(r.move_in_date), start, end))
    .map(r => ({
      tenant: clean(r.tenant_name) || '—',
      unit: ticklerUnits.get(`${propKey(r.property_name)}|${propKey(r.tenant_name)}|${iso(r.move_in_date)}`) || '',
      property: clean(r.property_name),
      date: iso(r.move_in_date),
      renewal: clean(r.renewal) === 'Yes',
      status: clean(r.status),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.property.localeCompare(b.property));

  // ---- 2. Move-outs --------------------------------------------------------
  // Union of the two sources, deduped on property+unit. The tickler is listed
  // first so its resident name wins — unit_vacancy carries no tenant.
  const outSeen = new Map();
  const addOut = row => {
    const k = `${propKey(row.property)}|${propKey(row.unit)}`;
    if (!outSeen.has(k)) outSeen.set(k, row);
    else if (!outSeen.get(k).tenant && row.tenant) outSeen.set(k, { ...outSeen.get(k), tenant: row.tenant });
  };

  tickler.forEach(r => {
    const d = iso(r.move_out_date);
    if (!keep(r.property_name) || !between(d, start, end)) return;
    addOut({
      tenant: clean(r.tenant) || '—',
      unit: clean(r.unit),
      property: clean(r.property_name),
      date: d,
      phone: firstPhone(r.tenant_phone_number),
      reason: clean(r.move_out_reason),
      source: 'tickler',
    });
  });

  vacancy.forEach(r => {
    if (!/notice/i.test(clean(r.unit_status))) return;
    const d = iso(r.last_move_out);
    if (!keep(r.property_name) || !between(d, start, end)) return;
    addOut({
      tenant: '', unit: clean(r.unit), property: clean(r.property_name),
      date: d, phone: '', reason: '',
      rented: /rented/i.test(clean(r.unit_status)) && !/unrented/i.test(clean(r.unit_status)),
      source: 'vacancy',
    });
  });

  const moveOuts = [...outSeen.values()]
    .map(r => ({ ...r, tenant: r.tenant || '—' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.property.localeCompare(b.property));

  // ---- 3. Tours ------------------------------------------------------------
  const tours = (src.showings || [])
    .filter(r => keep(r.property_name) && between(iso(r.showing_date), start, end)
      && !DEAD_SHOWING.test(clean(r.status)))
    .map(r => ({
      property: clean(r.property_name),
      unit: clean(r.unit),
      prospect: clean(r.prospect) || '—',
      date: iso(r.showing_date),
      status: clean(r.status),
      type: clean(r.type),
      past: iso(r.showing_date) < today,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.property.localeCompare(b.property));

  // ---- 4. Lease expirations, next 30 days ----------------------------------
  // rent_roll is the complete set: one row per lease, every unit. The renewal
  // status lives in a different report, so lease_expiration_detail is joined on
  // unit + date — and only joined, never used to filter, because it leaves out
  // units already on notice and those still have to appear here.
  const renewalBy = new Map();
  (src.leaseExpirations || []).forEach(r => {
    const d = iso(r.lease_expires);
    if (d) renewalBy.set(`${r.unit_id}|${d}`, clean(r.status));
  });

  const expSeen = new Set();
  const expirations = (src.rentRoll || [])
    .filter(r => keep(r.property_name) && between(iso(r.lease_to), today, horizon))
    .filter(r => {
      const k = `${r.unit_id}|${iso(r.lease_to)}`;
      if (expSeen.has(k)) return false;
      expSeen.add(k);
      return true;
    })
    .map(r => {
      const date = iso(r.lease_to);
      // rent_roll's status is the UNIT's state — "Notice-Unrented",
      // "Notice-Rented", "Current". A resident on notice is not a renewal
      // conversation, so that fact outranks whatever the pipeline says.
      const onNotice = /notice/i.test(clean(r.status));
      return {
        tenant: clean(r.tenant) || '—',
        unit: clean(r.unit),
        property: clean(r.property_name),
        date,
        status: clean(r.status),
        onNotice,
        // Empty when the lease is absent from the renewal pipeline for a reason
        // other than notice; the UI shows that as "not recorded" rather than
        // inventing a status.
        renewalStatus: onNotice ? '' : (renewalBy.get(`${r.unit_id}|${date}`) || ''),
        // Roommates on the same lease, so a call is not made to the wrong name.
        alsoOnLease: clean(r.additional_tenants),
        rent: clean(r.rent),
        daysOut: Math.round((new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.property.localeCompare(b.property));

  return {
    week: { start, end, today },
    horizon: { end: horizon, days: opts.expiryDays == null ? 30 : opts.expiryDays },
    moveIns, moveOuts, tours, expirations,
    counts: {
      moveIns: moveIns.length, moveOuts: moveOuts.length,
      tours: tours.length, expirations: expirations.length,
    },
  };
}

module.exports = { buildWeeklyBrief, weekOf, addDays, firstPhone, DEAD_SHOWING };
