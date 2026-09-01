/**
 * Email Auto-Move — Phase 2. Config-driven, multi-folder routing.
 *
 * Rules live in Supabase (automove_rules); a new rule is a row, not a deploy.
 * For each unread message in Lyndsay's Inbox the engine evaluates active rules
 * in priority order (lower first), FIRST MATCH WINS, then falls back to the
 * legacy cold_outreach_senders allowlist (lowest priority). No match → the
 * message is left untouched.
 *
 * Match types: sender_exact, sender_domain, header, subject_contains,
 * subject_startswith. Actions: move, move_read, archive, archive_read,
 * move_unsubscribe.
 *
 * PROTECTED folders are never written even if a rule targets them: a message
 * routed at one is skipped (blocked) and logged, not moved.
 *
 * Two switches, both off by default (unchanged from Phase 1):
 *   AUTO_MOVE_ENABLED=false  the cron does nothing
 *   AUTO_MOVE_DRY_RUN=true   decide and log, move nothing
 */

const UNSUBSCRIBE_FOLDER = 'Unsubscribe Needed';
const BATCH_LIMIT = 50;

// Never written, even if a rule points here. Normalized (lowercased, single
// spaces) so "Legal / Lawsuits" and "legal / lawsuits" both match.
const PROTECTED_FOLDERS = new Set(
  ['Lyndsay Review', 'Client Emails', 'Legal / Lawsuits', 'Proper Pending Items']
    .map(n => n.toLowerCase().replace(/\s+/g, ' ').trim()),
);
const normFolder = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();

const flag = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
};
const autoMoveEnabled = () => flag('AUTO_MOVE_ENABLED', false);
const autoMoveDryRun = () => flag('AUTO_MOVE_DRY_RUN', true);

// ── Data loads ──────────────────────────────────────────────────────────────
async function loadRules(db) {
  if (!db) return [];
  const { data, error } = await db.from('automove_rules')
    .select('*').eq('active', true).order('priority', { ascending: true });
  if (error) throw new Error('automove_rules: ' + error.message);
  return data || [];
}
// Legacy allowlist — kept, evaluated after the rules as the lowest priority.
async function loadColdSenders(db) {
  if (!db) return new Set();
  const { data, error } = await db.from('cold_outreach_senders')
    .select('sender_email').eq('active', true);
  if (error) throw new Error('cold_outreach_senders: ' + error.message);
  return new Set((data || []).map(r => (r.sender_email || '').trim().toLowerCase()).filter(Boolean));
}

async function fetchUnread(ctx, limit) {
  const select = 'id,subject,from,sender,receivedDateTime,internetMessageId';
  const url = ctx.base + '/mailFolders/inbox/messages?$filter=isRead eq false'
            + '&$top=' + limit + '&$orderby=receivedDateTime desc&$select=' + select;
  const r = await ctx.fetchFn(url, { headers: ctx.headers });
  const j = await r.json();
  if (!r.ok) throw new Error('Cannot read Inbox: ' + ((j.error && j.error.message) || r.status));
  return j.value || [];
}

// internetMessageHeaders can't be $selected on a list or $filtered, so one GET
// per message, batched 20 at a time. Returns a Map id → Set of lowercased
// header names, used by the 'header' match type.
async function fetchHeaderNames(ctx, msgs) {
  const out = new Map();
  for (let i = 0; i < msgs.length; i += 20) {
    const chunk = msgs.slice(i, i + 20);
    const r = await ctx.fetchFn('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      headers: Object.assign({}, ctx.headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ requests: chunk.map((m, j) => ({
        id: String(j), method: 'GET',
        url: '/users/' + ctx.mailbox + '/messages/' + encodeURIComponent(m.id) + '?$select=internetMessageHeaders',
      })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('$batch failed: ' + ((j.error && j.error.message) || r.status));
    for (const resp of (j.responses || [])) {
      const m = chunk[parseInt(resp.id, 10)];
      if (!m || resp.status !== 200) continue;
      const names = new Set((resp.body?.internetMessageHeaders || []).map(h => String(h.name || '').toLowerCase()));
      out.set(m.id, names);
    }
  }
  return out;
}

// ── Folder resolution (cached per run) ──────────────────────────────────────
// Lyndsay's routing folders (MPM Team, Rocio, Financial, Personal, …) are Inbox
// children; a top-level pass is added as a fallback. "Unsubscribe Needed" is
// created if missing. 'archive' is Graph's built-in alias and needs no lookup.
async function buildFolderMap(ctx) {
  if (ctx._folderMap) return ctx._folderMap;
  const map = new Map();
  const add = list => (list || []).forEach(f => {
    const key = normFolder(f.displayName);
    if (key && !map.has(key)) map.set(key, f.id);
  });
  const inboxR = await ctx.fetchFn(ctx.base + '/mailFolders/inbox/childFolders?$select=id,displayName&$top=200', { headers: ctx.headers });
  const inboxJ = await inboxR.json();
  if (!inboxR.ok) throw new Error('Cannot list Inbox folders: ' + ((inboxJ.error && inboxJ.error.message) || inboxR.status));
  add(inboxJ.value);
  const topR = await ctx.fetchFn(ctx.base + '/mailFolders?$select=id,displayName&$top=200', { headers: ctx.headers });
  const topJ = await topR.json();
  if (topR.ok) add(topJ.value);
  ctx._folderMap = map;
  return map;
}
async function resolveFolderId(ctx, name) {
  const map = await buildFolderMap(ctx);
  const key = normFolder(name);
  if (map.has(key)) return map.get(key);
  // Only "Unsubscribe Needed" is auto-created; every other unknown folder is a
  // configuration error the caller should see, not silently invent.
  if (key === normFolder(UNSUBSCRIBE_FOLDER)) {
    const mk = await ctx.fetchFn(ctx.base + '/mailFolders/inbox/childFolders', {
      method: 'POST', headers: Object.assign({}, ctx.headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ displayName: UNSUBSCRIBE_FOLDER }),
    });
    const mj = await mk.json();
    if (!mk.ok) throw new Error('Cannot create "' + UNSUBSCRIBE_FOLDER + '": ' + ((mj.error && mj.error.message) || mk.status));
    map.set(key, mj.id);
    ctx._folderCreated = true;
    return mj.id;
  }
  return null;
}

// ── Graph mutations ─────────────────────────────────────────────────────────
async function moveMessage(ctx, id, destination) {
  const r = await ctx.fetchFn(ctx.base + '/messages/' + encodeURIComponent(id) + '/move', {
    method: 'POST', headers: Object.assign({}, ctx.headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ destinationId: destination }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('move failed: ' + ((j.error && j.error.message) || r.status)); }
}
async function markRead(ctx, id) {
  const r = await ctx.fetchFn(ctx.base + '/messages/' + encodeURIComponent(id), {
    method: 'PATCH', headers: Object.assign({}, ctx.headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ isRead: true }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('mark read failed: ' + ((j.error && j.error.message) || r.status)); }
}

// ── Log / dedupe ────────────────────────────────────────────────────────────
// The unique index on internet_message_id makes this at-most-once. Dry runs
// claim with a NULL id (Postgres allows repeated NULLs) so they never block the
// real run and can be re-run freely.
async function claim(db, row, dryRun) {
  const payload = Object.assign({}, row, {
    internet_message_id: dryRun ? null : (row.internet_message_id || null),
    dry_run: dryRun,
  });
  const { data, error } = await db.from('auto_move_log').insert([payload]).select('id').single();
  if (error) { if (error.code === '23505') return null; throw new Error('auto_move_log: ' + error.message); }
  return data.id;
}
async function markError(db, id, message) {
  if (!db || !id) return;
  await db.from('auto_move_log').update({ error: String(message).slice(0, 500) }).eq('id', id);
}

const senderOf = (m) =>
  ((m.from && m.from.emailAddress && m.from.emailAddress.address)
    || (m.sender && m.sender.emailAddress && m.sender.emailAddress.address) || '').toLowerCase();

// Does one rule match one message? Comparisons are lowercased on both sides.
function ruleMatches(rule, msg, sender, headerNames) {
  const val = String(rule.match_value || '').toLowerCase();
  const subject = String(msg.subject || '').toLowerCase();
  switch (rule.match_type) {
    case 'sender_exact':       return sender === val;
    case 'sender_domain':      return sender.endsWith(val);
    case 'header':             return !!(headerNames && headerNames.has(val));
    case 'subject_contains':   return subject.includes(val);
    case 'subject_startswith': return subject.startsWith(val);
    default: return false;
  }
}

// Resolves a matched rule (or a legacy cold-sender hit) into the concrete
// destination + whether to mark read. Returns null if the action is unknown.
function planFor(action, rule) {
  const markReadFlag = (rule && rule.mark_read === true) || action === 'move_read' || action === 'archive_read';
  switch (action) {
    case 'archive':
    case 'archive_read':    return { kind: 'archive', destName: 'Archive', markRead: markReadFlag };
    case 'move_unsubscribe':return { kind: 'unsubscribe', destName: UNSUBSCRIBE_FOLDER, markRead: markReadFlag };
    case 'move':
    case 'move_read':       return { kind: 'move', destName: rule ? rule.target_folder : null, markRead: markReadFlag };
    default: return null;
  }
}

/**
 * One pass. deps: { fetchFn, token, mailbox, db, log }; opts: { dryRun }.
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
    dryRun, scanned: 0,
    archived: 0, unsubscribed: 0, moved: 0,   // archived = archive(_read); moved = folder routes
    skipped: 0, blocked: 0, alreadyHandled: 0, errors: 0,
    folderCreated: false, rulesLoaded: 0, allowlistSize: 0, actions: [],
  };

  const rules = await loadRules(db);
  const cold = await loadColdSenders(db);
  summary.rulesLoaded = rules.length;
  summary.allowlistSize = cold.size;

  const unread = await fetchUnread(ctx, BATCH_LIMIT);
  summary.scanned = unread.length;
  if (!unread.length) return summary;

  // Fetch headers only if any active rule needs them.
  const needHeaders = rules.some(r => r.match_type === 'header');
  const headersById = needHeaders ? await fetchHeaderNames(ctx, unread) : new Map();

  for (const m of unread) {
    const sender = senderOf(m);
    const headerNames = headersById.get(m.id);

    // 1) rules in priority order, first match wins; 2) legacy cold allowlist.
    let action = null, matchedOn = null, matchedRule = null;
    const hit = rules.find(r => ruleMatches(r, m, sender, headerNames));
    if (hit) {
      action = hit.action; matchedRule = hit;
      matchedOn = `${hit.match_type}:${hit.match_value}`;
    } else if (cold.has(sender)) {
      action = 'archive_read'; matchedOn = sender;   // legacy behavior
    }
    if (!action) { summary.skipped++; continue; }

    const plan = planFor(action, matchedRule);
    if (!plan) { summary.skipped++; log('[auto-move] unknown action "' + action + '" — skipped'); continue; }

    // Protected-folder guard: never write one, even if a rule points there.
    if (plan.kind === 'move' && PROTECTED_FOLDERS.has(normFolder(plan.destName))) {
      summary.blocked++;
      log('[auto-move] BLOCKED ' + sender + ' → protected folder "' + plan.destName + '"');
      continue;
    }

    const targetLabel = plan.kind === 'archive' ? 'Archive' : plan.destName;
    const rowId = await claim(db, {
      email_id: m.id,
      internet_message_id: m.internetMessageId || null,
      subject: (m.subject || '').slice(0, 500),
      sender,
      action,
      matched_on: matchedOn,
      target_folder: targetLabel,
      rule_id: matchedRule ? matchedRule.id : null,
    }, dryRun);
    if (!rowId) { summary.alreadyHandled++; continue; }

    const bump = () => { if (plan.kind === 'archive') summary.archived++; else if (plan.kind === 'unsubscribe') summary.unsubscribed++; else summary.moved++; };
    summary.actions.push({ action, sender, subject: m.subject || '', target: targetLabel });

    if (dryRun) { bump(); continue; }

    try {
      let destId = 'archive';
      if (plan.kind === 'unsubscribe' || plan.kind === 'move') {
        destId = await resolveFolderId(ctx, plan.destName);
        if (!destId) { summary.errors++; await markError(db, rowId, `folder "${plan.destName}" not found`); log('[auto-move] folder not found: ' + plan.destName); continue; }
        summary.folderCreated = summary.folderCreated || !!ctx._folderCreated;
      }
      // Read before move: Graph reissues the message id on a move.
      if (plan.markRead) await markRead(ctx, m.id);
      await moveMessage(ctx, m.id, destId);
      bump();
    } catch (err) {
      summary.errors++;
      await markError(db, rowId, err.message);
      log('[auto-move] ERROR ' + action + ' ' + sender + ': ' + err.message);
    }
  }

  return summary;
}

module.exports = {
  runAutoMove, loadRules, loadColdSenders, resolveFolderId,
  autoMoveEnabled, autoMoveDryRun,
  UNSUBSCRIBE_FOLDER, BATCH_LIMIT, PROTECTED_FOLDERS,
};
