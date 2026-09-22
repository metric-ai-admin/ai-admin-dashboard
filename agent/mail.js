// Graph sendMail for the agent service.
//
// Same mechanism as the dashboard's eodSendEmail(): an application
// (client-credential) token against /users/{sender}/sendMail — there is no
// signed-in user, so me/sendMail is not an option.
//
// Deliberately NOT importing server.js's helper: that one is wired to the
// dashboard's MSAL client and its file-backed token cache on the dashboard's
// disk, neither of which exists in this container. Client-credential tokens
// need no cache (server.js passes skipCache:true for exactly that reason), so
// a direct token request is the whole implementation.
//
// Replaces the reference script's SMTP + EMAIL_PASSWORD path. No new secret:
// this reuses the GRAPH_* credentials the dashboard already has.

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const SENDER = process.env.AGENT_MAIL_SENDER || process.env.EOD_SENDER || 'support@livewithmetric.com';
const RECIPIENT = process.env.AGENT_MAIL_TO || 'lyndsay@metricpropertymanagement.com';

function graphConfigured() {
  return !!(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET);
}

async function graphToken() {
  if (!graphConfigured()) throw new Error('Graph not configured — set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`${TOKEN_HOST}/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => null);
  // Never echo the response body on failure: a token endpoint error can quote
  // back the request, and the request carries the client secret.
  if (!r.ok || !j?.access_token) throw new Error(`Graph token request failed (${r.status})`);
  return j.access_token;
}

async function sendMail({ subject, html, to = RECIPIENT }) {
  const token = await graphToken();
  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(SENDER)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Graph sendMail ${r.status} (sender ${SENDER}): ${body.slice(0, 300) || r.statusText}`);
  }
  return { sender: SENDER, recipient: to };
}

// Sent when the saved browser profile is no longer signed in. Deliberately
// tells Lyndsay what to do rather than just reporting a failure: the session
// only comes back by a human completing the SMS challenge in the setup page.
function reauthEmailHtml({ reason, lastGoodAt, setupUrl, checkedAt }) {
  const when = d => (d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT' : 'never');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222;max-width:640px">
  <h2 style="margin:0 0 4px;font-size:18px">AppFolio Forms Agent — re-authentication needed</h2>
  <p style="margin:0 0 16px;color:#666">The agent could not reach AppFolio as a signed-in user, so <strong>it did not run today</strong>. No forms were countersigned or resent.</p>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">
    <tr><td style="padding:4px 14px 4px 0;color:#666">Detected</td><td style="padding:4px 0">${when(checkedAt)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666">Reason</td><td style="padding:4px 0">${reason}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666">Last signed in</td><td style="padding:4px 0">${when(lastGoodAt)}</td></tr>
  </table>
  <p style="margin:0 0 8px"><strong>To fix it:</strong> open the setup page below and sign in to AppFolio once. You will get an SMS code — that is expected, because this is a new browser. After that the agent reuses the session and will not ask again until it expires.</p>
  <p style="margin:0 0 18px"><a href="${setupUrl}" style="background:#2563eb;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open setup page</a></p>
  <p style="margin:0;color:#888;font-size:12px">You will get this reminder at most once every 24 hours until the session is restored.</p>
</div>`;
}

module.exports = { sendMail, reauthEmailHtml, graphConfigured, SENDER, RECIPIENT };
