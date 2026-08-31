/**
 * Email Auto-Move — Phase 1.
 *
 * Approved by Lyndsay in standup 2026-08-31. Two automatic actions on unread
 * mail sitting in her Inbox, and nothing else:
 *
 *   1. archive_read     — sender is on the confirmed cold-outreach allowlist:
 *                         mark read, move to Archive.
 *   2. move_unsubscribe — message carries a List-Unsubscribe header: move to
 *                         "Unsubscribe Needed", leave unread.
 *
 * Anything that matches neither is left exactly where it is. Lyndsay Review,
 * Client Emails, MPM Team, Financial, Bekah Follow Up, Rocio and Personal are
 * never read from and never written to — this only ever looks at Inbox.
 *
 * Two independent switches, both off by default, because the failure mode that
 * matters is a real email disappearing:
 *
 *   AUTO_MOVE_ENABLED=false  (default) — the cron does nothing at all.
 *   AUTO_MOVE_DRY_RUN=true   (default) — decide and log, move nothing.
 *
 * So a deploy changes no behaviour. Enabling it is two deliberate edits in the
 * Render dashboard, and the natural order is ENABLED first (which gets you a
 * dry-run log to read), then DRY_RUN off once the log looks right.
 */

const UNSUBSCRIBE_FOLDER = 'Unsubscribe Needed';
const ACTION_ARCHIVE = 'archive_read';
const ACTION_UNSUB = 'move_unsubscribe';

// How many unread messages one pass will look at. Her Inbox runs at or near
// zero, so this is a ceiling for a backlog day, not a normal load.
const BATCH_LIMIT = 50;

const flag = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
};

const autoMoveEnabled = () => flag('AUTO_MOVE_ENABLED', false);
const autoMoveDryRun = () => flag('AUTO_MOVE_DRY_RUN', true);

/**
 * Finds (or creates) "Unsubscribe Needed" as a child of Inbox.
 *
 * It does not exist in Lyndsay's mailbox today, even though data/email_rules.json
 * lists it as though it does — verified against Graph on 2026-08-31. Creating it
 * is idempotent: the lookup runs first every time.
 */
async function ensureUnsubscribeFolder(ctx) {
  const { fetchFn, base, headers } = ctx;
  const listUrl = base + '/mailFolders/inbox/childFolders?$select=id,displayName&$top=100';
  const r = await fetchFn(listUrl, { headers });
  const j = await r.json();
  if (!r.ok) throw new Error('Cannot list Inbox folders: ' + ((j.error && j.error.message) || r.status));

  const want = UNSUBSCRIBE_FOLDER.toLowerCase();
  const found = (j.value || []).find(f => (f.displayName || '').trim().toLowerCase() === want);
  if (found) return { id: found.id, created: false };

  const mk = await fetchFn(base + '/mailFolders/inbox/childFolders', {
    method: 'POST',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ displayName: UNSUBSCRIBE_FOLDER }),
  });
  const mj = await mk.json();
  if (!mk.ok) throw new Error('Cannot create "' + UNSUBSCRIBE_FOLDER + '": ' + ((mj.error && mj.error.message) || mk.status));
  return { id: mj.id, created: true };
}

/** Active allowlist, lowercased. Empty until a human approves entries. */
async function loadColdSenders(db) {
  if (!db) return new Set();
  const { data, error } = await db
    .from('cold_outreach_senders')
    .select('sender_email')
    .eq('active', true);
  if (error) throw new Error('cold_outreach_senders: ' + error.message);
  return new Set((data || []).map(r => (r.sender_email || '').trim().toLowerCase()).filter(Boolean));
}

/** Unread messages in Inbox, newest first. */
async function fetchUnread(ctx, limit) {
  const { fetchFn, base, headers } = ctx;
  const select = 'id,subject,from,sender,receivedDateTime,internetMessageId';
  const url = base + '/mailFolders/inbox/messages?$filter=isRead eq false'
            + '&$top=' + limit + '&$orderby=receivedDateTime desc&$select=' + select;
  const r = await fetchFn(url, { headers });
  const j = await r.json();
  if (!r.ok) throw new Error('Cannot read Inbox: ' + ((j.error && j.error.message) || r.status));
  return j.value || [];
}

/**
 * Which of these messages carry List-Unsubscribe.
 *
 * internetMessageHeaders does not come back on a list query and cannot be
 * $filtered — Graph answers 400, "does not support filtering" — so it takes one
 * GET per message. $batch does 20 per round trip.
 */
async function headersWithUnsubscribe(ctx, msgs) {
  const { fetchFn, mailbox, headers } = ctx;
  const out = new Set();
  for (let i = 0; i < msgs.length; i += 20) {
    const chunk = msgs.slice(i, i + 20);
    const r = await fetchFn('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ requests: chunk.map((m, j) => ({
        id: String(j),
        method: 'GET',
        url: '/users/' + mailbox + '/messages/' + encodeURIComponent(m.id) + '?$select=internetMessageHeaders',
      })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('$batch failed: ' + ((j.error && j.error.message) || r.status));
    for (const resp of (j.responses || [])) {
      const m = chunk[parseInt(resp.id, 10)];
      if (!m || resp.status !== 200) continue;
      const hs = (resp.body && resp.body.internetMessageHeaders) || [];
      if (hs.some(h => /^list-unsubscribe$/i.test(h.name))) out.add(m.id);
    }
  }
  return out;
}

const senderOf = (m) =>
  ((m.from && m.from.emailAddress && m.from.emailAddress.address)
    || (m.sender && m.sender.emailAddress && m.sender.emailAddress.address)
    || '').toLowerCase();

/**
 * Claims a message before acting on it.
 *
 * The unique index on internet_message_id is what makes this at-most-once: two
 * overlapping runs, or a retry after a half-finished move, hit a duplicate-key
 * error on the second attempt and skip. Returns the row id, or null if someone
 * already claimed it.
 *
 * Dry runs deliberately claim with a NULL internet_message_id. Postgres allows
 * repeated NULLs in a unique index, so dry runs can be re-run as often as you
 * like and — the part that matters — a dry run never blocks the real one later.
 */
async function claim(db, row, dryRun) {
  const payload = Object.assign({}, row, {
    internet_message_id: dryRun ? null : (row.internet_message_id || null),
    dry_run: dryRun,
  });
  const { data, error } = await db.from('auto_move_log').insert([payload]).select('id').single();
  if (error) {
    if (error.code === '23505') return null;   // already handled
    throw new Error('auto_move_log: ' + error.message);
  }
  return data.id;
}

async function markError(db, id, message) {
  if (!db || !id) return;
  await db.from('auto_move_log').update({ error: String(message).slice(0, 500) }).eq('id', id);
}

async function moveMessage(ctx, id, destination) {
  const { fetchFn, base, headers } = ctx;
  const r = await fetchFn(base + '/messages/' + encodeURIComponent(id) + '/move', {
    method: 'POST',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ destinationId: destination }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error('move failed: ' + ((j.error && j.error.message) || r.status));
  }
}

async function markRead(ctx, id) {
  const { fetchFn, base, headers } = ctx;
  const r = await fetchFn(base + '/messages/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ isRead: true }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error('mark read failed: ' + ((j.error && j.error.message) || r.status));
  }
}

/**
 * One pass.
 *
 * deps: { fetchFn, token, mailbox, db, log }
 * opts: { dryRun } — omit to read AUTO_MOVE_DRY_RUN.
 */
async function runAutoMove(deps, opts) {
  const options = opts || {};
  const dryRun = options.dryRun === undefined ? autoMoveDryRun() : !!options.dryRun;
  const log = deps.log || (() => {});
  const db = deps.db;

  const ctx = {
    fetchFn: deps.fetchFn,
    mailbox: deps.mailbox,
    base: 'https://graph.microsoft.com/v1.0/users/' + deps.mailbox,
    headers: { Authorization: 'Bearer ' + deps.token },
  };

  const summary = {
    dryRun,
    scanned: 0,
    archived: 0,
    unsubscribed: 0,
    skipped: 0,
    errors: 0,
    alreadyHandled: 0,
    folderCreated: false,
    allowlistSize: 0,
    actions: [],
  };

  const cold = await loadColdSenders(db);
  summary.allowlistSize = cold.size;

  const unread = await fetchUnread(ctx, BATCH_LIMIT);
  summary.scanned = unread.length;
  if (!unread.length) return summary;

  const withUnsub = await headersWithUnsubscribe(ctx, unread);

  // Only resolve/create the folder when something actually needs it — an empty
  // pass should not create a folder in her mailbox as a side effect.
  let unsubFolderId = null;
  const needsFolder = unread.some(m => !cold.has(senderOf(m)) && withUnsub.has(m.id));
  if (needsFolder && !dryRun) {
    const f = await ensureUnsubscribeFolder(ctx);
    unsubFolderId = f.id;
    summary.folderCreated = f.created;
    if (f.created) log('[auto-move] created folder "' + UNSUBSCRIBE_FOLDER + '"');
  }

  for (const m of unread) {
    const sender = senderOf(m);
    const isCold = cold.has(sender);
    const isList = withUnsub.has(m.id);

    // Allowlist wins. A confirmed cold-outreach sender who also sets
    // List-Unsubscribe is still cold outreach, and archiving is the decision
    // that was actually made about them.
    let action = null;
    let matchedOn = null;
    let target = null;
    if (isCold) { action = ACTION_ARCHIVE; matchedOn = sender; target = 'Archive'; }
    else if (isList) { action = ACTION_UNSUB; matchedOn = 'List-Unsubscribe'; target = UNSUBSCRIBE_FOLDER; }

    if (!action) { summary.skipped++; continue; }

    const rowId = await claim(db, {
      email_id: m.id,
      internet_message_id: m.internetMessageId || null,
      subject: (m.subject || '').slice(0, 500),
      sender,
      action,
      matched_on: matchedOn,
      target_folder: target,
    }, dryRun);

    if (!rowId) { summary.alreadyHandled++; continue; }

    summary.actions.push({ action, sender, subject: m.subject || '', target });

    if (dryRun) {
      if (action === ACTION_ARCHIVE) summary.archived++; else summary.unsubscribed++;
      continue;
    }

    try {
      if (action === ACTION_ARCHIVE) {
        // Read first, then move: Graph reissues the message id on a move, so
        // the PATCH has to happen while this id is still the live one.
        await markRead(ctx, m.id);
        await moveMessage(ctx, m.id, 'archive');
        summary.archived++;
      } else {
        await moveMessage(ctx, m.id, unsubFolderId);
        summary.unsubscribed++;
      }
    } catch (err) {
      summary.errors++;
      await markError(db, rowId, err.message);
      log('[auto-move] ERROR ' + action + ' ' + sender + ': ' + err.message);
    }
  }

  return summary;
}

module.exports = {
  runAutoMove,
  ensureUnsubscribeFolder,
  loadColdSenders,
  autoMoveEnabled,
  autoMoveDryRun,
  UNSUBSCRIBE_FOLDER,
  ACTION_ARCHIVE,
  ACTION_UNSUB,
  BATCH_LIMIT,
};
