// "Opened a record" — the beacon, and the property stamp on a CRM write.
//
// The table already forbids resident names, notes and amounts. This adds two
// things the CLIENT can influence, so most of what follows is about what must
// never reach the column.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/activity-log.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const PROPS = ['Hyde Park Square', 'Ascent at Northgate', 'iConic Round Rock'];

console.log('activity — open beacon');

// ---- the entity type -----------------------------------------------------
t('a type is a slug, and anything else rejects the whole value', () => {
  assert.strictEqual(A.normalizeEntityType('work_order'), 'work_order');
  assert.strictEqual(A.normalizeEntityType('DELINQUENT_ACCOUNT'), 'delinquent_account');
  // Not stripped into shape: a name with the punctuation removed is still a name.
  assert.strictEqual(A.normalizeEntityType('Gonzalez, Maria'), null);
  assert.strictEqual(A.normalizeEntityType('unit 112 — balance 1,240'), null);
  assert.strictEqual(A.normalizeEntityType('a'.repeat(41)), null);
  assert.strictEqual(A.normalizeEntityType(''), null);
  assert.strictEqual(A.normalizeEntityType(null), null);
});

// ---- the entity id -------------------------------------------------------
t('an id has to look like an id', () => {
  assert.strictEqual(A.normalizeEntityId('24231'), '24231');
  assert.strictEqual(A.normalizeEntityId('a1b2c3d4-1111-2222-3333-444455556666'),
    'a1b2c3d4-1111-2222-3333-444455556666');
});

t('THE DECISION-QUEUE KEY CAN NEVER BE STORED AS AN ID', () => {
  // Its key is "property|unit|name". If a screen ever passed it by mistake the
  // shape test drops it, and the open is still recorded without it — which is
  // the behaviour that makes the mistake harmless instead of a leak.
  assert.strictEqual(A.normalizeEntityId('Hyde Park Square|112|Gonzalez, Maria'), null);
  assert.strictEqual(A.normalizeEntityId('Gonzalez, Maria'), null);
  assert.strictEqual(A.normalizeEntityId('maria@example.com'), null);
});

t('a missing id is null, not a crash', () => {
  [null, undefined, '', '   '].forEach(v => assert.strictEqual(A.normalizeEntityId(v), null));
});

// ---- the property --------------------------------------------------------
t('the property is CHECKED against the real list, not sanitised', () => {
  // This is the one column where free text would look completely normal, so a
  // pattern test protects nothing. Only a name that exists is stored.
  assert.strictEqual(A.normalizeProperty('Hyde Park Square', PROPS), 'Hyde Park Square');
  assert.strictEqual(A.normalizeProperty('  hyde park square ', PROPS), 'Hyde Park Square',
    'should match case-insensitively and return the stored spelling');
  assert.strictEqual(A.normalizeProperty('Gonzalez, Maria', PROPS), null);
  assert.strictEqual(A.normalizeProperty('Hyde Park Square, unit 112, $1,240 owed', PROPS), null);
});

t('an empty or cold list stores nothing rather than trusting the caller', () => {
  assert.strictEqual(A.normalizeProperty('Hyde Park Square', []), null);
  assert.strictEqual(A.normalizeProperty('Hyde Park Square', null), null);
  assert.strictEqual(A.normalizeProperty(null, PROPS), null);
});

// ---- the row still obeys the old rules ------------------------------------
t('the allowlist and the forbidden-field rule are untouched', () => {
  const logged = [];
  const logger = A.createLogger(rows => { logged.push(...rows); return Promise.resolve(); },
    { setInterval: () => 0, flushMs: 1 });
  logger.log({ user_email: 'a@b.com', event: 'open', section: 'collections',
    entity_type: 'delinquent_account', property_name: 'Hyde Park Square', tenant: 'Maria' });
  logger.flushNow ? logger.flushNow() : null;
  // A forbidden key kills the whole row rather than being dropped from it.
  assert.strictEqual(logger.stats().queued, 0, 'a row carrying `tenant` was queued');
});

t('a clean open row is accepted', () => {
  const logger = A.createLogger(() => Promise.resolve(), { setInterval: () => 0 });
  logger.log({ user_email: 'a@b.com', event: 'open', section: 'collections',
    entity_type: 'delinquent_account', entity_id: '24231', property_name: 'Hyde Park Square' });
  assert.strictEqual(logger.stats().queued, 1);
});

// ---- the server ----------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

t('the beacon is registered BEFORE the write logger', () => {
  // Declared after it, every beacon would write two rows: the open it means
  // and a meaningless write to /api/activity. The same rule the view beacon
  // already follows.
  const open = CODE.indexOf("app.post('/api/activity/open'");
  const mw = CODE.indexOf("app.use('/api', activityWriteLogger)");
  assert.ok(open > 0 && mw > 0);
  assert.ok(open < mw, 'the open beacon would be logged twice');
});

t('it answers before it logs, and never from the body except the four fields', () => {
  const i = CODE.indexOf("app.post('/api/activity/open'");
  const body = CODE.slice(i, i + 1400);
  assert.ok(/res\.status\(204\)\.end\(\);/.test(body), 'it should answer first');
  assert.ok(/ACT\.normalizeSection\(b\.section\)/.test(body));
  assert.ok(/ACT\.normalizeEntityType\(b\.entity_type\)/.test(body));
  assert.ok(/ACT\.normalizeEntityId\(b\.entity_id\)/.test(body));
  assert.ok(/ACT\.normalizeProperty\(b\.property, actPropNames\)/.test(body),
    'the property must be checked against the cached real names');
  assert.ok(/requireAuth/.test(CODE.slice(i, i + 120)), 'the beacon is not behind requireAuth');
});

// The middleware's own body, bounded by its closing "});" — a fixed character
// window ran past it into the next route, which legitimately reads req.body.
function crmStampBody() {
  const i = CODE.indexOf("app.use('/api/crm/properties/:id'");
  assert.ok(i > 0, 'no CRM property stamp');
  const after = CODE.slice(i);
  return after.slice(0, after.indexOf('\n});') + 4);
}

t('the CRM property stamp comes from the PATH, never the body', () => {
  const body = crmStampBody();
  assert.ok(body.length > 60 && body.length < 600, 'slice looks wrong: ' + body.length);
  assert.ok(/req\.params\.id/.test(body), 'it does not read the id from the path');
  assert.ok(!/req\.body/.test(body), 'it reads the body — the audit would record whatever the caller wished');
  assert.ok(/res\.locals\.activityProperty = name/.test(body));
});

t('the stamp never blocks the write it is recording', () => {
  const body = crmStampBody();
  assert.ok(/catch \{/.test(body), 'an unhandled throw here would fail the user request');
  assert.ok(!/await/.test(body), 'the stamp must not add a round trip to the request path');
});

t('the write logger already carries property_name through', () => {
  assert.strictEqual(
    (CODE.match(/property_name: \(res\.locals && res\.locals\.activityProperty\) \|\| null/g) || []).length, 2,
    'both the export and the write logger should stamp it');
});

// ---- the client ----------------------------------------------------------
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CC = fs.readFileSync(path.join(__dirname, '..', 'public', 'command-center.js'), 'utf8');

t('one delegated listener serves every screen', () => {
  assert.ok(/function logRecordOpen\(type, id, property\)/.test(APP));
  assert.ok(/e\.target\.closest\?\.\('\[data-record-open\]'\)/.test(APP),
    'there should be a single delegated listener, not one per screen');
  assert.ok(/keepalive: true/.test(APP.slice(APP.indexOf('function logRecordOpen'))));
});

t('Collections marks the delinquency card, and sends NO id', () => {
  // COMMENTS STRIPPED: the note above the markup says "NO data-record-id", and
  // matching the raw text would fail on the very line documenting the rule.
  // This is the second time that has bitten this repo; hence the helper.
  const i = APP.indexOf('function dqCard(a)');
  const body = APP.slice(i, i + 900).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/data-record-open="delinquent_account"/.test(body));
  assert.ok(/data-record-property="\$\{dqEsc\(a\.property\)\}"/.test(body));
  assert.ok(!/data-record-id/.test(body), 'the dq key carries a resident name and must not be sent');
});

t('the Command Center marks the task card with the WO id and property', () => {
  assert.ok(/d\.dataset\.recordOpen = 'work_order'/.test(CC));
  assert.ok(/d\.dataset\.recordId = String\(t\.wo\.woId\)/.test(CC));
  assert.ok(/d\.dataset\.recordProperty = String\(t\.wo\.property\)/.test(CC));
  assert.ok(!/t\.wo\.tenant|primary_tenant|resident/.test(
    CC.slice(CC.indexOf("d.dataset.recordOpen"), CC.indexOf("d.dataset.recordOpen") + 300)),
    'no resident field may be attached to the beacon');
});

t('the section comes from the active tab, not from a literal', () => {
  const i = APP.indexOf('function logRecordOpen');
  const body = APP.slice(i, i + 900);
  assert.ok(/button\[data-tab\]\.active/.test(body));
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
