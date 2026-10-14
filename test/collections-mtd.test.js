// Month-to-date collections, and the alert that must never go quiet.
//
// THE FAILURE THIS GUARDS AGAINST is a silence that reads as good news.
// income_statement cannot be asked about September, so the comparison Kara
// wants is impossible until a month of our own captures exists. Every path
// through `alert` that cannot answer has to SAY it cannot answer: "not
// measurable" is a result, "no property is collecting less" on an empty table
// is a lie that looks like a pass.
//
// The second half is about the sync writing only what it was asked to write,
// and about the eight properties being eight on purpose — BY_ID holds sixteen
// ids, half of them entities nobody is asking about.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/collections-mtd.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('collections MTD');

// ---- reading the report ----------------------------------------------------
//
// The account name and the amount are found BY SHAPE, not by column name. We
// have been wrong about a column name three times this month.

t('rent income is read whatever the columns are called', () => {
  const rows = [
    { AccountName: 'Rent Income', Amount: '56,335.98' },
    { AccountName: 'Total Income', Amount: '61,000.00' },
  ];
  const s = C.readStatement(rows);
  assert.strictEqual(s.rentIncome, 56335.98);
  assert.strictEqual(s.totalIncome, 61000);
});

t('the same rows under different column names read the same', () => {
  const a = C.readStatement([{ account: 'Rent Income', total: '100.00' }]);
  const b = C.readStatement([{ gl_account_name: 'Rent Income', period_amount: '100.00' }]);
  assert.strictEqual(a.rentIncome, 100);
  assert.strictEqual(b.rentIncome, 100);
});

t('parentheses are a negative, not a word', () => {
  assert.strictEqual(C.num('(1,234.50)'), -1234.5);
  assert.strictEqual(C.num('$1,234.50'), 1234.5);
  assert.strictEqual(C.num(''), null);
  assert.strictEqual(C.num('Rent Income'), null);
});

t('every income line is kept, not just the one we compare on', () => {
  // "Which accounts are cash receipts" is unsettled. A sync that stored only
  // today's answer could not be re-asked tomorrow without re-syncing a month
  // that AppFolio will not hand back.
  const s = C.readStatement([
    { a: 'Rent Income', v: '100' },
    { a: 'Other Income', v: '25' },
    { a: 'Laundry Revenue', v: '10' },
    { a: 'Repairs and Maintenance', v: '999' },
  ]);
  assert.strictEqual(s.accounts['Rent Income'], 100);
  assert.strictEqual(s.accounts['Other Income'], 25);
  assert.strictEqual(s.accounts['Laundry Revenue'], 10);
  assert.ok(!('Repairs and Maintenance' in s.accounts), 'an expense line is not income');
});

// ---- the alert never passes quietly ----------------------------------------

t('nothing captured at all says so', () => {
  const a = C.alert([], '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.match(a.note, /NOT MEASURABLE/);
  assert.match(a.note, /Nothing has been captured/);
});

t('history that starts today names the month the comparison becomes possible', () => {
  const h = [{ captured_on: '2026-10-16', property: 'Ascent', rent_income: 56335.98 }];
  const a = C.alert(h, '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.strictEqual(a.startedOn, '2026-10-16');
  assert.match(a.note, /history starts 2026-10-16/);
  assert.match(a.note, /2026-11/, 'says when it can first be answered');
});

t('last month on file but nothing captured today is a BROKEN SYNC, not a pass', () => {
  // The whole point. compare() finds no `now` row for anybody, returns an
  // empty list, and "no property is collecting less than last month" would be
  // a clean bill of health computed from zero rows.
  const h = [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 60000 }];
  const a = C.alert(h, '2026-10-16');
  assert.strictEqual(a.measurable, false);
  assert.match(a.note, /NOT MEASURABLE TODAY/);
  assert.match(a.note, /sync did not run/);
  assert.ok(!/No property is collecting less/.test(a.note));
});

t('no reachable path reports an all-clear from an empty comparison', () => {
  // Belt and braces: whatever the history, if the alert claims it is
  // measurable it must have rows behind it.
  const histories = [
    [],
    [{ captured_on: '2026-10-16', property: 'Ascent', rent_income: 1 }],
    [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 1 }],
    [{ captured_on: '2026-09-16', property: 'Ascent', rent_income: 1 },
      { captured_on: '2026-10-16', property: 'Ascent', rent_income: 1 }],
  ];
  histories.forEach((h, i) => {
    const a = C.alert(h, '2026-10-16');
    if (a.measurable) {
      assert.ok(a.rows.length > 0, 'history ' + i + ' claimed measurable with no rows');
    } else {
      assert.match(a.note, /NOT MEASURABLE/, 'history ' + i + ' went quiet');
    }
  });
});

// ---- the comparison --------------------------------------------------------

t('this month to date against the same day last month', () => {
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 56335.98 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].delta, -3664.02);
  assert.strictEqual(rows[0].pct, -6.1);
  assert.strictEqual(rows[0].comparedOn, '2026-09-14');
});

t('a later capture in the same month is not used as the comparison point', () => {
  // Comparing the 14th against the 30th would make every property look like a
  // collapse. The match is the LATEST capture at or before the same day.
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-09-30', property: 'Ascent', rent_income: 95000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 59000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows[0].comparedOn, '2026-09-14');
  assert.strictEqual(rows[0].delta, -1000);
});

t('the 31st of a month after a 30-day month falls back rather than comparing nothing', () => {
  const h = [
    { captured_on: '2026-09-30', property: 'Ascent', rent_income: 95000 },
    { captured_on: '2026-10-31', property: 'Ascent', rent_income: 90000 },
  ];
  const rows = C.compare(h, '2026-10-31');
  assert.strictEqual(rows[0].comparedOn, '2026-09-30');
  assert.strictEqual(rows[0].delta, -5000);
});

t('a property with no capture last month is named, not dropped', () => {
  const h = [
    { captured_on: '2026-09-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Ascent', rent_income: 60000 },
    { captured_on: '2026-10-14', property: 'Hyde Park Square', rent_income: 12000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  const hps = rows.find(r => r.property === 'Hyde Park Square');
  assert.ok(hps, 'the new property is in the list');
  assert.strictEqual(hps.delta, null);
  assert.match(hps.why, /no capture from 2026-09/);
});

t('the portfolio is a row like any other, under *', () => {
  const h = [
    { captured_on: '2026-09-14', property: '*', rent_income: 311166.4 },
    { captured_on: '2026-10-14', property: '*', rent_income: 300000 },
  ];
  const rows = C.compare(h, '2026-10-14');
  assert.strictEqual(rows[0].property, C.PORTFOLIO);
  assert.strictEqual(rows[0].delta, -11166.4);
});

t('prevMonth crosses the year', () => {
  assert.strictEqual(C.prevMonth('2026-01'), '2025-12');
  assert.strictEqual(C.prevMonth('2026-10'), '2026-09');
  assert.strictEqual(C.nextMonth('2026-12-16'), '2027-01');
});

// ---- what period is this ---------------------------------------------------

t('the period check is a ratio with reasoning, never a verdict', () => {
  const full = C.periodCheck(56000, 60000, '2026-10-14');
  assert.ok(full.ratio > 0.8);
  assert.match(full.note, /consistent with the current month/);
  const tiny = C.periodCheck(600, 60000, '2026-10-14');
  assert.match(tiny.note, /probably NOT the current month/);
  // Nothing in it asserts an answer.
  assert.ok(!('period' in full) && !('isCurrentMonth' in full));
});

t('no monthly rent means no check, rather than a check against zero', () => {
  assert.strictEqual(C.periodCheck(56000, 0, '2026-10-14'), null);
  assert.strictEqual(C.periodCheck(null, 60000, '2026-10-14'), null);
});

// ---- the sync ---------------------------------------------------------------

const syncSrc = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'sync-collections-mtd.js'), 'utf8');

// My own prose has tripped my own tests five times. Comments and string
// literals are stripped before anything is searched for.
//
// SCANNED, NOT PATTERN-MATCHED. The first version of this used one regex per
// quote character. A comment containing an apostrophe — "each property's
// monthly rent" — put every quote after it out of phase, which silently ate
// the write statement and made "the sync writes to collections_mtd" fail by
// finding nothing at all. A regex cannot know whether a quote opens or closes.
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      out += c + c;                       // an empty literal keeps the syntax
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const code = strip(syncSrc);

t('the sync writes to collections_mtd and to nothing else', () => {
  // db.from, not Buffer.from — the Basic auth header is also a .from() call.
  const tables = [...code.matchAll(/db\.from\(([^)]*)\)/g)].map(m => m[1].trim());
  // Every table name was a string literal and is now ''. What matters is that
  // there is exactly one write target, and the raw source names only the one.
  assert.strictEqual(tables.length, 1, 'one .from() call: ' + JSON.stringify(tables));
  const named = [...syncSrc.matchAll(/db\.from\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepStrictEqual(named, ['collections_mtd']);
});

t('the only write verb is the daily upsert', () => {
  assert.ok(/\.upsert\(/.test(code), 'it upserts');
  assert.ok(!/\.insert\(/.test(code), 'no insert');
  assert.ok(!/\.delete\(/.test(code), 'no delete');
  assert.ok(!/\.update\(/.test(code), 'no update');
});

t('--dry-run reaches the upsert check before the upsert', () => {
  assert.ok(code.indexOf('if (DRY)') < code.indexOf('.upsert('),
    'the dry-run return is above the write');
});

t('the calls are spaced', () => {
  // Nine calls in a burst is how the Asana inventory died.
  assert.ok(/sleep\(900\)/.test(code), 'there is a wait between properties');
  assert.ok(/429/.test(syncSrc), 'rate limiting is handled');
});

t('the property filter is the one shape that actually filters', () => {
  // properties_ids inside a `properties` object. property_ids, property_id and
  // a bare array were all accepted and IGNORED — same portfolio number every
  // time, which is indistinguishable from a working filter if you count rows.
  assert.ok(/properties_ids/.test(syncSrc));
  assert.ok(!/body\.property_ids/.test(code));
});

t('the properties it skips are printed, not dropped quietly', () => {
  assert.ok(/skipped/.test(code), 'the skipped list exists');
  assert.ok(/not captured/.test(syncSrc), 'and it is printed');
});

t('the sync is importable, so the cron runs the tested code', () => {
  const m = require('../scripts/sync-collections-mtd.js');
  assert.strictEqual(typeof m.syncCollectionsMtd, 'function');
});

t('requiring the sync does not run it', () => {
  // It used to be a bare IIFE. Required from server.js that would fire nine
  // AppFolio calls at boot.
  assert.ok(/require\.main === module/.test(code),
    'the CLI entry point is guarded');
});

// ---- the cron ---------------------------------------------------------------

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The schedule is read by walking BACK from the require to the cron.schedule
// above it. Matching forward from cron.schedule across a block that contains a
// semicolon is how the first version of this test found nothing and said so.
function cronSlot() {
  const at = server.indexOf('sync-collections-mtd.js');
  if (at < 0) return null;
  const before = server.slice(0, at);
  const starts = [...before.matchAll(/cron\.schedule\('(\d+) (\d+) \* \* \*'/g)];
  const last = starts[starts.length - 1];
  return last ? { minute: Number(last[1]), hour: Number(last[2]) } : null;
}

t('the capture runs before the 06:00 brief that reads it', () => {
  const slot = cronSlot();
  assert.ok(slot, 'the collections sync has its own cron slot');
  const hour = slot.hour;
  assert.ok(hour < 6, 'it is scheduled before 06:00, not after (hour ' + hour + ')');
});

t('it does not land inside the 05:00 block', () => {
  // That hour is full to :55 and the comment at delinquency_kpi says anything
  // else has to displace something rather than squeeze between.
  assert.notStrictEqual(cronSlot().hour, 5, 'not in the 05:00 hour');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
