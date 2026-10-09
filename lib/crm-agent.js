// Who did this piece of CRM work — decided on the server, from the session.
//
// WHY THIS EXISTS. The Task Queue's "Completed" count is derived: there is no
// task-done record, the logged row IS the completion. So a row written without
// an agent is work that happened and that nobody can be credited for, ever.
// On 2026-10-09 that was 736 rows, including two whole tables, and it surfaced
// as Katie reporting "0 completed" for a week in which she had done seventeen
// digital-marketing reviews.
//
// THE NAME MUST BE THE ONE THE QUEUE FILTERS ON. There are three namespaces in
// this system and they do not agree:
//
//   dashboard_users.name   "Katrina Marie Lopez"   the session's display name
//   bd_agents.name         "Katrina Lopez"         the roster
//   bd_agents.crm_alias    "Katrina"               what the shop tables hold
//
// dashboard_users.agent_name already holds the third one and already travels
// in the JWT as `agentName`. Stamping the display name instead would create a
// fourth namespace and break the filter in a new way.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

// The agent this session acts as, from the VERIFIED token. Null for a user who
// is not a CRM agent at all (Arturo, Jay, Bekah): their writes stay unattributed
// rather than being credited to a name that is not theirs.
function agentFromSession(user) {
  return clean(user && user.agentName) || null;
}

// A name supplied by the client, accepted only if it is one we know.
//
// The body is where the old code took this from, unchecked — which is how a
// form that forgot the field wrote a null, and how any caller could have
// written anybody's name. It is still accepted, because an admin logging a
// shop on somebody's behalf is a real thing, but only against the roster.
function validatedBodyAgent(body, known) {
  const wanted = clean(body && (body.agent_name || body.agent)).toLowerCase();
  if (!wanted) return null;
  const hit = (known || []).find(n => clean(n).toLowerCase() === wanted);
  return hit ? clean(hit) : null;
}

// The session wins. An explicit, VALID name in the body is used only when the
// session has no agent of its own — otherwise anyone could file their work
// under somebody else's name by editing a request.
function resolveAgent(user, body, known) {
  return agentFromSession(user) || validatedBodyAgent(body, known) || null;
}

// Strip any agent field the caller sent, so a route that spreads req.body
// cannot smuggle one past the rules above. Returns a new object.
function withoutAgentFields(body) {
  const out = Object.assign({}, body || {});
  delete out.agent_name;
  delete out.agent;
  return out;
}

module.exports = { agentFromSession, validatedBodyAgent, resolveAgent, withoutAgentFields, clean };
