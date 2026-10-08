// Consolidating SimpleVoIP mail into Inbox/Simple VOIP (Lyndsay, 2026-10-08).
//
// The decisions — which folders are read, which sender really counts as
// SimpleVoIP — live here rather than in the route, so they can be tested
// without a mailbox. The route does the Graph calls and nothing else.

const SOURCE_FOLDER = 'Simple Voip Daily Report';   // root folder, 95 messages on 2026-10-08
const TARGET_FOLDER = 'Simple VOIP';                // Inbox child, empty on 2026-10-08
const DOMAIN = '@simplevoip.com';

const norm = s => String(s || '').trim().toLowerCase();

// Never read from, and never moved out of.
//
// Sent Items and Drafts are Lyndsay's own writing. Deleted Items and Junk are
// decisions she has already made, and pulling mail back out of them would undo
// those decisions silently. The Sync Issues tree and Recovered Deleted Items
// are not mail she files.
const PROTECTED = new Set(['sent items', 'drafts', 'deleted items', 'junk email',
  'outbox', 'conversation history', 'sync issues', 'conflicts', 'local failures',
  'server failures', 'rss feeds', 'recovered deleted items (oct 1)']);

// Archive is excluded by DEFAULT but not protected: it holds years of SimpleVoIP
// notices filed as they arrived. "All SimpleVoIP mail goes to one folder" is
// about the live mail; hauling the whole history in would bury it. The dry run
// prints the Archive count either way, so the choice is made on a number rather
// than on a guess.
const ARCHIVE = 'archive';

// endsWith, not includes. 'simplevoip.com' as a substring also matches
// simplevoip.com.example.net — a lookalike domain is exactly how a filter like
// this gets abused, and the cost of being strict here is zero.
const isDomainSender = address => norm(address).endsWith(DOMAIN);

const senderOf = m => (m && m.from && m.from.emailAddress && m.from.emailAddress.address) || '';

// Which folders to search for stray SimpleVoIP mail.
function foldersToScan(folders, opts) {
  const o = opts || {};
  const out = [], skipped = [];
  for (const f of folders || []) {
    const name = norm(f.displayName);
    if (o.targetId && f.id === o.targetId) continue;        // already where it belongs
    if (o.sourceId && f.id === o.sourceId) continue;        // handled wholesale
    if (PROTECTED.has(name)) { skipped.push({ folder: f.displayName, why: 'protected' }); continue; }
    if (name === ARCHIVE && !o.includeArchive) {
      skipped.push({ folder: f.displayName, why: 'excluded by default — pass includeArchive to include it' });
      continue;
    }
    if (!f.totalItemCount) continue;                        // nothing in it
    out.push(f);
  }
  return { scan: out, skipped };
}

// Graph's $search is a relevance match, so every hit is re-checked here. A
// search that quietly returns a near-miss would move somebody else's mail.
function keepRealHits(messages) {
  const kept = [], discarded = [];
  for (const m of messages || []) {
    (isDomainSender(senderOf(m)) ? kept : discarded).push(m);
  }
  return { kept, discarded };
}

function planRow(m, folderName, why) {
  return {
    id: m.id,
    from: senderOf(m) || '(none)',
    subject: m.subject || '(no subject)',
    received: String(m.receivedDateTime || '').slice(0, 10),
    fromFolder: folderName,
    why,
  };
}

function summarize(plan) {
  const byFolder = {}, bySender = {};
  (plan || []).forEach(m => {
    byFolder[m.fromFolder] = (byFolder[m.fromFolder] || 0) + 1;
    bySender[m.from] = (bySender[m.from] || 0) + 1;
  });
  const dates = (plan || []).map(m => m.received).filter(Boolean).sort();
  return {
    total: (plan || []).length,
    byFolder, bySender,
    received: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    sample: (plan || []).slice(0, 5).map(m => ({ received: m.received, from: m.from, subject: m.subject })),
  };
}

module.exports = {
  SOURCE_FOLDER, TARGET_FOLDER, DOMAIN, PROTECTED,
  isDomainSender, senderOf, foldersToScan, keepRealHits, planRow, summarize, norm,
};
