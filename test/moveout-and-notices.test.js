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

// The move-out section is OFF unless somebody turns it on. Tests about what
// the section SAYS switch it on; whether it appears at all is its own test.
const SECTION_ON = [{ property: '*', move_out_section_enabled: true }];
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

t('an open inspection is reported as open, not as missing', () => {
  // This used to assert "not a pass, but it is said" — one state with a note.
  // It is its own state now: somebody has to close it, not re-walk the unit.
  const open = [{ property_name: 'The Chateau', unit: '4', status: 'NEW',
    inspected_on: null, inspection_name: 'Move Out Damage and Occupancy Inspection' }];
  const a = M.walkOverdue({ turns: TURNS, inspections: open }, TODAY, { businessDays: 2 })
    .find(x => x.property === 'The Chateau');
  assert.strictEqual(a.state, 'open');
  assert.strictEqual(a.openWalk, 'NEW');
  assert.ok(/NOT marked done in AppFolio/.test(M.line(a)));
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

t('an inspection linked to another turn is still read by NAME', () => {
  // This test used to assert the opposite, and the opposite was the bug: a
  // non-matching turn id vetoed the name, so when the two id namespaces did
  // not line up nothing could ever match. A turn id is a positive signal only.
  const turns = [{ property_name: 'The Chateau', unit: '4',
    move_out_date: '2026-10-08', unit_turn_id: '202' }];
  const insp = [{ property_name: 'The Chateau', unit: '4', unit_turn_id: '999',
    inspection_name: 'Move Out Damage and Occupancy Inspection',
    status: 'DONE', inspected_on: '2026-10-09' }];
  const out = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 });
  assert.strictEqual(out.length, 0, 'the name pass did not run');
});

t('the alert says which signal it used', () => {
  // 'turn' only when the link actually produced candidates. A turn id that
  // matched nothing means the verdict rests on names, and saying "turn" there
  // would claim a structural certainty we do not have.
  const noTurn = [{ property_name: 'The Highlander', unit: '9', move_out_date: '2026-10-06' }];
  const a = M.walkOverdue({ turns: noTurn, inspections: [] }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.basis, 'name');
  assert.ok(/no turn id on this move-out/.test(M.line(a)), M.line(a));

  const linked = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-06', unit_turn_id: 'T1' }];
  const insp = [{ property_name: 'A', unit: '1', unit_turn_id: 'T1',
    inspection_name: 'Untitled', status: 'NEW', inspected_on: '2026-10-07' }];
  const b2 = M.walkOverdue({ turns: linked, inspections: insp }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(b2.basis, 'turn', 'the link produced a candidate and was not credited');
  assert.strictEqual(b2.openWalk, 'NEW');
});

t('the measurement names what it cannot do', () => {
  const sc = src('scripts/measure-moveout-walks.js');
  assert.ok(/MIGRATION 095 HAS NOT BEEN RUN/.test(sc),
    'it would report the old numbers under the new headings');
  // NOT an escaped BACKSLASH: /\./ matches nothing here, so the assertion
  // would pass whatever the script did.
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(/.test(sc), 'the measurement writes');
  assert.ok(/no resident name or unit was printed/.test(sc));
});

t('the id diagnostic reads every column, not a guessed shortlist', () => {
  // A list of names I thought of is how we got here.
  const sc = src('scripts/diagnose-turn-ids.js');
  assert.ok(/Object\.keys\(t \|\| \{\}\)\.forEach/.test(sc));
  assert.ok(/IN INSPECTIONS/.test(sc), 'it does not report the overlap');
  assert.ok(/no unit or resident name was printed/.test(sc));
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(/.test(sc), 'the diagnostic writes');
});

// ---- the three states (Arturo, 2026-10-14) ---------------------------------
//
// The measurement found it: 33 of 39 move-outs had an inspection named like a
// walk and only 6 were DONE, and those 6 were thrown away on a date. The walks
// are HAPPENING; what is missing is the click in AppFolio. Reporting all 33 as
// "no inspection" would send people to re-walk units that were already walked,
// which is how an alert gets switched off.

t('a turn-linked inspection counts WHATEVER its date', () => {
  // The date rule exists to stop a walk from the previous tenancy counting, and
  // a turn id already rules that out — a stronger statement than any date.
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08', unit_turn_id: 'T1' }];
  const insp = [{ property_name: 'A', unit: '1', unit_turn_id: 'T1',
    inspection_name: 'Untitled', status: 'DONE', inspected_on: '2026-10-01' }];
  assert.deepStrictEqual(M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 }), [],
    'a linked, done inspection was rejected on a date the link had already answered');
});

t('the date rule still applies to the NAME fallback', () => {
  // Without a turn id there is nothing else to tell this move-out's walk from
  // the last one's.
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08' }];
  const insp = [{ property_name: 'A', unit: '1', inspection_name: 'Move Out Inspection',
    status: 'DONE', inspected_on: '2026-10-01' }];
  const out = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].state, 'none');
  assert.strictEqual(out[0].tooEarly.length, 1);
});

t('"exists but not marked done" is its own state', () => {
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08', unit_turn_id: 'T1' }];
  const insp = [{ property_name: 'A', unit: '1', unit_turn_id: 'T1',
    inspection_name: 'Move Out Inspection', status: 'NEW', inspected_on: '2026-10-09' }];
  const a = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.state, 'open');
  assert.strictEqual(a.openName, 'Move Out Inspection');
  const l = M.line(a);
  assert.ok(/NOT marked done in AppFolio/.test(l), l);
  // The advice changed on 2026-10-14: the open records are empty, so closing
  // one records a walk that never happened.
  assert.ok(/check it before closing it/.test(l), l);
  assert.ok(!/No move-out inspection recorded/.test(l), 'it still reads as missing');
});

t('only "none" means go and inspect', () => {
  assert.deepStrictEqual(M.STATES, ['done', 'open', 'none']);
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08' }];
  const a = M.walkOverdue({ turns, inspections: [] }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.state, 'none');
  assert.ok(/No move-out inspection recorded/.test(M.line(a)));
});

t('an open inspection found only by NAME is still "open"', () => {
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08' }];
  const insp = [{ property_name: 'A', unit: '1', inspection_name: 'Move Out Damage and Occupancy Inspection',
    status: 'IN PROGRESS', inspected_on: '2026-10-09' }];
  const a = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.state, 'open');
  assert.strictEqual(a.basis, 'name');
});

t('the brief and the panel keep the two apart', () => {
  // One heading for both sends people to re-walk units already walked.
  const open = { property: 'A', unit: '1', moveOut: '2026-10-08', due: '2026-10-12',
    state: 'open', openWalk: 'NEW', openName: 'Move Out Inspection', basis: 'turn',
    businessDaysOverdue: 2, tooEarly: [], unnamedInspections: [] };
  const none = { ...open, state: 'none', openWalk: null, openName: null, property: 'B' };
  const brief = B.build({ properties: [], thresholds: SECTION_ON,
    moveOuts: { today: [], walkOverdue: [open, none], sourceEmpty: false } });
  const text = B.render(brief, { today: TODAY });
  const html = H.renderHtml(brief, { today: TODAY });
  [['text', text], ['html', html]].forEach(([which, out]) => {
    assert.ok(/not marked done in AppFolio/i.test(out), which + ': no "open" section');
    assert.ok(/No move-out inspection recorded/i.test(out), which + ': no "missing" section');
  });
  const app = src('public/app.js');
  assert.ok(/a\.state === 'open'/.test(app), 'the panel shows one list');
  assert.ok(/all were empty/.test(app), 'the panel does not carry the finding');
});

t('the measurement reports the three states by property', () => {
  const sc = src('scripts/measure-moveout-walks.js');
  assert.ok(/THE THREE STATES/.test(sc));
  assert.ok(/inspection EXISTS, not marked done/.test(sc));
  assert.ok(/BY PROPERTY/.test(sc) && /done  open  none/.test(sc));
  assert.ok(/M\.matchWalk\(/.test(sc), 'it reimplements the rule again');
});

// ---- the brief -------------------------------------------------------------

t('the brief carries the section, in both renderings', () => {
  const mo = { today: M.moveOutsOn(TURNS, TODAY), walkOverdue: OVERDUE, sourceEmpty: false };
  // Switched ON explicitly: this test is about what the section SAYS. Whether
  // it appears at all is move_out_section_enabled, tested on its own above.
  const brief = B.build({ properties: [], moveOuts: mo, thresholds: SECTION_ON });
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
  const brief = B.build({ properties: [], thresholds: SECTION_ON,
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

// ---- what Erick found on 2026-10-14 ----------------------------------------
//
// He opened every open move-out inspection and ALL WERE EMPTY — no areas, no
// photos. In twenty of those units the real walk was recorded in a different
// inspection, under a technician's name or "Untitled".
//
// So "somebody has to close it, not re-walk the unit" was advice to record a
// walk that never happened in that record — and it is the record a charge to a
// resident rests on. Two changes, no new state: the wording, and attaching the
// evidence that was already being calculated and thrown away.

t('the open state no longer tells anybody to just close it', () => {
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08', unit_turn_id: 'T1' }];
  const insp = [{ property_name: 'A', unit: '1', unit_turn_id: 'T1',
    inspection_name: 'Move Out Inspection', status: 'NEW', inspected_on: '2026-10-09' }];
  const a = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 })[0];
  const l = M.line(a);
  assert.ok(/all were empty/.test(l), l);
  assert.ok(/check it before closing it/.test(l), l);
  assert.ok(!/not re-walk the unit/.test(l), 'the old advice survived');
  assert.ok(/2026-10-14/.test(l), 'the date of the check is not stated');
});

t('the open state carries the unrecognised inspections, like none does', () => {
  // THE TWENTY UNITS. An empty open shell plus the real walk under a
  // technician's name used to show as "open — close it" with no mention of the
  // other inspection: the alert hid the evidence exactly where somebody was
  // deciding whether to close an empty record.
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08', unit_turn_id: 'T1' }];
  const insp = [
    { property_name: 'A', unit: '1', unit_turn_id: 'T1',
      inspection_name: 'Move Out Damage and Occupancy Inspection', status: 'NEW',
      inspected_on: '2026-10-09' },
    { property_name: 'A', unit: '1', inspection_name: 'Andres luevano',
      status: 'DONE', inspected_on: '2026-10-10' },
  ];
  const a = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.state, 'open', 'this is not the fourth state');
  assert.strictEqual(a.unnamedInspections.length, 1);
  assert.strictEqual(a.unnamedInspections[0].name, 'Andres luevano');
  assert.strictEqual(a.unnamedInspections[0].inspectedOn, '2026-10-10');
  assert.strictEqual(a.unnamedInspections[0].status, 'DONE');
  assert.ok(/may be the walk/.test(M.line(a)));
});

t('the same is true when the open one was found by name', () => {
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08' }];
  const insp = [
    { property_name: 'A', unit: '1', inspection_name: 'Move Out Inspection',
      status: 'IN PROGRESS', inspected_on: '2026-10-09' },
    { property_name: 'A', unit: '1', inspection_name: 'Untitled',
      status: 'DONE', inspected_on: '2026-10-09' },
  ];
  const a = M.walkOverdue({ turns, inspections: insp }, TODAY, { businessDays: 2 })[0];
  assert.strictEqual(a.state, 'open');
  assert.strictEqual(a.unnamedInspections.length, 1);
});

t('NO FOURTH STATE was added', () => {
  // Jay and Bekah have not decided how inspections will be recorded, and a
  // fourth state is a patch over that decision.
  assert.deepStrictEqual(M.STATES, ['done', 'open', 'none']);
  // CODE ONLY. The file now records the decisions Erick's review produced, and
  // those name the state that is not built — a guard that matches the note
  // explaining why something is absent fires on the explanation. Fifth time
  // this repo's own prose has tripped one of my searches.
  const code = src('lib/moveout-alerts.js').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/probably done under another name/i.test(code));
  assert.ok(!/state\('probably/.test(code), 'a fourth state arrived');
});

t('all three renderings say it and show the evidence', () => {
  const open = { property: 'A', unit: '1', moveOut: '2026-10-08', due: '2026-10-12',
    state: 'open', openWalk: 'NEW', openName: 'Move Out Inspection', basis: 'turn',
    businessDaysOverdue: 2, tooEarly: [],
    unnamedInspections: [{ name: 'Andres luevano', status: 'DONE', inspectedOn: '2026-10-10' }] };
  const brief = B.build({ properties: [], thresholds: SECTION_ON,
    moveOuts: { today: [], walkOverdue: [open], sourceEmpty: false } });
  const text = B.render(brief, { today: TODAY });
  const html = H.renderHtml(brief, { today: TODAY });
  [['text', text], ['html', html]].forEach(([which, out]) => {
    assert.ok(/all were EMPTY|all were empty/.test(out), which + ': the finding is not stated');
    assert.ok(!/do not re-walk/i.test(out), which + ': the old advice survived');
  });
  assert.ok(html.includes('Andres luevano'), 'the html drops the evidence');
  const app = src('public/app.js');
  assert.ok(/all were empty/.test(app), 'the panels do not state the finding');
  assert.ok(!/Do not send anyone back to the unit/.test(app), 'the old advice survived on screen');
});

// ---- the email section is OFF until somebody turns it on -------------------
//
// Arturo, 2026-10-16: the section does not go in Kara's email until Erick has
// finished cleaning up the inspections, and KARA_BRIEF_TO is live — the next
// 6 AM send would have carried it.

const MO_FIXTURE = {
  today: [{ property: 'A', unit: '1', moveOut: '2026-10-16' }],
  walkOverdue: [{ property: 'B', unit: '2', moveOut: '2026-10-08', due: '2026-10-12',
    state: 'open', openWalk: 'NEW', openName: 'x', basis: 'turn',
    businessDaysOverdue: 2, tooEarly: [], unnamedInspections: [] }],
  sourceEmpty: false,
};

t('OFF when nothing says otherwise — no row, no column, null', () => {
  // The live brief_thresholds row has no such column, so the section is off
  // without migration 096 running at all. An absent column, an absent row and
  // a null must all mean off, or the email goes out tomorrow with it.
  [[], [{ property: '*', delinquency_over: 5000 }],
    [{ property: '*', move_out_section_enabled: null }],
    [{ property: '*', move_out_section_enabled: false }]].forEach(th => {
    const b = B.build({ properties: [], moveOuts: MO_FIXTURE, thresholds: th });
    assert.strictEqual(b.moveOutSection, false, JSON.stringify(th));
    assert.strictEqual(b.moveOuts, null, 'the data is still on the brief: ' + JSON.stringify(th));
    assert.ok(!/MOVE-OUTS/.test(B.render(b, { today: TODAY })), JSON.stringify(th));
    assert.ok(!/Move-outs/.test(H.renderHtml(b, { today: TODAY })), JSON.stringify(th));
  });
});

t('ON only when somebody writes true', () => {
  const b = B.build({ properties: [], moveOuts: MO_FIXTURE,
    thresholds: [{ property: '*', move_out_section_enabled: true }] });
  assert.strictEqual(b.moveOutSection, true);
  assert.ok(/MOVE-OUTS/.test(B.render(b, { today: TODAY })));
  assert.ok(/Move-outs/.test(H.renderHtml(b, { today: TODAY })));
});

t('the gate is in ONE place, so it cannot leak through one renderer', () => {
  // Dropping the data in build() means the email payload never carries it.
  // Gating in each renderer would mean a change to one and not the other
  // quietly puts the section back.
  const b = B.build({ properties: [], moveOuts: MO_FIXTURE, thresholds: [] });
  assert.strictEqual(b.moveOuts, null);
  const lib = src('lib/kara-brief.js');
  assert.ok(/moveOutSectionEnabled\(thresholds\) \? \(o\.moveOuts \|\| null\) : null/.test(lib));
});

t('the rest of the brief is untouched', () => {
  // PROP lives in test/bekah-corrections.test.js; a long-open property is
  // built here so this file does not depend on another one's fixture.
  const prop = { name: 'Ascent at Northgate', occupancyPct: 0.95, goalPct: 0.9,
    makeReadyOpen: 2, makeReadyOldestDays: 490,
    longOpenMakeReadies: 1, longOpenOldestDays: 490,
    longOpenUnits: [{ unit: '5-127', days: 490, since: '2025-06-10' }] };
  const b = B.build({ properties: [prop], moveOuts: MO_FIXTURE, thresholds: [] });
  const text = B.render(b, { today: TODAY });
  assert.ok(/being cleaned up with Maintenance/.test(text), 'the make-ready caveat vanished');
  assert.ok(/LONG-OPEN MAKE-READIES/.test(text), 'the long-open section vanished');
  assert.ok(!/MOVE-OUTS/.test(text), 'the move-out section came back');
});

t('Collections and Maintenance are NOT gated by it', () => {
  // Erick needs the register to do the clean-up. It is the EMAIL that waits.
  const s = src('server.js');
  ['/api/maintenance/moveout-alerts', '/api/maintenance/moveout-register'].forEach(r => {
    const at = s.indexOf("app.get('" + r + "'");
    assert.ok(at > 0, r + ' is gone');
    const block = s.slice(at, at + 600);
    assert.ok(!/move_out_section_enabled/.test(block), r + ' was gated by the email switch');
  });
  const app = src('public/app.js');
  assert.ok(!/move_out_section_enabled/.test(app), 'a panel reads the email switch');
});

t('migration 096 is not what turns it off', () => {
  // It is already off without running anything; the column exists so it can be
  // turned ON later without a deploy.
  const sql = src('supabase/migrations/096_brief_moveout_section.sql');
  assert.ok(/add column if not exists move_out_section_enabled/i.test(sql));
  assert.ok(/NOT WHAT TURNS IT OFF/.test(sql));
  assert.ok(!/UPDATE brief_thresholds SET move_out_section_enabled = false/i.test(sql),
    'it relies on a write to be safe');
});

// ---- the Maintenance view (Erick does not hold Collections) ----------------

t('the register returns EVERY move-out, not only the overdue', () => {
  // Erick is the person who closes an inspection or sends somebody back to a
  // unit. A list of only the failures cannot be checked against the ones that
  // went fine.
  const turns = [
    { property_name: 'A', unit: '1', move_out_date: '2026-10-08', unit_turn_id: 'T1' },
    { property_name: 'B', unit: '2', move_out_date: '2026-10-09' },
    { property_name: 'C', unit: '3', move_out_date: '2026-10-13' },
  ];
  const insp = [
    { property_name: 'A', unit: '1', unit_turn_id: 'T1', inspection_name: 'Untitled',
      status: 'DONE', inspected_on: '2026-10-02' },
    { property_name: 'B', unit: '2', inspection_name: 'Move Out Inspection',
      status: 'NEW', inspected_on: '2026-10-10' },
  ];
  const rows = M.register({ turns, inspections: insp }, TODAY, { days: 60 });
  assert.strictEqual(rows.length, 3, 'a move-out inside the window was dropped');
  assert.deepStrictEqual(rows.map(r => r.state), ['none', 'open', 'done'],
    'newest first: C none, B open, A done');
  // The inspection is NAMED, so somebody can open it instead of hunting for it.
  assert.strictEqual(rows[2].inspectionName, 'Untitled');
  assert.strictEqual(rows[2].inspectionDate, '2026-10-02');
  assert.strictEqual(rows[2].basis, 'turn');
  assert.strictEqual(rows[1].inspectionStatus, 'NEW');
});

t('a move-out outside the window is not in the register', () => {
  const turns = [{ property_name: 'A', unit: '1', move_out_date: '2026-01-01' }];
  assert.deepStrictEqual(M.register({ turns, inspections: [] }, TODAY, { days: 60 }), []);
});

t('NO BALANCE OR DELINQUENCY can reach the maintenance view', () => {
  // THE WHOLE POINT. Erick holds Maintenance and not Collections, and should
  // not: that tab carries balances. This is asserted on the payload and on the
  // screen, because "I did not add one" is not a control.
  const rows = M.register({
    turns: [{ property_name: 'A', unit: '1', move_out_date: '2026-10-08',
      balance: 1234, delinquent_rent: 999, amount_receivable: 50, tenant: 'Somebody' }],
    inspections: [],
  }, TODAY, { days: 60 });
  const text = JSON.stringify(rows);
  ['balance', 'delinquen', 'receivable', 'amount', 'tenant', 'resident']
    .forEach(k => assert.ok(!new RegExp(k, 'i').test(text), k + ' reached the register'));

  const s = src('server.js');
  const at = s.indexOf('async function moveOutRegisterData');
  const block = s.slice(at, s.indexOf("app.get('/api/maintenance/moveout-register.xlsx'", at))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/balance|delinquen|receivable/i.test(block), 'the route reads a balance');
});

t('the maintenance view is reachable by Erick and not by nobody', () => {
  const s = src('server.js');
  assert.ok(/MOVEOUT_ROLES = \['admin', 'maintenance'/.test(s), 'Erick cannot open it');
  assert.ok(/MOVEOUT_ROLES\.includes\(req\.user\?\.role\)/.test(s), 'the route is ungated');
  // Both the view and the export are gated the same way — an export that is
  // more permissive than the screen it came from is the leak.
  assert.strictEqual((s.match(/MOVEOUT_ROLES\.includes/g) || []).length, 2);
  const html = src('public/index.html');
  assert.ok(/data-maint-view="moveouts"/.test(html), 'the tab is missing');
  assert.ok(/No balances here/.test(html), 'the screen does not say what it leaves out');
});

t('Collections keeps its own view, unchanged', () => {
  const app = src('public/app.js');
  assert.ok(/function loadMoveOutAlerts/.test(app), 'the Collections panel was replaced');
  assert.ok(/function loadMoveOutRegister/.test(app));
  const s = src('server.js');
  assert.ok(/app\.get\('\/api\/maintenance\/moveout-alerts'/.test(s));
  assert.ok(/app\.get\('\/api\/maintenance\/moveout-register'/.test(s));
});

t('the export has one sheet per state, including the empty ones', () => {
  // A missing tab reads as "we did not look", which is the opposite of zero.
  const s = src('server.js');
  const at = s.indexOf("app.get('/api/maintenance/moveout-register.xlsx'");
  const block = s.slice(at, at + 2800);
  assert.ok(/\['none', 'open', 'done'\]\.forEach/.test(block));
  assert.ok(/'Summary'/.test(block), 'no summary sheet');
  assert.ok(/d\.caveat/.test(block), 'the caveat is not in the file people take to a meeting');
  assert.ok(/not a technician back at the unit/.test(block));
});

t('an empty inspections source is not a page of clean rows', () => {
  const app = src('public/app.js');
  const fn = app.slice(app.indexOf('function renderMoveOutRegister'));
  assert.ok(/sourceEmpty/.test(fn), 'an empty source would read as "no inspections done"');
  assert.ok(/because the source is empty/.test(fn));
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
