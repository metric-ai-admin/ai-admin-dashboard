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
      } else if (c.targetsSet) {
        bits.push('<div class="alert-box" style="margin:10px 0"><div class="al">ALL IN</div>'
          + 'Everyone on the roster posted on ' + esc(c.day) + '.</div>');
      }

      // NO TARGET IS NOT ALL CLEAR. With the five agents loaded and no daily
      // number from Lyndsay, `missing` is empty on a day nobody posted — and
      // the old branch above would have called that "everyone posted". This is
      // the honest reading: here is what they did, and the number they are
      // being measured against does not exist yet.
      if (c.noTarget && c.noTarget.length) {
        bits.push('<div class="alert-box warn" style="margin:10px 0">'
          + '<div class="al">NO DAILY TARGET</div>'
          + esc(c.note || '') + '<br>'
          + c.noTarget.map(p => esc(p.name) + ' — ' + p.posts
              + (p.posts === 1 ? ' post' : ' posts')).join(' · ')
          + '</div>');
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
    // The uploader, when it is somebody other than the author. Compared on the
    // EMAIL where both are present — two people can share a display name and a
    // login cannot, and "Rocío" vs "Rocio" would otherwise read as a different
    // person uploading for herself.
    const spUploader = p => {
      const by = String(p.uploaded_by || '').trim();
      if (!by) return '';
      const a = String(p.author_email || '').toLowerCase().trim();
      const u = String(p.uploaded_by_email || '').toLowerCase().trim();
      if (a && u) return a === u ? '' : by;
      return by.toLowerCase() === String(p.author || '').toLowerCase().trim() ? '' : by;
    };
    const row = p => '<tr>'
      + '<td>' + esc(String(p.posted_on || p.created_at || '').slice(0, 10)) + '</td>'
      // WHOSE POST, then who entered it — and only when those differ. Katrina
      // files the leasing agents' links for them now, so "Who" alone would
      // read as though Sammy pressed the button, and the daily count below is
      // measured on the agent either way.
      + '<td>' + esc(p.author)
        + (spUploader(p)
          ? '<div class="muted small">uploaded by ' + esc(spUploader(p)) + '</div>'
          : '')
        + '</td>'
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

  /* The "Posted by (agent)" selector.
   *
   * Drawn only when the SERVER says this account may upload on somebody's
   * behalf — Katrina (marketing_bd_agent) and admins. Katie keeps the tab and
   * the upload; she just files posts as herself.
   *
   * Hidden, not disabled: a control that is visible and refuses to work is a
   * support question. And hiding it is a courtesy only — POST re-checks the
   * role and refuses the field outright, so a hand-made request gets the same
   * answer as the form.
   */
  function spRenderUploadFor() {
    const field = $('#sp-for-field');
    const sel = $('#sp-for');
    if (!field || !sel) return;
    const people = (spData && spData.uploadFor) || [];
    if (!spData || !spData.mayUploadForOthers || !people.length) {
      field.classList.add('hidden');
      sel.value = '';                       // never submit a stale name
      return;
    }
    field.classList.remove('hidden');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Me</option>'
      + people.map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');
    // The agent stays selected between uploads: Katrina enters several links
    // for one person at a time, and re-picking the name every time is how the
    // wrong one gets picked.
    if (keep && people.some(p => p.name === keep)) sel.value = keep;
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
    spRenderUploadFor();
    if (sub) {
      // SAY WHOSE POSTS THESE ARE. A leasing agent sees only her own rows, and
      // an unlabelled list of three would read as a quiet day for the whole
      // team. The duplicate check still runs against everybody's posts — she
      // gets the message naming who posted it, not their list.
      sub.textContent = (spData.posts || []).length + ' post(s) · '
        + (spData.scope === 'own'
            ? 'your posts only — duplicates are still checked against everyone’s'
            : 'duplicate links are refused')
        + ' · screenshots go to SharePoint by week';
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
      // FormData, because a screenshot comes with it.
      //
      // posted_by RIDES ALONG, and is the one field here the sender does not
      // get to decide the meaning of: the server honours it only for the
      // roles that may file on somebody's behalf, and REFUSES it for anyone
      // else rather than quietly filing the post under their own name. A
      // request made by hand gets the same answer as this form.
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
      // The agent stays picked across the reset. Katrina enters several links
      // for one person at a time, and a selector that silently returns to "Me"
      // between uploads files the next one against the wrong person — with no
      // error, because uploading as yourself is always allowed.
      const keepFor = (document.getElementById('sp-for') || {}).value || '';
      form.reset();
      const selAfter = document.getElementById('sp-for');
      if (selAfter && keepFor) selAfter.value = keepFor;
      await loadSocialPosts();
    } catch (err) {
      spMessage('warn', '<div class="al">ERROR</div>' + esc(err.message));
    } finally { btn.disabled = false; }
  });

  window.loadSocialPosts = loadSocialPosts;
}());
