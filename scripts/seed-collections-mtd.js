#!/usr/bin/env node
//
// Seed collections_mtd with October's two cash-basis points from Katie's
// weekly workbooks, so November has something to compare against on 11/01.
//
//   node scripts/seed-collections-mtd.js --describe "<file.xlsx>"
//   node scripts/seed-collections-mtd.js --as-of 2026-10-12 --dry-run "<file.xlsx>"
//   node scripts/seed-collections-mtd.js --as-of 2026-10-12 --write "<file.xlsx>"
//
// WHY A SEED AT ALL. AppFolio answers for a whole past month but ignores the
// day, so a PART of last month cannot be asked for, and
// the history can only start the day the sync starts — which would put the
// first real comparison in December. Katie's workbooks already hold the
// figures for 10/05 and 10/12, taken from the saved report "Income Statement -
// Property Comparison" with Accounting Basis: Cash. Two points are enough for
// November to compare against October.
//
// CASH ONLY. The workbooks carry an MTD Cash tab and an MTD Accrual tab, and
// they are different numbers from the same report — Ascent at 10/12 is
// 42,164.55 cash against 48,175.63 accrual. Seeding the accrual column would
// put the wrong basis into the history silently, which is the whole reason the
// daily capture is currently switched off. The tab is chosen by NAME and the
// script refuses rather than guesses.
//
// --describe FIRST. The layout of these workbooks has not been seen by this
// code. --describe prints the tab names, the header row and the row labels it
// can find, and writes nothing — so the mapping is checked by a person before
// any figure is stored under a date.
require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const C = require('../lib/collections-mtd.js');
const PA = require('../lib/property-aliases.js');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const files = argv.filter(a => /\.xlsx$/i.test(a));

const DESCRIBE = has('--describe');
const DRY = has('--dry-run');
const WRITE = has('--write');
const AS_OF = val('--as-of');

const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// The tab holding cash figures. Matched by name, and anything that merely
// looks financial is NOT accepted — "MTD Accrual" must never satisfy this.
const CASH_TAB = /cash/i;
const ACCRUAL_TAB = /accrual/i;
const RENT_ROW = /^rent income$/i;

// The header row is the first one with two or more cells that resolve to a
// property we recognise. Taking row 0 on faith is how a title row becomes the
// column names — these workbooks open with two lines of report settings.
function headerRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const known = (rows[i] || []).filter(c => c && PA.canonical(String(c))).length;
    if (known >= 2) return i;
  }
  return -1;
}

function describe(file) {
  const wb = XLSX.readFile(file);
  console.log('\n' + path.basename(file));
  wb.SheetNames.forEach(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    const tag = CASH_TAB.test(name) ? '  <-- cash'
      : (ACCRUAL_TAB.test(name) ? '  (accrual — not used)' : '');
    console.log('   tab: ' + pad(name, 34) + rows.length + ' rows' + tag);
    if (!CASH_TAB.test(name)) return;
    // Header and row labels only. An income statement holds no resident data,
    // but this still prints structure rather than contents.
    //
    // THE SAME DETECTION THE READER USES, not row 0. Printing row 0 and calling
    // it the header would show a title line — "Income Statement - Property
    // Comparison" — and a person checking the mapping would see a header that
    // the reader never looks at.
    const at = headerRow(rows);
    console.log('      header row: ' + (at < 0 ? 'NOT FOUND — the mapping below will fail' : '#' + (at + 1)));
    if (at >= 0) {
      console.log('      header: '
        + (rows[at] || []).map(c => (c === null ? '' : String(c))).slice(0, 14).join(' | '));
    }
    const labels = rows.slice(1, 40)
      .map(r => (r && r[0] !== null && r[0] !== undefined ? String(r[0]).trim() : ''))
      .filter(Boolean);
    console.log('      row labels: ' + labels.slice(0, 20).join(', '));
    const rent = labels.find(l => RENT_ROW.test(l));
    console.log('      "Rent Income" row: ' + (rent ? 'FOUND' : 'NOT FOUND — the mapping below will fail'));
  });
}

/**
 * The cash Rent Income figure per property, from one workbook.
 *
 * The layout is a property comparison: row labels down the left, ONE COLUMN
 * PER PROPERTY across the top. So the figure for a property is the cell where
 * the "Rent Income" row meets that property's column.
 */
function readCash(file) {
  const wb = XLSX.readFile(file);
  const tab = wb.SheetNames.find(n => CASH_TAB.test(n) && !ACCRUAL_TAB.test(n));
  if (!tab) {
    throw new Error('no cash tab in ' + path.basename(file)
      + ' (tabs: ' + wb.SheetNames.join(', ') + '). Run --describe.');
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, defval: null });

  const headerAt = headerRow(rows);
  if (headerAt < 0) {
    throw new Error('no header row in "' + tab + '" has two recognisable property names. Run --describe.');
  }
  const header = rows[headerAt];

  const rentAt = rows.findIndex((r, i) =>
    i > headerAt && r && RENT_ROW.test(String(r[0] || '').trim()));
  if (rentAt < 0) throw new Error('no "Rent Income" row in "' + tab + '". Run --describe.');

  const out = [];
  const skipped = [];
  header.forEach((cell, col) => {
    if (!cell) return;
    const name = PA.canonical(String(cell));
    const value = C.num(rows[rentAt][col]);
    if (!name) {
      // A column that is not one of our eight. Printed, never dropped quietly
      // — a property that stops being measured is invisible otherwise.
      if (String(cell).trim() && value !== null) skipped.push(String(cell).trim());
      return;
    }
    if (value === null) { skipped.push(String(cell).trim() + ' (no figure)'); return; }
    out.push({ property: name, rent_income: value });
  });
  return { tab, rows: out, skipped, file: path.basename(file) };
}

(async () => {
  if (!files.length) {
    console.error('Pass the workbook path(s). Run with --describe first.');
    process.exitCode = 1;
    return;
  }

  if (DESCRIBE) {
    console.log('READ ONLY — describing the workbooks. Nothing is written.');
    files.forEach(describe);
    console.log('\nCheck the cash tab, the header and the "Rent Income" row above.');
    console.log('Then run again with --as-of <the date the figures are AS OF> --dry-run.');
    return;
  }

  if (!AS_OF || !/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) {
    console.error('--as-of YYYY-MM-DD is required: the date the figures are AS OF,');
    console.error('which is filters[posted_on_relative_to] in the saved report\'s URL');
    console.error('(10/05 and 10/12 for these two) — NOT the day the file was exported.');
    process.exitCode = 1;
    return;
  }
  if (files.length > 1) {
    console.error('One file at a time: each workbook has its own as-of date, and a');
    console.error('single --as-of applied to both would date one of them wrongly.');
    process.exitCode = 1;
    return;
  }

  const read = readCash(files[0]);
  console.log('file: ' + read.file);
  console.log('tab:  ' + read.tab + '   (cash)');
  console.log('as of: ' + AS_OF + '\n');

  read.rows.forEach(r => console.log('   ' + pad(r.property, 26) + money(r.rent_income)));
  if (read.skipped.length) {
    console.log('\n   not seeded: ' + read.skipped.join(', '));
    console.log('   (columns that are not one of the eight managed properties)');
  }

  const total = read.rows.reduce((a, r) => a + r.rent_income, 0);
  console.log('\n   ' + read.rows.length + ' properties, ' + money(total) + ' total');
  console.log('\n   NO PORTFOLIO ROW IS WRITTEN. The sum of eight columns is not the');
  console.log('   portfolio — the report has sixteen entities and we seed eight, so a');
  console.log('   total stored under \'*\' would be a different figure from the one the');
  console.log('   daily capture will store there, and the comparison would show a cliff.');

  const payload = read.rows.map(r => ({
    captured_on: AS_OF,
    property: r.property,
    property_id: null,
    rent_income: r.rent_income,
    total_income: null,
    accounts: { 'Rent Income': r.rent_income },
    source: 'katie_workbook_cash',
    period_note: 'cash basis, from "Income Statement - Property Comparison" '
      + '(Accounting Basis: Cash, Period Basis: Calendar) as of ' + AS_OF
      + '; seeded from ' + read.file + ', not captured by the sync',
  }));

  if (!WRITE || DRY) {
    console.log('\nDRY RUN — nothing written. Add --write to store these ' + payload.length + ' rows.');
    return;
  }

  const db = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  // Upsert on (captured_on, property): running this twice replaces the seed
  // rather than doubling the series.
  const { error } = await db.from('collections_mtd')
    .upsert(payload, { onConflict: 'captured_on,property' });
  if (error) throw new Error(error.message);
  console.log('\nstored: ' + payload.length + ' rows for ' + AS_OF + ', source katie_workbook_cash');
  console.log('These are SEEDED rows. source tells them apart from captured ones.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
