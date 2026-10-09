const assert = require('assert');
const { selectAll, selectAllResult } = require('../lib/db-page.js');

// A stand-in for a PostgREST builder: holds N rows, answers a .range() with at
// most 1000 of them, and records every range it was asked for.
function fakeTable(n, calls, opts) {
  const o = opts || {};
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  return () => {
    // What the builder was ordered by on this page, recorded so a test can
    // prove the ORDER BY is there. `noOrderColumn` makes it answer the way
    // PostgREST does for a column that does not exist.
    let ordered = null;
    const q = {
      order(col, args) { ordered = [col, !!(args && args.ascending !== false)]; return q; },
      range(from, to) {
        if (o.noOrderColumn && ordered) {
          return Promise.resolve({ data: null, error: {
            message: 'column "' + ordered[0] + '" does not exist', code: '42703' } });
        }
        calls.push({ from, to, ordered });
        const size = Math.min(to - from + 1, 1000);
        return Promise.resolve({ data: rows.slice(from, from + size), error: null });
      },
    };
    return q;
  };
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

(async () => {
  console.log('db-page');

  await ta('a table under the ceiling comes back whole in one request', async () => {
    const calls = [];
    const rows = await selectAll(fakeTable(42, calls));
    assert.strictEqual(rows.length, 42);
    assert.strictEqual(calls.length, 1);
  });

  await ta('1557 rows — the size that broke the KPI report — all arrive', async () => {
    const calls = [];
    const rows = await selectAll(fakeTable(1557, calls));
    assert.strictEqual(rows.length, 1557);
    assert.deepStrictEqual(calls.map(c => [c.from, c.to]), [[0, 999], [1000, 1999]]);
    // Every row exactly once, in order.
    assert.deepStrictEqual(rows.map(r => r.i).slice(-3), [1554, 1555, 1556]);
    assert.strictEqual(new Set(rows.map(r => r.i)).size, 1557);
  });

  await ta('an exact multiple of the page size does not lose the last page', async () => {
    const calls = [];
    const rows = await selectAll(fakeTable(2000, calls));
    assert.strictEqual(rows.length, 2000);
    assert.strictEqual(calls.length, 3); // the third page comes back empty
  });

  await ta('an empty table is an empty array, not an error', async () => {
    const rows = await selectAll(fakeTable(0, []));
    assert.deepStrictEqual(rows, []);
  });

  await ta('a fresh builder per page — a reused one would re-read page zero', async () => {
    let made = 0;
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    const data = await selectAll(() => {
      made++;
      const q = { order() { return q; },
        range: (f, to) => Promise.resolve({ data: rows.slice(f, f + Math.min(to - f + 1, 1000)), error: null }) };
      return q;
    });
    assert.strictEqual(made, 3);
    assert.strictEqual(data.length, 2500);
  });

  await ta('an error on a later page throws, it does not return a prefix', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    let n = 0;
    await assert.rejects(
      selectAll(() => ({
        order() { return this; },
        range: (f, to) => {
          if (n++ === 1) return Promise.resolve({ data: null, error: { message: 'boom', code: '42501' } });
          return Promise.resolve({ data: rows.slice(f, f + Math.min(to - f + 1, 1000)), error: null });
        },
      })),
      /boom/);
  });

  await ta('the circuit breaker throws rather than returning a silent prefix', async () => {
    await assert.rejects(selectAll(fakeTable(5000, []), { max: 2000, label: 'calls' }),
      /passed 2000 rows/);
  });

  await ta('selectAllResult hands back { data, error } instead of throwing', async () => {
    const r = await selectAllResult(() => ({
      order() { return this; },
      range: () => Promise.resolve({ data: null, error: { message: 'nope', code: '42P01' } }),
    }));
    assert.strictEqual(r.data, null);
    assert.strictEqual(r.error.message, 'nope');
    assert.strictEqual(r.error.code, '42P01');
    const ok = await selectAllResult(fakeTable(3, []));
    assert.strictEqual(ok.error, null);
    assert.strictEqual(ok.data.length, 3);
  });

  // ---- paging without an ORDER BY -----------------------------------------
  //
  // OFFSET with no ORDER BY has no defined row order, so page two may repeat a
  // row from page one and skip another. Nothing errors and the total still
  // looks about right — the same silent-wrong-number failure as the 1000-row
  // ceiling itself.

  await ta('every page is ordered, so two pages cannot overlap', async () => {
    const calls = [];
    await selectAll(fakeTable(2500, calls));
    assert.strictEqual(calls.length, 3);
    calls.forEach((c, i) => assert.deepStrictEqual(c.ordered, ['id', true],
      'page ' + i + ' was fetched without an ORDER BY'));
  });

  await ta('a caller can name the column, and the direction', async () => {
    const calls = [];
    await selectAll(fakeTable(10, calls), { order: 'created_at', ascending: false });
    assert.deepStrictEqual(calls[0].ordered, ['created_at', false]);
  });

  await ta('order: null leaves ordering to the caller’s own factory', async () => {
    const calls = [];
    await selectAll(fakeTable(10, calls), { order: null });
    assert.strictEqual(calls[0].ordered, null);
  });

  await ta('a table with no id column pages unordered instead of failing', async () => {
    const calls = [];
    const warn = console.warn; let said = '';
    console.warn = m => { said += m; };
    try {
      const rows = await selectAll(fakeTable(1500, calls, { noOrderColumn: true }), { label: 'oddtable' });
      assert.strictEqual(rows.length, 1500, 'the rows must still arrive');
      calls.forEach(c => assert.strictEqual(c.ordered, null));
      assert.ok(/oddtable/.test(said) && /UNORDERED/.test(said),
        'it must say out loud that this query is not trustworthy past page one');
    } finally { console.warn = warn; }
  });

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
