// The SOP image backup script — the guards, not the plumbing.
//
// There is nothing to unit-test about a PUT. What can go wrong here is what
// went wrong with the social screenshots: the wrong kind of destination, an
// unverified upload, or a copy that quietly becomes the primary. These assert
// against the source, because that is where those decisions live.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Comments say all the right words. Strip them, or every assertion below
// passes on prose and nothing on code.
const code = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const SRC = read('scripts/backup-sop-assets-sharepoint.js');
const BODY = code(SRC);
const MIG = read('supabase/migrations/117_sop_assets_backup_item_id.sql');
const DEST = require('../lib/sharepoint-destination.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('sop-assets backup');

// These CALL the guard. The first version of these asserted that the patterns
// appeared in the source, and mutation testing switched both checks off with
// every assertion still green.

const refuses = (site, why) => assert.throws(() => DEST.assertTeamSite(site), /./, why);

t('a personal OneDrive host is refused', () => {
  refuses('netorgft5473895-my.sharepoint.com:/sites/Ops', 'the -my host was accepted');
  assert.throws(() => DEST.assertTeamSite('x-my.sharepoint.com:/sites/A'), /PERSONAL OneDrive/);
});

t('a user drive spelled as a path is refused', () => {
  refuses('metricpropertymanagement.sharepoint.com/users/admin', 'a /users/ drive was accepted');
  refuses('metricpropertymanagement.sharepoint.com/personal/admin_metric_com', 'a /personal/ drive was accepted');
});

t('a team site is required, not merely preferred', () => {
  refuses('metricpropertymanagement.sharepoint.com', 'a bare host was accepted');
  refuses('metricpropertymanagement.sharepoint.com:/sites/', 'an empty site name was accepted');
  refuses('', 'an empty destination was accepted');
  assert.strictEqual(
    DEST.assertTeamSite(' metricpropertymanagement.sharepoint.com:/sites/Ops '),
    'metricpropertymanagement.sharepoint.com:/sites/Ops');
});

t('the drive Graph answers with is checked again', () => {
  // Resolving a name is not proof of where it pointed.
  assert.throws(() => DEST.assertTeamDrive('https://netorgft5473895-my.sharepoint.com/personal/admin'),
    /personal OneDrive/);
  assert.strictEqual(DEST.assertTeamDrive('https://metric.sharepoint.com/sites/Ops/Shared%20Documents'),
    'https://metric.sharepoint.com/sites/Ops/Shared%20Documents');
});

t('the script uses that guard rather than its own copy', () => {
  assert.ok(/DEST\.assertTeamSite\(SITE\)/.test(BODY), 'the destination is not checked');
  assert.ok(/DEST\.assertTeamDrive\(/.test(BODY), 'the resolved drive is not checked');
});

t('the destination has no default', () => {
  // The whole point: Jay picks the folder. A default would upload 86 MB
  // somewhere nobody agreed to the first time this is run without flags.
  assert.ok(/if \(!SITE \|\| !FOLDER\)/.test(BODY), 'the destination can be omitted');
  const dest = BODY.slice(BODY.indexOf('const SITE'), BODY.indexOf('const DATA_DIR'));
  assert.ok(!/\|\|\s*['"][^'"]*sharepoint/i.test(dest), 'a site is hard-coded as a fallback');
  assert.ok(!/SOP_BACKUP_FOLDER\s*\)\s*\|\|\s*'[^']+'/.test(dest), 'a folder is hard-coded as a fallback');
});

t('dry run is the default and uploading must be asked for', () => {
  assert.ok(/const WRITE = process\.argv\.includes\('--write'\)/.test(BODY));
  assert.ok(/if \(!WRITE\) \{[\s\S]{0,1200}return;/.test(BODY),
    'the dry run does not return before the upload loop');
});

t('the dry run contacts nothing', () => {
  // It must be safe to run at any hour on any machine: no token, no Graph.
  const dry = BODY.slice(BODY.indexOf('if (!WRITE) {'), BODY.indexOf('const token = await graphToken()'));
  assert.ok(!/fetch\(|graphToken|resolveDrive/.test(dry), 'the dry run reaches the network');
  const beforeWrite = BODY.slice(0, BODY.indexOf('const token = await graphToken();\n  const drive'));
  assert.ok(!/resolveDrive\(/.test(beforeWrite.slice(beforeWrite.indexOf('requireDestination();'))),
    'the site is resolved before the dry-run check');
});

t('the dry run prints count, bytes and the target paths', () => {
  const dry = BODY.slice(BODY.indexOf('WOULD UPLOAD'), BODY.indexOf('Nothing was uploaded'));
  assert.ok(/files : /.test(dry) && /bytes : /.test(dry), 'count or bytes missing');
  assert.ok(/FOLDER \+ '\/' \+ w\.name/.test(dry), 'the target paths are never shown');
});

t('an upload is verified by bytes, not by a 200', () => {
  assert.ok(/Number\(j\.size\) !== body\.length/.test(BODY), 'the returned size is not checked');
  assert.ok(/size mismatch/.test(SRC));
});

t('a missing item id is a failure', () => {
  assert.ok(/if \(!j\.id\) throw/.test(BODY), 'an upload with no id is accepted');
});

t('an upload that cannot be recorded counts as failed', () => {
  // An unrecorded copy is one nobody can find again.
  assert.ok(/uploaded but could not record/.test(SRC));
  const loop = BODY.slice(BODY.indexOf('for (const [i, w] of work.entries())'));
  assert.ok(/throw new Error\('uploaded but could not record/.test(loop), 'the record error is only logged');
});

t('--write refuses to run before the migration', () => {
  assert.ok(/117_sop_assets_backup_item_id\.sql/.test(BODY), 'the migration is not named');
  assert.ok(/Refusing to upload/.test(SRC));
  assert.ok(/if \(WRITE\) \{[^}]*process\.exitCode = 2/.test(BODY), 'it continues without the column');
});

t('nothing is deleted or moved', () => {
  assert.ok(!/unlink|rmdir|rm -|\.rename\(|\.rm\(/.test(BODY), 'the script can remove files');
});

t('the served route is untouched', () => {
  const server = read('server.js');
  assert.ok(/app\.get\('\/api\/sop\/assets\/:name'/.test(server), 'the asset route moved');
  assert.ok(!/backup_item_id/.test(server),
    'the server reads the backup copy — the disk is supposed to stay primary');
});

t('a row with no file on disk is not counted as backed up', () => {
  assert.ok(/statSync/.test(BODY) && /missing\+\+/.test(BODY),
    'disk presence is never checked, so a missing file reads as ready');
});

t('the migration adds columns and backfills nothing', () => {
  assert.ok(/add column if not exists backup_item_id/.test(MIG));
  assert.ok(/add column if not exists backup_bytes/.test(MIG));
  assert.ok(!/^\s*update |^\s*insert /im.test(code(MIG)), 'the migration writes rows');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
