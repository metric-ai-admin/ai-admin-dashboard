// sop-library.js
//
// SOP Library v2 — the decisions, as pure functions.
//
// Access, review scheduling and markdown rendering live here rather than in a
// route handler so they can be tested without a database and so the dashboard
// and any future job answer the same way. Nothing in this file does I/O.

const STATUSES = ['Current', 'Needs Review', 'Outdated', 'Archived'];
// 90 / 180 / 365 as asked, plus null for "not on a schedule" — which is a real
// state and not the same as overdue.
const REVIEW_INTERVALS = [90, 180, 365];

// ---- Access ----------------------------------------------------------------
//
// Driven by the sop_departments table, not a hard-coded list, so granting
// Collections access to Accounting's procedures is a row change.
//
// admin is allowed everywhere regardless of what the table says. That is not a
// shortcut: admin already administers the table, so an admin locked out of a
// department could simply grant themselves access, and pretending otherwise
// would only make the code lie about who can see what.
function canRead(role, department, departments) {
  if (role === 'admin') return true;
  const d = (departments || []).find(x => x.name === department);
  return !!d && (d.read_roles || []).includes(role);
}

function canEdit(role, department, departments) {
  if (role === 'admin') return true;
  const d = (departments || []).find(x => x.name === department);
  return !!d && (d.edit_roles || []).includes(role);
}

// Which departments a role may see at all — used to filter the list before it
// reaches the browser, rather than hiding rows in the UI. A row that reaches
// the client is readable by whoever asked for it.
function readableDepartments(role, departments) {
  if (role === 'admin') return (departments || []).map(d => d.name);
  return (departments || []).filter(d => (d.read_roles || []).includes(role)).map(d => d.name);
}

// Which departments a role may WRITE in.
//
// Separate from readableDepartments because the two differ for everyone except
// admin: Operations reads several departments and edits one. The New SOP form
// offers only these, so nobody picks a department and then discovers on save
// that it was never theirs — and the create route checks the same function, so
// the form is a convenience and not the lock.
function editableDepartments(role, departments) {
  if (role === 'admin') return (departments || []).map(d => d.name);
  return (departments || []).filter(d => (d.edit_roles || []).includes(role)).map(d => d.name);
}

// A url-safe id from a title, made unique against what is already there.
//
// Slugs are a primary-key-ish column, and two people creating "Move-Out
// Process" on the same morning must not collide — the second becomes
// move-out-process-2 rather than failing with a database error nobody can act
// on. `taken` is a Set of existing slugs.
function uniqueSlug(title, taken) {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'sop';
  if (!taken || !taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    const s = base + '-' + i;
    if (!taken.has(s)) return s;
  }
  return base + '-' + Date.now();
}

// ---- Review scheduling -----------------------------------------------------

function isoDay(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10) || null;
}

// next = the day it was reviewed + the interval. Returns null when there is no
// interval: unscheduled must not silently become "due today".
function nextReviewDate(reviewedAt, intervalDays) {
  const n = Number(intervalDays);
  if (!reviewedAt || !isFinite(n) || n <= 0) return null;
  const base = new Date(isoDay(reviewedAt) + 'T00:00:00Z');
  if (isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
}

// `today` is a parameter, never the clock, so a list is reproducible and a test
// does not drift.
function reviewState(doc, today, { soonDays = 14 } = {}) {
  const due = isoDay(doc && doc.next_review_at);
  if (!due) return { state: 'unscheduled', days: null, overdue: false, dueSoon: false };
  const days = Math.round(
    (Date.parse(due + 'T00:00:00Z') - Date.parse(isoDay(today) + 'T00:00:00Z')) / 86400000);
  if (!isFinite(days)) return { state: 'unscheduled', days: null, overdue: false, dueSoon: false };
  if (days < 0) return { state: 'overdue', days, overdue: true, dueSoon: false };
  if (days <= soonDays) return { state: 'due-soon', days, overdue: false, dueSoon: true };
  return { state: 'ok', days, overdue: false, dueSoon: false };
}

// What "Mark as Reviewed" writes. Status is moved to Current ONLY from
// "Needs Review": reviewing an Outdated document does not make it accurate, and
// an Archived one should not quietly come back to life.
function markReviewed(doc, { by, at = new Date().toISOString() } = {}) {
  const interval = doc && doc.review_interval_days;
  return {
    last_reviewed_at: at,
    last_reviewed_by: by || 'Dashboard',
    next_review_at: nextReviewDate(at, interval),
    ...(doc && doc.status === 'Needs Review' ? { status: 'Current' } : {}),
    updated_at: at,
    updated_by: by || 'Dashboard',
  };
}

// ---- Search ----------------------------------------------------------------
// Title, category and tags, plus the body. Body last and cheapest-first, since
// a 50 KB article scanned per keystroke is what makes a search feel broken.
function matches(doc, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  const head = [doc.title, doc.category, (doc.tags || []).join(' '), doc.owner, doc.author]
    .filter(Boolean).join(' ').toLowerCase();
  const body = String(doc.body_md || '').toLowerCase();
  return terms.every(t => head.includes(t) || body.includes(t));
}

// ---- Markdown --------------------------------------------------------------
//
// A small renderer rather than a dependency. The corpus is known: Slab exports
// headings, bold, italic, links, images, blockquotes, lists, code and tables,
// and that is the whole set.
//
// EVERYTHING IS ESCAPED FIRST. These documents came from an export nobody has
// audited, and 44 of them are empty while others contain raw HTML — rendering
// that HTML would be a stored-XSS hole that arrives with the import, on a page
// every employee can open.
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only http(s) and the library's own asset paths. A javascript: or data: URL in
// a link or an image is a script waiting to be clicked.
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/api\/sop\/assets\//.test(u)) return u;
  if (/^sop-assets\//.test(u)) return '/api/sop/assets/' + u.slice('sop-assets/'.length);
  return null;
}

function inline(text) {
  let s = esc(text);
  // Code first: its contents must not then be read as emphasis.
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, url) => {
    const safe = safeUrl(url);
    return safe ? `<img src="${esc(safe)}" alt="${alt}" loading="lazy">` : `<span class="sop-broken">[image: ${alt || 'missing'}]</span>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s;
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null, inCode = false, inQuote = false, inTable = false, tableRow = 0;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; tableRow = 0; } };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      closeList(); closeQuote(); closeTable();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }

    if (!line.trim()) {
      // A blank line does NOT always end a list.
      //
      // Slab's export puts a blank line between list items, and closing the
      // list on sight of one gave every item its own <ol> — so a numbered
      // procedure rendered as a column of "1." all the way down. That is a
      // loose list in every markdown dialect: the items are still one list,
      // they are just spaced.
      //
      // Looked ahead past the blanks: the list only closes if what follows is
      // not another item of the same kind.
      if (list) {
        let j = li + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nxt = j < lines.length ? lines[j] : '';
        const same = list === 'ul' ? /^\s*[-*+]\s+/.test(nxt) : /^\s*\d+[.)]\s+/.test(nxt);
        if (same) { closeQuote(); closeTable(); continue; }
      }
      closeList(); closeQuote(); closeTable(); continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); closeQuote(); closeTable(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) { closeList(); closeQuote(); out.push('<hr>'); continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inline(q[1])}</p>`);
      continue;
    }
    closeQuote();

    // Pipe tables. 22 articles in the export use them, and rendered as
    // paragraphs they become an unreadable run of pipes.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      // The ---|--- separator row is formatting, not data.
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!inTable) { out.push('<table class="sop-table">'); inTable = true; tableRow = 0; }
      const tag = tableRow === 0 ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>');
      tableRow++;
      continue;
    }
    closeTable();

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        // An ordered list that starts somewhere other than 1 keeps its own
        // number — a procedure pasted in starting at step 4 is still step 4.
        // Everything after it is numbered by the browser, which is the whole
        // point of an <ol> and the reason "1. 1. 1." in the source is fine.
        const first = ol ? parseInt(line.match(/^\s*(\d+)/)[1], 10) : 1;
        out.push(ol && first > 1 ? `<ol start="${first}">` : `<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeQuote(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

// A few lines of plain text for a list row. Images and links become their text.
function excerpt(md, chars = 180) {
  const t = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > chars ? t.slice(0, chars).replace(/\s+\S*$/, '') + '…' : t;
}

module.exports = {
  STATUSES, REVIEW_INTERVALS,
  canRead, canEdit, readableDepartments, editableDepartments, uniqueSlug,
  nextReviewDate, reviewState, markReviewed, isoDay,
  matches, renderMarkdown, excerpt, safeUrl,
};
