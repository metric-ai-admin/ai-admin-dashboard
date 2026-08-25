// =====================================================================
// AppFolio Reports API v2 — HTTP client
//
// Read-only. Handles auth, the 7-requests-per-15-seconds rate limit,
// next_page_url pagination, and maps HTTP failures to clear messages.
//
// Docs shape:
//   POST https://{subdomain}.appfolio.com/api/v2/reports/{report}.json
//   Basic auth = CLIENT_ID : CLIENT_SECRET
//   Response   = { results: [...], next_page_url: "..." | null }
// =====================================================================

const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');

const RATE_LIMIT_MAX = 7;      // requests …
const RATE_LIMIT_WINDOW = 15000; // … per 15 seconds
const MAX_PAGES = 200;         // safety net: 200 × 5000 rows = 1M rows
const MAX_RETRIES = 3;

// ---- Config -----------------------------------------------------------------

function config() {
  return {
    clientId:  process.env.APPFOLIO_CLIENT_ID,
    secret:    process.env.APPFOLIO_CLIENT_SECRET,
    subdomain: process.env.APPFOLIO_SUBDOMAIN,
  };
}

function isConfigured() {
  const c = config();
  return !!(c.clientId && c.secret && c.subdomain);
}

function authHeader() {
  const { clientId, secret } = config();
  return 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64');
}

function reportUrl(report) {
  const { subdomain } = config();
  return `https://${subdomain}.appfolio.com/api/v2/reports/${report}.json`;
}

// next_page_url comes back as a full URL and may embed credentials.
// Strip them — we always send auth via the Authorization header instead,
// because undici drops userinfo from fetch() URLs.
function stripCredentials(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

// ---- Rate limiter -----------------------------------------------------------
// Sliding window shared by every caller in this process, so a "sync all"
// across six reports still respects the account-wide budget.

const _timestamps = [];
let _chain = Promise.resolve();

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function _reserveSlot() {
  for (;;) {
    const now = Date.now();
    // Drop timestamps that have aged out of the window.
    while (_timestamps.length && now - _timestamps[0] >= RATE_LIMIT_WINDOW) {
      _timestamps.shift();
    }
    if (_timestamps.length < RATE_LIMIT_MAX) {
      _timestamps.push(now);
      return;
    }
    // Wait until the oldest request leaves the window (+10ms cushion).
    await _sleep(RATE_LIMIT_WINDOW - (now - _timestamps[0]) + 10);
  }
}

// Serialize slot reservation so concurrent callers can't claim the same slot.
function scheduled(fn) {
  const run = _chain.then(_reserveSlot).then(fn, fn);
  // Keep the chain alive regardless of individual failures.
  _chain = run.then(() => {}, () => {});
  return run;
}

// ---- Errors -----------------------------------------------------------------

class AppFolioError extends Error {
  constructor(message, { status = null, retryable = false, report = null } = {}) {
    super(message);
    this.name = 'AppFolioError';
    this.status = status;
    this.retryable = retryable;
    this.report = report;
  }
}

function describeStatus(status, report, bodySnippet) {
  switch (status) {
    case 400:
      return new AppFolioError(
        `AppFolio rejected the request for "${report}" (400). A filter or parameter is invalid.${bodySnippet ? ' — ' + bodySnippet : ''}`,
        { status, retryable: false, report });
    case 401:
    case 403:
      return new AppFolioError(
        `Invalid AppFolio credentials (${status}). Check APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_SUBDOMAIN in .env, and confirm the API key still has Reports API access.`,
        { status, retryable: false, report });
    case 404:
      return new AppFolioError(
        `Report "${report}" not found (404). The report name may be wrong or not enabled for this AppFolio account.`,
        { status, retryable: false, report });
    case 429:
      return new AppFolioError(
        `AppFolio rate limit hit (429) on "${report}". The limit is 7 requests / 15 seconds — retrying with backoff.`,
        { status, retryable: true, report });
    default:
      if (status >= 500) {
        return new AppFolioError(
          `AppFolio temporary server error (${status}) on "${report}". This is on their side — retrying.`,
          { status, retryable: true, report });
      }
      return new AppFolioError(
        `Unexpected response ${status} from AppFolio on "${report}".${bodySnippet ? ' — ' + bodySnippet : ''}`,
        { status, retryable: false, report });
  }
}

// ---- Single request ---------------------------------------------------------

async function _rawRequest({ url, method, body, report }) {
  const opts = {
    method,
    headers: {
      'Authorization': authHeader(),
      'Accept': 'application/json',
    },
  };
  if (method === 'POST') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }

  let res;
  try {
    res = await fetchFn(url, opts);
  } catch (e) {
    // DNS failure, connection refused, TLS problem, offline…
    throw new AppFolioError(
      `Could not reach AppFolio (${e.code || e.message}). Check the internet connection and that APPFOLIO_SUBDOMAIN is correct.`,
      { status: null, retryable: true, report });
  }

  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim(); } catch {}
    throw describeStatus(res.status, report, snippet);
  }

  try {
    return await res.json();
  } catch {
    throw new AppFolioError(
      `AppFolio returned a non-JSON response for "${report}". This usually means the URL or report name is wrong.`,
      { status: res.status, retryable: false, report });
  }
}

// Rate-limited + retried single request.
async function request({ url, method = 'POST', body = null, report = '' }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await scheduled(() => _rawRequest({ url, method, body, report }));
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AppFolioError) || !err.retryable || attempt === MAX_RETRIES) throw err;
      // Exponential backoff: 429 waits out a full window, 5xx backs off faster.
      const wait = err.status === 429
        ? RATE_LIMIT_WINDOW * attempt
        : 1000 * Math.pow(2, attempt);
      await _sleep(wait);
    }
  }
  throw lastErr;
}

// ---- Paginated fetch --------------------------------------------------------

/**
 * Fetch a full report, following next_page_url until exhausted.
 * We intentionally do NOT use paginate_results=false — AppFolio caps that,
 * and following next_page_url is the supported path for >5000 rows.
 *
 * @returns {Promise<{rows: Array, pages: number, truncated: boolean}>}
 */
async function fetchReport(report, params = {}, { onProgress } = {}) {
  if (!isConfigured()) {
    throw new AppFolioError(
      'AppFolio is not configured. Add APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET and APPFOLIO_SUBDOMAIN to .env, then restart the dashboard.',
      { status: null, retryable: false, report });
  }

  const rows = [];
  let url = reportUrl(report);
  let method = 'POST';
  let body = params;
  let pages = 0;
  let truncated = false;

  while (url) {
    const json = await request({ url, method, body, report });
    const batch = Array.isArray(json.results) ? json.results
                : Array.isArray(json.data)    ? json.data
                : [];
    rows.push(...batch);
    pages++;
    if (onProgress) onProgress({ pages, rows: rows.length });

    const next = json.next_page_url || json.nextPageUrl || null;
    if (!next) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }

    // Subsequent pages are pre-built URLs — GET them, no body.
    url = stripCredentials(next);
    method = 'GET';
    body = null;
  }

  return { rows, pages, truncated };
}

module.exports = {
  fetchReport,
  isConfigured,
  config,
  AppFolioError,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
};
