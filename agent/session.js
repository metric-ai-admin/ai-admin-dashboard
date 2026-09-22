// Browser profile lifecycle for the AppFolio Forms Agent.
//
// THE PROBLEM THIS SOLVES
// AppFolio authenticates through Keycloak at account.appfolio.com (realm
// "property"), and it SMS-challenges the first login from an unrecognised
// browser. After that the browser is remembered. So the agent needs one
// long-lived signed-in browser profile rather than credentials.
//
// Consequence: this service never receives, stores or types a password. The
// one-time sign-in happens in a real browser inside this container, driven by
// a human. Nothing here has access to Lyndsay's credentials, by design.
//
// WHY THE PROFILE LIVES IN THE CONTAINER AND IS NEVER COPIED IN
// The "remembered device" trust is a cookie plus a fingerprint, and AppFolio
// also sees the source IP. A profile created on a Windows laptop and copied to
// a Linux container in Oregon is likely to be re-challenged — and Chromium
// profile directories are not portable across OS/browser builds anyway. So the
// sign-in must happen here, against this container's IP and browser build.
// That is why the disk matters: it is the only thing that survives a deploy.

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const DATA_DIR = process.env.AGENT_DATA_DIR || '/var/data';
const PROFILE_DIR = path.join(DATA_DIR, 'appfolio-profile');
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');

// The tenant. Anything that lands on account.appfolio.com is the login flow.
const APPFOLIO_URL = process.env.APPFOLIO_URL || 'https://metricpropertymanagement.appfolio.com';
const IDP_HOSTS = ['account.appfolio.com', 'login.microsoftonline.com'];

const NAV_TIMEOUT = Number(process.env.AGENT_NAV_TIMEOUT || 45000);

// ---- state file -------------------------------------------------------------
// Small JSON on the disk: last check, last good sign-in, when we last nagged.
// Read by the dashboard card later; the only thing that must survive a deploy
// besides the profile itself.

async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { lastCheckAt: null, lastGoodAt: null, lastReauthEmailAt: null, lastStatus: null, lastReason: null }; }
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ---- browser ----------------------------------------------------------------

/**
 * Open the persistent profile. headless=false is used by the setup flow so a
 * human can complete the SMS challenge through a remote display.
 *
 * launchPersistentContext (not launch + storageState) because the whole point
 * is that Chromium's own profile — including whatever the IdP writes to mark
 * this device as trusted — survives between runs.
 */
async function openContext({ headless = true } = {}) {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    args: [
      // Render containers give a small /dev/shm; without this Chromium crashes
      // on pages of any size.
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
}

/**
 * Is the saved profile still signed in?
 *
 * Loads the tenant root and looks at where it ends up. Verified 2026-09-22
 * against the live site: an unauthenticated request to the tenant root
 * redirects to
 *   account.appfolio.com/realms/property/protocol/openid-connect/auth?...
 * so the final hostname is the signal. A signed-in session stays on the tenant
 * host.
 *
 * Returns { authenticated, reason, url }. It never throws for an expected
 * "logged out" — only for a genuine failure to check.
 */
async function checkSession(context) {
  const page = await context.newPage();
  try {
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.goto(APPFOLIO_URL, { waitUntil: 'domcontentloaded' });
    // The IdP page is a JS app; give any client-side redirect a moment to run.
    await page.waitForTimeout(2500);

    const url = page.url();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep '' */ }

    if (IDP_HOSTS.some(h => host.endsWith(h)) || /\/realms\//.test(url)) {
      return { authenticated: false, reason: 'Redirected to the AppFolio sign-in page — the saved session has expired.', url };
    }
    const tenantHost = new URL(APPFOLIO_URL).hostname;
    if (host !== tenantHost) {
      return { authenticated: false, reason: `Unexpected host after loading AppFolio: ${host || 'unknown'}`, url };
    }
    // On the tenant host and not bounced to the IdP. Treat a visible sign-in
    // form as logged out too, in case AppFolio ever serves login in-tenant.
    const signInVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (signInVisible) {
      return { authenticated: false, reason: 'A sign-in form is being shown — the saved session has expired.', url };
    }
    return { authenticated: true, reason: 'Signed in.', url };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Full check: open the profile, look, record the result, close.
 * Used by the daily run and by the dashboard's status card.
 */
async function verifySession() {
  const checkedAt = new Date().toISOString();
  let context;
  try {
    context = await openContext({ headless: true });
    const result = await checkSession(context);
    await writeState({
      lastCheckAt: checkedAt,
      lastStatus: result.authenticated ? 'authenticated' : 'needs_auth',
      lastReason: result.reason,
      ...(result.authenticated ? { lastGoodAt: checkedAt } : {}),
    });
    return { ...result, checkedAt };
  } catch (err) {
    // A launch or navigation failure is NOT "logged out" — do not send the
    // re-auth email for it, or a network blip would tell Lyndsay to go and
    // sign in again for no reason.
    await writeState({ lastCheckAt: checkedAt, lastStatus: 'error', lastReason: err.message });
    return { authenticated: false, error: true, reason: err.message, checkedAt };
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Has a profile ever been created on this disk? */
async function profileExists() {
  try {
    const entries = await fs.readdir(PROFILE_DIR);
    return entries.length > 0;
  } catch { return false; }
}

module.exports = {
  openContext, checkSession, verifySession, profileExists,
  readState, writeState,
  PROFILE_DIR, STATE_FILE, DATA_DIR, APPFOLIO_URL,
};
