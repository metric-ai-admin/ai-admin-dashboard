// Bekah's corrections of 2026-10-13, and the three things that went with them.
//
// The make-ready rule is the one that matters. We shipped a brief that filed
// every 90+ day unit turn as paperwork, on reasoning that sounded right and was
// wrong: she checked them and "they aren't done". Units empty for over a year
// were being hidden by the rule meant to reduce noise, which is the most
// expensive possible direction for a mistake like that to run.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../lib/kara-brief-gather.js');
const B = require('../lib/kara-brief.js');
const H = require('../lib/kara-brief-html.js');
const MRA = require('../lib/make-ready-audit.js');
const WB = require('../weekly-brief.js');
const DRH = require('../lib/daily-report-history.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const TODAY = '2026-10-13';
const AN = 'Ascent at Northgate';

console.log('bekah corrections');

// ---- 1b. the rent roll decides, not the age --------------------------------

const VACANT = new Set([AN + '|5-127', AN + '|3-109', AN + '|7-204']);
const TURNS = [
  { property_name: AN, unit: '5-127', move_out_date: '2025-06-10' }, // vacant, 490d
  { property_name: AN, unit: '7-204', move_out_date: '2026-01-02' }, // vacant, 284d
  { property_name: AN, unit: '3-109', move_out_date: '2026-10-06' }, // vacant, 7d
  { property_name: AN, unit: '9-900', move_out_date: '2025-01-01' }, // OCCUPIED
  { property_name: AN, unit: '4-410', move_out_date: '2026-09-01', turn_end_date: '2026-09-20' },
];
const MR = G.makeReadiesFrom(TURNS, TODAY, { vacantUnits: VACANT, staleDays: 90 });

t('a 490-day turn on a VACANT unit is work, not a record', () => {
  // THE CORRECTION. The old rule sent this to "records to clean up".
  assert.strictEqual(MR[AN].open, 3, 'the three vacant units are all open work');
  assert.strictEqual(MR[AN].oldest, 490);
  assert.strictEqual(MR[AN].staleCount, 1, 'only the occupied one is a record');
});

t('an OCCUPIED unit is a record however old the turn is', () => {
  assert.strictEqual(MR[AN].staleCount, 1);
  assert.strictEqual(MR[AN].staleOldest, 650);
});

t('the 90+ vacant ones get their own count and their units', () => {
  assert.strictEqual(MR[AN].longOpen, 2);
  assert.strictEqual(MR[AN].longOpenOldest, 490);
  assert.deepStrictEqual(MR[AN].longOpenUnits.map(u => u.unit), ['5-127', '7-204'],
    'oldest first, and it names the units so somebody can go and look');
});

t('a finished turn is still finished', () => {
  assert.ok(!MR[AN].longOpenUnits.some(u => u.unit === '4-410'));
  assert.strictEqual(MR[AN].open + MR[AN].staleCount, 4);
});

t('no unit number is treated as work, not quietly dropped', () => {
  // Unverifiable. Chasing a done one costs a phone call; hiding a real empty
  // unit costs a month of rent.
  const m = G.makeReadiesFrom([{ property_name: AN, move_out_date: '2026-10-01' }],
    TODAY, { vacantUnits: new Set(), staleDays: 90 });
  assert.strictEqual(m[AN].open, 1);
});

const PROP = {
  name: AN, occupancyPct: 0.95, goalPct: 0.90, delinquency: 100,
  makeReadyOpen: 3, makeReadyOldestDays: 490,
  longOpenMakeReadies: 2, longOpenOldestDays: 490,
  longOpenUnits: [{ unit: '5-127', days: 490, since: '2025-06-10' },
    { unit: '7-204', days: 284, since: '2026-01-02' }],
  staleMakeReadies: 1, staleMakeReadyOldest: 650,
};

t('long-open make-readies turn a property red, with the number of days', () => {
  const flags = B.flagsFor(PROP, B.thresholdsFor(AN, []));
  const f = flags.find(x => x.kind === 'long_open_make_ready');
  assert.ok(f, 'it is not flagged at all');
  assert.ok(/2 make-readies open over 90 days on vacant units/.test(f.text), f.text);
  assert.ok(/oldest 490/.test(f.text), 'the age is the point and it must be on the flag');
});

t('a property with only occupied-unit records is NOT red for it', () => {
  const flags = B.flagsFor({ name: AN, staleMakeReadies: 9, staleMakeReadyOldest: 700 },
    B.thresholdsFor(AN, []));
  assert.ok(!flags.some(f => f.kind === 'long_open_make_ready'));
});

t('both renderings carry the new section, with the units', () => {
  const brief = B.build({ properties: [PROP], portfolio: null, freshness: null });
  const text = B.render(brief, { today: TODAY });
  const html = H.renderHtml(brief, { today: TODAY });
  [['text', text], ['html', html]].forEach(([which, out]) => {
    assert.ok(/Long-open make-readies \(90\+ days\)/i.test(out), which + ': no section');
    assert.ok(out.includes('5-127'), which + ': it does not name the unit');
    assert.ok(/490/.test(out), which + ': no age');
  });
  assert.ok(text.indexOf('LONG-OPEN MAKE-READIES') < text.indexOf('RECORDS TO CLEAN UP'),
    'work must come before paperwork');
});

t('the footnote no longer says a 90-day turn is a record', () => {
  const brief = B.build({ properties: [PROP] });
  const text = B.render(brief, { today: TODAY });
  assert.ok(!/past 90 days, or on an occupied unit, it is a record/.test(text));
  assert.ok(/On an OCCUPIED unit it is a record/.test(text));
});

// ---- 1a. the workbook ------------------------------------------------------

const RENT_ROLL = [
  { property_name: AN, unit: '5-127', status: 'Vacant-Unrented' },
  { property_name: AN, unit: '7-204', status: 'Vacant-Rented' },
  { property_name: AN, unit: '3-109', status: 'Vacant-Unrented' },
  { property_name: AN, unit: '9-900', status: 'Current' },
];
const WOS = [
  { property_name: AN, unit: '5-127', work_order_type: 'unit_turn', work_order_number: '24231',
    status: 'Assigned', created_at: '2026-09-01' },
  { property_name: AN, unit: '3-109', type: 'tenant_requested', work_order_number: '9', status: 'New' },
];
const ROWS = MRA.turnRows({ turns: TURNS, rentRoll: RENT_ROLL, workOrders: WOS }, TODAY);

t('one row per OPEN turn, oldest first', () => {
  assert.strictEqual(ROWS.length, 4, 'the finished turn is not a row');
  // Sorted by days open, which is what was asked for — so the 650-day record
  // on an occupied unit leads. It is not hidden for being a record; the
  // Verdict column is what tells them apart.
  assert.deepStrictEqual(ROWS.map(r => r.unit), ['9-900', '5-127', '7-204', '3-109']);
  assert.strictEqual(ROWS[0].days, 650);
});

t('the sheet says what the rent roll says, in words and raw', () => {
  const r = ROWS.find(x => x.unit === '9-900');
  assert.strictEqual(r.unitToday, 'occupied');
  assert.strictEqual(r.unitStatusRaw, 'Current');
  assert.strictEqual(MRA.describeStatus('Notice-Rented', true), 'occupied, on notice');
});

t('the verdict on the sheet is the rule the brief applies', () => {
  assert.ok(/LONG-OPEN/.test(ROWS.find(x => x.unit === '5-127').verdict));
  assert.ok(/record to clean up/.test(ROWS.find(x => x.unit === '9-900').verdict));
  assert.strictEqual(ROWS.find(x => x.unit === '3-109').verdict, 'make-ready in progress');
});

t('a make-ready with no work order says so — it is a finding', () => {
  // Nobody is working a turn that has no work order, whatever the turn says.
  assert.strictEqual(ROWS.find(x => x.unit === '5-127').workOrder, '24231');
  assert.strictEqual(ROWS.find(x => x.unit === '7-204').workOrderStatus, 'none found');
  // A tenant request on the unit is not a make-ready and must not be claimed.
  assert.strictEqual(ROWS.find(x => x.unit === '3-109').workOrderStatus, 'none found');
});

t('the summary counts work and records apart', () => {
  const s = MRA.summarise(ROWS)[0];
  assert.strictEqual(s.open, 3);
  assert.strictEqual(s.longOpen, 2);
  assert.strictEqual(s.records, 1);
  assert.strictEqual(s.oldest, 490);
  assert.strictEqual(s.noWorkOrder, 2);
});

t('no resident data in any cell', () => {
  const text = JSON.stringify(ROWS) + JSON.stringify(MRA.summarise(ROWS));
  ['tenant', 'phone', 'email', 'resident'].forEach(k =>
    assert.ok(!new RegExp(k, 'i').test(text), k + ' reached the sheet'));
});

t('applications carry the unit and the age, never the applicant', () => {
  const apps = [
    { property_name: 'Windy Hill Apartment', unit: '1101', application_date: '2026-10-01',
      status: 'Decision Pending', detailed_status: 'In Screening',
      applicant_name: 'X', email: 'x@y.z' },
    { property_name: 'Windy Hill Apartment', unit: '1102', application_date: '2026-09-01',
      status: 'Canceled' },
    { property_name: AN, unit: '1', application_date: '2026-10-01', status: 'Decision Pending' },
  ];
  const out = MRA.applicationRows(apps, 'Windy Hill Apartment', TODAY);
  assert.strictEqual(out.length, 1, 'cancelled is not pending, and it is one property');
  assert.strictEqual(out[0].days, 12);
  assert.ok(!/applicant_name|x@y\.z/.test(JSON.stringify(out)));
});

t('the route exists, is admin-only, and resolves its own modules', () => {
  // A route that references an identifier server.js does not bind throws the
  // first time anybody calls it, with every source-reading test still green —
  // which is how "AFP is not defined" shipped. So: no bare identifier.
  const s = src('server.js');
  const at = s.indexOf("'/api/reports/make-ready-audit.xlsx'");
  assert.ok(at > 0, 'the route is gone');
  const block = s.slice(at, at + 3200);
  assert.ok(/requireMetricAdmin/.test(block.slice(0, 200)), 'it is not admin-only');
  assert.ok(/require\('\.\/appfolio-reports\.js'\)/.test(block), 'it uses an unbound identifier');
  assert.ok(/require\('\.\/lib\/make-ready-audit\.js'\)/.test(block));
  assert.ok(/sheetName\(/.test(block), 'a 32-character property name breaks the whole workbook');
});

t('a sheet name Excel would reject cannot be produced', () => {
  const s = src('server.js');
  const m = s.match(/function sheetName\(s\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'sheetName is gone');
  // eslint-disable-next-line no-new-func
  const fn = new Function('return (' + m[0].replace('function sheetName', 'function') + ')')();
  assert.strictEqual(fn('Windy Hill Apartment'), 'Windy Hill Apartment');
  assert.strictEqual(fn('A/B:C*D?E[F]G').indexOf('/'), -1);
  assert.ok(fn('x'.repeat(60)).length <= 31);
});

// ---- 2. the Monday Brief's two windows -------------------------------------

t('retrospective means the 7 days before the brief, by default', () => {
  // Bekah, 2026-10-13. The first reading of "like the owners' KPI report" took
  // it for Sun-Sat, which is the dashboard's convention and NOT her report's:
  // she said on 10-08 "the KPI report doesn't use sunday-saturday", and
  // Ascent's ran 09/30-10/06, a Wednesday to a Tuesday.
  const b = WB.buildWeeklyBrief({}, { today: '2026-10-12' });
  assert.strictEqual(b.lookback.start, '2026-10-05');
  assert.strictEqual(b.lookback.end, '2026-10-11');
  assert.strictEqual(b.lookback.mode, 'rolling');
  assert.strictEqual(WB.LOOKBACK_DEFAULT, 'rolling');
  assert.ok(/7 days to 2026-10-11/.test(b.lookback.label),
    'a reader must not have to guess which seven days');
  assert.ok(/not the Sun-Sat week/.test(b.lookback.label),
    'the difference from the Goal Board is the thing most likely to confuse');
});

t('a rolling window ends the day BEFORE the brief, never on the day itself', () => {
  // A brief that counts today has counted a day that is not over.
  ['2026-10-12', '2026-10-13', '2026-10-18'].forEach(d => {
    const r = WB.lookbackOf(d);
    assert.strictEqual(r.end, WB.addDays(d, -1), d);
    assert.strictEqual(WB.addDays(r.start, 7), d, d + ': not seven days');
  });
});

t('the Sun-Sat reading is still there, so switching is a parameter', () => {
  const r = WB.lookbackOf('2026-10-12', 'kpi');
  assert.strictEqual(r.start, '2026-10-04');
  assert.strictEqual(r.end, '2026-10-10');
  assert.deepStrictEqual(WB.LOOKBACK_MODES, ['rolling', 'kpi']);
});

t('forward-looking sections stay on the week in progress', () => {
  const b = WB.buildWeeklyBrief({}, { today: '2026-10-12' });
  assert.strictEqual(b.windows.forward.start, b.week.start);
  assert.strictEqual(b.windows.forward.end, b.week.end);
  ['moveIns', 'moveOuts', 'tours'].forEach(k =>
    assert.ok(b.windows.forward.sections.includes(k), k + ' moved to the lookback'));
  assert.notStrictEqual(b.windows.forward.start, b.lookback.start,
    'the two windows must not silently be the same');
});

// ---- 6. the snapshot taken before its own day ------------------------------

const LATE = {
  state_date: '2026-10-03', generated_at: '2026-10-03T01:03:27.006+00:00',
  total_tasks: 243, completed_tasks: 0,
};
const FINE = {
  state_date: '2026-10-02', generated_at: '2026-10-02T22:38:33.966+00:00',
  total_tasks: 243, completed_tasks: 0,
};

t('a snapshot written before its day began is not a record of that day', () => {
  // 2026-10-03T01:03Z is 2026-10-02 20:03 CT. Its 243 tasks are Thursday's.
  assert.strictEqual(DRH.capturedBeforeItsDay(LATE), true);
  assert.strictEqual(DRH.capturedBeforeItsDay(FINE), false);
});

t('the history shows "no record (captured late)" and no figures', () => {
  const out = DRH.fallbackFromState(LATE, '2026-10-03');
  assert.strictEqual(out.note, 'no record (captured late)');
  assert.strictEqual(out.available, false);
  assert.strictEqual(out.total_tasks, undefined, "another day's number must not be shown");
  assert.ok(/before the day began/.test(out.reason), 'it must say why');
});

t('a normal day still shows its figures', () => {
  const out = DRH.fallbackFromState(FINE, '2026-10-02');
  assert.strictEqual(out.total_tasks, 243);
  assert.ok(!out.note || !/captured late/.test(out.note));
});

t('a note written in the table wins, and nothing is deleted', () => {
  const marked = { ...FINE, capture_note: 'no record (captured late)' };
  assert.strictEqual(DRH.fallbackFromState(marked, '2026-10-02').available, false);
  const s = src('scripts/mark-cc-late-capture.js');
  assert.ok(!/\.delete\(/.test(s), 'the script deletes rows');
  assert.ok(/DRY RUN/.test(s) && /--write/.test(s));
  assert.ok(/capturedBeforeItsDay/.test(s), 'it hard-codes the date instead of the rule');
});

t('the server asks for capture_note without betting the query on it', () => {
  // Migration 090 may not have been run. An unknown column fails the WHOLE
  // select, and losing the fallback to gain a column is the wrong trade.
  const s = src('server.js');
  const at = s.indexOf('capture_note');
  assert.ok(at > 0);
  const block = s.slice(at - 500, at + 700);
  assert.ok(/capture_note.*test\(stErr\.message|\/capture_note\/\.test/.test(block),
    'there is no fallback when the column is missing');
});

// ---- 3. the reset nobody could use -----------------------------------------

t('a temporary password is admin-only and never logged', () => {
  const s = src('server.js');
  const at = s.indexOf("'/api/auth/admin/temp-password'");
  assert.ok(at > 0, 'the route is gone');
  const block = s.slice(at, at + 2600);
  assert.ok(/requireMetricAdmin/.test(block.slice(0, 160)), 'anybody can issue one');
  const gen = s.slice(s.indexOf('function tempPassword'), at);
  assert.ok(/require\('crypto'\)\.randomBytes/.test(gen),
    'server.js binds no `crypto`, and Math.random is not a password source');
  // The ACT is logged; the credential is not.
  const log = block.slice(block.indexOf('activityLog.log'), block.indexOf('res.json'));
  assert.ok(!/password/.test(log.replace(/temp_password_issued/g, '')),
    'the activity log carries the password');
});

t('a must-change session can do exactly one thing', () => {
  // A must-change screen the browser draws is a suggestion. Anybody who closes
  // the dialog would otherwise be signed in with a password an admin knows.
  const s = src('server.js');
  const m = s.match(/function requireAuth\(req, res, next\) \{[\s\S]*?\n\}/);
  assert.ok(m && /mustChangePassword/.test(m[0]), 'the flag is not enforced server-side');
  assert.ok(/req\.path !== '\/api\/auth\/change-password'/.test(m[0]));
});

t('changing a password proves you know the old one', () => {
  const s = src('server.js');
  // Anchored on the route and not on the path: requireAuth names the same
  // string, and indexOf would have measured the wrong block.
  const at = s.indexOf("app.post('/api/auth/change-password'");
  assert.ok(at > 0);
  const block = s.slice(at, at + 3000);
  assert.ok(/signInWithPassword/.test(block), 'a stolen cookie could change the password');
  assert.ok(/must_change_password: false/.test(block), 'the flag is never cleared');
  assert.ok(/jwt\.sign/.test(block), 'she would stay locked out after changing it');
});

t('the login page stops promising a reset link that cannot arrive', () => {
  // Three independent failures: @metric.internal receives no mail, redirectTo
  // lands on a page with no recovery handling, and there was no change screen.
  const h = src('public/login.html');
  assert.ok(/does not work yet/.test(h), 'it still offers the reset as if it worked');
  assert.ok(/change-section/.test(h) && /api\/auth\/change-password/.test(h));
  assert.ok(/mustChangePassword/.test(h), 'the login response is ignored');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
