// The weekly KPI screen, and who can reach it.
//
// The report existed only as an API: /api/kpi/report and its two exports were
// reachable by typing a URL and by nothing else, which is why Katie was still
// working from Lyndsay's KPI HTML. These guard the screen that replaces it and
// the three ways widening access goes wrong:
//
//   * a read list that quietly carries a write with it
//   * "adjust a figure by hand" inherited through a role
//   * a number that could not be computed arriving as a measured zero
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const server = read('server.js');
const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/styles.css');

console.log('the weekly KPI screen');

// ---- the screen exists -------------------------------------------------------

t('the report has a panel, inside the KPI tab', () => {
  const at = html.indexOf('id="kr-wrap"');
  assert.ok(at > 0, 'there is no panel');
  const sec = html.indexOf('id="tab-kpi"');
  assert.ok(at > sec && at < html.indexOf('</section>', sec), 'it is not in the KPI tab');
});

t('it has a week picker and both downloads', () => {
  const at = html.indexOf('id="kr-wrap"');
  const panel = html.slice(at, html.indexOf('id="kc-wrap"'));
  assert.match(panel, /id="kr-week"[^>]*type="date"|type="date"[^>]*id="kr-week"/);
  assert.match(panel, /id="kr-col"/, 'no column picker, so no per-owner download');
  assert.match(panel, /id="kr-xlsx"/);
  assert.match(panel, /id="kr-pdf"/);
});

t('the tab actually loads it', () => {
  assert.match(app, /tab === 'kpi'[^\n]*krInit\(\)/);
});

// ---- it uses the routes that already exist -------------------------------------

const krBlock = app.slice(app.indexOf('let krReport = null;'),
  app.indexOf("/* ── Compare with Katie's workbook"));

t('the page reads /api/kpi/report and passes the chosen week', () => {
  assert.match(krBlock, /api\('\/api\/kpi\/report'/);
  assert.match(krBlock, /week_ending=' \+ encodeURIComponent\(week\)/);
});

t('the downloads hit the existing export routes, with the column', () => {
  assert.match(krBlock, /\/api\/kpi\/report\/export\/' \+ format/);
  assert.match(krBlock, /qs\.set\('property', col\)/);
  assert.match(krBlock, /qs\.set\('week_ending'/);
});

t('every column the exports offer is offered for download', () => {
  // Including Round Rock, Greystone and Portfolio — the per-owner files are
  // the whole point, and a picker built from properties alone would drop them.
  const R = require('../lib/kpi-report.js');
  const cols = R.columnOrder(['Ascent at Northgate', 'The Chateau']);
  assert.ok(cols.includes('Greystone'), 'Greystone is not a column any more');
  assert.ok(cols.includes('Round Rock'));
  assert.ok(cols.includes('Portfolio'));
  // The picker is built from the report's own columns, not a second list.
  assert.match(krBlock, /krReport\.columns \|\| \[\]\)\.map\(c => '<option/);
});

// ---- a number that is not there --------------------------------------------------

t('a missing value is empty, never zero', () => {
  const cell = app.slice(app.indexOf('function krCell'), app.indexOf('const KR_MARK'));
  assert.match(cell, /value === null \|\| card\.value === undefined\) return '—'/);
  assert.ok(!/\|\| 0/.test(cell), 'a null falls through to 0 somewhere');
});

t('a percentage is formatted by its metric, not by its size', () => {
  // 100% occupancy is 1.0 and used to print as "1".
  assert.match(app, /KR_PERCENT = \['occPct', 'prePct', 'occupancyGoal'\]/);
  const cell = app.slice(app.indexOf('function krCell'), app.indexOf('const KR_MARK'));
  assert.match(cell, /KR_PERCENT\.includes\(card\.metric\)/);
  assert.ok(!/v > 0 && v < 1|v <= 1/.test(cell), 'it is guessing from the value');
});

t('a source that could not be read is named on the page', () => {
  // Otherwise every metric that depends on it is blank and the week looks quiet.
  assert.match(krBlock, /SOURCES MISSING/);
  assert.match(krBlock, /not because they are zero/);
});

t('the occupancy date says when it is not the week', () => {
  // leasing_occupancy is a snapshot the sync overwrites, so its date can be
  // days after the week closed. Against Katie's workbook that reads as a
  // disagreement rather than as a different day.
  assert.match(krBlock, /f\.matchesWeek === false/);
  assert.match(krBlock, /not a reading taken that day/);
});

t('a held-out property is named, not printed as an object', () => {
  // report.unconfirmed carries objects; escaping one gave "[object Object]" —
  // a property held out of the report, named as nothing.
  assert.match(krBlock, /u\.property/);
  assert.ok(!/unconfirmed\.map\(kcEsc\)/.test(krBlock), 'it escapes the object itself');
});

t('the metric column cannot slide off the left edge', () => {
  // Without max-width the scroller shrink-wraps the table, the page scrolls
  // instead, and the sticky column leaves a screen of numbers with nothing
  // saying which metric they are.
  const at = css.indexOf('.kr-scroll {');
  assert.ok(at > 0);
  assert.match(css.slice(at, at + 120), /max-width:\s*100%/);
  assert.match(css, /\.kr-table th\.kr-metric[^}]*position:\s*sticky/s);
});

// ---- who can reach it --------------------------------------------------------------

const roles = name => {
  const m = app.match(new RegExp(name + ":\\s*\\[([^\\]]*)\\]"));
  assert.ok(m, name + ' is not in TAB_ACCESS');
  return m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
};

t('Katie reaches the KPI tab without losing what she had', () => {
  const tabs = roles('leasing_bd');
  assert.ok(tabs.includes('kpi'), 'she still cannot open it');
  assert.ok(tabs.includes('leasing') && tabs.includes('crm') && tabs.includes('socialposts'));
});

t('reading and exporting is a wider list than writing', () => {
  const at = server.indexOf('const KPI_REPORT_READ_ROLES');
  assert.ok(at > 0, 'the read list does not exist');
  assert.match(server.slice(at, server.indexOf(';', at)), /leasing_bd/);
  ["app.get('/api/kpi/report'", "app.get('/api/kpi/report/export/:format'"].forEach(r => {
    const i = server.indexOf(r);
    assert.ok(i > 0, r + ' is gone');
    assert.match(server.slice(i, i + 160), /KPI_REPORT_READ_ROLES/, r + ' is on the wrong list');
  });
});

t('Katie can save the workbook for the week', () => {
  // She builds that Excel. While the five figures have no AppFolio source she
  // IS the source, and routing her own file through somebody else adds a day.
  const at = server.indexOf('const KPI_WORKBOOK_ROLES');
  assert.ok(at > 0, 'the workbook list does not exist');
  assert.match(server.slice(at, server.indexOf(';', at)), /leasing_bd/);
  const i = server.indexOf("app.post('/api/kpi/workbook'");
  assert.match(server.slice(i, i + 160), /KPI_WORKBOOK_ROLES/);
});

t('saving the workbook and overriding one figure are different powers', () => {
  // Replacing the week's three sheets is not the same as changing a single
  // number, and the second stays with Bekah and Kara BY NAME.
  const wb = server.indexOf('const KPI_WORKBOOK_ROLES');
  assert.ok(!/KPI_EDITORS/.test(server.slice(wb, server.indexOf(';', wb))));
  const i = server.indexOf("app.patch('/api/kpi/report/:week_ending'");
  assert.ok(!/KPI_WORKBOOK_ROLES/.test(server.slice(i, i + 400)),
    'the workbook list reaches the manual override');
});

t('the upload has a screen, beside the report it feeds', () => {
  // The route had none: the permission existed and there was nowhere to use
  // it, so "upload the workbook" was not a step anyone could be shown.
  const at = html.indexOf('id="kr-wb"');
  assert.ok(at > 0, 'there is no upload panel');
  const kr = html.indexOf('id="kr-wrap"');
  assert.ok(at > kr && at < html.indexOf('id="kc-wrap"'), 'it is not in the KPI panel');
  assert.match(html.slice(at, at + 400), /id="kr-wb-file"/);
  assert.match(app, /fetch\('\/api\/kpi\/workbook'/);
});

t('it says it is not the comparison panel', () => {
  // Same file, two jobs: this one SAVES and changes the report, the other
  // saves nothing. Anybody following a written guide has to tell them apart.
  const at = html.indexOf('id="kr-wb"');
  const near = html.slice(Math.max(0, at - 900), at);
  assert.match(near, /Compare with Katie/);
  assert.match(near, /saves nothing/i);
});

t('the upload sends the week on screen, never an unstated one', () => {
  const up = app.slice(app.indexOf('async function krUploadWorkbook'),
    app.indexOf('function krRenderTable'));
  assert.match(up, /fd\.append\('week_ending', krReport\.week_ending\)/);
});

t('a refusal names the tab and says nothing changed', () => {
  const up = app.slice(app.indexOf('async function krUploadWorkbook'),
    app.indexOf('function krRenderTable'));
  assert.match(up, /NOT SAVED/);
  assert.match(up, /Nothing changed for week/);
  assert.match(up, /d\.error/, 'the reason from the route is not passed through');
});

t('a success reports counts, not a bare OK', () => {
  // A workbook that parsed into two properties instead of nine is a failure
  // that looks exactly like a success.
  const up = app.slice(app.indexOf('async function krUploadWorkbook'),
    app.indexOf('function krRenderTable'));
  assert.match(up, /p\.mtd_cash/);
  assert.match(up, /p\.occupancy_goals/);
});

t('a week with no workbook says so, rather than going blank', () => {
  const r = app.slice(app.indexOf('function krRenderWorkbook'),
    app.indexOf('async function krUploadWorkbook'));
  assert.match(r, /No workbook for this week/);
  assert.match(r, /st\.loaded/);
});

t('re-choosing the same file still fires', () => {
  // After a refusal, picking the corrected file with the same NAME used to do
  // nothing at all: the input's value had not changed.
  assert.match(app, /krUploadWorkbook\(e\.target\.files\[0\]\);[\s\S]{0,200}e\.target\.value = '';/);
});

t('the upload keeps a list of its own, separate from reading', () => {
  // It decides five figures the report cannot compute — a write that changes
  // what an owner reads. It happens to hold the same people as the read list
  // today; sharing the constant would make that an accident rather than a
  // decision, and the next role added for reading would inherit the write.
  const i = server.indexOf("app.post('/api/kpi/workbook'");
  assert.ok(i > 0);
  const head = server.slice(i, i + 160);
  assert.match(head, /KPI_WORKBOOK_ROLES/);
  assert.ok(!/KPI_REPORT_READ_ROLES/.test(head), 'the read list now carries a write');
});

t('adjusting a figure by hand is still Bekah and Kara, by name', () => {
  assert.match(server, /KPI_EDITORS = \(process\.env\.KPI_EDITORS \|\| 'bekah,kara'\)/);
  const i = server.indexOf("app.patch('/api/kpi/report/:week_ending'");
  assert.ok(i > 0);
  const body = server.slice(i, i + 400);
  assert.match(body, /mayEditKpi\(req\.user\)/);
  // By NAME, so no role on the read list can inherit it.
  assert.ok(!/KPI_REPORT_READ_ROLES|requireRole/.test(body), 'the edit gate became a role');
});

t('Katie can compare her workbook, and comparing stores nothing', () => {
  const at = server.indexOf('const KPI_COMPARE_ROLES');
  assert.ok(at > 0);
  assert.match(server.slice(at, server.indexOf(';', at)), /leasing_bd/);
  const i = server.indexOf("app.post('/api/kpi/compare'");
  assert.match(server.slice(i, i + 160), /KPI_COMPARE_ROLES/);
  // The file is parsed out of the buffer and dropped.
  const block = server.slice(server.indexOf('// Compare with Katie'), i);
  assert.match(block, /THE FILE IS NOT STORED/);
  assert.ok(!/fs\.writeFile|createWriteStream/.test(server.slice(i, i + 3000)),
    'the upload is written somewhere');
});

t('the panel is shown to the same roles the route allows', () => {
  assert.match(app, /KPI_COMPARE_ROLES = \['admin', 'leasing_bd'\]/);
  assert.match(app, /KPI_COMPARE_ROLES\.includes\(currentUser\.role\)/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
