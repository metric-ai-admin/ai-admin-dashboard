// A new table needs its GRANT in the same migration.
//
// Supabase: from 2026-10-30, a table created in `public` with no explicit
// grant is unreachable through the Data API — supabase-js answers "permission
// denied". Existing tables keep what they were given automatically.
//
// THE FAILURE IS DELAYED AND LOOKS LIKE SOMETHING ELSE. The table is created,
// the migration succeeds, and the route that reads it fails days later with a
// message about permissions that nobody connects to a file written last week.
// Before the cutoff it is worse: everything works, and the missing grant is
// invisible until somebody rebuilds the schema from these files and finds
// eight tables that cannot be read.
//
// So this fails at the file, the day it is written.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

// Comments are not grants. A file that merely TALKS about permissions in a
// header would otherwise pass, which is the exact shape of a test that proves
// nothing.
const codeOf = sql => sql
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

const tablesIn = sql => [...codeOf(sql)
  .matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)]
  .map(m => m[1].toLowerCase());

const grantsIn = sql => [...codeOf(sql)
  .matchAll(/grant\s+[^;]*?\son\s+(?:table\s+)?([a-z_][a-z0-9_]*)[^;]*?to\s+([a-z_]+)/gi)]
  .map(m => ({ table: m[1].toLowerCase(), role: m[2].toLowerCase() }));

// WRITTEN BEFORE THE RULE EXISTED.
//
// NOT a list of files — a cutoff. The first pass enumerated 102 to 111
// because those were the ones asked about, and the test then reported 78
// tables across the whole history: NO migration in this repo has ever written
// a grant. An enumerated exemption would have implied the other seventy were
// fine, which is the opposite of true.
//
// 112 backfills the eight most recent (102-111) because those are the tables
// whose absence would bite first. The rest are listed in that file's header as
// a known gap: they work today on an automatic permission, and a schema
// rebuilt from these files would come up unreadable. Backfilling all of them
// is a bigger change than a rule, and it is Arturo's call.
const RULE_FROM = 112;
const numberOf = f => { const m = /^(\d+)/.exec(f); return m ? Number(m[1]) : Infinity; };
const underRule = f => numberOf(f) >= RULE_FROM;

console.log('migration grants');

t('every migration that creates a table grants on it', () => {
  const offenders = [];
  files.forEach(f => {
    if (!underRule(f)) return;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const tables = tablesIn(sql);
    if (!tables.length) return;
    const granted = new Set(grantsIn(sql).map(g => g.table));
    tables.forEach(tb => {
      if (!granted.has(tb)) offenders.push(f + ' -> ' + tb);
    });
  });
  assert.deepStrictEqual(offenders, [],
    'these create a table with no GRANT in the same file:\n   ' + offenders.join('\n   '));
});

t('service_role is the one that is always granted', () => {
  // Nothing in public/ talks to Supabase: every read and write goes through an
  // Express route holding the service-role key. `authenticated` would grant a
  // client that does not exist.
  files.forEach(f => {
    if (!underRule(f)) return;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!tablesIn(sql).length) return;
    const roles = new Set(grantsIn(sql).map(g => g.role));
    if (!roles.size) return;          // covered by the test above
    assert.ok(roles.has('service_role'), f + ' grants to ' + [...roles].join(', ')
      + ' but not service_role');
  });
});

t('anon is never granted without being asked for', () => {
  // anon is the public internet. These tables carry residents, deposits and
  // who posted what.
  const offenders = [];
  files.forEach(f => {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    grantsIn(sql).filter(g => g.role === 'anon')
      .forEach(g => offenders.push(f + ' -> ' + g.table));
  });
  assert.deepStrictEqual(offenders, [], 'these open a table to anon: ' + offenders.join(', '));
});

t('the backfill covers every table it claims to', () => {
  // The exemption is for the FILE. If a table 112 names is not actually
  // granted there, the schema still does not rebuild and the header is lying.
  const backfill = fs.readFileSync(path.join(DIR, '112_grants_backfill.sql'), 'utf8');
  const granted = new Set(grantsIn(backfill).map(g => g.table));
  const claimed = ['102_code_violation_notes.sql', '105_code_violation_closed_cases.sql',
    '106_code_violation_watchlist_history.sql', '107_code_violation_work_orders.sql',
    '108_social_posts.sql', '111_deposit_held.sql'];
  const missing = [];
  claimed.forEach(f => {
    tablesIn(fs.readFileSync(path.join(DIR, f), 'utf8')).forEach(tb => {
      if (!granted.has(tb)) missing.push(f + ' -> ' + tb);
    });
  });
  assert.deepStrictEqual(missing, [],
    'named in the backfill header but never granted: ' + missing.join(', '));
});

t('a bigserial table also grants its sequence', () => {
  // A grant on the table does not reach the sequence behind bigserial: the
  // insert fails on nextval() with the table perfectly readable, which reads
  // as a permission bug in the wrong place.
  const offenders = [];
  files.forEach(f => {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const code = codeOf(sql);
    const serials = [...code.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi)]
      .filter(m => /\b(big)?serial\b/i.test(m[2]))
      .map(m => m[1].toLowerCase());
    if (!serials.length) return;
    if (!underRule(f) && !/^(102|105|106|107|108|111)_/.test(f)) return;
    // Granted here, or in the backfill — the sequence has to be granted
    // somewhere for an insert to work.
    const all = files.map(x => fs.readFileSync(path.join(DIR, x), 'utf8')).join('\n');
    serials.forEach(tb => {
      const seq = tb + '_id_seq';
      if (!new RegExp('grant[^;]*on\\s+sequence\\s+' + seq, 'i').test(codeOf(all))) {
        offenders.push(f + ' -> ' + seq);
      }
    });
  });
  assert.deepStrictEqual(offenders, [],
    'a serial column whose sequence is never granted: ' + offenders.join(', '));
});

t('the rule detects a table added with no grant', () => {
  // Proving the detector detects, rather than trusting that it would.
  const sql = 'create table if not exists some_new_thing (\n  id uuid primary key\n);\n';
  assert.deepStrictEqual(tablesIn(sql), ['some_new_thing']);
  assert.deepStrictEqual(grantsIn(sql), []);
  // And that a comment about grants does not count as one.
  const commented = '-- grant all privileges on table some_new_thing to service_role;\n' + sql;
  assert.deepStrictEqual(grantsIn(commented), [], 'a commented-out grant passed as real');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
