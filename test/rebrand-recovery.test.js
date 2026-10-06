// The Rebrand Review page must not be able to lose an answer.
//
// On 2026-10-06 Zak finished his review and reported that answers had vanished.
// What the page did when a write failed was: keep the value in localStorage,
// retry ONCE for the whole page, show a notice, and then go back to displaying
// "All responses saved" — because the indicator only ever looked at whether a
// request was in flight, never at whether one had succeeded. And localStorage
// was only ever read back in the offline fallback, so on the next load the
// page showed the server copy alone and the field was blank.
//
// Driven through jsdom against the real file, with fetch stubbed, so these are
// the page's actual behaviours rather than assertions about its source.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);

const FILE = path.join(__dirname, '..', 'public', 'tools', 'rebrand-review.html');
const SRC = fs.readFileSync(FILE, 'utf8');

// A page wired to a fake server and a fake browser store.
function boot({ server = {}, local = {}, person = 'Zach', fail = () => false } = {}) {
  const puts = [];
  const html = SRC.replace(/__REVIEW_TOKEN__/g, 'tkn').replace(/__REVIEW_PERSON__/g, person);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.invalid/review/tkn',
    beforeParse(w) {
      // Seeded before any script runs, the way a returning browser would have it.
      Object.keys(local).forEach(k =>
        w.localStorage.setItem('metricRebrand:doc:' + k, JSON.stringify(local[k])));
      w.localStorage.setItem('metricRebrand:me', person);
      // The read-only link belongs to nobody in `people`, which is exactly the
      // value that used to crash the page.
      w.fetch = async (u, o) => {
        o = o || {};
        if (!o.method || o.method === 'GET') {
          // Shaped like the real route, which has always returned readOnly.
          return { ok: true, status: 200, json: async () => ({
            docs: JSON.parse(JSON.stringify(server)), person,
            readOnly: person === 'Lyndsay',
          }) };
        }
        const b = JSON.parse(o.body || '{}');
        if (o.method === 'PUT') {
          if (fail(b.path)) { const e = new Error('HTTP 403'); throw e; }
          puts.push({ path: b.path, data: b.data });
          server[b.path] = b.data;
        }
        return { ok: true, status: 204, json: async () => null };
      };
    },
  });
  return { w: dom.window, puts, server };
}
const settle = ms => new Promise(r => setTimeout(r, ms == null ? 1200 : ms));
// Read through the DOM, not the page's internals: the page's script runs
// inside an IIFE, and what the reviewer actually sees is the better question
// anyway.
const field = (w, path, f) => {
  const el = w.document.querySelector(`[data-path="${path}"][data-field="${f}"]`);
  return el ? el.value : undefined;
};
const syncState = w => w.document.querySelector('#sync').dataset.s;
const syncText = w => w.document.querySelector('#sync').lastElementChild.textContent;

// ---- 1. nothing disappears on reload ---------------------------------------
t('an answer only this browser has survives a reload', async () => {
  // Exactly Zak's shape: the server has the first name's answers, the browser
  // also holds deeper answers for a second name that never reached it.
  const { w, server } = boot({
    server: { 'reviews/signal--zach': { overall: 'from the server', person: 'Zach' } },
    local: {
      'reviews/signal--zach': { overall: 'from the server', q0: 'only on this device' },
      'reviews/logic--zach': { overall: 'also local', q3: 'deep answer nobody has' },
    },
  });
  await settle();
  assert.strictEqual(field(w, 'reviews/signal--zach', 'q0'), 'only on this device',
    'a field the server lacks must be recovered');
  assert.strictEqual(field(w, 'reviews/logic--zach', 'q3'), 'deep answer nobody has',
    'a whole document the server lacks must be recovered');
  // And it is sent back, so the next device sees it too.
  assert.strictEqual(server['reviews/logic--zach'].q3, 'deep answer nobody has');
});

t('the server always wins where it has a value', async () => {
  // Bekah is typing while this deploys. A stale local copy must never be able
  // to overwrite something written since.
  const { w } = boot({
    server: { 'reviews/signal--zach': { overall: 'NEWER, written elsewhere' } },
    local: { 'reviews/signal--zach': { overall: 'older local copy', q1: 'kept' } },
  });
  await settle();
  assert.strictEqual(field(w, 'reviews/signal--zach', 'overall'), 'NEWER, written elsewhere');
  assert.strictEqual(field(w, 'reviews/signal--zach', 'q1'), 'kept',
    'the fields it does not conflict with still come across');
});

t('nothing is ever removed by the merge', async () => {
  const { w } = boot({
    server: { 'reviews/signal--zach': { overall: 'a', pros: 'b', cons: 'c' } },
    local: { 'reviews/signal--zach': { overall: 'a' } },
  });
  await settle();
  assert.deepStrictEqual(
    ['overall', 'pros', 'cons'].map(f => field(w, 'reviews/signal--zach', f)),
    ['a', 'b', 'c']);
});

t('an empty local value does not blank out anything', async () => {
  const { w, puts } = boot({
    server: { 'reviews/signal--zach': { overall: 'real answer' } },
    local: { 'reviews/signal--zach': { overall: '', pros: '   ' } },
  });
  await settle();
  assert.strictEqual(field(w, 'reviews/signal--zach', 'overall'), 'real answer');
  assert.strictEqual(puts.length, 0, 'and nothing is re-sent, because nothing was recovered');
});

t("someone else's answer is never re-sent, even if this browser has a copy", async () => {
  // It would be refused, and the refusal would light up the error state for a
  // write that SHOULD be refused.
  const { w, puts } = boot({
    server: {},
    local: { 'reviews/signal--kara': { overall: 'Kara typed this on a shared laptop' } },
  });
  await settle();
  assert.ok(!puts.some(p => p.path.endsWith('--kara')), 'it is not written back');
  assert.ok(!puts.some(p => p.path.endsWith('--kara')), 'but never written back');
});

t('the read-only link recovers nothing back to the server', async () => {
  const { w, puts } = boot({
    person: 'Lyndsay',
    server: {},
    local: { 'reviews/signal--lyndsay': { overall: 'x' } },
  });
  await settle();
  assert.strictEqual(puts.length, 0);
  assert.strictEqual(syncState(w), 'error');
  assert.strictEqual(syncText(w), 'Read only');
});

// ---- 2. the indicator tells the truth --------------------------------------
t('a failed write never ends up saying "All responses saved"', async () => {
  const { w } = boot({ server: {}, local: {}, fail: p => p === 'reviews/signal--zach' });
  await settle(300);
  const ta = w.document.querySelector('[data-field="overall"][data-path="reviews/signal--zach"]');
  ta.value = 'this will not reach the server';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(4000);
  assert.strictEqual(syncState(w), 'error');
  assert.ok(/Not saved/.test(syncText(w)), 'got: ' + syncText(w));
});

t('the failure state is sticky until a write for that path lands', async () => {
  let broken = true;
  const { w } = boot({ server: {}, local: {}, fail: () => broken });
  await settle(300);
  const ta = w.document.querySelector('[data-field="overall"][data-path="reviews/signal--zach"]');
  ta.value = 'one';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(4000);
  assert.strictEqual(syncState(w), 'error');
  broken = false;
  ta.value = 'two';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(1500);
  assert.strictEqual(syncState(w), 'live', 'got: ' + syncText(w));
  assert.strictEqual(syncText(w), 'All responses saved');
});

t('a failed write still leaves the answer in this browser', async () => {
  const { w } = boot({ server: {}, local: {}, fail: () => true });
  await settle(300);
  const ta = w.document.querySelector('[data-field="overall"][data-path="reviews/signal--zach"]');
  ta.value = 'kept locally';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(4000);
  const raw = w.localStorage.getItem('metricRebrand:doc:reviews/signal--zach');
  assert.ok(raw && JSON.parse(raw).overall === 'kept locally',
    'localStorage is written before the server call and regardless of its outcome');
});

// ---- 3. retries are per path -----------------------------------------------
t('one document failing does not use up another document\'s retries', async () => {
  const { w, puts } = boot({ server: {}, local: {}, fail: p => /logic/.test(p) });
  await settle(300);
  const a = w.document.querySelector('[data-field="overall"][data-path="reviews/signal--zach"]');
  const b = w.document.querySelector('[data-field="overall"][data-path="reviews/logic--zach"]');
  a.value = 'fine'; a.dispatchEvent(new w.Event('input', { bubbles: true }));
  b.value = 'broken'; b.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(5000);
  assert.ok(puts.some(p => p.path === 'reviews/signal--zach'),
    'the healthy document must still save while another is failing');
  assert.strictEqual(syncState(w), 'error', 'and the page still says the other one did not');
});

t('a path retries more than once before giving up', async () => {
  let attempts = 0;
  const { w } = boot({ server: {}, local: {}, fail: () => { attempts++; return true; } });
  await settle(300);
  const ta = w.document.querySelector('[data-field="overall"][data-path="reviews/signal--zach"]');
  ta.value = 'x';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(6000);
  assert.ok(attempts >= 3, 'expected several attempts, got ' + attempts);
});

// ---- 4. the optional questions are visible ---------------------------------
t('the deeper questions are open, not hidden behind a collapsed summary', async () => {
  const { w } = boot({ server: {}, local: {} });
  await settle();
  const deeps = [...w.document.querySelectorAll('details.deep')];
  assert.ok(deeps.length >= 4, 'one per full panel, got ' + deeps.length);
  assert.ok(deeps.every(d => d.open), 'every one must start open');
});

t('each name says how many deeper questions it has and how many are answered', async () => {
  const { w } = boot({
    server: { 'reviews/signal--zach': { q0: 'answered', q1: 'also answered' } },
    local: {},
  });
  await settle();
  const sums = [...w.document.querySelectorAll('.deep-sum')].map(s => s.textContent);
  assert.ok(sums.some(x => /9 deeper questions about Signal .*2 of 9 answered/.test(x)),
    'got: ' + JSON.stringify(sums));
  assert.ok(sums.some(x => /deeper questions about Logic .*none answered yet/.test(x)),
    'an untouched name must say so: ' + JSON.stringify(sums));
});

t('the count follows along as answers are typed', async () => {
  const { w } = boot({ server: {}, local: {} });
  await settle();
  const panel = w.document.querySelector('.fb[data-target="logic"]');
  const ta = panel.querySelector('.deep-body textarea');
  ta.value = 'an answer';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(200);
  assert.ok(/1 of 9 answered/.test(panel.querySelector('.deep-sum').textContent),
    'a counter stuck on "none answered yet" is worse than no counter');
});

t('the questions themselves are untouched', async () => {
  const { w } = boot({ server: {}, local: {} });
  await settle();
  const labels = [...w.document.querySelectorAll('.deep-body label')].map(l => l.textContent);
  assert.ok(labels.some(x => /immediate gut reaction/.test(x)), 'got: ' + labels.slice(0, 2));
  assert.strictEqual(
    w.document.querySelectorAll('.fb[data-target="signal"] .deep-body textarea').length, 9);
});

(async () => {
  for (const [name, fn] of results) {
    await fn();
    pass++;
    console.log('  ok  ' + name);
  }
  console.log(`\n${pass} passing`);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
