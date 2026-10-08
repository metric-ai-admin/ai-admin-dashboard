#!/usr/bin/env node
// Read-only audit. Finds every Supabase read in the code, asks the database how
// big each table actually is, and classifies the read as paged / capped / naked.
//
// Nothing is written. This only counts.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = process.argv[2] || '.';
const files = ['server.js'];
for (const d of ['lib', 'routes', 'scripts']) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) for (const f of fs.readdirSync(p)) if (f.endsWith('.js')) files.push(d + '/' + f);
}

const FROM = /\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/g;
const hits = [];
const tables = new Set();
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  let m;
  FROM.lastIndex = 0;
  while ((m = FROM.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    // The statement: from the match to the next semicolon, capped so a runaway
    // never swallows the file.
    const tail = src.slice(m.index, m.index + 900);
    const stmt = tail.slice(0, (tail.indexOf(';') + 1) || 400).replace(/\s+/g, ' ');
    const table = m[1];
    tables.add(table);
    const isWrite = /\.(insert|upsert|update|delete)\(/.test(stmt);
    if (isWrite) continue;
    if (!/\.select\(/.test(stmt)) continue;
    // A query wrapped in selectAll()/selectAllResult() is paged by the helper,
    // and the pagination is not visible in the statement text itself — so look
    // back at what opened the call. Without this every fixed site keeps being
    // reported as broken and the audit becomes noise nobody reads.
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    // An explicit marker, for a query built in a NAMED factory that is handed
    // to selectAll elsewhere — the lookback below cannot see that from here,
    // and without the marker a fixed site is reported as broken forever.
    const marked = /\/\* paged \*\//.test(before) || /\/\* paged \*\//.test(stmt);
    const wrapped = marked || /selectAll(Result)?\(\s*\(\s*\)\s*=>\s*$/.test(before.replace(/\s+$/, '') + ' ')
      || /selectAll(Result)?\(\s*\(\s*\)\s*=>[^;]*$/.test(before);
    const headOnly = /head:\s*true/.test(stmt);
    const counted = /count:\s*['"]exact['"]/.test(stmt);
    const ranged = /\.range\(/.test(stmt);
    const lim = /\.limit\(\s*([0-9]+)\s*\)/.exec(stmt);
    const single = /\.(single|maybeSingle)\(/.test(stmt);
    const eqId = /\.eq\(\s*['"](id|.*_id)['"]/.test(stmt);
    let kind;
    if (wrapped) kind = 'PAGED';
    else if (headOnly) kind = 'count-only';
    else if (ranged) kind = 'PAGED';
    else if (single) kind = 'single-row';
    else if (lim && Number(lim[1]) <= 200) kind = 'bounded (' + lim[1] + ')';
    else if (lim) kind = 'CAPPED limit(' + lim[1] + ')';
    else kind = 'NAKED (no limit, no range)';
    hits.push({ file: rel, line, table, kind, counted, stmt: stmt.slice(0, 150) });
  }
}

(async () => {
  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  const counts = {};
  for (const t of [...tables].sort()) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    counts[t] = error ? 'ERR ' + error.code : count;
  }

  console.log('=== TABLE SIZES (live) ===');
  Object.entries(counts).sort((a, b) => (Number(b[1]) || -1) - (Number(a[1]) || -1))
    .forEach(([t, c]) => {
      const n = Number(c);
      const flag = !isFinite(n) ? '  ' : n >= 1000 ? 'OVER' : n >= 700 ? 'NEAR' : '    ';
      console.log('  ' + flag + '  ' + String(c).padStart(7) + '  ' + t);
    });

  console.log('\n=== READS AT RISK (table at or near the ceiling, read unpaged) ===');
  const risky = hits.filter(h => {
    const n = Number(counts[h.table]);
    if (!isFinite(n)) return false;
    if (h.kind === 'PAGED' || h.kind === 'count-only' || h.kind === 'single-row') return false;
    if (/^bounded/.test(h.kind)) return false;
    return n >= 700;
  });
  risky.sort((a, b) => Number(counts[b.table]) - Number(counts[a.table]));
  risky.forEach(h => console.log('  ' + h.file + ':' + h.line + '  ' + h.table +
    ' (' + counts[h.table] + ' rows)  ' + h.kind + '\n      ' + h.stmt));
  console.log('\n  risky reads: ' + risky.length + ' of ' + hits.length + ' reads over ' + tables.size + ' tables');

  console.log('\n=== ALL UNPAGED READS, by table (for the ones that can grow) ===');
  const byTable = {};
  hits.forEach(h => { (byTable[h.table] = byTable[h.table] || []).push(h); });
  Object.keys(byTable).sort().forEach(t => {
    const bad = byTable[t].filter(h => h.kind === 'NAKED (no limit, no range)' || /^CAPPED/.test(h.kind));
    if (!bad.length) return;
    console.log('  ' + t + '  [' + counts[t] + ' rows]');
    bad.forEach(h => console.log('      ' + h.file + ':' + h.line + '  ' + h.kind));
  });
})().catch(e => { console.error(e.message); process.exit(1); });
