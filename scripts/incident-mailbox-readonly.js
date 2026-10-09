#!/usr/bin/env node
//
// INCIDENT TRIAGE — Lyndsay's mailbox. STRICTLY READ ONLY.
//
// Every request below is a GET. Nothing is created, changed, moved, deleted or
// disabled, and no rule is touched. If something needs turning off, a person
// does it knowing what they are turning off.
//
//   node scripts/incident-mailbox-readonly.js [YYYY-MM-DDTHH:MM Eastern]
//
// Default window opens at 15:15 America/New_York today.
//
// NO SECRETS ARE PRINTED. The access token is decoded only to list the
// application ROLES it carries, which is how "does this app have
// AuditLog.Read.All" gets an answer instead of a guess.
require('dotenv').config();

const TENANT = process.env.GRAPH_TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET;
const MB = process.env.MAILBOX_LYNDSAY || 'lyndsay@metricpropertymanagement.com';
if (!TENANT || !CLIENT || !SECRET) { console.error('Graph credentials missing.'); process.exit(2); }

const ET = 'America/New_York';
const fmtET = iso => iso ? new Date(iso).toLocaleString('en-US',
  { timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET' : '—';

// 15:15 Eastern today, as a UTC instant.
function windowStart(arg) {
  if (arg) return new Date(arg).toISOString();
  const now = new Date();
  const etDay = now.toLocaleDateString('en-CA', { timeZone: ET });          // YYYY-MM-DD
  // Offset of Eastern from UTC at this instant, so EDT vs EST is not assumed.
  const name = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'shortOffset' })
    .formatToParts(now).find(p => p.type === 'timeZoneName').value;         // "GMT-4"
  const m = /GMT([+-]\d+)/.exec(name);
  const offset = m ? parseInt(m[1], 10) : -4;
  const utcHour = 15 - offset;                                             // 15:15 ET -> UTC
  return new Date(`${etDay}T${String(utcHour).padStart(2, '0')}:15:00Z`).toISOString();
}

async function token() {
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error('token: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

// The roles the app actually holds. Decoding the token is the only way to
// answer this without asking for a permission we were told not to request.
function rolesOf(tok) {
  try {
    const payload = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { roles: payload.roles || [], appId: payload.appid || null, tenant: payload.tid || null };
  } catch (e) { return { roles: [], error: e.message }; }
}

let TOK = null;
async function get(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOK}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j.error && (j.error.message || j.error.code)) || `HTTP ${r.status}`);
    err.status = r.status; err.code = j.error && j.error.code;
    throw err;
  }
  return j;
}
async function getAll(url) {
  const out = [];
  let next = url, guard = 0;
  while (next && guard++ < 25) {
    const j = await get(next);
    out.push(...(j.value || []));
    next = j['@odata.nextLink'] || null;
  }
  return out;
}

const G = 'https://graph.microsoft.com/v1.0';
const line = s => console.log(s);
const hr = t => { console.log('\n' + '='.repeat(72)); console.log(t); console.log('='.repeat(72)); };

(async () => {
  const since = windowStart(process.argv[2]);
  TOK = await token();
  const who = rolesOf(TOK);

  line('MAILBOX : ' + MB);
  line('WINDOW  : from ' + since + '  (' + fmtET(since) + ')');
  line('MODE    : READ ONLY — every call below is a GET');

  // ---- 0. what this app is allowed to do --------------------------------
  hr('0. APPLICATION PERMISSIONS (from the token, no secret printed)');
  line('  app id : ' + who.appId);
  line('  roles  : ' + (who.roles.length ? who.roles.sort().join('\n           ') : '(none)'));
  const hasAudit = who.roles.includes('AuditLog.Read.All');
  line('\n  AuditLog.Read.All : ' + (hasAudit ? 'YES' : 'NO — sign-in and directory audit are NOT available to this app'));

  // ---- 1. every inbox rule ----------------------------------------------
  hr('1. INBOX RULES — all of them, not just the ones the dashboard manages');
  let rules = [];
  try {
    rules = await getAll(`${G}/users/${encodeURIComponent(MB)}/mailFolders/inbox/messageRules`);
  } catch (e) { line('  COULD NOT READ: ' + e.message + (e.code ? ' (' + e.code + ')' : '')); }
  line('  ' + rules.length + ' rule(s)\n');

  // Rules the code creates, by displayName, so anything else is flagged as
  // not ours. Taken from the two arrays in server.js.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const OURS = new Set();
  for (const m of src.matchAll(/displayName: '([^']+)'/g)) OURS.add(m[1].toLowerCase());

  const RISKY = [];
  rules.forEach(r => {
    const a = r.actions || {};
    const c = r.conditions || {};
    const acts = [];
    if (a.moveToFolder) acts.push('move');
    if (a.copyToFolder) acts.push('copy');
    if (a.forwardTo) acts.push('FORWARD -> ' + a.forwardTo.map(x => x.emailAddress && x.emailAddress.address).join(', '));
    if (a.forwardAsAttachmentTo) acts.push('FORWARD-AS-ATTACHMENT -> ' + a.forwardAsAttachmentTo.map(x => x.emailAddress && x.emailAddress.address).join(', '));
    if (a.redirectTo) acts.push('REDIRECT -> ' + a.redirectTo.map(x => x.emailAddress && x.emailAddress.address).join(', '));
    if (a.delete) acts.push('DELETE');
    if (a.permanentDelete) acts.push('PERMANENT DELETE');
    if (a.markAsRead) acts.push('mark read');
    if (a.markImportance) acts.push('importance ' + a.markImportance);
    if (a.assignCategories) acts.push('categories ' + a.assignCategories.join('/'));
    if (a.stopProcessingRules) acts.push('stop');

    const conds = Object.entries(c).map(([k, v]) =>
      k + '=' + (Array.isArray(v) ? v.join('|') : JSON.stringify(v))).join('  ');

    const ours = OURS.has(String(r.displayName || '').toLowerCase());
    const danger = !!(a.forwardTo || a.forwardAsAttachmentTo || a.redirectTo || a.delete || a.permanentDelete);
    if (danger || !ours) RISKY.push({ r, acts, ours, danger });

    line('  ' + (danger ? '!! ' : ours ? '   ' : ' ? ') + 'seq ' + String(r.sequence).padStart(3)
      + '  ' + (r.isEnabled ? 'on ' : 'OFF') + '  ' + JSON.stringify(r.displayName)
      + (ours ? '' : '   <-- NOT created by the dashboard'));
    if (conds) line('        when: ' + conds.slice(0, 300));
    line('        then: ' + (acts.join(' · ') || '(nothing)'));
  });

  hr('1b. RULES THAT FORWARD, REDIRECT OR DELETE — the ones that matter here');
  const bad = RISKY.filter(x => x.danger);
  if (!bad.length) line('  None. No inbox rule forwards, redirects or deletes.');
  bad.forEach(x => line('  ' + JSON.stringify(x.r.displayName) + '  ' + x.acts.join(' · ')
    + (x.ours ? '  (created by the dashboard)' : '  <-- NOT created by the dashboard')));

  const unknown = RISKY.filter(x => !x.ours);
  line('\n  rules not created by the dashboard: ' + unknown.length);
  unknown.forEach(x => line('    ' + JSON.stringify(x.r.displayName)));

  // ---- 2. forwarding / mailbox settings ----------------------------------
  hr('2. MAILBOX SETTINGS');
  try {
    const ms = await get(`${G}/users/${encodeURIComponent(MB)}/mailboxSettings`);
    const ar = ms.automaticRepliesSetting || {};
    line('  automatic replies : ' + (ar.status || '—'));
    if (ar.status && ar.status !== 'disabled') {
      line('    internal : ' + String(ar.internalReplyMessage || '').replace(/<[^>]+>/g, ' ').slice(0, 200));
      line('    external : ' + String(ar.externalReplyMessage || '').replace(/<[^>]+>/g, ' ').slice(0, 200));
    }
    line('  timezone          : ' + (ms.timeZone || '—'));
    line('  delegate meeting  : ' + (ms.delegateMeetingMessageDeliveryOptions || '—'));
  } catch (e) { line('  COULD NOT READ: ' + e.message); }
  line('\n  NOTE: Graph does NOT expose mailbox-level forwarding');
  line('  (ForwardingSmtpAddress / DeliverToMailboxAndForward). That setting is a');
  line('  common persistence trick and it is INVISIBLE HERE. It has to be checked in');
  line('  Exchange admin or with: Get-Mailbox lyndsay@... | fl ForwardingSmtpAddress,ForwardingAddress,DeliverToMailboxAndForward');

  // ---- 3. sent and deleted in the window ---------------------------------
  hr('3. SENT ITEMS since the window opened');
  try {
    const sent = await getAll(`${G}/users/${encodeURIComponent(MB)}/mailFolders/SentItems/messages`
      + `?$filter=sentDateTime ge ${since}`
      + '&$select=id,subject,sentDateTime,toRecipients,ccRecipients,bccRecipients,from&$top=100&$orderby=sentDateTime desc');
    line('  ' + sent.length + ' message(s)');
    sent.forEach(m => {
      const to = (m.toRecipients || []).concat(m.ccRecipients || [], m.bccRecipients || [])
        .map(x => x.emailAddress && x.emailAddress.address).join(', ');
      line('    ' + fmtET(m.sentDateTime) + '  -> ' + (to || '(none)'));
      line('       ' + JSON.stringify(String(m.subject || '').slice(0, 110)));
    });
  } catch (e) { line('  COULD NOT READ: ' + e.message); }

  hr('4. DELETED ITEMS touched since the window opened');
  line('  Matched on lastModifiedDateTime, which is when the item MOVED to Deleted');
  line('  Items. Exchange rewrites that field for hours after a bulk operation, so');
  line('  treat the list as "look at these", not as an exact timeline.');
  try {
    const del = await getAll(`${G}/users/${encodeURIComponent(MB)}/mailFolders/DeletedItems/messages`
      + `?$filter=lastModifiedDateTime ge ${since}`
      + '&$select=id,subject,receivedDateTime,sentDateTime,lastModifiedDateTime,from&$top=100&$orderby=lastModifiedDateTime desc');
    line('  ' + del.length + ' message(s)');
    del.slice(0, 60).forEach(m => {
      const f = m.from && m.from.emailAddress && m.from.emailAddress.address;
      line('    deleted ' + fmtET(m.lastModifiedDateTime) + '  from ' + (f || '—')
        + '  received ' + fmtET(m.receivedDateTime));
      line('       ' + JSON.stringify(String(m.subject || '').slice(0, 110)));
    });
    if (del.length > 60) line('    ... and ' + (del.length - 60) + ' more');
  } catch (e) { line('  COULD NOT READ: ' + e.message); }

  // ---- 5. sign-ins, only if the app may --------------------------------
  hr('5. SIGN-IN AND DIRECTORY AUDIT');
  if (!hasAudit) {
    line('  SKIPPED. This app does not hold AuditLog.Read.All, and it was not to be');
    line('  requested or added. Sign-in location, IP and result have to come from');
    line('  Entra admin center > Users > Lyndsay > Sign-in logs.');
  } else {
    try {
      const si = await getAll('https://graph.microsoft.com/v1.0/auditLogs/signIns'
        + `?$filter=userPrincipalName eq '${MB}' and createdDateTime ge ${since}&$top=50`);
      line('  ' + si.length + ' sign-in(s)');
      si.forEach(s => line('    ' + fmtET(s.createdDateTime) + '  ' + (s.ipAddress || '—')
        + '  ' + [s.location && s.location.city, s.location && s.location.countryOrRegion].filter(Boolean).join(', ')
        + '  ' + (s.status && s.status.errorCode === 0 ? 'SUCCESS' : 'fail ' + (s.status && s.status.errorCode))
        + '  ' + (s.appDisplayName || '') + '  ' + (s.clientAppUsed || '')));
    } catch (e) { line('  sign-ins COULD NOT READ: ' + e.message); }
    try {
      const da = await getAll('https://graph.microsoft.com/v1.0/auditLogs/directoryAudits'
        + `?$filter=activityDateTime ge ${since}&$top=50`);
      line('\n  ' + da.length + ' directory audit event(s)');
      da.forEach(d => line('    ' + fmtET(d.activityDateTime) + '  ' + d.activityDisplayName
        + '  by ' + ((d.initiatedBy && d.initiatedBy.user && d.initiatedBy.user.userPrincipalName) || '—')
        + '  ' + d.result));
    } catch (e) { line('  directory audits COULD NOT READ: ' + e.message); }
  }

  hr('DONE — nothing was changed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
