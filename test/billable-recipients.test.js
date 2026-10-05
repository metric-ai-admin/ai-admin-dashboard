// Who the Billable Labor Report actually reaches.
//
// Kara Garst and Rebekah Tuckner were added to CC on 2026-10-05 at Jay's
// request. Nobody was removed. These assertions exist because the failure mode
// is silent in both directions: a CC that never reaches the Graph payload
// looks exactly like a successful send, and a CC quietly promoted to To
// changes who "reply all" reaches without anyone noticing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// Match code, never the comments around it — a comment naming an address would
// otherwise satisfy an assertion about the address being configured.
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// Resolve the two lists exactly as the server does, from the same literals,
// with no env override — this is the shipped default.
const listFrom = name => {
  const m = code.match(new RegExp(name + String.raw`\s*=\s*\(process\.env\.\w+\s*\n?\s*\|\|\s*'([^']+)'\)`));
  assert.ok(m, name + ' is not a single env-overridable constant');
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
};
const TO = listFrom('BILLABLE_RECIPIENTS');
const CC = listFrom('BILLABLE_CC');

console.log('the recipient list');
t('To is unchanged — Lyndsay and Jay', () => {
  assert.deepStrictEqual(TO, [
    'lyndsay@metricpropertymanagement.com',
    'admin@metricpropertymanagement.com',
  ]);
});
t('Cc is Kara and Rebekah', () => {
  assert.deepStrictEqual(CC, [
    'kgarst@metricpropertymanagement.com',
    'rtuckner@metricpropertymanagement.com',
  ]);
});
t('nobody was dropped and nobody was moved between To and Cc', () => {
  const overlap = TO.filter(a => CC.includes(a));
  assert.deepStrictEqual(overlap, [], 'someone is in both lists and will get two copies');
  assert.ok(!TO.includes('kgarst@metricpropertymanagement.com'),
    'Kara was put in To — that changes who reply-all reaches');
  assert.ok(!TO.includes('rtuckner@metricpropertymanagement.com'),
    'Rebekah was put in To — that changes who reply-all reaches');
});
t('the final list is these four, no more', () => {
  const all = [...TO, ...CC];
  assert.strictEqual(all.length, 4);
  assert.strictEqual(new Set(all).size, 4, 'an address is duplicated');
  all.forEach(a => assert.ok(/^[^@\s]+@metricpropertymanagement\.com$/.test(a),
    'not a well-formed Metric address: ' + a));
});

console.log('\nit is configuration, in one place');
t('both lists are env-overridable', () => {
  assert.ok(/process\.env\.BILLABLE_RECIPIENTS/.test(code));
  assert.ok(/process\.env\.BILLABLE_CC/.test(code));
});
t('each address appears exactly once in the billable configuration', () => {
  // Repeating them is how one copy gets updated and the other does not.
  //
  // Scoped to the billable block on purpose: kgarst@ is also in EOD_CC and
  // rtuckner@ in the Morning Report's internal-sender test. Those are separate
  // features that happen to involve the same people, and a repo-wide count
  // would fail on them without anything being wrong.
  const i = code.indexOf('const BILLABLE_RECIPIENTS');
  const j = code.indexOf('async function billableManifest');
  assert.ok(i > 0 && j > i, 'the billable configuration block moved');
  const block = code.slice(i, j);
  [...TO, ...CC].forEach(a => {
    const n = block.split(a).length - 1;
    assert.strictEqual(n, 1, `${a} appears ${n} times in the billable config`);
  });
  // And nowhere else in the billable feature.
  const feature = code.slice(i, code.indexOf("const sopLib = require('./sop-library.js')"));
  [...TO, ...CC].forEach(a => {
    const n = feature.split(a).length - 1;
    assert.strictEqual(n, 1, `${a} is hard-coded again further down the billable feature`);
  });
});
t('both are documented in .env.example', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(/^BILLABLE_RECIPIENTS=/m.test(env));
  assert.ok(/^BILLABLE_CC=/m.test(env));
  assert.ok(/REPLACES the default list/.test(env),
    'nothing warns that setting the var overrides rather than appends');
});

console.log('\nthe Cc actually leaves the building');
t('it reaches the Graph payload as ccRecipients', () => {
  const i = code.indexOf("app.post('/api/billable/email'");
  const body = code.slice(i, code.indexOf("const sopLib = require('./sop-library.js')", i));
  assert.ok(/ccRecipients: mail\.cc\.map\(a => \(\{ emailAddress: \{ address: a \} \}\)\)/.test(body),
    'the CC is configured but never sent — the send would look successful');
  assert.ok(/toRecipients: mail\.recipients\.map/.test(body), 'the To list stopped being sent');
});
t('preview and send share one definition', () => {
  // A preview built separately drifts, and a drifted preview is a promise
  // about what will be sent.
  const i = code.indexOf('function billableEmail(report)');
  const body = code.slice(i, i + 300);
  assert.ok(/recipients: BILLABLE_RECIPIENTS/.test(body) && /cc: BILLABLE_CC/.test(body));
  assert.ok(/res\.json\(billableEmail\(report\)\)/.test(code), 'the preview no longer uses it');
});
t('the status route reports the Cc too', () => {
  assert.ok(/recipients: BILLABLE_RECIPIENTS,\s*\n\s*cc: BILLABLE_CC,/.test(code));
});

console.log('\nErick is told before he presses send');
t('the preview has a Cc row', () => {
  assert.ok(/id="bl-preview-cc"/.test(html), 'the modal cannot show a Cc');
  assert.ok(/id="bl-preview-cc-row"/.test(html));
  assert.ok(/bl-preview-cc-row'\)\.classList\.toggle\('hidden', !cc\.length\)/.test(app),
    'the Cc row is either always shown or never shown');
});
t('the confirm names the Cc', () => {
  assert.ok(/confirm\('Send this report to ' \+ to \+ \(cc \? '\\nCc: ' \+ cc : ''\)/.test(app),
    'the prompt names two people while four receive it');
});
t('the sent confirmation names the Cc', () => {
  assert.ok(/' · cc ' \+ r\.cc\.join/.test(app),
    'Erick is told it went to Lyndsay and Jay and would reasonably assume nobody else');
});

console.log('\nnothing in this change sends an email');
t('no test mail, no new send path', () => {
  const sends = (code.match(/\/sendMail/g) || []).length;
  assert.ok(sends > 0, 'the send path vanished');
  // The billable report has exactly one send route, and it is the one Erick
  // presses. Nothing here added a second.
  assert.strictEqual((code.match(/app\.post\('\/api\/billable\/email'/g) || []).length, 1);
  assert.ok(!/billable.*cron\.schedule|cron\.schedule.*billable/i.test(code),
    'a cron now sends the billable report — it is a manual send');
});

console.log(`\n${pass} passing`);
