// Social media post links — the form, the duplicate message, the daily check.
//
// Lyndsay asked for no duplicate links or posts, screenshots for the weekly
// report, and a daily accountability check. This is the screen for the first
// and the third; the screenshot goes to SharePoint on the way through.
//
// THE DUPLICATE MESSAGE IS THE POINT. Katrina's answer today is "we already
// have that, Rox posted it Tuesday", and a bare "duplicate" loses the half
// that settles it. The server sends who and when; this prints them.

(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  let spData = null;

  function spMessage(kind, html) {
    const el = $('#sp-message');
    if (!el) return;
    if (!html) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="alert-box ' + kind + '" style="margin:10px 0">' + html + '</div>';
  }

  // ---- the daily check ------------------------------------------------------
  //
  // An empty roster answers "we do not know who was expected", never
  // "everybody is up to date". A check that reports success from an empty
  // list is the most expensive kind of quiet.
  function spRenderCheck() {
    const el = $('#sp-check');
    if (!el || !spData) return;
    const c = spData.check || {};
    const bits = [];

    if (!c.known) {
      bits.push('<div class="alert-box warn" style="margin:10px 0"><div class="al">NOT KNOWN</div>'
        + esc(c.note || '') + '</div>');
    } else {
      if (c.missing && c.missing.length) {
        bits.push('<div class="alert-box warn" style="margin:10px 0">'
          + '<div class="al">MISSING</div><b>' + c.missing.length + '</b> did not post on '
          + esc(c.day) + ': '
          + c.missing.map(m => esc(m.name) + ' (' + m.posts + '/' + m.expected + ')').join(' · ')
          + '</div>');
      } else {
        bits.push('<div class="alert-box" style="margin:10px 0"><div class="al">ALL IN</div>'
          + 'Everyone on the roster posted on ' + esc(c.day) + '.</div>');
      }
      if (c.notOnRoster && c.notOnRoster.length) {
        bits.push('<p class="muted small">Posted but not on the roster: '
          + c.notOnRoster.map(esc).join(', ') + ' — the roster may be out of date.</p>');
      }
    }

    // Both halves of what is NOT built, said on the screen rather than left
    // for somebody to discover.
    const caveats = [];
    if (!spData.perceptualAvailable) {
      caveats.push('Near-duplicate screenshots are not detected — only an exact '
        + 'match of the same file. That needs an image decoder nobody has added yet.');
    }
    if (!spData.emailEnabled) {
      caveats.push('No summary email is being sent: how many posts a day are '
        + 'expected and who receives it are still open.');
    }
    if (caveats.length) {
      bits.push('<p class="muted small">' + caveats.map(esc).join('<br>') + '</p>');
    }
    el.innerHTML = bits.join('');
  }

  function spRenderList() {
    const el = $('#sp-list');
    if (!el || !spData) return;
    const posts = spData.posts || [];
    if (!posts.length) {
      el.innerHTML = '<p class="mb-empty">No posts uploaded yet.</p>';
      return;
    }
    const row = p => '<tr>'
      + '<td>' + esc(String(p.posted_on || p.created_at || '').slice(0, 10)) + '</td>'
      + '<td>' + esc(p.author) + '</td>'
      + '<td>' + esc(p.platform) + '</td>'
      + '<td>' + esc(p.property || '—') + '</td>'
      + '<td><a href="' + esc(p.url) + '" target="_blank" rel="noopener">open</a></td>'
      + '<td>' + (p.screenshot_url
        ? '<a href="' + esc(p.screenshot_url) + '" target="_blank" rel="noopener">screenshot</a>'
        : '<span class="muted">none</span>') + '</td>'
      + '</tr>';
    el.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr>'
      + '<th>Date</th><th>Who</th><th>Platform</th><th>Property</th>'
      + '<th>Link</th><th>Screenshot</th></tr></thead><tbody>'
      + posts.map(row).join('') + '</tbody></table></div>';
  }

  async function loadSocialPosts() {
    const sub = $('#sp-sub');
    try {
      spData = await api('/api/social-posts');
    } catch (err) {
      const setup = /migration|not set up/i.test(err.message || '');
      if (sub) sub.textContent = '';
      spMessage(setup ? 'warn' : 'warn',
        '<div class="al">' + (setup ? 'SETUP' : 'ERROR') + '</div>' + esc(err.message));
      return;
    }
    if (sub) {
      sub.textContent = (spData.posts || []).length + ' post(s) · '
        + 'duplicate links are refused · screenshots go to SharePoint by week';
    }
    const dl = $('#sp-properties');
    if (dl && window.METRIC_PROPERTIES) {
      dl.innerHTML = window.METRIC_PROPERTIES.map(p => '<option value="' + esc(p) + '">').join('');
    }
    spRenderCheck();
    spRenderList();
  }

  $('#sp-refresh')?.addEventListener('click', loadSocialPosts);

  $('#sp-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    spMessage('', '');
    try {
      // FormData, because a screenshot comes with it. The author is NOT in
      // here: the server takes it from the session, or a post could be filed
      // under somebody else's name.
      const res = await fetch('/api/social-posts', { method: 'POST', body: new FormData(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 is the duplicate, and its message already names who and when.
        spMessage('warn', '<div class="al">' + (res.status === 409 ? 'DUPLICATE' : 'NOT ADDED')
          + '</div>' + esc(data.error || 'Could not add it.'));
        return;
      }
      let note = 'Added.';
      if (data.warning) note += ' ' + data.warning;
      if (data.screenshotError) {
        // The post is saved; say what did not happen rather than implying the
        // screenshot is there.
        note += ' The screenshot did NOT reach SharePoint: ' + data.screenshotError;
      }
      spMessage('', esc(note));
      form.reset();
      await loadSocialPosts();
    } catch (err) {
      spMessage('warn', '<div class="al">ERROR</div>' + esc(err.message));
    } finally { btn.disabled = false; }
  });

  window.loadSocialPosts = loadSocialPosts;
}());
