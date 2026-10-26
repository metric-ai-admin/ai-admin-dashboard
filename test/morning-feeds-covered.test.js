// Everything the 06:00 brief checks must actually be synced before 06:00.
//
// WHAT HAPPENED. unit_turn_detail joined MORNING_FEEDS on 2026-10-13, so the
// brief began asking every morning whether it had been written TODAY. Nothing
// synced it in the morning — the only job that touched it ran at 17:45 for the
// KPI report — so the answer was always no. Twelve consecutive emails, 10/15
// through 10/26, every one saying "1 morning sync did not run".
//
// Nothing had failed. The data was twelve hours old and the brief's own note
// said so, under a headline that read like an outage.
//
// TWO LISTS IN TWO FILES, and nothing connected them: a feed could be added to
// the checklist without being scheduled, or dropped from the schedule while
// the checklist kept asking. Either way the brief cries wolf every morning,
// which is worse than silence — the comment above EARLY_FEEDS makes exactly
// that argument about a different version of this check.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const G = require('../lib/kara-brief-gather.js');

// The schedule, read from the source rather than from a list kept by hand
// here — a copy in this file would drift exactly the way the two real lists
// drifted.
// An entry may carry a trailing hour, defaulting to 5: unit_turn_detail runs
// at 04:45 because the 05:00 hour had no slot left that kept both the
// five-minute spacing and clear of the two unlimited AppFolio pulls. Parsed
// line by line — a multiline regex over the block dropped an entry once the
// trailing-hour form appeared.
function earlyFeeds() {
  const at = server.indexOf('const EARLY_FEEDS = [');
  assert.ok(at > 0, 'EARLY_FEEDS moved or was renamed');
  const block = server.slice(at, server.indexOf('\n];', at));
  return block.split('\n').map(line => {
    const head = line.match(/^\s*\[(\d+),\s*'([^']+)'/);
    if (!head) return null;
    const tail = line.match(/,\s*(\d+)\s*\],?\s*$/);
    const hour = tail ? Number(tail[1]) : 5;
    return { minute: Number(head[1]), label: head[2], hour, at: hour * 60 + Number(head[1]) };
  }).filter(Boolean);
}

console.log('morning feeds are covered');

t('both lists are non-empty (the scrape still works)', () => {
  // Without this, an empty scrape makes every assertion below vacuously true.
  assert.ok(earlyFeeds().length >= 8, 'only parsed ' + earlyFeeds().length + ' early feeds');
  assert.ok(G.MORNING_FEEDS.length >= 4, 'MORNING_FEEDS looks empty');
});

t('MORNING_FEEDS is a subset of EARLY_FEEDS', () => {
  // THE RULE. Anything the 06:00 brief reports on must be synced before 06:00.
  const synced = new Set(earlyFeeds().map(f => f.label));
  const missing = G.MORNING_FEEDS.filter(id => !synced.has(id));
  assert.deepStrictEqual(missing, [],
    'the 06:00 brief checks these and nothing syncs them in the morning, so it '
    + 'will report them as failed EVERY day:\n   ' + missing.join('\n   '));
});

t('unit_turn_detail specifically, by name', () => {
  // The one that caused it. Named so a future reshuffle that drops it fails
  // with the history attached rather than as an anonymous subset violation.
  const f = earlyFeeds().find(x => x.label === 'unit_turn_detail');
  assert.ok(f, 'unit_turn_detail is out of the morning block again — '
    + 'the brief flagged it for twelve consecutive mornings last time');
  assert.ok(f.at < 6 * 60, 'it has to be synced before the 06:00 brief reads it');
});

t('the morning sync lands before the brief reads it', () => {
  // The brief is 06:00. A feed at 05:59 would be racing the thing that reads
  // it, and that race shows up as a stale number rather than as an error.
  const at = server.indexOf('EARLY_FEEDS.forEach(');
  const body = server.slice(at, at + 600);
  assert.match(body, /cron\.schedule\(`\$\{minute\} \$\{hour\} \* \* \*`/,
    'the schedule template no longer honours a per-entry hour');
  earlyFeeds().forEach(f => {
    assert.ok(f.at <= 5 * 60 + 55,
      f.label + ' runs at ' + f.hour + ':' + f.minute + ', too close to the 06:00 brief');
  });
});

t('no two feeds share a minute', () => {
  // Five minutes apart is the convention here precisely so each job has the
  // AppFolio limiter to itself.
  const byMinute = {};
  earlyFeeds().forEach(f => { (byMinute[f.at] = byMinute[f.at] || []).push(f.label); });
  const clashes = Object.entries(byMinute).filter(([, v]) => v.length > 1)
    .map(([k, v]) => Math.floor(k / 60) + ':' + (k % 60) + ' — ' + v.join(' + '));
  assert.deepStrictEqual(clashes, [], 'two feeds fire together:\n   ' + clashes.join('\n   '));
});

t('nothing in the morning block collides with an UNLIMITED AppFolio pull', () => {
  // THE TRAP THAT MADE THE OBVIOUS SLOT WRONG. There are two AppFolio paths in
  // this codebase and only one is rate limited:
  //
  //   appfolio-reports.js -> appfolio-client.js    queues at 7 req / 15s
  //   appfolioReportsFetch() in server.js          raw fetch, no limiter, paginates
  //
  // 05:00 (occupancy) and 05:30 (guest cards) are on the unlimited, paginating
  // path. A limited pull sharing their minute still gets 429s, because the
  // queue it waits in is not the one spending the tenant's budget — and a 429
  // here leaves yesterday's rows in the store and the brief saying "did not
  // run" for real.
  const UNLIMITED = [5 * 60 + 0, 5 * 60 + 30];
  const clash = earlyFeeds().filter(f => UNLIMITED.some(u => Math.abs(f.at - u) < 5));
  assert.deepStrictEqual(clash.map(f => f.label), [],
    'these run within five minutes of an unlimited paginating AppFolio pull: '
    + clash.map(f => f.label + ' @' + f.hour + ':' + f.minute).join(', '));
});

t('the evening KPI sync is still there', () => {
  // The morning entry is an addition, not a move: the KPI comparison reads
  // this store too. Deleting the 17:45 run would leave the weekly report on
  // figures up to a day older than it thinks.
  const at = server.indexOf("cron.schedule('45 17 * * *'");
  assert.ok(at > 0, 'the 17:45 block is gone');
  const body = server.slice(at, at + 2500);
  assert.match(body, /syncReport\('unit_turn_detail'\)/,
    'the evening unit_turn_detail sync was removed when the morning one was added');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
