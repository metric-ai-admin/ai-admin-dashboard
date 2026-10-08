// Reading a whole table out of Supabase.
//
// PostgREST answers with at most 1000 rows. `.limit(50000)` does not raise that
// ceiling — it only promises not to ask for more — so the query succeeds,
// returns 1000 rows, and reports no error. The number that comes back is
// plausible. Nothing looks wrong.
//
// It has now bitten this codebase three times: the SOP list, the KPI report
// (closedThisWeek 61 against Katie's 76, every missing row sitting in the
// table), and the Command Center's closure sources. The common shape is always
// a table that crossed 1000 rows long after the query that reads it was
// written.
//
// So: never `.limit(big)`. Page.
//
//   const rows = await selectAll(() =>
//     db.from('maintenance_work_orders').select('work_order_number,status'));
//
// The argument is a FACTORY, not a query. A PostgREST builder can only be
// awaited once, so each page needs a fresh one; passing a builder would read
// page zero three times and look like it worked.

const PAGE = 1000;

// Reads every row the query matches, a page at a time, until a short page says
// there are no more.
//
// `max` is a circuit breaker, not a limit: a query that would return more than
// this THROWS rather than quietly returning a prefix, because a silent prefix
// is the exact failure this function exists to prevent. Raise it deliberately
// for a table that is genuinely that big.
async function selectAll(makeQuery, opts) {
  const o = opts || {};
  const page = o.page || PAGE;
  const max = o.max || 200000;
  const label = o.label || '';
  const out = [];
  for (let from = 0; ; from += page) {
    if (from >= max) {
      throw new Error('selectAll' + (label ? ' (' + label + ')' : '') +
        ' passed ' + max + ' rows — raise `max` if the table really is this big.');
    }
    const { data, error } = await makeQuery().range(from, from + page - 1);
    if (error) {
      const e = new Error(error.message);
      e.code = error.code; e.details = error.details; e.hint = error.hint;
      throw e;
    }
    const got = data || [];
    for (const r of got) out.push(r);
    // A short page is the end. Testing `length < page` rather than `=== 0`
    // saves the extra round trip on an exact multiple only costing one more
    // request in the rare case it IS an exact multiple.
    if (got.length < page) break;
  }
  return out;
}

// Same, but returns { data, error } so it can drop into a call site that
// already branches on `error` instead of catching.
async function selectAllResult(makeQuery, opts) {
  try {
    return { data: await selectAll(makeQuery, opts), error: null };
  } catch (e) {
    return { data: null, error: { message: e.message, code: e.code, details: e.details, hint: e.hint } };
  }
}

module.exports = { selectAll, selectAllResult, PAGE };
