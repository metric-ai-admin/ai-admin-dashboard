// Lyndsay's read-only link, actually rendered.
//
// The sibling file asserts the SHAPE of the code. This one runs the page in
// jsdom with answers from all three reviewers and looks at the DOM that comes
// out, because the bug being fixed was invisible to a source scrape: every
// function was present and correct, and the page still came up with nothing on
// it — the picker that chooses whose answers to show was disabled along with
// everything else, so nothing was ever chosen.
//
// No server and no Supabase: fetch is stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const FILE = path.join(__dirname, '..', 'public', 'tools', 'rebrand-review.html');

// Deliberately uneven: a full answer, a partial one, a bare one, a reviewer who
// has not ranked, and a payload carrying markup.
const DOCS = {
  'reviews/signal--zach': { person: 'Zach', score: '8',
    overall: 'Sharp and modern.\nReads as a tech-forward operator.',
    pros: 'Short, memorable.', cons: 'Could read as a telecom brand.',
    q0: 'Immediate reaction: confident.' },
  'reviews/signal--kara': { person: 'Kara', score: '6',
    overall: 'Aspirational more than descriptive.', cons: 'Ops would have to catch up.' },
  'reviews/signal--bekah': { person: 'Bekah', score: '9',
    overall: 'Feels great. <script>alert(1)</script> and "quotes".' },
  'rankings/zach': { person: 'Zach', ranks: { 'base-signal': 1, 'base-axiom': 2, 'base-logic': 3, 'base-method': 4 } },
  'rankings/kara': { person: 'Kara', ranks: { 'base-axiom': 1, 'base-signal': 2 } },
  'final/zach': { person: 'Zach', drawn: 'Signal, because it sounds like us in five years.',
    against: 'It may age into a telecom cliche.' },
  'ideas/everpoint': { name: 'Everpoint', by: 'Zach' },
  'ideas/truemark': { name: 'Truemark', by: 'Zach' },
};

function render(readOnly) {
  return new Promise(resolve => {
    const html = fs.readFileSync(FILE, 'utf8')
      .replace(/__REVIEW_TOKEN__/g, 'd'.repeat(32))
      .replace(/__REVIEW_PERSON__/g, readOnly ? 'Lyndsay' : 'Kara');
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => errors.push(e.message));
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'https://example.test/review/' + 'd'.repeat(32), virtualConsole: vc,
      beforeParse(win) {
        win.fetch = async (url, init) => ({
          ok: true, status: 200,
          json: async () => (/\/docs$/.test(String(url)) && (!init || !init.method || init.method === 'GET')
            ? { docs: DOCS, person: readOnly ? 'Lyndsay' : 'Kara', readOnly }
            : { ok: true }),
        });
        win.EventSource = function () { this.close = () => {}; this.addEventListener = () => {}; };
      },
    });
    setTimeout(() => {
      const d = dom.window.document;
      resolve({ d, errors, body: d.body.textContent, close: () => dom.window.close() });
    }, 600);
  });
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

(async () => {
  console.log("rebrand read-only link — rendered");
  const ro = await render(true);

  t('it renders without errors', () => {
    assert.deepStrictEqual(ro.errors, []);
  });

  t('THE BUG: the page is not empty', () => {
    const panels = [...ro.d.querySelectorAll('.fb')];
    assert.ok(panels.length >= 4, 'only ' + panels.length + ' panels rendered');
    const cols = ro.d.querySelectorAll('.ro-col');
    assert.ok(cols.length > 0, 'nothing is shown at all — this is the original bug');
  });

  t('every panel is the read-only kind; no editable shell survives', () => {
    const panels = [...ro.d.querySelectorAll('.fb')];
    const editable = panels.filter(p => p.dataset.readonly !== '1');
    assert.strictEqual(editable.length, 0, editable.length + ' editable panels left');
  });

  t('all three reviewers appear side by side on one name', () => {
    const sig = [...ro.d.querySelectorAll('.fb')].find(p => p.dataset.target === 'signal');
    assert.ok(sig, 'the Signal panel is missing');
    const who = [...sig.querySelectorAll('.ro-col .top span:first-child')].map(s => s.textContent);
    assert.deepStrictEqual(who, ['Zach', 'Kara', 'Bekah']);
  });

  t('each column carries that reviewer\'s own score and sections', () => {
    const sig = [...ro.d.querySelectorAll('.fb')].find(p => p.dataset.target === 'signal');
    const cols = [...sig.querySelectorAll('.ro-col')];
    assert.strictEqual(cols[0].querySelector('.score').textContent, '8 / 10');
    assert.strictEqual(cols[1].querySelector('.score').textContent, '6 / 10');
    assert.ok(cols[0].textContent.includes('Short, memorable.'), "Zach's pros are missing");
    assert.ok(cols[1].textContent.includes('Ops would have to catch up.'), "Kara's cons are missing");
    // The deeper question is labelled with its question, not "q0".
    assert.ok(cols[0].textContent.includes('immediate gut reaction'), 'the deeper question lost its label');
    assert.ok(!/\bq0\b/.test(cols[0].textContent));
  });

  t('a reviewer with nothing to say gets a column, not a gap', () => {
    const logic = [...ro.d.querySelectorAll('.fb')].find(p => p.dataset.target === 'logic');
    assert.strictEqual(logic.querySelectorAll('.ro-col').length, 3);
    assert.ok(/No feedback on Logic yet\./.test(logic.textContent));
  });

  t('stored markup is escaped but still readable', () => {
    const sig = [...ro.d.querySelectorAll('.fb')].find(p => p.dataset.target === 'signal');
    assert.ok(!/<script>alert\(1\)<\/script>/.test(sig.innerHTML), 'stored HTML was injected');
    assert.ok(sig.textContent.includes('<script>alert(1)</script>'), 'the text was dropped instead of escaped');
    assert.strictEqual(ro.d.querySelectorAll('.ro-col script').length, 0);
  });

  t('nothing on the page can be typed into or clicked', () => {
    const live = [...ro.d.querySelectorAll('main input, main textarea, main select, .fb button')]
      .filter(el => !el.disabled);
    assert.strictEqual(live.length, 0, live.length + ' live controls on a read-only page');
  });

  t('rankings read as an ordered list, best first', () => {
    const box = ro.d.querySelector('#rankingForms');
    assert.strictEqual(box.querySelectorAll('select').length, 0, 'disabled dropdowns survived');
    const cols = [...box.querySelectorAll('.ro-col')];
    assert.strictEqual(cols.length, 3);
    assert.deepStrictEqual([...cols[0].querySelectorAll('li')].map(li => li.textContent),
      ['Signal', 'Axiom', 'Logic', 'Method']);
    // Kara ranked two of four; the rest are named rather than silently dropped.
    assert.ok(/Not ranked:/.test(cols[1].textContent), 'a partial ranking hides what was left out');
    assert.ok(/Has not ranked yet\./.test(cols[2].textContent));
  });

  t('the final comparison shows the questions that were answered', () => {
    const box = ro.d.querySelector('#finalForms');
    assert.strictEqual(box.querySelectorAll('textarea').length, 0, 'disabled textareas survived');
    const cols = [...box.querySelectorAll('.ro-col')];
    assert.strictEqual(cols.length, 3);
    assert.ok(cols[0].textContent.includes('sounds like us in five years'));
    assert.ok(/No final comparison yet\./.test(cols[1].textContent));
  });

  t("Zach's work is all still on the page after his link was revoked", () => {
    ['Everpoint', 'Truemark'].forEach(nm =>
      assert.ok(ro.body.includes(nm), nm + ' — one of his name ideas — is gone'));
    assert.ok(ro.body.includes('Sharp and modern.'), 'his Signal review is gone');
    assert.ok(ro.body.includes('sounds like us in five years'), 'his final comparison is gone');
  });

  ro.close();

  // ---- and a reviewer still gets a working form --------------------------
  const rw = await render(false);
  t('a reviewer still gets the editable page, not this one', () => {
    assert.deepStrictEqual(rw.errors, []);
    const panels = [...rw.d.querySelectorAll('.fb')];
    assert.ok(panels.length > 0);
    assert.strictEqual(panels.filter(p => p.dataset.readonly === '1').length, 0,
      'reviewers got the read-only view');
    assert.ok(rw.d.querySelectorAll('.fb .fields').length > 0, 'no answer fields for a reviewer');
    const live = [...rw.d.querySelectorAll('main textarea')].filter(el => !el.disabled);
    assert.ok(live.length > 0, 'a reviewer cannot type anything');
  });
  rw.close();

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
