// The expanded call history on a delinquency card.
//
// The pure merge-and-limit logic is tested in call-match.test.js. These are
// the things that live in the wiring and the markup, where a mistake is a
// resident-facing one: what the server attaches to a card, what the card
// prints, and what must never reach either.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CM = require('../lib/call-match.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Comments explain what must NOT be on the card, so they name the very things
// the assertions forbid. Stripping them means these tests read the code.
const code = s => s.replace(/^\s*\/\/.*$/gm, '');
const server = read('server.js');
const app = read('public/app.js');
const css = read('public/styles.css');

console.log('dq call history');

// ---- what the server fetches ----------------------------------------------

t('the calls select asks for recording_id', () => {
  // Without it every call is unlinkable and no call can ever carry an agent,
  // because the grade join is keyed on the recording.
  assert.ok(/call_date,call_direction,duration,counterparty_number,recording_id/.test(server),
    'recording_id is not in the decision-queue calls select');
});

t('the agent comes from call_grades, never from the archive line owner', () => {
  assert.ok(/from\('call_grades'\)[\s\S]{0,120}select\('recording_id,agent_name'\)/.test(server),
    'the grade join is gone');
  // THE ONE THAT MATTERS. user_name is the line owner. If it ever becomes the
  // fallback, every ungraded call gets a name on it and the name is wrong.
  const block = server.slice(server.indexOf('const agentByRecording'),
    server.indexOf('const agentByRecording') + 1200);
  assert.ok(!/user_name/.test(block), 'the line owner is being used as an agent');
});

t('both the summary and the history read the same number list', () => {
  // Two different lists would let the collapsed line be about one phone and
  // the list it opens be about another.
  assert.ok(/calls: a\.externallyManaged \? null : CM\.summarise\(CM\.numbersFor\(a, directoryIndex\)/.test(server));
  assert.ok(/callHistory: a\.externallyManaged \? null : CM\.history\(CM\.numbersFor\(a, directoryIndex\)/.test(server));
});

t('an externally managed account gets no history, same as no summary', () => {
  // Cedar & Sage is not on the Metric phone system: an empty list there would
  // read as "nobody called" rather than "we cannot see".
  assert.ok(/callHistory: a\.externallyManaged \? null :/.test(server));
});

t('the capture date is sent to the client, not written out twice', () => {
  assert.ok(/callCaptureStart: CM\.CAPTURE_START/.test(server), 'the server does not send it');
  assert.ok(/dqData && dqData\.callCaptureStart/.test(app), 'the client does not read it');
});

// ---- what the card prints --------------------------------------------------

t('the list carries BOTH caveats', () => {
  const fn = app.slice(app.indexOf('function dqCallHistory'),
    app.indexOf('function dqCallHistory') + 2200);
  assert.ok(/Calls recorded since/.test(fn), 'the capture floor is missing');
  assert.ok(/shared with/.test(fn), 'the shared-number warning is missing');
  // The collapsed line's copy is hidden once the list is open, so the list
  // needs its own.
  assert.ok(/shared[\s\S]{0,400}dq-call-list|dq-call-list[\s\S]{0,600}shared/.test(fn));
});

t('there is no outcome column, and no score on the card', () => {
  const fn = code(app.slice(app.indexOf('function dqCallHistory'),
    app.indexOf('function dqCallHistory') + 2200));
  assert.ok(!/outcome/i.test(fn), 'an outcome column appeared');
  // `summary` on its own is the <details> element's own tag, which is how the
  // list collapses — the forbidden thing is the GRADE's summary field.
  assert.ok(!/overall_score|overall_grade|\.summary|transcript/i.test(fn),
    'a grade value or transcript reached the card');
});

t('the grade is a LINK and the Collections screen fetches nothing for it', () => {
  const handler = app.slice(app.indexOf("querySelectorAll('.dq-call-grade[data-rid]')"),
    app.indexOf("querySelectorAll('.dq-call-grade[data-rid]')") + 600);
  assert.ok(/svgSelect\(btn\.dataset\.rid\)/.test(handler), 'the chip does not open the grade');
  assert.ok(!/api\(/.test(handler), 'the chip fetches grade data into Collections');
});

t('an ungraded call prints an empty agent cell, never a placeholder', () => {
  const fn = app.slice(app.indexOf('function dqCallHistory'),
    app.indexOf('function dqCallHistory') + 2200);
  assert.ok(/x\.agent \? dqEsc\(x\.agent\) : ''/.test(fn),
    'the agent cell has a fallback value');
  // "Unidentified" is what the grades table shows and it is right there; it
  // would be wrong here, because the question was never asked of this call.
  assert.ok(!/Unidentified|Unknown agent/i.test(fn));
});

t('every value printed in the list is escaped', () => {
  const fn = app.slice(app.indexOf('function dqCallHistory'),
    app.indexOf('function dqCallHistory') + 2200);
  ['x.direction', 'x.duration', 'x.agent', 'x.recordingId']
    .forEach(v => assert.ok(new RegExp('dqEsc\\(' + v.replace('.', '\\.') + '\\)').test(fn),
      v + ' is printed unescaped'));
});

// ---- the styles ------------------------------------------------------------

t('the history styles use tokens that exist', () => {
  // A var() that names an undefined token renders fine and silently falls
  // back, so the NAMES are what has to be checked.
  ['--accent', '--text-secondary', '--border'].forEach(v =>
    assert.ok(new RegExp('\\' + v + ':').test(css), v + ' is never defined'));
  assert.ok(/\.dq-call-list/.test(css) && /\.dq-call-grade/.test(css));
});

// ---- the shared constant ---------------------------------------------------

t('the client fallback date matches the library', () => {
  const m = app.match(/dqData\.callCaptureStart\) \|\| '(\d{4}-\d{2}-\d{2})'/);
  assert.ok(m, 'no fallback found');
  assert.strictEqual(m[1], CM.CAPTURE_START);
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
