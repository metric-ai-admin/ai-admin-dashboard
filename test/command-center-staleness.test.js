// The Command Center showing data older than it looks, and the "not in feed"
// line nobody could see.
//
// BOTH BUGS CAME FROM THE SAME MORNING. On 2026-10-05 Erick opened the board,
// it restored his session, showed a green "Restored from today's session"
// notice and a grey "Data from last sync: 10/2" line, and he generated 243
// tasks from three-day-old work orders. Arturo then reported a work order as
// "Unknown" that the table had correctly closed — he was reading the same
// stale board.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const cc = read(path.join('public', 'command-center.js'));
const html = read(path.join('public', 'index.html'));
const css = read(path.join('public', 'styles.css'));
// Assertions match code, never the prose around it — a comment that quotes the
// string being tested would make these pass with the feature removed.
const code = cc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('the age of the data is impossible to miss');
t('there is a staleness banner, and it is above the restore notice', () => {
  const stale = html.indexOf('id="cc-stale"');
  const restored = html.indexOf('id="cc-restored"');
  assert.ok(stale > 0, 'no staleness banner in the markup');
  assert.ok(stale < restored, 'the reassuring banner is read first');
});
t('it has its own loud style, not the existing warn style', () => {
  assert.ok(/\.banner-stale\s*\{/.test(css), 'banner-stale is not defined');
  const rule = css.slice(css.indexOf('.banner-stale'), css.indexOf('.banner-stale') + 160);
  assert.ok(/--red/.test(rule), 'the stale banner is not red');
});
t('the age is stated in days, not as a timestamp to work out', () => {
  assert.ok(/function ccShowStaleness/.test(code));
  assert.ok(/86400000/.test(code), 'nothing converts the gap into days');
  assert.ok(/day\$\{days === 1 \? '' : 's'\} old/.test(code), 'the banner does not say how old');
});
t('fresh data shows nothing', () => {
  // A banner that appears every single morning is a banner nobody reads.
  assert.ok(/if \(days < 1\) \{ banner\.classList\.add\('hidden'\); return days; \}/.test(code));
});
t('no sync at all is louder than a stale sync, not quieter', () => {
  // Returning early on a missing last_synced is how an empty board looked
  // identical to a current one.
  assert.ok(/ccShowStaleness\(null\); return false/.test(code),
    'a missing or failed cache load leaves no notice at all');
  const n = (code.match(/ccShowStaleness\(null\)/g) || []).length;
  assert.ok(n >= 2, 'only one of the two failure paths warns');
});
t('a sync that pulled nothing does not clear the warning', () => {
  assert.ok(/if \(total\) ccShowStaleness\(/.test(code),
    'an empty sync is treated as a refresh');
});
t('the green restore notice yields to the red one', () => {
  assert.ok(/if \(!\$\('#cc-stale'\)\?\.classList\.contains\('hidden'\)\) banner\.classList\.add\('hidden'\)/.test(code),
    'both banners can show at once, which reads as permission to ignore the red one');
});
t('the server copy replaces the restored board rather than merging', () => {
  const i = code.indexOf('async function ccLoadCached');
  const body = code.slice(i, code.indexOf('function ccInit'));
  assert.ok(/ccGenerate\(\)/.test(body), 'the stale task board is never rebuilt');
});

console.log('\nthe "not in feed" line Arturo could not find');
// Sliced to a NAMED END MARKER, not a byte count. A fixed window stops
// covering what it was written for the moment a line is added above it, and
// then passes for the wrong reason.
const SUMMARY = (() => {
  const i = code.indexOf('function ccRefreshCounts');
  const j = code.indexOf('CC_CATS.forEach', i);
  assert.ok(i > 0 && j > i, 'ccRefreshCounts or its end marker moved');
  return code.slice(i, j);
})();

t('it reads the column through the map, not by guessing field names', () => {
  // ccIngest stores rows keyed by the SOURCE HEADER ('Status', 'Work Order
  // Number'). r.status and r.wo are undefined on these rows, so the filter
  // matched nothing and the banner never rendered.
  assert.ok(/ccVal\(r, woRep\.map, 'status'\)/.test(SUMMARY), 'the status is read off the raw row');
  assert.ok(/ccVal\(r, woRep\.map, 'woNum'\)/.test(SUMMARY), 'the work order number is read off the raw row');
  assert.ok(!/r\.wo \|\| r\.workorder/.test(SUMMARY), 'the guessed field names are still there');
});
t('it is in the Command Center summary, where Erick works', () => {
  assert.ok(/ccNotInFeed/.test(SUMMARY), 'the banner is gone');
  const at = SUMMARY.indexOf('if (sum && ccNotInFeed.length)');
  assert.ok(at > 0, 'the banner is never rendered');
  assert.ok(SUMMARY.slice(at).includes('sum.appendChild(banner)'), 'it is built but never attached');
});
t('the work order numbers are shown, not just a count', () => {
  const body = SUMMARY.slice(SUMMARY.indexOf('if (sum && ccNotInFeed.length)'));
  assert.ok(/slice\(0, 12\)/.test(body), 'every number would be dumped, or none');
  assert.ok(/ccNotInFeed\.length > nums\.length \? ', …' : ''/.test(body),
    'a truncated list does not say it was truncated');
});

console.log('\nthe sweep that could resolve the Unknowns');
const server = read('server.js');
const REC = server.slice(server.indexOf('async function reconcileWorkOrders('),
  server.indexOf('// ── Supporting maintenance reports'));
t('it is off unless asked for', () => {
  assert.ok(/sweep = false/.test(REC), 'the sweep runs by default');
  assert.ok(/req\.body\.sweep === true/.test(server), 'the route cannot turn it on');
});
t('an Unknown row is only reconsidered under a sweep', () => {
  assert.ok(/if \(WOS\.isUnknown\(r\.status\) && !sweep\) return;/.test(REC),
    'either Unknowns are never revisited, or they are churned on every ordinary run');
});
t('a sweep never writes Unknown over Unknown', () => {
  // Re-marking a row that is still in neither feed would stamp a new run_at on
  // it every pass and bury the run that first set it.
  assert.ok(/if \(WOS\.isUnknown\(r\.status\)\) return;\s*\/\/ still unresolved/.test(REC));
});
t('a reopened row gets the status AppFolio gave, not a guess', () => {
  assert.ok(/openStatus/.test(REC), 'the sweep throws the status away');
  assert.ok(!/status_after: 'Assigned'/.test(REC), 'a status is invented for reopened rows');
  assert.ok(/if \(!found\) return;/.test(REC), 'a row is reopened with an empty status');
});
t('the stored pulls win over the sweep where they disagree', () => {
  assert.ok(/if \(!k \|\| openNow\.has\(k\) \|\| closedBy\.has\(k\)\) return;/.test(REC),
    'a one-off request can overwrite what the rest of the dashboard runs on');
});
t('a failed sweep does not fail the reconciliation', () => {
  assert.ok(/catch \(e\) \{ sweepStatus = 'failed: ' \+ e\.message; \}/.test(REC));
});
t('the result says what the sweep did', () => {
  assert.ok(/sweep: sweepStatus/.test(REC), 'a run cannot be told apart from one without a sweep');
  assert.ok(/TRUNCATED/.test(REC), 'a partial sweep looks like a complete one');
});
t('the probe is read-only and names what would change', () => {
  const p = read(path.join('scripts', 'probe-unknown-work-orders.js'));
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(p), 'the probe writes');
  assert.ok(/DRY RUN/.test(p));
  assert.ok(/would become CLOSED/.test(p) && /stay Unknown/.test(p),
    'the probe does not say what stays unresolved');
});

console.log(`\n${pass} passing`);
