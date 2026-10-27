// The inspection type label. DISPLAY ONLY.
//
// Jay, 2026-10-27: a reader cannot tell a move-out walk from a make-ready
// from a technician's name without opening each one. So each inspection on
// the Collections screen now says what kind it is.
//
// THE DANGEROUS PART IS NOT THE LABEL, IT IS THE LABEL LEAKING INTO MATCHING.
// isWalk() answers "is this the walk for this turn" and a turn id outranks
// every name rule in it. inspectionType() answers "what does this name look
// like" and knows nothing else. If the second ever feeds the first, a
// turn-linked inspection named "Untitled" stops being the walk because of a
// word, and the state column goes quietly wrong on a screen Karla trusts to
// decide deposits. That separation is asserted here, not remembered.
//
// AND ONE RULE HERE IS NEW. MOVE_IN_NAME had no existing regex to come from.
// It is marked as such in the source and asserted below to be the ONLY new
// pattern, so the next person knows which five were read off live data.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const codeOf = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');

const MO = require('../lib/moveout-alerts.js');
const libCode = codeOf(read('lib/moveout-alerts.js'));
const client = codeOf(read('public/app.js'));

const ins = (name, extra) => Object.assign({ inspection_name: name }, extra || {});
const typeOf = name => MO.inspectionType(ins(name));

console.log('inspections — the type label');

// ---- the six categories ----------------------------------------------------

t('real names from the live data land where a reader would put them', () => {
  // Taken from the names this repo has actually seen, not invented.
  assert.strictEqual(typeOf('Move Out Occupancy Inspection'), 'Move-out walk');
  assert.strictEqual(typeOf('Move-Out Damage Inspection'), 'Move-out walk');
  assert.strictEqual(typeOf('FAS'), 'FAS');
  assert.strictEqual(typeOf('Final Account Statement'), 'FAS');
  assert.strictEqual(typeOf('General Make Ready Items'), 'Make-ready');
  assert.strictEqual(typeOf('make-ready'), 'Make-ready');
  assert.strictEqual(typeOf('Move In Inspection'), 'Move-in');
  assert.strictEqual(typeOf('Andres luevano'), 'Other');
  assert.strictEqual(typeOf('Mike redy'), 'Other');
});

t('UNTITLED IS ITS OWN ANSWER, not Other', () => {
  // Jay asked for these separate because they mean different things: "Other"
  // is a name our rules do not know, "Untitled" is nobody having named it.
  // 34 rows carry the literal string and some carry nothing at all.
  assert.strictEqual(typeOf('Untitled'), 'Untitled');
  assert.strictEqual(typeOf('untitled'), 'Untitled');
  assert.strictEqual(typeOf(''), 'Untitled');
  assert.strictEqual(MO.inspectionType({}), 'Untitled');
  assert.strictEqual(MO.inspectionType(null), 'Untitled');
  // But a name that merely CONTAINS it is a name somebody wrote.
  assert.strictEqual(typeOf('Untitled 114 walk'), 'Other');
});

t('the order is fixed, so an ambiguous name has one answer', () => {
  // These satisfy two patterns each. The point is not which answer is
  // "right" — it is that the answer does not depend on who reads the code.
  assert.strictEqual(typeOf('FAS move out occupancy'), 'Move-out walk');
  assert.strictEqual(typeOf('Make ready FAS'), 'FAS');
  assert.strictEqual(typeOf('Move out inspection then move in'), 'Move-out walk');
});

t('A MOVE-OUT NAME CAN NEVER BE READ AS A MOVE-IN', () => {
  // /move[\s-]*in/i is the one new rule and it is the one that could do real
  // damage: "move-out inspection" contains no "move in", but a sloppier
  // pattern or a reordering would make the walk column lie.
  ['Move Out Occupancy Inspection', 'Move-Out Damage Inspection', 'move out damage']
    .forEach(n => assert.notStrictEqual(typeOf(n), 'Move-in', n + ' read as a move-in'));
});

t('every answer is one of the six declared categories', () => {
  ['Move Out Occupancy Inspection', 'FAS', 'General Make Ready Items', 'Move In',
    'Untitled', 'Andres luevano', '', 'Monthly Management Inspection']
    .forEach(n => assert.ok(MO.INSPECTION_TYPES.indexOf(typeOf(n)) >= 0,
      typeOf(n) + ' is not a declared category'));
  assert.deepStrictEqual(MO.INSPECTION_TYPES,
    ['Move-out walk', 'Make-ready', 'FAS', 'Move-in', 'Untitled', 'Other']);
});

t('the routine inspections are Other, not Make-ready', () => {
  // They were one inline pattern before the split. Monthly/annual/renewal
  // are excluded from WALKS for the same reason make-ready is, but they are
  // not make-readies and a reader should not be told they are.
  assert.strictEqual(typeOf('Monthly Management Inspection'), 'Other');
  assert.strictEqual(typeOf('Annual Renewal Inspection'), 'Other');
});

// ---- one set of rules, not two ---------------------------------------------

t('THE MAKE-READY RULE WAS LIFTED OUT, NOT COPIED', () => {
  // The whole requirement: no second set of rules. If the inline pattern
  // came back, isUnrecognised and the label could drift apart silently.
  assert.ok(!/make\[\\s-\]\*ready\|monthly/.test(libCode),
    'the old combined inline pattern is back alongside the named ones');
  assert.match(libCode, /MAKE_READY_NAME\.test\(name\)/);
  assert.match(libCode, /ROUTINE_NAME\.test\(name\)/);
});

t('the split did not change what isUnrecognised does', () => {
  // The behaviour that existed before the refactor, re-asserted against the
  // same names the old inline pattern was written for.
  const un = n => MO.isUnrecognised(ins(n));
  assert.strictEqual(un('General Make Ready Items'), false);
  assert.strictEqual(un('Monthly Management Inspection'), false);
  assert.strictEqual(un('Annual Renewal Inspection'), false);
  assert.strictEqual(un('Move Out Occupancy Inspection'), false, 'a walk is not unrecognised');
  assert.strictEqual(un('FAS'), false);
  assert.strictEqual(un('Andres luevano'), true, 'a technician name must stay unrecognised');
  assert.strictEqual(un('Untitled'), true);
});

t('MOVE_IN_NAME is the only pattern not read off live data', () => {
  // Written down so nobody later assumes all six came from the same place.
  ['WALK_NAME', 'FAS_NAME', 'MAKE_READY_NAME', 'ROUTINE_NAME', 'MOVE_IN_NAME']
    .forEach(k => assert.ok(MO[k] instanceof RegExp, k + ' is not exported'));
  const src = read('lib/moveout-alerts.js');
  const at = src.indexOf('const MOVE_IN_NAME');
  assert.ok(at > 0);
  assert.match(src.slice(Math.max(0, at - 900), at), /THE ONE NEW RULE/,
    'the new rule is no longer flagged as new in the source');
});

// ---- it must never feed matching -------------------------------------------

t('MATCHING DOES NOT READ THE LABEL', () => {
  // The assertion this file exists for. isWalk/isFas/matchWalk decide state;
  // none of them may consult a display string.
  const fns = ['function isWalk', 'function isFas', 'function matchWalk',
    'function isUnrecognised'];
  fns.forEach(f => {
    const at = libCode.indexOf(f);
    assert.ok(at > 0, f + ' moved');
    const body = libCode.slice(at, libCode.indexOf('\n}', at));
    assert.ok(!/inspectionType|INSPECTION_TYPES/.test(body),
      f + ' now consults the display label');
  });
});

t('a turn-linked inspection is still the walk whatever it is called', () => {
  // The concrete failure the separation prevents: the turn id wins, and the
  // label says "Untitled" beside it without changing the answer.
  const row = { inspection_name: 'Untitled', unit_turn_id: '202' };
  assert.strictEqual(MO.isWalk(row, { turnId: '202' }), true,
    'the label broke turn-id matching');
  assert.strictEqual(MO.inspectionType(row), 'Untitled',
    'the label was bent to agree with matching');
});

t('the state of a row does not depend on the label', () => {
  const at = libCode.indexOf('function collectionsView');
  const body = libCode.slice(at, libCode.indexOf('rows.sort(', at));
  assert.ok(!/inspectionType|\.type\b/.test(body),
    'collectionsView decides a state using the type label');
});

// ---- it reaches the screen --------------------------------------------------

t('every described inspection carries its type', () => {
  // One place, so the row, the still-empty official one and the others on the
  // unit all get it — rather than three call sites, two of which get forgotten.
  const d = MO.describeInspection({
    inspection_id: '1451', inspection_name: 'Jose reyes', status: 'DONE',
    created_by: 'Erick Frey',
  });
  assert.strictEqual(d.type, 'Other');
  assert.strictEqual(d.createdBy, 'Erick Frey', 'created by was lost');
  assert.strictEqual(MO.describeInspection(null), null);
});

t('the client prints the type, escaped, and omits it when absent', () => {
  assert.match(client, /ins\.type \?[^\n]*esc\(ins\.type\)/,
    'the type is printed unescaped, or not printed');
  assert.ok(!/\+ ins\.type/.test(client), 'ins.type is concatenated without esc()');
  // Omitted rather than blanked: a response served before this shipped has no
  // type, and "· " alone reads as a type we failed to work out.
  const at = client.indexOf('const kind =');
  assert.ok(at > 0, 'the type chip is gone');
  assert.match(client.slice(at, at + 40), /ins\.type \?/,
    'the chip does not check there is a type to show');
});

t('the type sits outside the link, not inside the name', () => {
  const at = client.indexOf('function moInspectionLink');
  const body = client.slice(at, client.indexOf('\n}', at));
  assert.match(body, /: label\) \+ kind/, 'the type was folded into the anchor text');
});

// ---- the Other count --------------------------------------------------------

t('collectionsView counts the types it shows', () => {
  const turns = [
    { property_name: 'Highlander', unit: '114', move_out_date: '2026-10-01' },
  ];
  const inspections = [
    { inspection_id: '1', inspection_name: 'Andres luevano', property_name: 'Highlander',
      unit: '114', status: 'Done', inspected_on: '2026-10-05' },
    { inspection_id: '2', inspection_name: 'Untitled', property_name: 'Highlander',
      unit: '114', status: 'Done', inspected_on: '2026-10-06' },
  ];
  const v = MO.collectionsView({ turns, inspections }, '2026-10-27', {});
  assert.ok(v.typeCounts, 'no type counts');
  assert.strictEqual(v.typeCounts.Other, 1);
  assert.strictEqual(v.typeCounts.Untitled, 1);
  assert.strictEqual(v.typeTotal, 2);
  // Every declared category is present as a key, so a zero reads as zero
  // rather than as a category that was never counted.
  MO.INSPECTION_TYPES.forEach(k => assert.strictEqual(typeof v.typeCounts[k], 'number',
    k + ' is missing from typeCounts'));
});

t('AN INSPECTION ON TWO ROWS IS COUNTED ONCE', () => {
  // The same inspection can be a row's answer and another row's "also on this
  // unit". Counting it twice would inflate the Other number on a screen whose
  // whole purpose is telling Jay how bad the naming is.
  const turns = [
    { property_name: 'HPS', unit: '114', move_out_date: '2026-10-01' },
    { property_name: 'HPS', unit: '114', move_out_date: '2026-10-02' },
  ];
  const inspections = [
    { inspection_id: '7', inspection_name: 'Andres luevano', property_name: 'HPS',
      unit: '114', status: 'Done', inspected_on: '2026-10-05' },
  ];
  const v = MO.collectionsView({ turns, inspections }, '2026-10-27', {});
  assert.strictEqual(v.rows.length, 2, 'the fixture no longer makes two rows');
  assert.strictEqual(v.typeTotal, 1, 'one inspection was counted on both rows');
  assert.strictEqual(v.typeCounts.Other, 1);
});

t('the screen says WHICH inspections it counted', () => {
  // A bare "301 Other" next to a screen showing twelve rows would be compared
  // against the probe's full-table number and read as the backlog shrinking.
  const at = client.indexOf('const tc = c.typeCounts');
  assert.ok(at > 0, 'the type summary is gone');
  const body = client.slice(at, at + 700);
  assert.match(body, /shown on this screen/, 'the denominator is not stated');
  assert.match(body, /c\.typeTotal/, 'the total is not the one that was counted');
  assert.match(body, /tc\.Untitled/, 'untitled is folded into Other on screen');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
