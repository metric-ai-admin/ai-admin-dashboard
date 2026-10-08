// Consolidating SimpleVoIP mail into Inbox/Simple VOIP (Lyndsay, 2026-10-08).
//
// The decisions — which folders are read, which sender really counts as
// SimpleVoIP — live here rather than in the route, so they can be tested
// without a mailbox. The route does the Graph calls and nothing else.

const SOURCE_FOLDER = 'Simple Voip Daily Report';   // root folder, 95 messages on 2026-10-08
const TARGET_FOLDER = 'Simple VOIP';                // Inbox child, empty on 2026-10-08
// Two domains. Billing and the daily report come from .com; SUPPORT TICKETS
// COME FROM .us, which is not a typo and is easy to miss.
const DOMAINS = ['@simplevoip.com', '@simplevoip.us'];
const DOMAIN = DOMAINS[0];   // kept for callers that name a single domain

// And a subject match, whatever the sender. Jay answers support threads from
// admin@metricpropertymanagement.com, so the replies on a ticket carry an
// internal address — no sender test can see them, and the thread would end up
// split across two folders.
//
// Deliberately broad: a thread that only mentions SimpleVoIP in its subject is
// caught too. The dry run names every message before anything moves.
const SUBJECT_RE = /simplevoip/i;

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
const isDomainSender = address => DOMAINS.some(d => norm(address).endsWith(d));

const senderOf = m => (m && m.from && m.from.emailAddress && m.from.emailAddress.address) || '';
const subjectOf = m => (m && m.subject) || '';
const isSubjectMatch = subject => SUBJECT_RE.test(String(subject || ''));

// Why a message is being moved, or null if it is not. The reason is carried
// through to the dry run so a surprising row can be explained without guessing
// which test caught it.
function matchReason(m) {
  if (isDomainSender(senderOf(m))) return 'sender ' + norm(senderOf(m)).split('@')[1];
  if (isSubjectMatch(subjectOf(m))) return 'subject says SimpleVoIP';
  return null;
}

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
    const why = matchReason(m);
    if (why) kept.push({ message: m, why }); else discarded.push(m);
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

// The Graph $search terms that find candidates. Searched separately rather than
// as one OR string: Graph's KQL support across mailboxes is uneven, and a query
// that silently returns nothing is indistinguishable from a folder with nothing
// in it. Every hit is re-checked by matchReason either way.
function searchTerms() {
  return DOMAINS.map(d => `"from:${d}"`).concat(['"subject:SimpleVoIP"']);
}

function summarizeReasons(plan) {
  const byReason = {};
  (plan || []).forEach(m => { byReason[m.why] = (byReason[m.why] || 0) + 1; });
  return byReason;
}

module.exports = {
  SOURCE_FOLDER, TARGET_FOLDER, DOMAIN, DOMAINS, SUBJECT_RE, PROTECTED,
  isDomainSender, isSubjectMatch, matchReason, senderOf, subjectOf,
  foldersToScan, keepRealHits, planRow, summarize, summarizeReasons, searchTerms, norm,
};
