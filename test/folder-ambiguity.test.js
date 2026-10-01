// Reading a folder by name when two folders share the name.
//
// Lyndsay has "Unsubscribe Needed" twice: once at the root, empty, and once
// under Inbox with 18 messages in it. resolveFolderPath used .find(), so Graph's
// listing order decided which one you got — and the empty one came back as a
// successful read of zero emails. A wrong answer shaped like a right one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
// AWAITED. Half of these assertions are async, and a runner that calls fn()
// without awaiting turns every one of them into a test that cannot fail: the
// rejection lands as an unhandled promise long after "ok" has been printed.
const t = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp-tools.cjs'), 'utf8');

// The real function, with its one dependency stubbed from a fixture.
const FOLDERS = [
  { id: 'AAA-root-unsub', displayName: 'Unsubscribe Needed', parentName: null, totalItemCount: 0, unreadItemCount: 0 },
  { id: 'BBB-inbox-unsub', displayName: 'Unsubscribe Needed', parentName: 'Inbox', totalItemCount: 18, unreadItemCount: 18 },
  { id: 'CCC-review', displayName: 'Lyndsay Review', parentName: 'Inbox', totalItemCount: 42, unreadItemCount: 7 },
  { id: 'DDD-file', displayName: 'Need to File', parentName: 'Inbox', totalItemCount: 9, unreadItemCount: 0 },
];
const src = server.slice(server.indexOf('async function resolveFolderPath('),
  server.indexOf('// Lists all mail folders'));
// eslint-disable-next-line no-new-func
const resolveFolderPath = new Function('listMailFolders',
  src + 'return resolveFolderPath;')(async () => FOLDERS);
const resolve = (name, id) => resolveFolderPath('lyndsay', 'tok', name, id);

const ROUTE = (() => {
  const i = server.indexOf("app.get('/api/email/inbox'");
  return server.slice(i, server.indexOf("app.get('/api/email/message/:id'"));
})();
const TOOL = mcp.slice(mcp.indexOf("registerTool('get_lyndsay_folder_emails'"),
  mcp.indexOf("registerTool('search_lyndsay_email'"));

(async () => {
  console.log('an id beats a name, and skips the lookup entirely');
  await t('folder_id is returned as given', async () => {
    assert.strictEqual(await resolve(null, 'BBB-inbox-unsub'), 'BBB-inbox-unsub');
  });
  await t('an id wins when both are given — a name cannot override it', async () => {
    // The whole point of passing an id is that you already know which one.
    assert.strictEqual(await resolve('Unsubscribe Needed', 'AAA-root-unsub'), 'AAA-root-unsub');
    assert.strictEqual(await resolve('Lyndsay Review', 'BBB-inbox-unsub'), 'BBB-inbox-unsub');
  });
  await t('an id works for a folder no longer findable by name', async () => {
    // Resolution by id does not consult the tree at all, so a renamed folder
    // stays reachable.
    assert.strictEqual(await resolve(null, 'ZZZ-renamed'), 'ZZZ-renamed');
  });

  console.log('\nname lookup still works — this is the part that must not break');
  await t('a unique name resolves exactly as before', async () => {
    assert.strictEqual(await resolve('Lyndsay Review'), 'CCC-review');
    assert.strictEqual(await resolve('Need to File'), 'DDD-file');
  });
  await t('case still does not matter', async () => {
    assert.strictEqual(await resolve('lyndsay review'), 'CCC-review');
    assert.strictEqual(await resolve('NEED TO FILE'), 'DDD-file');
  });
  await t('Inbox is still the well-known name Graph resolves itself', async () => {
    for (const v of ['Inbox', 'inbox', 'INBOX', '', null, undefined]) {
      assert.strictEqual(await resolve(v), 'inbox', String(v));
    }
  });
  await t('a name that does not exist still says so', async () => {
    await assert.rejects(() => resolve('No Such Folder'), /not found/);
  });

  console.log('\nan ambiguous name refuses to guess');
  await t('it throws instead of silently picking one', async () => {
    // Either choice would be a guess. The empty one is wrong today; the full
    // one would be wrong the first time the empty one fills up.
    await assert.rejects(() => resolve('Unsubscribe Needed'), /ambiguous/i);
  });
  await t('the error names both candidates, with parent, count and id', async () => {
    const err = await resolve('Unsubscribe Needed').then(() => null, e => e);
    assert.ok(err, 'it resolved instead of refusing');
    ['AAA-root-unsub', 'BBB-inbox-unsub', 'Inbox/Unsubscribe Needed', '18 messages']
      .forEach(s => assert.ok(err.message.includes(s), `the error does not mention ${s}`));
    assert.ok(/folder_id/.test(err.message), 'the error does not say how to fix it');
  });
  await t('the candidates come back as data too, not only prose', async () => {
    const err = await resolve('Unsubscribe Needed').then(() => null, e => e);
    assert.ok(Array.isArray(err.ambiguous) && err.ambiguous.length === 2);
    assert.deepStrictEqual(err.ambiguous.map(f => f.id).sort(), ['AAA-root-unsub', 'BBB-inbox-unsub']);
    const inbox = err.ambiguous.find(f => f.parent === 'Inbox');
    assert.strictEqual(inbox.totalCount, 18, 'the counts that distinguish them are missing');
    assert.strictEqual(err.ambiguous.find(f => f.parent === null).totalCount, 0);
  });

  console.log('\nwired through the route and the tool');
  await t('the route reads folder_id and prefers it', async () => {
    assert.ok(/req\.query\.folder_id/.test(ROUTE), 'the route ignores folder_id');
    assert.ok(/resolveFolderPath\(key, token, folder, folderId\)/.test(ROUTE),
      'folderId never reaches the resolver');
    assert.ok(/folderId: folderPath/.test(ROUTE),
      'the response does not say which folder it actually read');
  });
  await t('the ambiguity list survives into the response', async () => {
    assert.ok(/err\.ambiguous/.test(ROUTE),
      'the candidates are dropped, so a caller gets prose it has to parse');
  });
  await t('the MCP tool takes folder_id and no longer requires a name', async () => {
    assert.ok(/folder_id: z\.string\(\)\.optional\(\)/.test(TOOL), 'no folder_id parameter');
    assert.ok(/folder_name: z\.string\(\)\.optional\(\)/.test(TOOL),
      'folder_name is still required, so folder_id alone cannot be used');
    assert.ok(/params\.set\('folder_id', folder_id\)/.test(TOOL), 'folder_id is not sent');
    assert.ok(/Give folder_name or folder_id/.test(TOOL),
      'calling it with neither would read the Inbox and look like a success');
  });
  await t('both tool descriptions warn that names are not unique', async () => {
    const list = mcp.slice(mcp.indexOf("registerTool('get_lyndsay_folders'"),
      mcp.indexOf("registerTool('get_lyndsay_folder_emails'"));
    assert.ok(/not unique|Unsubscribe Needed/i.test(list),
      'the folder list does not warn that two folders can share a name');
    assert.ok(/\bid\b/.test(list), 'it does not mention that it returns an id');
    assert.ok(/ambiguous/i.test(TOOL), 'the reader does not explain the ambiguous case');
  });
  await t('the folder listing exposes id and parent — it already did', async () => {
    const i = server.indexOf("app.get('/api/email/folders'");
    const body = server.slice(i, server.indexOf('// Cross-folder search'));
    assert.ok(/id: f\.id/.test(body) && /parent: f\.parentName/.test(body),
      'the listing stopped exposing what folder_id needs');
  });

  console.log(`\n${pass} passing`);
})().catch(err => { console.error(err); process.exit(1); });
