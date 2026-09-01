// =====================================================================
// SimpleVOIP SimplyAI — call metadata and transcripts.
//
// READ-ONLY. Nothing here writes back to SimpleVOIP.
//
// Verified live against ajax.simplevoip.us on 2026-08-27. Both endpoints
// answer 200 with no authentication at all, which is worth stating plainly:
// anyone with an account id and a user id can read these transcripts, so the
// routes that expose them are session-gated on our side.
//
// Shapes confirmed from the live responses, not from the docs:
//
//   GET /users/{user_id}/cdr_analysis
//       ?account_id=…&start_ts=…&end_ts=…&page=1&per_page=100
//   → { status, data: { calls: [...], pagination: { page, per_page, total, total_pages } } }
//
//   GET /users/{user_id}/cdr_analysis/details/{recording_id}
//   → { status, data: { transcription, summary, sentiment, sentiment_score,
//                       tokens_used, word_count, character_count, created_at,
//                       caller_id_name, caller_id_number, call_id, recording_id } }
//
// Three things the field names get wrong if you guess them: the caller is
// from_number / from_name (not "caller"), the timestamp is `datetime` in Unix
// SECONDS (not "time"), and the transcript flag is `has_analysis` (not
// "has_transcript"). A missed call carries an empty recording_id.
//
// Two gotchas carried from the SOP and confirmed in the data:
//   - One inbound call ringing six phones is six rows. Count distinct calls.
//   - Join the two endpoints on recording_id. call_id differs between them.
// =====================================================================

const BASE = 'https://ajax.simplevoip.us';

// No defaults. The account and user ids are tenant data, not constants, and a
// hardcoded id would keep working after someone changed it in the portal —
// silently reporting the wrong person's calls. See .env.example.
const ACCOUNT_ID = (process.env.SIMPLEVOIP_ACCOUNT_ID || '').trim();
const USER_ID = (process.env.SIMPLEVOIP_USER_ID || '').trim();

const isConfigured = () => !!(ACCOUNT_ID && USER_ID);
const defaultUserId = () => USER_ID;

const fetchFn = (...a) => (globalThis.fetch ? globalThis.fetch(...a) : Promise.reject(new Error('fetch unavailable')));

// A "day of calls" is the day the Central-time office worked. The old code used
// the SERVER's local midnight, which on Render (UTC) meant a Sept-1 window ran
// 00:00–23:59 UTC = CT 19:00 Aug-31 → 18:59 Sep-1: it still caught business
// hours (why a normal day looked fine) but shoved evening CT calls into the
// wrong day. Anchor the window to America/Chicago instead, so Sep-1 CT is
// 05:00Z Sep-1 → 05:00Z Sep-2 (CDT) — or an hour later under CST.
const CT_TZ = 'America/Chicago';

// Minutes CT is offset from UTC at a given instant (handles CST vs CDT). "GMT-5"
// → -300. Returns 0 only if the platform gives no offset, which no modern one does.
function ctOffsetMinutes(atUTC) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: CT_TZ, timeZoneName: 'shortOffset' })
    .formatToParts(atUTC).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!m) return 0;
  const sign = m[1].startsWith('-') ? -1 : 1;
  return parseInt(m[1], 10) * 60 + sign * (m[2] ? parseInt(m[2], 10) : 0);
}

function dayBounds(dateStr) {
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    [y, m, d] = dateStr.split('-').map(Number);
  } else {
    // "Today" in Central time, not in the server's timezone.
    [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: CT_TZ }).format(new Date()).split('-').map(Number);
  }
  // CT midnight of that day, and CT midnight of the next day, each as a real UTC
  // instant: the wall-clock reading minus CT's offset. Offset is resolved per
  // boundary so a DST-transition day still bounds correctly.
  const toUTC = (yy, mm, dd) => {
    const wall = new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0));
    return wall.getTime() - ctOffsetMinutes(wall) * 60000;
  };
  const startMs = toUTC(y, m, d);
  const endMs = toUTC(y, m, d + 1) - 1000; // inclusive last second of the CT day
  return { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) };
}

async function getJSON(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`SimpleVOIP returned ${res.status}`);
    const json = await res.json();
    if (json?.status && json.status !== 'success') throw new Error(`SimpleVOIP status "${json.status}"`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls between two Unix-second timestamps. Pages until the API says it is
 * done — a week was 87 calls across 18 pages at the default page size, so a
 * single request would have quietly returned a fraction of the day.
 *
 * Never throws: an unreachable phone system should not take a dashboard tab
 * down. Returns { calls, error } and lets the caller decide what to show.
 */
async function fetchCDRList(userId, dateFrom, dateTo) {
  const uid = userId || USER_ID;
  if (!ACCOUNT_ID || !uid) {
    return { calls: [], error: 'SimpleVOIP is not configured — set SIMPLEVOIP_ACCOUNT_ID and SIMPLEVOIP_USER_ID.' };
  }
  const calls = [];
  try {
    for (let page = 1; page <= 50; page++) {
      const url = `${BASE}/users/${encodeURIComponent(uid)}/cdr_analysis`
        + `?account_id=${encodeURIComponent(ACCOUNT_ID)}`
        + `&start_ts=${dateFrom}&end_ts=${dateTo}&page=${page}&per_page=100`;
      const json = await getJSON(url);
      const batch = json?.data?.calls || [];
      calls.push(...batch);
      const pg = json?.data?.pagination;
      if (!batch.length || !pg || page >= (pg.total_pages || 1)) break;
    }
    return { calls, error: null };
  } catch (err) {
    console.error('[simplevoip] cdr list failed:', err.message);
    // Whatever pages already came back are still worth showing.
    return { calls, error: err.message };
  }
}

async function fetchTodaysCalls(userId) {
  const { start, end } = dayBounds(null);
  return fetchCDRList(userId, start, end);
}

async function fetchCallsForDate(userId, dateStr) {
  const { start, end } = dayBounds(dateStr);
  return fetchCDRList(userId, start, end);
}

/**
 * One call's transcript. Returns null rather than throwing — a call whose
 * analysis has expired or was never made is a normal state, not a failure.
 */
async function fetchCallTranscript(userId, recordingId) {
  const uid = userId || USER_ID;
  if (!uid || !recordingId) return null;
  try {
    const json = await getJSON(
      `${BASE}/users/${encodeURIComponent(uid)}/cdr_analysis/details/${encodeURIComponent(recordingId)}`);
    return json?.data || null;
  } catch (err) {
    console.error(`[simplevoip] transcript ${recordingId} failed:`, err.message);
    return null;
  }
}

/**
 * The list rows, reduced to what a person reading the day needs. Field names
 * are normalised here so the shape of the vendor's response does not leak into
 * the routes or the UI.
 *
 * A ringing group produces one row per phone. Rows are folded on recording_id
 * where there is one, so a single call is a single line; the rows with no
 * recording — missed calls — stay separate, since each is its own attempt.
 */
// The vendor sends the answered-elsewhere fields inconsistently — sometimes an
// array, sometimes a comma/semicolon string, sometimes absent. Normalise to a
// clean string array either way.
function normList(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return String(v).split(/[,;]/).map(x => x.trim()).filter(Boolean);
}
// Union that preserves order and drops duplicates — used when ring-group legs
// fold onto one row.
function unionList(a, b) {
  const out = [], seen = new Set();
  for (const x of [...(a || []), ...(b || [])]) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function shapeCalls(calls) {
  const byRecording = new Map();
  const out = [];
  for (const c of (calls || [])) {
    const row = {
      recording_id: c.recording_id || null,
      call_id: c.call_id || null,
      caller: c.from_name || c.from_number || 'Unknown',
      caller_number: c.from_number || null,
      to_name: c.to_name || null,
      to_number: c.to_number || null,
      direction: c.direction || null,
      duration: Number(c.duration) || 0,
      ring_duration: Number(c.ring_duration) || 0,
      // Unix SECONDS. Milliseconds here would put every call in 1970.
      datetime: Number(c.datetime) || null,
      status: c.status_label || c.status_key || null,
      has_transcript: !!(c.has_analysis && c.recording_id),
      has_recording: !!c.has_recording,
      // Who actually answered when this leg didn't — lets the UI point the
      // reviewer at that agent's day. Kept as parallel id/name arrays so the
      // name is clickable and the id drives the dropdown switch.
      answered_elsewhere_user_ids: normList(c.answered_elsewhere_user_ids),
      answered_elsewhere_user_names: normList(c.answered_elsewhere_user_names),
    };
    if (!row.recording_id) { out.push(row); continue; }
    const seen = byRecording.get(row.recording_id);
    if (!seen) { byRecording.set(row.recording_id, row); out.push(row); continue; }
    // Same call, another phone that rang: keep the longest talk time and the
    // fact that someone answered.
    seen.duration = Math.max(seen.duration, row.duration);
    seen.has_transcript = seen.has_transcript || row.has_transcript;
    seen.answered_elsewhere_user_ids = unionList(seen.answered_elsewhere_user_ids, row.answered_elsewhere_user_ids);
    seen.answered_elsewhere_user_names = unionList(seen.answered_elsewhere_user_names, row.answered_elsewhere_user_names);
  }
  return out.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
}

// sentiment_score is NOT a 0-1 number. It comes back as a breakdown —
// { Mixed, Neutral, Negative, Positive } — each a probability, e.g.
// Neutral 0.7195 alongside Positive 0.2803. Rendering it as a percentage
// directly would print "[object Object]%", so the confidence in the label
// SimplyAI actually chose is pulled out here and the full breakdown is passed
// through beside it.
function sentimentPct(label, score) {
  if (!label || !score || typeof score !== 'object') return null;
  const want = String(label).trim().toLowerCase();
  const hit = Object.entries(score).find(([k]) => k.toLowerCase() === want);
  if (!hit || typeof hit[1] !== 'number') return null;
  return Math.round(hit[1] * 100);
}

// Compliance — "Office Redirect" (Lyndsay 2026-09-01): no one may tell a
// resident/applicant to just come to the office. SimpleVOIP's AI does the
// summary/sentiment; this is our own deterministic scan of the transcript text
// for the policy phrases, so it needs no model call and is reliable for a fixed
// rule. It flags the phrase regardless of which speaker said it — the quote lets
// a reviewer confirm — because the transcript's speaker labels cannot be mapped
// to the agent with confidence.
const OFFICE_REDIRECT_PATTERNS = [
  /come\s+(?:in\s*to|into|down\s+to|by|to)\s+(?:the\s+|our\s+|the\s+leasing\s+)?office/i,
  /come\s+in\s+person/i,
  /come\s+on\s+in\b/i,
  /just\s+come\s+(?:in|by|on\s+in)\b/i,
  /stop\s+by\s+(?:the\s+|our\s+)?office/i,
  /visit\s+(?:us\b|our\s+office|the\s+office)/i,
  /go\s+(?:in\s*to|into|to)\s+(?:the\s+|our\s+)?office/i,
];
function detectOfficeRedirect(text) {
  const t = String(text || '');
  for (const re of OFFICE_REDIRECT_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const idx = m.index;
    // The line containing the match — keeps a speaker label ("Participant 1: …")
    // if the transcript has one, so a reviewer sees who said it.
    const lineStart = t.lastIndexOf('\n', idx) + 1;
    let lineEnd = t.indexOf('\n', idx); if (lineEnd === -1) lineEnd = t.length;
    let quote = t.slice(lineStart, lineEnd).trim();
    if (quote.length > 240) {
      const rel = idx - lineStart, s = Math.max(0, rel - 90);
      quote = (s > 0 ? '…' : '') + quote.slice(s, s + 240).trim() + (s + 240 < quote.length ? '…' : '');
    }
    return { flagged: true, quote, matched: m[0] };
  }
  return { flagged: false, quote: null };
}

function shapeTranscript(d, recordingId) {
  if (!d) return null;
  const sentiment = d.sentiment || null;
  const officeRedirect = detectOfficeRedirect(d.transcription || '');
  return {
    compliance: { office_redirect: officeRedirect },
    recording_id: d.recording_id || recordingId,
    caller: d.caller_id_name || d.caller_id_number || 'Unknown',
    caller_number: d.caller_id_number || null,
    transcript_text: d.transcription || '',
    summary: d.summary || null,
    sentiment,
    sentiment_score: d.sentiment_score || null,
    sentiment_pct: sentimentPct(sentiment, d.sentiment_score),
    word_count: d.word_count ?? null,
    character_count: d.character_count ?? null,
    tokens_used: d.tokens_used ?? null,
    // Unix seconds, not an ISO string — multiplying is what puts it in this
    // century.
    created_at: d.created_at || null,
  };
}

module.exports = {
  isConfigured, defaultUserId, dayBounds,
  fetchCDRList, fetchTodaysCalls, fetchCallsForDate, fetchCallTranscript,
  shapeCalls, shapeTranscript, detectOfficeRedirect,
};
