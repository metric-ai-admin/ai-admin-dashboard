// teams-transcripts.js
//
// Reads Microsoft Teams meeting transcripts via Graph, app-only. Requires the
// application permissions OnlineMeetings.Read.All + OnlineMeetingTranscript.Read.All
// (admin-consented) AND a Teams application access policy granting this app's
// client id access to the target user's meetings — without the policy every call
// 403s even with the permissions. Token comes from the caller (the app-only
// client-credentials token); the userId is the meeting organizer (Lyndsay).

const BASE = 'https://graph.microsoft.com/v1.0';

async function graphGet(fetchFn, token, url, asText) {
  const r = await fetchFn(url, { headers: { Authorization: 'Bearer ' + token } });
  if (asText) {
    const text = await r.text();
    if (!r.ok) throw new Error('Graph ' + r.status + ': ' + text.slice(0, 160));
    return text;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Graph ' + r.status + ': ' + ((j.error && j.error.message) || 'request failed'));
  return j;
}

// Resolve a calendar event's Teams join URL to its onlineMeeting object (we need
// its id to reach the transcripts). Returns the object (with .id) or null.
async function resolveOnlineMeeting(fetchFn, token, userId, joinUrl) {
  // The $filter value is an OData string literal — single quotes are doubled.
  const url = `${BASE}/users/${encodeURIComponent(userId)}/onlineMeetings`
    + `?$filter=JoinWebUrl%20eq%20'${encodeURIComponent(joinUrl).replace(/'/g, "''")}'`;
  const j = await graphGet(fetchFn, token, url);
  return (j.value && j.value[0]) || null;
}

// All transcripts for a meeting. Each: { id, createdDateTime, transcriptContentUrl }.
async function listTranscripts(fetchFn, token, userId, meetingId) {
  const url = `${BASE}/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
  const j = await graphGet(fetchFn, token, url);
  return j.value || [];
}

// The transcript body as WebVTT text.
async function fetchTranscriptVtt(fetchFn, token, userId, meetingId, transcriptId) {
  const url = `${BASE}/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}`
    + `/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;
  return graphGet(fetchFn, token, url, true);
}

// Teams transcripts are WebVTT with cues like `<v Speaker Name>text</v>`. Reduce
// to "Speaker: text" lines, collapsing consecutive lines from the same speaker.
function parseVtt(vtt) {
  const lines = String(vtt || '').split(/\r?\n/);
  const turns = [];
  let last = null;
  for (const line of lines) {
    const m = line.match(/<v\s+([^>]+)>([\s\S]*?)<\/v>/i);
    if (!m) continue;
    const who = m[1].trim();
    const said = m[2].replace(/<[^>]+>/g, '').trim();
    if (!said) continue;
    if (who === last && turns.length) turns[turns.length - 1].text += ' ' + said;
    else { turns.push({ who, text: said }); last = who; }
  }
  if (turns.length) return turns.map(t => `${t.who}: ${t.text}`).join('\n');
  // Fallback for transcripts without speaker tags: drop the header, cue numbers,
  // timestamps and id lines, keep the spoken text.
  return lines
    .filter(l => l && !/^WEBVTT/i.test(l) && !/-->/.test(l) && !/^\d+$/.test(l) && !/^[0-9a-f]{8}-[0-9a-f-]+/i.test(l))
    .map(l => l.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

module.exports = { resolveOnlineMeeting, listTranscripts, fetchTranscriptVtt, parseVtt };
