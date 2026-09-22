// AppFolio Forms Agent — service entrypoint.
//
// PHASE A ONLY. This service checks whether its saved AppFolio session is still
// valid and asks Lyndsay to sign in again when it is not. It does NOT open the
// forms table, countersign anything, resend anything, or change any record in
// AppFolio. Phase B adds that, and is not approved yet.
//
// Runs as a Render web service rather than a cron job because:
//   - a cron job has no HTTP surface, and the one-time sign-in needs one;
//   - a cron job cannot mount a disk shared with the dashboard, and Render
//     forbids sharing disks between services at all;
//   - a disk pins a service to a single instance, so this in-process schedule
//     cannot double-fire. That matters once Phase B is signing documents.

const http = require('http');
const cron = require('node-cron');
const { verifySession, readState, writeState, profileExists, APPFOLIO_URL } = require('./session');
const { sendMail, reauthEmailHtml, graphConfigured, RECIPIENT } = require('./mail');

const PORT = Number(process.env.PORT || 10000);
const TIMEZONE = process.env.AGENT_TIMEZONE || 'America/Chicago';
const SCHEDULE = process.env.AGENT_SCHEDULE || '0 8 * * *';   // 08:00 CT daily
const PUBLIC_URL = process.env.AGENT_PUBLIC_URL || '';
// Shared secret so the dashboard can read status without a user session. Same
// idea as METRIC_API_KEY on the dashboard side.
const AGENT_KEY = process.env.AGENT_API_KEY || '';

const REAUTH_EMAIL_EVERY_MS = 24 * 60 * 60 * 1000;

const log = (...a) => console.log(`[forms-agent ${new Date().toISOString()}]`, ...a);

// ---- the daily job ----------------------------------------------------------

/**
 * Phase A run: verify the session, and email once a day at most if it is gone.
 *
 * Throttled deliberately. A dead session persists until a human fixes it, and
 * without throttling every scheduled run — plus every manual check — would send
 * another "please sign in" email. One a day is a reminder; six is noise that
 * gets filtered, and then the real one is missed.
 */
async function runDailyCheck({ trigger = 'schedule' } = {}) {
  log(`run start (${trigger})`);
  const result = await verifySession();

  if (result.authenticated) {
    log('session OK —', result.url);
    return { ok: true, authenticated: true, checkedAt: result.checkedAt };
  }

  if (result.error) {
    // Could not complete the check at all. Not the same as "logged out", so no
    // email — this is a service problem, visible in the status endpoint.
    log('CHECK FAILED (not treated as logged out):', result.reason);
    return { ok: false, authenticated: false, error: result.reason, checkedAt: result.checkedAt };
  }

  log('session EXPIRED —', result.reason);
  const state = await readState();
  const last = state.lastReauthEmailAt ? Date.parse(state.lastReauthEmailAt) : 0;
  const due = !last || (Date.now() - last) >= REAUTH_EMAIL_EVERY_MS;

  if (!due) {
    log('re-auth email suppressed — already sent within 24h');
    return { ok: false, authenticated: false, emailed: false, reason: result.reason, checkedAt: result.checkedAt };
  }
  if (!graphConfigured()) {
    log('WARNING: session expired but Graph is not configured — cannot notify');
    return { ok: false, authenticated: false, emailed: false, reason: result.reason, checkedAt: result.checkedAt };
  }

  try {
    await sendMail({
      subject: 'AppFolio Forms Agent — re-authentication needed',
      html: reauthEmailHtml({
        reason: result.reason,
        lastGoodAt: state.lastGoodAt,
        checkedAt: result.checkedAt,
        setupUrl: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/+$/, '')}/setup` : '(setup URL not configured)',
      }),
    });
    await writeState({ lastReauthEmailAt: new Date().toISOString() });
    log(`re-auth email sent to ${RECIPIENT}`);
    return { ok: false, authenticated: false, emailed: true, reason: result.reason, checkedAt: result.checkedAt };
  } catch (err) {
    log('re-auth email FAILED:', err.message);
    return { ok: false, authenticated: false, emailed: false, emailError: err.message, checkedAt: result.checkedAt };
  }
}

// ---- HTTP surface -----------------------------------------------------------
// Minimal on purpose. /status is what the dashboard card will read; /setup is a
// placeholder until the remote-browser sign-in page lands (the rest of Phase A).

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
};

const authorized = req => !AGENT_KEY || req.headers['x-agent-key'] === AGENT_KEY;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  if (url.pathname === '/status') {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const state = await readState();
    return json(res, 200, {
      ...state,
      profileExists: await profileExists(),
      appfolioUrl: APPFOLIO_URL,
      schedule: SCHEDULE,
      timezone: TIMEZONE,
      phase: 'A — session lifecycle only; no AppFolio actions are performed',
    });
  }

  // Manual trigger for the Run Now button. POST only: a GET would be fetched by
  // link scanners and browser prefetch.
  if (url.pathname === '/check' && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    try { return json(res, 200, await runDailyCheck({ trigger: 'manual' })); }
    catch (err) { return json(res, 500, { error: err.message }); }
  }

  if (url.pathname === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Forms Agent setup</title>
<body style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#222">
<h1 style="font-size:20px">AppFolio Forms Agent — setup</h1>
<p>The remote sign-in page is not built yet. It is the remaining piece of Phase A.</p>
<p>Until then this service only reports whether its saved session is still valid;
it performs no actions in AppFolio.</p>
</body>`);
  }

  json(res, 404, { error: 'Not found' });
});

// ---- boot -------------------------------------------------------------------

server.listen(PORT, () => {
  log(`listening on ${PORT}`);
  log(`schedule ${SCHEDULE} (${TIMEZONE})`);
  log(`target ${APPFOLIO_URL}`);
  log('PHASE A — session checks only; no AppFolio actions');
});

cron.schedule(SCHEDULE, () => {
  runDailyCheck({ trigger: 'schedule' }).catch(err => log('scheduled run threw:', err.message));
}, { timezone: TIMEZONE });

// One check shortly after boot so a deploy surfaces a dead session without
// waiting for 08:00. Delayed so it does not compete with startup.
setTimeout(() => {
  runDailyCheck({ trigger: 'startup' }).catch(err => log('startup check threw:', err.message));
}, 20000);

// CLI: `node index.js --check-session` runs one check and exits. Used to verify
// the image locally without waiting for the schedule.
if (process.argv.includes('--check-session')) {
  runDailyCheck({ trigger: 'cli' })
    .then(r => { log('result:', JSON.stringify(r)); process.exit(r.authenticated ? 0 : 1); })
    .catch(err => { log('error:', err.message); process.exit(2); });
}
