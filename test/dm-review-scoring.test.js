// Round-trip the new DM Review shape through the real scoring paths.
const assert = require('assert');
const engine = require('../crm-task-engine.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

// The overall_score calculation, copied from server.js:7264.
const overall = sections => {
  const all = sections.filter(Boolean).flatMap(s => Object.values(s)).filter(v => typeof v === 'number' && !isNaN(v));
  return all.length ? parseFloat((all.reduce((a, b) => a + b, 0) / all.length).toFixed(2)) : null;
};
// crmUpdateDMOverall, copied from public/app.js.
const pctOf = scores => {
  const all = Object.values(scores).flatMap(s => Object.values(s || {})).filter(v => typeof v === 'number');
  return all.length ? Math.round((all.reduce((a, b) => a + b, 0) / (all.length * 5)) * 100) : null;
};

console.log('\nNotes and N/A are ignored by scoring');
t('a note does not change overall_score', () => {
  const without = { seo: 4, nav: 5 };
  const withNote = { seo: 4, nav: 5, seo__note: 'no meta descriptions' };
  assert.strictEqual(overall([withNote]), overall([without]));
  assert.strictEqual(overall([withNote]), 4.5);
});
t('the client percentage agrees, ignoring notes', () => {
  assert.strictEqual(pctOf({ website: { seo: 4, seo__note: 'x' } }), 80);
});
t('rating-scale N/A is a numeric 0 and DOES count — long-standing behaviour', () => {
  // GRADE_LABELS[0] is 'N/A' and stores the number 0, so it lowers the average.
  // Untouched here; recorded so a future change is a deliberate one.
  assert.strictEqual(overall([{ seo: 4, nav: 0 }]), 2);
});
t('binary Yes/No questions have no N/A option', () => {
  // Added 2026-09-22 and reverted the same day at Katie's request. Guards
  // against it being reintroduced by accident.
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const ynBlock = app.slice(app.indexOf("$$('.crm-yn-picker')"), app.indexOf("$$('.crm-yn-picker')") + 1200);
  assert.ok(!/data-val="na"/.test(ynBlock), 'the yes/no picker must not render an N/A button');
  assert.ok(/data-val="5"/.test(ynBlock) && /data-val="0"/.test(ynBlock), 'Yes and No must both remain');
});
t('a section of only notes scores null, not zero', () => {
  assert.strictEqual(overall([{ seo__note: 'a', nav__note: 'b' }]), null);
});

console.log('\ndmComplete counts scored criteria only');
const mk = sections => ({ dm_review: Object.fromEntries(
  ['website_scores', 'floorplan_scores', 'gbp_scores', 'facebook_scores', 'ils_scores']
    .map((k, i) => [k, sections[i]])) });
t('all five sections scored -> complete', () => {
  assert.strictEqual(engine.dmComplete(mk([{ a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }])), true);
});
t('a note-only section is NOT complete', () => {
  // The regression this guards: a bare key count treated this as done and the
  // DM task dropped off the queue before anything was scored.
  assert.strictEqual(engine.dmComplete(mk([{ a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }, { a__note: 'typed a note' }])), false);
});
t('a section holding only non-numeric values is NOT complete', () => {
  // Notes are the only non-numeric value the UI writes today. The rule is
  // deliberately about numbers rather than about notes specifically, so any
  // future marker is handled the same way.
  assert.strictEqual(engine.dmComplete(mk([{ a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }, { a: 'something' }])), false);
});
t('a scored criterion alongside its note -> complete', () => {
  assert.strictEqual(engine.dmComplete(mk([{ a: 4, a__note: 'x' }, { a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }])), true);
});
t('an empty section is NOT complete', () => {
  assert.strictEqual(engine.dmComplete(mk([{ a: 4 }, { a: 4 }, { a: 4 }, { a: 4 }, {}])), false);
});

console.log('\nRound trip through JSON (what Supabase stores)');
t('shape survives serialisation', () => {
  const before = { seo: 4, seo__note: 'no meta descriptions', instagram: 'na' };
  const after = JSON.parse(JSON.stringify(before));
  assert.deepStrictEqual(after, before);
  assert.strictEqual(typeof after.instagram, 'string');
  assert.strictEqual(typeof after.seo, 'number');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
