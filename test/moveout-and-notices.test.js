// Kara's Phase C: move-out alerts, verbal notices, lost-lead reasons.
//
// THE FAS ALERT IS NOT HERE and that is the point of the first test. The only
// trace of a Final Account Statement in this data is an INSPECTION named after
// one, so "the FAS is done" could only ever mean "somebody completed an
// inspection with FAS in its name" — not that the statement reached the
// resident. Kara was asked what she means before it gets built.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/moveout-alerts.js');
const W = require('../lib/week.js');
const B = require('../lib/kara-brief.js');
const H = require('../lib/kara-brief-html.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('move-out alerts, verbal notices, loss reasons');

// ---- business days ---------------------------------------------------------

t('two business days from a Friday is Tuesday, not Sunday', () => {
  // 2026-10-09 is a Friday. The whole reason this is not addDaysYMD.
  assert.strictEqual(W.addBusinessDays('2026-10-09', 2), '2026-10-13');
  assert.strictEqual(W.addBusinessDays('2026-10-09', 5), '2026-10-16');
  assert.strictEqual(W.isBusinessDay('2026-10-10'), false, 'Saturday');
  assert.strictEqual(W.isBusinessDay('2026-10-11'), false, 'Sunday');
  assert.strictEqual(W.isBusinessDay('2026-10-12'), true, 'Monday');
  assert.strictEqual(W.businessDaysBetween('2026-10-09', '2026-10-14'), 3);
});

t('holidays are NOT handled, and that is written down', () => {
  // There is no holiday calendar in this database. Thanksgiving counts as a
  // working day and the alert fires a day early that week. A stated limit
  // rather than a silent one — inventing a list would be wrong invisibly.
  const wk = src('lib/week.js');
  assert.ok(/WEEKENDS ONLY/.test(wk));
  assert.ok(/holiday calendar/.test(wk));
  // Christmas Day 2026 is a Friday and still counts.
  assert.strictEqual(W.isBusinessDay('2026-12-25'), true);
});

// ---- recognising a walk ----------------------------------------------------

const WALK = { inspection_name: 'Move Out Damage and Occupancy Inspection' };

t('the move-out walk is recognised by name', () => {
  assert.ok(M.isWalk(WALK));
  assert.ok(M.isWalk({ inspection_name: 'Move Out Inspection' }));
  assert.ok(!M.isWalk({ inspection_name: 'Inspection make ready' }));
  assert.ok(!M.isWalk({ inspection_name: 'Monthly Property Inspection' }));
});

t('THE TURN ID WINS over the name', () => {
  // The probe of 2026-10-14 settled it: no type column, but unit_turn_id on
  // 202 of 635 rows. An inspection carrying this move-out's turn id IS its
  // walk — nothing to read, nothing to misspell.
  assert.ok(M.isWalk({ unit_turn_id: '202', inspection_name: 'Untitled' }, { turnId: '202' }));
  assert.ok(M.isWalk({ unit_turn_id: '202', inspection_name: 'Andres luevano' }, { turnId: '202' }));
  // Linked to a DIFFERENT turn: not this move-out's walk, however it is named.
  assert.ok(!M.isWalk({ unit_turn_id: '999', inspection_name: 'Move Out Damage and Occupancy Inspection' },
    { turnId: '202' }));
  // No turn id at all: the name is the fallback, which is the honest ordering.
  assert.ok(M.isWalk({ inspection_name: 'Move Out Inspection' }, { turnId: '202' }));
  assert.ok(!M.isWalk({ inspection_name: 'Untitled' }, { turnId: '202' }));
});

t('ids are compared as trimmed strings', () => {
  // One side arrives from Supabase as text and the other from the report as a
  // number, and 202 === '202' is false.
  assert.ok(M.belongsToTurn({ unit_turn_id: 202 }, '202'));
  assert.ok(M.belongsToTurn({ unit_turn_id: ' 202 ' }, 202));
  assert.ok(!M.belongsToTurn({ unit_turn_id: '' }, ''), 'two blanks are not a match');
});

t('the date is inspected_on, with marked_done_on as the fallback', () => {
  // inspection_date is NOT a column inspection_detail returns — the sync asked
  // for a name AppFolio never sends, so it was null on all 635 rows.
  assert.strictEqual(M.inspectedOn({ inspected_on: '2026-10-08', marked_done_on: '2026-10-09' }),
    '2026-10-08');
  assert.strictEqual(M.inspectedOn({ marked_done_on: '2026-10-09' }), '2026-10-09');
  // created_on is NOT used: when a record was created says nothing about when
  // somebody walked the unit.
  assert.strictEqual(M.inspectedOn({ created_on: '2026-10-01' }), null);
  const lib = src('lib/moveout-alerts.js');
  assert.ok(/IS NOT A COLUMN inspection_detail returns/.test(lib));
});

t('the sync stores the columns the report actually has', () => {
  const s = src('server.js');
  const at = s.indexOf("report: '/api/v2/reports/inspection_detail.json'");
  assert.ok(at > 0);
  const block = s.slice(at, at + 2200);
  assert.ok(/inspected_on:\s+leasingDateOnly\(mwoPick\(r, \['inspected_on'/.test(block),
    'the real date column is still not stored');
  assert.ok(/unit_turn_id:\s+mwoStr\(mwoPick\(r, \['unit_turn_id'\]\)\)/.test(block),
    'the structural link is still dropped');
  const sql = src('supabase/migrations/095_inspection_turn_link.sql');
  assert.ok(/add column if not exists inspected_on/i.test(sql));
  assert.ok(/add column if not exists unit_turn_id/i.test(sql));
  // The dead column is not dropped — that is a different decision.
  assert.ok(!/drop column/i.test(sql));
});

t('a name nobody can classify is UNRECOGNISED, not "not a walk"', () => {
  // 388 of 635 rows on 2026-10-14: Untitled, person names, "110".
  ['Untitled', 'Andres luevano', 'Mike redy', '110', 'Acen', ''].forEach(n =>
    assert.ok(M.isUnrecognised({ inspection_name: n }), n));
  // A make-ready or a monthly inspection IS classified — it is just not a walk.
  ['Inspection make ready', 'Monthly Property Inspection'].forEach(n =>
    assert.ok(!M.isUnrecognised({ inspection_name: n }), n));
});

t('the FAS pattern exists but nothing uses it yet', () => {
  assert.ok(M.isFas({ inspection_name: 'Move Out - FAS Inspection' }));
  assert.ok(M.isFas({ inspection_name: 'Final Account Statement Inspection' }));
  // No alert is built on it. Asserted so adding one is a deliberate act.
  const lib = src('lib/moveout-alerts.js');
  assert.ok(/waiting on her answer/.test(lib), 'the reason it is missing is not recorded');
  assert.ok(!/fasOverdue|function fasAlert/.test(lib), 'an unapproved FAS alert shipped');
});

// ---- the alerts ------------------------------------------------------------

const TODAY = '2026-10-14';
const TURNS = [
  { property_name: 'Hyde Park Square', unit: '107', move_out_date: '2026-10-14' },
  { property_name: 'The Chateau', unit: '4', move_out_date: '2026-10-08' },
  { property_name: 'Sunset Palms', unit: '12', move_out_date: '2026-10-07' },
  { property_name: 'The Highlander', unit: '9', move_out_date: '2026-10-13' },
];
const INSP = [
  { property_name: 'Sunset Palms', unit: '12', status: 'DONE', inspected_on: '2026-10-08',
    inspection_name: 'Move Out Damage and Occupancy Inspection' },
  { property_name: 'The Chateau', unit: '4', status: 'DONE', inspected_on: '2026-10-09',
    inspection_name: 'Andres luevano' },
];
const OVERDUE = M.walkOverdue({ turns: TURNS, inspections: INSP }, TODAY, { businessDays: 2 });

t('today\'s move-outs are today\'s, not this week\'s', () => {
  const today = M.moveOutsOn(TURNS, TODAY);
  assert.strictEqual(today.length, 1);
  assert.strictEqual(today[0].property, 'Hyde Park Square');
});

t('a unit with a recorded walk is not flagged', () => {
  assert.ok(!OVERDUE.some(a => a.property === 'Sunset Palms'));
});

t('a move-out still inside its two business days is not flagged', () => {
  // 10/13 + 2 business days is 10/15; today is the 14th.
  assert.ok(!OVERDUE.some(a => a.property === 'The Highlander'));
  assert.ok(!OVERDUE.some(a => a.moveOut === TODAY), 'today\'s move-out cannot be overdue');
});

t('a unit with only an unrecognised inspection IS flagged, and says so', () => {
  const a = OVERDUE.find(x => x.property === 'The Chateau');
  assert.ok(a, 'The Chateau was not flagged');
  assert.strictEqual(a.due, '2026-10-12');
  assert.strictEqual(a.businessDaysOverdue, 2);
  assert.strictEqual(a.unnamedInspections.length, 1);
  assert.strictEqual(a.unnamedInspections[0].name, 'Andres luevano');
});

t('the alert says RECORDED, never that nobody did the walk', () => {
  // The data cannot tell those apart and the alert must not pretend it can.
  // An alert with false positives is one people switch off in two weeks.
  const line = M.line(OVERDUE.find(x => x.property === 'The Chateau'));
  assert.ok(/No move-out inspection recorded/.test(line), line);
  assert.ok(!/nobody|did not do|was not done/i.test(line), line);
  assert.ok(/may be the walk/.test(line), 'the unrecognised ones are not surfaced');
});

t('an inspection done BEFORE the move-out does not count', () => {
  // That one was about the resident still living there.
  const early = [{ property_name: 'The Chateau', unit: '4', status: 'DONE',
    inspected_on: '2026-10-01', inspection_name: 'Move Out Damage and Occupancy Inspection' }];
  const out = M.walkOverdue({ turns: TURNS, inspections: early }, TODAY, { businessDays: 2 });
  assert.ok(out.some(a => a.property === 'The Chateau'));
});

t('an inspection that is open is not a pass, but it is said', () => {
  const open = [{ property_name: 'The Chateau', unit: '4', status: 'NEW',
    inspected_on: null, inspection_name: 'Move Out Damage and Occupancy Inspection' }];
  const a = M.walkOverdue({ turns: TURNS, inspections: open }, TODAY, { businessDays: 2 })
    .find(x => x.property === 'The Chateau');
  assert.strictEqual(a.openWalk, 'NEW');
  assert.ok(/an inspection is open \(NEW\)/.test(M.line(a)));
});

t('a turn-linked inspection counts even when its name is a person', () => {
  // THE WHOLE WIN. "Andres luevano" on turn 303 is the walk for turn 303, and
  // the 388 unreadable names stop mattering wherever the link exists.
  const turns = [{ property_name: 'Sunset Palms', unit: '12',
    move_out_date: '2026-10-07', unit_turn_id: '303' }];
  const insp = [{ property_name: 'Sunset Palms', unit: '12', unit_turn_id: '303',
    inspection_name: 'Andres luevano', status: 'DONE', inspected_on: '2026-10-08' }];
  const out = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 });
  assert.deepStrictEqual(out, [], 'a linked inspection was ignored because of its name');
});

t('an inspection linked to ANOTHER turn does not cover this one', () => {
  const turns = [{ property_name: 'The Chateau', unit: '4',
    move_out_date: '2026-10-08', unit_turn_id: '202' }];
  const insp = [{ property_name: 'The Chateau', unit: '4', unit_turn_id: '999',
    inspection_name: 'Move Out Damage and Occupancy Inspection',
    status: 'DONE', inspected_on: '2026-10-09' }];
  const out = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 });
  assert.strictEqual(out.length, 1, 'a perfectly-named inspection from another turn was accepted');
  assert.strictEqual(out[0].basis, 'turn');
});

t('the alert says which signal it used', () => {
  // A turn-linked verdict is structural. A name-based one is reading free text
  // and may be wrong, and the reader is told which they are looking at.
  const noTurn = [{ property_name: 'The Highlander', unit: '9', move_out_date: '2026-10-06' }];
  const a = M.walkOverdue({ turns: noTurn, inspections: [] }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.basis, 'name');
  assert.ok(/decided by inspection NAME/.test(M.line(a)), M.line(a));
  const withTurn = [{ property_name: 'The Chateau', unit: '4',
    move_out_date: '2026-10-08', unit_turn_id: '202' }];
  const b2 = M.walkOverdue({ turns: withTurn, inspections: [] }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(b2.basis, 'turn');
  assert.ok(!/decided by inspection NAME/.test(M.line(b2)));
});

t('the measurement separates turn from name from none', () => {
  // The breakdown is the point: "found by name only" is right about as often
  // as people type carefully, and a total hides that.
  const sc = src('scripts/measure-moveout-walks.js');
  assert.ok(/by unit_turn_id/.test(sc) && /by name only/.test(sc) && /none found/.test(sc));
  assert.ok(/MIGRATION 095 HAS NOT BEEN RUN/.test(sc),
    'it would report the old numbers under the new headings');
  // NOT an escaped BACKSLASH: /\./ matches nothing here, so the assertion
  // would pass whatever the script did.
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(/.test(sc), 'the measurement writes');
  assert.ok(/no resident name or unit was printed/.test(sc));
});

// ---- the brief -------------------------------------------------------------

t('the brief carries the section, in both renderings', () => {
  const mo = { today: M.moveOutsOn(TURNS, TODAY), walkOverdue: OVERDUE, sourceEmpty: false };
  const brief = B.build({ properties: [], moveOuts: mo });
  const text = B.render(brief, { today: TODAY });
  const html = H.renderHtml(brief, { today: TODAY });
  [['text', text], ['html', html]].forEach(([which, out]) => {
    assert.ok(/MOVE-OUTS|Move-outs/.test(out), which + ': no section');
    assert.ok(out.includes('Hyde Park Square'), which + ': today\'s move-out is missing');
    assert.ok(/The Chateau/.test(out), which + ': the overdue walk is missing');
    assert.ok(/free text/.test(out), which + ': the caveat is missing');
  });
});

t('NO INSPECTIONS AT ALL is a warning, not a clean week', () => {
  // A section that goes quiet because its source is empty is the most
  // expensive kind of quiet.
  const brief = B.build({ properties: [],
    moveOuts: { today: [], walkOverdue: [], sourceEmpty: true } });
  const text = B.render(brief, { today: TODAY });
  assert.ok(/broken source, not a clean week/.test(text), text.slice(0, 400));
  assert.ok(/broken source/.test(H.renderHtml(brief, { today: TODAY })));
});

// ---- verbal notices --------------------------------------------------------

t('anybody signed in can log a verbal notice', () => {
  // A technician standing in the unit is often the person who hears it, and a
  // form only leasing can reach is a form that does not get used.
  const s = src('server.js');
  const at = s.indexOf("app.post('/api/leasing/verbal-notices'");
  assert.ok(at > 0, 'the route is gone');
  assert.ok(/requireAuth/.test(s.slice(at, at + 120)), 'it is restricted by role');
  assert.ok(!/requireRole|requireMetricAdmin/.test(s.slice(at, at + 120)));
});

t('the warning is in the SUBJECT, not only in the body', () => {
  // A body that explains under a subject that does not gets forwarded without
  // the explanation.
  const s = src('server.js');
  assert.ok(/VERBAL_SUBJECT_PREFIX = 'VERBAL NOTICE \(not a formal notice\)'/.test(s));
  const at = s.indexOf('const subject = VERBAL_SUBJECT_PREFIX');
  assert.ok(at > 0, 'the subject does not use the prefix');
  const body = s.slice(at, at + 1500);
  assert.ok(/this is NOT the formal notice/i.test(body) || /NOT the formal notice/.test(body));
  assert.ok(/nothing has\s*\n?\s*'been filed in AppFolio|been filed in AppFolio/.test(body),
    'the mail does not say AppFolio was not touched');
  assert.ok(/written notice in the portal/.test(body), 'the reminder is missing');
});

t('the row survives a mail failure', () => {
  // A notice nobody emailed is still a notice somebody gave. Losing it because
  // Graph was down would be the worse failure.
  const s = src('server.js');
  const at = s.indexOf("app.post('/api/leasing/verbal-notices'");
  const block = s.slice(at, s.indexOf('// ---- lost-lead reasons', at));
  assert.ok(/notifyError = e\.message/.test(block), 'a send failure throws away the row');
  assert.ok(/notified_at: notified, notify_error: notifyError/.test(block),
    'a row could look notified when the send failed');
  // The insert happens BEFORE the send.
  assert.ok(block.indexOf('.insert(row)') < block.indexOf('briefSendMail'));
});

t('nothing in this feature writes to AppFolio', () => {
  const s = src('server.js');
  const at = s.indexOf('// ---- verbal notices');
  // Comments AND string literals stripped: the email body says "nothing has
  // been filed in AppFolio", and a test that matches the prose promising the
  // thing is a test that fails for saying so. Third time this file's own words
  // have tripped a search — strings count as prose too.
  const block = s.slice(at, s.indexOf('// ---- On-call rotation', at))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.ok(!/appfolio|syncReport/i.test(block),
    'a verbal-notice route touches AppFolio');
  // And the promise itself is still in the mail.
  assert.ok(/been filed in AppFolio/.test(s.slice(at, s.indexOf('// ---- On-call rotation', at))),
    'the email no longer says AppFolio was not touched');
});

// ---- lost-lead reasons -----------------------------------------------------

t('NO COUNT READS the loss reason', () => {
  // The promise Kara was given. A promise nobody checks is a promise.
  ['lib/kpi-report.js', 'lib/kpi-build.js', 'lib/goal-board-split.js']
    .filter(f => fs.existsSync(path.join(__dirname, '..', f)))
    .forEach(f => assert.ok(!/loss_reason/.test(src(f)), f + ' reads loss_reason'));
  // And the KPI/Goal Board route code does not either.
  const s = src('server.js');
  const reads = (s.match(/loss_reason/g) || []).length;
  const inFeature = (s.slice(s.indexOf('// ---- lost-lead reasons'),
    s.indexOf('// ---- On-call rotation')).match(/loss_reason/g) || []).length;
  assert.strictEqual(reads, inFeature,
    'loss_reason is read somewhere outside its own routes — check it is not a count');
});

t('a retired reason is not deleted', () => {
  // A history that changes when somebody edits a dropdown is not a history.
  const s = src('server.js');
  const at = s.indexOf("app.post('/api/leasing/loss-reasons'");
  const block = s.slice(at, at + 1200);
  assert.ok(/update\(\{ active: false \}\)/.test(block));
  assert.ok(!/\.delete\(/.test(block), 'the route deletes reasons');
  const sql = src('supabase/migrations/094_verbal_notices_and_loss_reasons.sql');
  assert.ok(/Retired rather than deleted/.test(sql));
  assert.ok(/add column if not exists loss_reason/i.test(sql));
});

t('the six reasons Kara named are seeded', () => {
  const sql = src('supabase/migrations/094_verbal_notices_and_loss_reasons.sql');
  ['Price', 'Did not qualify', 'Chose another property', 'No response',
    'Area / location', 'Objection to the unit']
    .forEach(r => assert.ok(sql.includes("'" + r + "'"), r + ' is not seeded'));
});

// ---- the screens -----------------------------------------------------------

t('the move-out panel says which signal decided each alert', () => {
  // A reader should know when they are being told something read off free
  // text. 'turn id' is structural; 'by name' may be wrong.
  const app = src('public/app.js');
  assert.ok(/function loadMoveOutAlerts/.test(app));
  const fn = app.slice(app.indexOf('function loadMoveOutAlerts'), app.indexOf('function loadVerbalNotices'));
  assert.ok(/turn id/.test(fn) && /by name/.test(fn), 'the basis is not shown');
  assert.ok(/may be the walk/.test(fn), 'the unrecognised inspections are not listed');
  assert.ok(/d\.caveat/.test(fn), 'the screen drops the caveat the route sends');
  assert.ok(!/FAS|Final Account/.test(fn), 'an unapproved FAS alert reached the screen');
});

t('the verbal-notice form leads with what it is NOT', () => {
  const html = src('public/index.html');
  const at = html.indexOf('id="vn-wrap"');
  assert.ok(at > 0, 'the form is missing');
  const block = html.slice(at, at + 1600);
  assert.ok(/not<\/b> the formal notice/.test(block), 'the warning is not on the form');
  assert.ok(/nothing is written to AppFolio/.test(block));
  assert.ok(/written\s*\n?\s*notice in the portal/.test(block), 'the reminder is missing');
});

t('the confirmation repeats the reminder, not "saved"', () => {
  const app = src('public/app.js');
  const at = app.indexOf("document.getElementById('vn-form')");
  const fn = app.slice(at, app.indexOf('// ---- lost-lead reasons', at));
  assert.ok(/esc\(d\.reminder\)/.test(fn), 'the reminder from the server is thrown away');
  // A failed email must not read as a clean save.
  assert.ok(/d\.notifyError/.test(fn) && /tell Bekah and Kara yourself/.test(fn));
});

t('an open verbal notice is visible as open', () => {
  const app = src('public/app.js');
  const fn = app.slice(app.indexOf('function loadVerbalNotices'), app.indexOf('async function vnMarkWritten'));
  assert.ok(/still waiting on written notice/.test(fn));
  assert.ok(/mark written notice received/.test(fn));
  assert.ok(/not emailed/.test(fn), 'a row could look notified when the send failed');
});

t('marking the written notice does not delete the verbal one', () => {
  // The gap between the two dates is the thing worth seeing.
  const s = src('server.js');
  const at = s.indexOf("app.post('/api/leasing/verbal-notices/:id/written'");
  assert.ok(at > 0, 'the route is missing');
  const block = s.slice(at, at + 900);
  assert.ok(/update\(\{ written_notice_received: when \}\)/.test(block));
  assert.ok(!/\.delete\(/.test(block));
});

t('the loss-reason dropdown is empty-safe and wired to one route', () => {
  const app = src('public/app.js');
  assert.ok(/function lossReasonSelect/.test(app));
  const fn = app.slice(app.indexOf('function lossReasonSelect'), app.indexOf('function wireLossReasonSelects'));
  // An empty select would read as "no reason" rather than "not loaded".
  assert.ok(/if \(!LOSS_REASONS\.length\) return ''/.test(fn));
  assert.ok(/leads\/' \+ encodeURIComponent/.test(app));
  // Retired reasons are not offered, but the list still shows them.
  assert.ok(/\.filter\(r => r\.active\)/.test(app));
  assert.ok(/stays on the leads already annotated/.test(app));
});

// ---- the probe that could not see the report -------------------------------

t('the probe can read a report that is not in the registry', () => {
  // inspection_detail is pulled by the maintenance sync, not by
  // appfolio-reports.js, so "Pass a report id" was the only answer the probe
  // had for the one report somebody needed to look at.
  const s = src('scripts/probe-report-columns.js');
  assert.ok(/function reportsApiPull/.test(s));
  assert.ok(/APPFOLIO_REPORTS_CLIENT_ID/.test(s), 'it uses the wrong credentials');
  assert.ok(/paginate_results: false/.test(s),
    'without this AppFolio answers with a shape fetchReport cannot unwrap');
  assert.ok(/no cell value was printed/.test(s), 'it could print resident data');
  assert.ok(!/writeJSON|syncReport/.test(s), 'a probe that writes is not a probe');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
