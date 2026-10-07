#!/usr/bin/env node
//
// Run HER page over a workbook and print what it computes.
//
//   node scripts/kpi-run-her-page.js \
//     --html "C:/Users/artur/Downloads/kpi_dashboard_17.html" \
//     --workbook "C:/Users/artur/Downloads/Data Source ... .xlsx" [--property "Hyde Park Square"]
//
// READ-ONLY. Nothing is written anywhere.
//
// WHY THIS EXISTS. Three of our ported parsers stopped reproducing on the
// 2026-10-07 export, and there were two possible reasons with opposite fixes:
// our port is wrong, or the export changed. Arguing about it from column
// indexes was going nowhere, so this loads kpi_dashboard_17.html in jsdom with
// SheetJS attached and calls its own processWorkbook(). Whatever it prints is
// what Katie sees, by construction.
//
// It settled the delinquency question in one run: her page produces
// 106,616.31 from this very file, so the file is fine and our reading of her
// delinquency sheet is what is wrong.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const XLSX = require('xlsx');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const HTML = arg('html', 'C:/Users/artur/Downloads/kpi_dashboard_17.html');
const BOOK = arg('workbook');
const ONLY = arg('property');

if (!BOOK || !fs.existsSync(BOOK)) { console.error('--workbook is required and must exist'); process.exit(2); }
if (!fs.existsSync(HTML)) { console.error('--html not found: ' + HTML); process.exit(2); }

const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://local.invalid/',
  // Her page expects SheetJS on window; give it the same library we use so the
  // only difference between the two sides is the parsing, not the reader.
  beforeParse(w) { w.XLSX = XLSX; },
});
const w = dom.window;

setTimeout(() => {
  w.XLSX = XLSX;
  w.__wb = XLSX.read(fs.readFileSync(BOOK), { type: 'buffer' });
  try {
    w.eval('processWorkbook(window.__wb, "workbook.xlsx");');
  } catch (e) {
    console.error('her page threw while parsing: ' + e.message);
    process.exit(1);
  }
  const APP = w.eval('APP');
  const data = (APP && APP.data) || {};
  console.log('properties her page built: ' + Object.keys(data).join(', '));
  console.log('ranges: ' + JSON.stringify(APP.ranges || {}));

  const show = name => {
    const d = data[name];
    if (!d) { console.log('\n' + name + ': not built'); return; }
    console.log('\n=== ' + name + ' ===');
    Object.keys(d).sort().forEach(k => {
      const v = d[k];
      let out;
      if (Array.isArray(v)) out = '[' + v.length + ']';
      else if (v && typeof v === 'object') out = '{' + Object.keys(v).length + ' keys}';
      else out = JSON.stringify(v);
      console.log('   ' + k.padEnd(28) + out);
    });
  };

  if (ONLY) show(ONLY);
  else {
    show('Portfolio');
    Object.keys(data).filter(n => n !== 'Portfolio').forEach(show);
  }
  process.exit(0);
}, 1500);
