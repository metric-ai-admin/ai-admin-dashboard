#!/usr/bin/env node
//
// Can income_statement be filtered at all? READ ONLY — report reads, nothing
// written anywhere.
//
//   PROBE_PROPERTY_ID=1703 node scripts/probe-income-filters.js
//
// THE ONE LEAD WORTH FOLLOWING. The previous probe settled that the date
// filters and properties_ids / property_ids / property_id are IGNORED — same
// Rent Income, 311,166.40, every time. But "properties" came back HTTP 500,
// and a 500 is not a rejection: the parameter is RECOGNISED and the shape is
// wrong. That is the only door that is not locked, so this tries the shapes.
//
// EVERY VERDICT IS A COMPARISON OF VALUES, never of row counts. An ignored
// parameter returns the same numbers and a full-looking response, which is how
// `from_date` on the applications report cost a morning and how this report
// has now wasted two probes. The baseline figure is printed first and every
// attempt is scored against it:
//
//   DIFFERENT  the filter did something — this is the answer
//   SAME       recognised or not, it changed nothing
//   ERROR      with the status, because a 500 means "shape wrong, keep trying"
//              and a 400 means "stop"
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const PROP = process.env.PROBE_PROPERTY_ID || '1703';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);

const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// The figure to compare: the Rent Income line, whatever its value column is
// called. One number, so "did this change anything" is a yes or a no.
function rentIncome(rows) {
  const row = (rows || []).find(r =>
    Object.values(r).some(v => /^rent income$/i.test(String(v || '').trim())));
  if (!row) return null;
  const vals = Object.values(row).map(num).filter(n => n !== null && n !== 0);
  return vals.length ? vals[0] : null;
}

async function call(body) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/income_statement.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  return { status: r.status, rows, rent: rentIncome(rows), text };
}

// Property-filter shapes. "properties" answered 500, so the name is right and
// the VALUE is wrong — these are the shapes a Rails API usually wants.
const PROPERTY_SHAPES = [
  ['properties: {properties_ids:[string]}', { properties: { properties_ids: [PROP] } }],
  ['properties: {property_ids:[string]}', { properties: { property_ids: [PROP] } }],
  ['properties: {ids:[string]}', { properties: { ids: [PROP] } }],
  ['properties: [string]', { properties: [PROP] }],
  ['properties: [number]', { properties: [Number(PROP)] }],
  ['properties: string', { properties: PROP }],
  ['properties: number', { properties: Number(PROP) }],
  ['properties: {id:string}', { properties: { id: PROP } }],
  ['filters: {properties:[string]}', { filters: { properties: [PROP] } }],
  ['filters: {property_ids:[string]}', { filters: { property_ids: [PROP] } }],
];

// Date-parameter names, including inside a filters object — the shape the 500
// hints this report wants.
const DATE_SHAPES = [
  ['period_from / period_to', { period_from: '2026-09-01', period_to: '2026-09-26' }],
  ['posted_on_from / posted_on_to', { posted_on_from: '2026-09-01', posted_on_to: '2026-09-26' }],
  ['accounting_date_from / _to', { accounting_date_from: '2026-09-01', accounting_date_to: '2026-09-26' }],
  ['filters: {from_date,to_date}', { filters: { from_date: '2026-09-01', to_date: '2026-09-26' } }],
  ['filters: {period_from,period_to}', { filters: { period_from: '2026-09-01', period_to: '2026-09-26' } }],
  ['date_range: {from,to}', { date_range: { from: '2026-09-01', to: '2026-09-26' } }],
  ['accounting_basis: cash', { accounting_basis: 'cash' }],
  ['accounting_basis: accrual', { accounting_basis: 'accrual' }],
];

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. income_statement only. Nothing is written anywhere.\n');

  const base = await call({ property_visibility: 'active', paginate_results: false });
  console.log('BASELINE: ' + base.rows.length + ' rows, Rent Income '
    + (base.rent === null ? '(not found)' : base.rent));
  if (base.rent === null) {
    console.log('   Without a baseline figure nothing below can be scored. Stopping.');
    return;
  }

  const score = (label, r) => {
    const verdict = r.status >= 400
      ? 'ERROR ' + r.status + (r.status === 500 ? '  (recognised, shape wrong)' : '  (stop)')
      : (r.rent === null ? 'no Rent Income line'
        : (r.rent === base.rent ? 'SAME  ' + r.rent : 'DIFFERENT  ' + r.rent + '  <-- THIS FILTERS'));
    console.log('   ' + pad(label, 40) + verdict);
    return r.status < 400 && r.rent !== null && r.rent !== base.rent;
  };

  console.log('\nPROPERTY FILTER SHAPES (property ' + PROP + ')');
  let propertyWorks = null;
  for (const [label, body] of PROPERTY_SHAPES) {
    const r = await call({ ...body, property_visibility: 'active', paginate_results: false });
    if (score(label, r) && !propertyWorks) propertyWorks = label;
    await sleep(700);
  }

  console.log('\nDATE / BASIS SHAPES');
  let dateWorks = null;
  for (const [label, body] of DATE_SHAPES) {
    const r = await call({ ...body, property_visibility: 'active', paginate_results: false });
    if (score(label, r) && !dateWorks) dateWorks = label;
    await sleep(700);
  }

  console.log('\nVERDICT');
  console.log('   property filter: ' + (propertyWorks || 'NONE of the shapes changed the number'));
  console.log('   date filter:     ' + (dateWorks || 'NONE of the shapes changed the number'));
  if (!propertyWorks && !dateWorks) {
    console.log('\n   income_statement answers one number for the whole portfolio, for a');
    console.log('   period it chooses. Collections by property cannot come from it, and');
    console.log('   the next move is to accumulate our own history — see the note in');
    console.log('   the brief proposal. No further guessing at parameter names.');
  }
  console.log('\nNothing was written. Only the Rent Income total was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
