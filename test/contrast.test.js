// Can the text actually be read?
//
// The Collections move-out table was written with var(--ok, #1a7f37),
// var(--warn, #b26a00) and var(--bad, #b00020). NONE of --ok, --warn or --bad
// is defined in styles.css, so all three fell through to their fallbacks —
// light-theme colours drawn on a dark card. Measured against #111118 the green
// came to 3.70, the red to 2.57, the amber to 4.43, against AA's 4.50. The
// status column, the first thing read on a row, was the least readable thing
// on the screen.
//
// A colour nobody measured looks exactly like a colour somebody chose, so this
// measures them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const css = read('public/styles.css');
const app = read('public/app.js');

// ---- the maths ------------------------------------------------------------------

const hex = h => {
  const v = String(h).replace('#', '').trim();
  const full = v.length === 3 ? v.split('').map(c => c + c).join('') : v;
  return [0, 2, 4].map(i => parseInt(full.substr(i, 2), 16));
};
const luminance = c => {
  const a = c.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
};
const ratio = (fg, bg) => {
  const a = luminance(hex(fg));
  const b = luminance(hex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};
const AA = 4.5;

console.log('contrast');

t('the maths is right before it is trusted', () => {
  // Known values: black on white is 21, white on white is 1.
  assert.strictEqual(Math.round(ratio('#000000', '#ffffff')), 21);
  assert.strictEqual(Math.round(ratio('#ffffff', '#ffffff')), 1);
  // And the colour that started this, on the card it was drawn on.
  assert.ok(ratio('#b00020', '#111118') < 3, 'the red that failed now passes?');
});

// ---- the tokens, in both themes ----------------------------------------------------

// styles.css defines the dark values at the top and redefines them in the
// light block. Reading the LAST definition before/after that boundary is how
// each theme's value is found, rather than assuming an order.
const lightAt = css.indexOf('--bg-base: #f3f3f5');
assert.ok(lightAt > 0, 'the light theme block moved — this test cannot locate it');

const valueOf = (name, inLight) => {
  const re = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,8})', 'g');
  let m, last = null;
  while ((m = re.exec(css))) {
    const isLight = m.index > lightAt;
    if (isLight === inLight) last = m[1];
  }
  return last;
};

const THEMES = [
  { name: 'dark', light: false, surface: '#111118' },
  { name: 'light', light: true, surface: '#ffffff' },
];

t('every status colour passes AA in both themes', () => {
  // These three carry the whole meaning of the Collections table.
  const bad = [];
  ['critical', 'warning', 'success'].forEach(token => {
    THEMES.forEach(th => {
      const v = valueOf(token, th.light);
      assert.ok(v, '--' + token + ' has no ' + th.name + ' value');
      const r = ratio(v, th.surface);
      if (r < AA) bad.push('--' + token + ' ' + v + ' on ' + th.name + ' '
        + th.surface + ' = ' + r.toFixed(2));
    });
  });
  assert.deepStrictEqual(bad, [], 'below AA:\n   ' + bad.join('\n   '));
});

t('secondary text passes too', () => {
  const bad = [];
  THEMES.forEach(th => {
    const v = valueOf('text-secondary', th.light);
    if (!v) return;
    const r = ratio(v, th.surface);
    if (r < AA) bad.push('--text-secondary ' + v + ' on ' + th.name + ' = ' + r.toFixed(2));
  });
  assert.deepStrictEqual(bad, []);
});

t('the light amber is the one that was measured, not the one that looked fine', () => {
  // #b26a00 reads as a perfectly good amber and measures 4.24 on white.
  const v = valueOf('warning', true);
  assert.ok(ratio(v, '#ffffff') >= AA, v + ' measures ' + ratio(v, '#ffffff').toFixed(2));
  assert.notStrictEqual(v, '#b26a00', 'the failing value is back');
});

// ---- the root cause: a token that does not exist ---------------------------------

t('no var() in app.js names a token styles.css does not define', () => {
  // THIS IS THE BUG, not the ratios. var(--ok, #1a7f37) is valid CSS, draws the
  // fallback, and looks deliberate in review — there is nothing to notice.
  const defined = new Set();
  const dre = /--([a-z0-9-]+)\s*:/g;
  let m;
  while ((m = dre.exec(css))) defined.add(m[1]);

  const used = new Map();
  const ure = /var\(\s*--([a-z0-9-]+)/g;
  // Comments explain the old names on purpose; they are not code.
  const code = app.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  while ((m = ure.exec(code))) {
    if (!defined.has(m[1])) {
      used.set(m[1], (used.get(m[1]) || 0) + 1);
    }
  }
  assert.deepStrictEqual([...used.keys()], [],
    'these tokens are used and never defined: ' + [...used].map(([k, n]) => '--' + k + ' x' + n).join(', '));
});

t('the Collections table uses tokens, not hand-picked hex', () => {
  const block = app.slice(app.indexOf('const MO_STATE_STYLE'),
    app.indexOf('async function loadMoveOutAlerts'));
  const code = block.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const hexes = code.match(/#[0-9a-fA-F]{6}\b/g) || [];
  assert.deepStrictEqual(hexes, [],
    'hard-coded colours are back: ' + hexes.join(', '));
  assert.match(code, /var\(--success\)/);
  assert.match(code, /var\(--warning\)/);
  assert.match(code, /var\(--critical\)/);
});

t('the headings carry a colour instead of inheriting one', () => {
  // Inheriting left them at whatever the card decided, which in dark mode is a
  // grey chosen for secondary text.
  const heads = app.match(/<h4 style="[^"]*">(Today|Move-out inspections[^<]*|Inspection exists[^<]*|No move-out inspection[^<]*)</g) || [];
  assert.ok(heads.length >= 4, 'only found ' + heads.length + ' headings');
  heads.forEach(h => assert.match(h, /color:var\(--/, h.slice(0, 60) + ' has no colour'));
});

t('the counts line is not left to inherit either', () => {
  const head = app.slice(app.indexOf("const head = '<p class=\"small\""), app.indexOf("const caveat"));
  assert.match(head, /color:var\(--text\)/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
