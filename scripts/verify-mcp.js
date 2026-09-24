#!/usr/bin/env node
//
// End-to-end check of a deployed MCP service.
//
//   MCP_AUTH_TOKEN=<token> node scripts/verify-mcp.js https://metric-mcp.onrender.com
//
// The token is read from the environment and never printed, so this can be run
// and its output pasted anywhere without leaking it.
//
// WHAT IT CHECKS, and why each one is here:
//
//   /health              the service is up, and reports MCP_ONLY + a remote
//                        upstream — a service still on loopback would answer
//                        tool calls from its own empty disk.
//   surface              MCP_ONLY means /, /app.js and /api/* are 404. If they
//                        answer, the dashboard is being republished at a second
//                        public URL over resident and collections data.
//   no token / bad token both 401. The endpoint fails closed.
//   initialize           the MCP handshake, and a session id comes back.
//   tools/list           49 tools. A short count means mcp-tools.cjs did not
//                        fully register.
//   tools/call           THE ONE THAT MATTERS. Everything above passes even
//                        when METRIC_API_KEY on the MCP service does not match
//                        the dashboard's — the mismatch only shows when a tool
//                        actually proxies, and it comes back as "the dashboard
//                        returned 401" rather than as a connection error.

const BASE = (process.argv[2] || 'https://metric-mcp.onrender.com').replace(/\/+$/, '');
const TOKEN = process.env.MCP_AUTH_TOKEN || '';
const URL_MCP = `${BASE}/mcp`;

const EXPECTED_TOOLS = 49;

let failures = 0;
const ok = (name, detail = '') => console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
const bad = (name, detail = '') => { failures++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); };

const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  ...extra,
});

// The StreamableHTTP transport may answer as SSE ("event: message\ndata: {...}")
// or as plain JSON depending on the request. Handle both rather than assuming.
function parseBody(text) {
  const line = text.split('\n').find(l => l.startsWith('data:'));
  try { return JSON.parse(line ? line.slice(5).trim() : text); } catch { return null; }
}

async function rpc(body, sessionId) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: headers(sessionId ? { 'mcp-session-id': sessionId } : {}),
    body: JSON.stringify(body),
  });
  return { res, json: parseBody(await res.text()) };
}

(async () => {
  console.log(`\nVerifying ${BASE}\n`);

  // ---- health ----
  console.log('service');
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    h.status === 'ok' ? ok('/health responds') : bad('/health responds', JSON.stringify(h));
    h.mcp_only === true ? ok('MCP_ONLY is on') : bad('MCP_ONLY is on', `mcp_only=${h.mcp_only} — this service would also publish the dashboard UI`);
    h.mcp_upstream === 'remote' ? ok('upstream is remote') : bad('upstream is remote', `mcp_upstream=${h.mcp_upstream} — MCP_UPSTREAM_URL is not set, so tools read this service's own (empty) state`);
    h.crons_enabled === false ? ok('crons are off here') : bad('crons are off here', 'ENABLE_CRONS is set on the MCP service — the nightly jobs would run TWICE');
  } catch (e) { bad('/health responds', e.message); }

  // ---- surface ----
  console.log('\nsurface (MCP_ONLY)');
  for (const p of ['/', '/app.js', '/api/tasks', '/login.html']) {
    try {
      const r = await fetch(`${BASE}${p}`);
      r.status === 404 ? ok(`${p} is 404`) : bad(`${p} is 404`, `got ${r.status} — the dashboard is exposed here`);
    } catch (e) { bad(`${p} is 404`, e.message); }
  }

  // ---- auth ----
  console.log('\nauth');
  for (const [label, hdrs] of [['no token', {}], ['wrong token', { Authorization: 'Bearer not-the-token' }]]) {
    try {
      const r = await fetch(URL_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...hdrs }, body: '{}' });
      r.status === 401 ? ok(`${label} is rejected`) : bad(`${label} is rejected`, `got ${r.status}`);
    } catch (e) { bad(`${label} is rejected`, e.message); }
  }

  if (!TOKEN) {
    console.log('\n  MCP_AUTH_TOKEN is not set in this shell — skipping the handshake.');
    console.log('  Re-run as:  MCP_AUTH_TOKEN=<token> node scripts/verify-mcp.js ' + BASE);
    process.exitCode = 1;
    return;
  }

  // ---- handshake ----
  console.log('\nMCP protocol');
  let sessionId = null;
  try {
    const res = await fetch(URL_MCP, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-mcp', version: '1' } } }),
    });
    sessionId = res.headers.get('mcp-session-id');
    const j = parseBody(await res.text());
    const name = j && j.result && j.result.serverInfo && j.result.serverInfo.name;
    name ? ok('initialize', `serverInfo.name=${name}`) : bad('initialize', JSON.stringify(j));
    sessionId ? ok('session established') : bad('session established', 'no mcp-session-id header');
  } catch (e) { bad('initialize', e.message); }

  if (sessionId) {
    await fetch(URL_MCP, { method: 'POST', headers: headers({ 'mcp-session-id': sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

    try {
      const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
      const tools = (json && json.result && json.result.tools) || [];
      tools.length === EXPECTED_TOOLS
        ? ok('tools/list', `${tools.length} tools`)
        : bad('tools/list', `${tools.length} tools, expected ${EXPECTED_TOOLS}`);
    } catch (e) { bad('tools/list', e.message); }

    // The real one: this has to travel MCP service -> HTTPS -> dashboard.
    try {
      const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'get_operational_tasks', arguments: {} } }, sessionId);
      const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
      if (!text) bad('tools/call proxies to the dashboard', JSON.stringify(json).slice(0, 200));
      else if (/returned 401|returned 403/.test(text)) bad('tools/call proxies to the dashboard', 'the dashboard rejected the key — METRIC_API_KEY here does not match the dashboard\'s');
      else if (/Could not reach the dashboard/.test(text)) bad('tools/call proxies to the dashboard', 'MCP_UPSTREAM_URL is wrong or the dashboard is down');
      else {
        let n = null;
        try { const parsed = JSON.parse(text); n = Array.isArray(parsed) ? parsed.length : null; } catch { /* not an array */ }
        ok('tools/call proxies to the dashboard', n == null ? `${text.length} chars returned` : `${n} tasks returned`);
      }
    } catch (e) { bad('tools/call proxies to the dashboard', e.message); }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exitCode = failures ? 1 : 0;
})();
