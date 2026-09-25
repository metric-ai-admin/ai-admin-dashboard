#!/usr/bin/env node
//
// Can the three Billable Labor saved reports be pulled automatically?
//
//   node scripts/probe-buffered-reports.js
//
// READ-ONLY. Every request is a GET or a POST that AppFolio treats as a read;
// nothing is written anywhere, no file is created, and no result is stored.
// Run it on Render Shell, where APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET
// already live — this script never asks for a credential and never prints one.
//
// WHAT IT IS TESTING
//
// Two different doors, and the distinction is the whole question:
//
//   /api/v2/reports/{name}.json   the public Reports API. Basic auth with the
//                                 OAuth client id and secret. This is what the
//                                 dashboard already uses for 20-odd reports.
//
//   /buffered_reports/{uuid}      a page in the AppFolio WEB UI. It is what the
//                                 browser hits when Lyndsay opens a saved
//                                 report, and it authenticates with her login
//                                 SESSION COOKIE, not with the API credentials.
//
// The prior on this is not good. Jay's saved report was probed on 2026-09-23
// (see appfolio-reports.js): the bare UUID answered 400 "Id is not a valid
// report" and the joined_reports path answered 404. The three UUIDs here are
// the same shape and the same generation family (…-11f1-948b-0269bfa09cb1), so
// the expected outcome is that the API cannot see them either. This script is
// here to establish that against these specific ids rather than assume it, and
// to record exactly WHICH failure each path gives — a 401 means "wrong kind of
// credential", a 400/404 means "the API cannot address this object at all",
// and those point at completely different workarounds.
//
// It also asks what each response actually IS: a redirect to a login page is
// the signature of the web UI, and it is easy to mistake a 200 that returns an
// HTML sign-in form for a working pull.

require('dotenv').config();

const SUBDOMAIN = process.env.APPFOLIO_SUBDOMAIN || 'metricpropertymanagement';
const CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const SECRET = process.env.APPFOLIO_CLIENT_SECRET;

if (!CLIENT_ID || !SECRET) {
  console.error('APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET are not set in this shell.');
  console.error('Run this on Render Shell for the dashboard service, where they are configured.');
  process.exit(2);
}

const AUTH = 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
const HOST = `https://${SUBDOMAIN}.appfolio.com`;

const SAVED = [
  { name: 'MDaily', uuid: 'df235f82-8c54-11f1-948b-0269bfa09cb1' },
  { name: 'MWeekly', uuid: 'fa67b87d-8c51-11f1-948b-0269bfa09cb1' },
  { name: 'MMonthly', uuid: '512fb703-8c55-11f1-948b-0269bfa09cb1' },
];

// What came back, in the terms that decide whether this is buildable.
function describe(res, body) {
  const ct = (res.headers.get('content-type') || '').split(';')[0] || '(none)';
  const loc = res.headers.get('location');
  let shape = 'unknown';
  const head = body.trimStart().slice(0, 400);
  if (/^\s*[[{]/.test(head)) shape = 'JSON';
  else if (/^\s*<!doctype html|^\s*<html/i.test(head)) shape = 'HTML';
  else if (/^\s*</.test(head)) shape = 'XML/markup';
  else if (head.includes(',') && head.split('\n')[0].split(',').length > 2) shape = 'possibly CSV';
  else if (!head) shape = 'empty';
  else shape = 'text';

  // An HTML sign-in form returned with status 200 is the trap this is looking for.
  const looksLikeLogin = /sign in|log ?in|password|session|authenticity_token/i.test(head);
  return { ct, loc, shape, looksLikeLogin, excerpt: head.replace(/\s+/g, ' ').slice(0, 220) };
}

async function probe(label, url, { method = 'GET', body = null, auth = true } = {}) {
  const headers = { Accept: 'application/json, text/csv, */*' };
  if (auth) headers.Authorization = AUTH;
  if (body) headers['Content-Type'] = 'application/json';

  let res, text = '';
  try {
    // redirect: 'manual' so a bounce to the login page is VISIBLE rather than
    // silently followed into a 200 that means the opposite of success.
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    text = await res.text();
  } catch (e) {
    console.log(`  ${label}`);
    console.log(`    NETWORK ERROR  ${e.code || e.message}`);
    return null;
  }

  const d = describe(res, text);
  console.log(`  ${label}`);
  console.log(`    ${method} ${url.replace(HOST, '')}`);
  console.log(`    ${res.status} ${res.statusText}   content-type: ${d.ct}   body looks like: ${d.shape}${d.looksLikeLogin ? '  ** LOGIN PAGE **' : ''}`);
  if (d.loc) console.log(`    redirects to: ${d.loc.replace(/([?&])(token|key|password)=[^&]*/gi, '$1$2=***')}`);
  if (d.excerpt) console.log(`    body: ${d.excerpt}`);
  return { status: res.status, ...d };
}

(async () => {
  console.log(`AppFolio saved-report probe — ${HOST}`);
  console.log('READ-ONLY. Nothing is written or stored.\n');

  console.log('=== 1. buffered_reports (the web-UI path) ============================');
  for (const r of SAVED) {
    await probe(`${r.name} — bare`, `${HOST}/buffered_reports/${r.uuid}`);
    await probe(`${r.name} — .csv`, `${HOST}/buffered_reports/${r.uuid}.csv`);
  }
  // The one that is already mapped, by NAME rather than uuid. This is the
  // control: if this also fails on the buffered_reports path while working
  // through the API, the path is the problem, not the credentials.
  await probe('work_order_labor_summary (control, by name)', `${HOST}/buffered_reports/work_order_labor_summary`);

  console.log('\n=== 2. v2 Reports API, the UUID as a report name ====================');
  for (const r of SAVED) {
    await probe(`${r.name}`, `${HOST}/api/v2/reports/${r.uuid}.json`, { method: 'POST', body: {} });
  }

  console.log('\n=== 3. v2 Reports API, joined_reports path ==========================');
  for (const r of SAVED) {
    await probe(`${r.name}`, `${HOST}/api/v2/reports/joined_reports/${r.uuid}.json`, { method: 'POST', body: {} });
  }

  console.log('\n=== 4. Control: a report we KNOW works ==============================');
  // Proves the credentials in this shell are good, so a failure above is about
  // the endpoint and not about auth. Bounded params, one page, nothing stored.
  await probe('work_order_labor_summary via the API',
    `${HOST}/api/v2/reports/work_order_labor_summary.json?paginate_results=false`,
    { method: 'POST', body: { labor_performed_from: '2026-09-01', labor_performed_to: '2026-09-02' } });

  console.log('\n=== 5. Is the credential even accepted without auth? ================');
  // If the UNAUTHENTICATED request looks the same as the authenticated one,
  // then auth is not what is being tested and the result above means nothing.
  await probe('buffered_reports, NO auth header', `${HOST}/buffered_reports/${SAVED[0].uuid}`, { auth: false });

  console.log('\nHOW TO READ THIS');
  console.log('  401/403 or a redirect to a login page  -> web UI, session-cookie only.');
  console.log('     The API credentials cannot open it. Automating it would mean');
  console.log('     driving a browser session, not calling an API.');
  console.log('  400 "Id is not a valid report" / 404   -> the API cannot address saved');
  console.log('     reports at all, same as Jay\'s report on 2026-09-23.');
  console.log('  200 + JSON or CSV                      -> it works; report the shape.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
