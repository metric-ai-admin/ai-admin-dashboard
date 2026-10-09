// Who gets the credit for a CRM row.
//
// Every assertion here replays a real failure: a whole table written with no
// agent at all (dm_reviews, 133 of 133), and an agent taken from the request
// body with nothing checking it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/crm-agent.js');

const ROSTER = ['Katie', 'Katrina', 'Erick', 'Rhoxie', 'Claudia', 'Lyndsay'];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- resolution ------------------------------------------------------------

test('the session is what counts', () => {
  assert.strictEqual(A.resolveAgent({ agentName: 'Katie' }, {}, ROSTER), 'Katie');
});

test('a user who is not a CRM agent stamps nothing, not their display name', () => {
  // Arturo, Jay, Bekah, Kara have agent_name null. Their writes stay
  // unattributed rather than inventing a fourth name for the queue to miss.
  assert.strictEqual(A.resolveAgent({ name: 'Arturo Mendoza', agentName: null }, {}, ROSTER), null);
});

test('the body cannot override the session', () => {
  // THE ONE THAT MATTERS. Without this, anyone could file their work under
  // somebody else's name by editing one field in a request.
  assert.strictEqual(A.resolveAgent({ agentName: 'Katie' }, { agent_name: 'Katrina' }, ROSTER), 'Katie');
});

test('a body name is accepted only when it is on the roster', () => {
  assert.strictEqual(A.resolveAgent({}, { agent_name: 'Katie' }, ROSTER), 'Katie');
  assert.strictEqual(A.resolveAgent({}, { agent_name: 'Nobody' }, ROSTER), null);
  assert.strictEqual(A.resolveAgent({}, { agent_name: 'Katie' }, []), null,
    'an empty roster must validate nothing, not everything');
});

test('a roster name matches regardless of case and space, and is stored as the roster spells it', () => {
  assert.strictEqual(A.resolveAgent({}, { agent_name: '  katie ' }, ROSTER), 'Katie');
});

test('no session and no body is null, never a guess', () => {
  assert.strictEqual(A.resolveAgent(null, null, ROSTER), null);
  assert.strictEqual(A.resolveAgent(undefined, {}, undefined), null);
});

test('the legacy `agent` spelling is honoured on the body', () => {
  assert.strictEqual(A.resolveAgent({}, { agent: 'Erick' }, ROSTER), 'Erick');
});

// ---- the spread guard ------------------------------------------------------

test('withoutAgentFields strips both spellings and copies', () => {
  const body = { score: 4, agent_name: 'Katrina', agent: 'Katrina', note: 'x' };
  const out = A.withoutAgentFields(body);
  assert.deepStrictEqual(out, { score: 4, note: 'x' });
  assert.strictEqual(body.agent_name, 'Katrina', 'must not mutate the request body');
  assert.deepStrictEqual(A.withoutAgentFields(null), {});
});

// ---- the routes actually use it --------------------------------------------
//
// A helper nothing calls fixes nothing. These read server.js, because that is
// where the bug was.

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  // Comments stripped: this file's own prose says "agent_name" many times and a
  // test must not pass by matching an explanation of itself.
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// The body of the route starting at `marker`, bounded by the next route so a
// match cannot come from the one after it.
function routeBody(marker) {
  const at = SERVER.indexOf(marker);
  assert.ok(at >= 0, 'route not found: ' + marker);
  const rest = SERVER.slice(at + marker.length);
  const next = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
  return rest.slice(0, next < 0 ? rest.length : next);
}

[
  ["app.post('/api/crm/properties/:id/follow-ups'", 'follow_ups'],
  ["app.post('/api/crm/properties/:id/phone-shops'", 'phone_shops'],
  ["app.post('/api/crm/properties/:id/online-shops'", 'online_shops'],
].forEach(([marker, table]) => {
  test(table + ' stamps the agent and drops the body one', () => {
    const body = routeBody(marker);
    assert.ok(/agent_name:\s*crmAgentFor\(req\)/.test(body),
      table + ' must stamp agent_name from the session');
    assert.ok(/CRMAG\.withoutAgentFields\(req\.body\)/.test(body),
      table + ' spreads req.body, so it must strip the agent fields first');
    assert.ok(!/\{\s*\.\.\.req\.body/.test(body),
      table + ' must not spread req.body raw');
  });
});

test('dm_reviews stamps the agent — the table where every row lost it', () => {
  const body = routeBody("app.put('/api/crm/properties/:id/dm-review'");
  assert.ok(/agent_name:\s*crmAgentFor\(req\)/.test(body),
    'the dm_reviews row literal must include agent_name');
});

test('crmAgentFor never trusts the body on its own', () => {
  const at = SERVER.indexOf('function crmAgentFor');
  assert.ok(at >= 0, 'crmAgentFor must exist');
  const fn = SERVER.slice(at, at + 400);
  assert.ok(/CRMAG\.resolveAgent\(req\.user,/.test(fn),
    'it must go through resolveAgent with the session first');
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
});
console.log('crm-agent: ' + (tests.length - failed) + '/' + tests.length);
if (failed) process.exit(1);
