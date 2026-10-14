#!/usr/bin/env node
//
// What is actually used in Asana. READ ONLY — every request is a GET, and the
// script cannot create, move, edit or delete anything.
//
//   node scripts/asana-inventory.js
//   node scripts/asana-inventory.js --days 90
//
// COUNTS, NOT CONTENT. Task names, descriptions, comments and attachment names
// are never printed. People appear by NAME ONLY — no emails — because Arturo
// asked who creates and who completes, and a count against "User 1211..." is
// not an answer anybody can act on.
//
// WHY A SCRIPT AND NOT THE MCP TOOLS. Asana's search endpoint caps at 100
// results per call with no offset, and the Team's Priorities Tracker alone
// holds 10,630 tasks. A capped search would report "100" for every busy
// project and the inventory would be wrong in the direction that matters.
// This pages /projects/{gid}/tasks properly.
require('dotenv').config();

const TOKEN = process.env.ASANA_TOKEN || process.env.ASANA_ACCESS_TOKEN;
const BASE = 'https://app.asana.com/api/1.0';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', 90));
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

const pad = (s, w) => String(s).padEnd(w);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '—');

let calls = 0;
// ASANA RATE-LIMITS ON COST, NOT JUST ON COUNT. Paging a 10,630-task project
// is "exceptionally expensive" by its reckoning and comes back 429 with a
// Retry-After. Honouring that header is the difference between an inventory
// that finishes and one that reports two projects out of six and calls it the
// company.
async function get(path, params, attempt) {
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  calls++;
  const r = await global.fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 8) throw new Error('Asana kept rate-limiting ' + path + ' after ' + n + ' tries');
    // Its own number, not one I invented; 30s when it does not say.
    const wait = Number(r.headers.get('retry-after')) || 30;
    console.log('      (rate limited, waiting ' + wait + 's)');
    await new Promise(res => setTimeout(res, wait * 1000));
    return get(path, params, n);
  }
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    throw new Error('Asana ' + r.status + ' on ' + path + ': ' + b.slice(0, 200));
  }
  return r.json();
}

// Every page, not the first one. The default page size hides exactly the
// projects that matter.
async function getAll(path, params) {
  const out = [];
  let offset = null;
  do {
    const j = await get(path, { ...params, limit: 100, offset });
    out.push(...(j.data || []));
    offset = j.next_page ? j.next_page.offset : null;
    // A breath between pages. Cheaper than being throttled for a minute.
    if (offset) await new Promise(res => setTimeout(res, 250));
  } while (offset);
  return out;
}

const bump = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n || 12);

(async () => {
  if (!TOKEN) {
    console.error('ASANA_TOKEN is not set in this shell.');
    process.exitCode = 1;
    return;
  }

  // ---- 1. structure --------------------------------------------------------
  const ws = (await get('/workspaces', { opt_fields: 'name,is_organization' })).data;
  console.log('WORKSPACES');
  ws.forEach(w => console.log('   ' + pad(w.name, 34)
    + (w.is_organization ? 'organization' : 'workspace')));

  // TWO ORGANISATIONS, AND THE TOKEN SEES BOTH. The MCP connector in the chat
  // shows only "Metric Property Management"; ASANA_TOKEN — the one the
  // dashboard uses — also sees "livewithmetric.com". Picking ws[0] reported an
  // empty workspace as the whole company, which is the failure this loop
  // exists to prevent. Every workspace is inventoried and named.
  const only = arg('workspace', null);
  for (const workspace of ws) {
    if (only && workspace.name !== only) continue;
    await inventory(workspace);
  }
  console.log('\n' + calls + ' GET requests. Nothing was created, moved or edited.');
  console.log('No task name, description, comment, attachment or email was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });

async function inventory(workspace) {
  const W = workspace.gid;
  console.log('\n' + '='.repeat(72));
  console.log('WORKSPACE: ' + workspace.name);
  console.log('='.repeat(72));

  const teams = await getAll('/organizations/' + W + '/teams', { opt_fields: 'name' })
    .catch(() => []);
  const active = await getAll('/projects', { workspace: W, archived: false,
    opt_fields: 'name,created_at,modified_at,owner.name,public,default_view' });
  const archived = await getAll('/projects', { workspace: W, archived: true,
    opt_fields: 'name,modified_at' });

  console.log('\nSTRUCTURE');
  console.log('   ' + pad('teams', 24) + teams.length);
  console.log('   ' + pad('projects, active', 24) + active.length);
  console.log('   ' + pad('projects, archived', 24) + archived.length);

  const users = await getAll('/workspaces/' + W + '/users', { opt_fields: 'name' });
  const named = users.filter(u => u.name && u.name !== 'Private User' && !/@/.test(u.name));
  const privy = users.filter(u => u.name === 'Private User');
  const emailish = users.filter(u => /@/.test(u.name || ''));
  console.log('   ' + pad('users, total records', 24) + users.length);
  console.log('   ' + pad('...named', 24) + named.length);
  console.log('   ' + pad('...“Private User”', 24) + privy.length
    + '   not in a team this token can see');
  console.log('   ' + pad('...name is an address', 24) + emailish.length
    + '   never invited properly, or a bot seat');

  console.log('\nNAMED USERS (name only; no emails, no roles in the API)');
  named.map(u => u.name).sort().forEach(n => console.log('   ' + n));

  // ---- 2. usage ------------------------------------------------------------
  console.log('\nPROJECTS — ALL TIME, AND THE LAST ' + DAYS + ' DAYS');
  console.log('   ' + pad('project', 42) + pad('tasks', 8) + pad('open', 7)
    + pad('created', 9) + pad('completed', 11) + 'last change');

  const feature = {
    sections: 0, sectionsNamed: 0, subtasks: 0, customFields: {}, dependencies: 0,
    recurring: 0, dueDates: 0, startDates: 0, comments: 0, attachments: 0,
    followersOver1: 0, tags: {}, milestones: 0, approvals: 0, assigned: 0,
    liked: 0, notes: 0,
  };
  const creators = {};
  const completers = {};
  let recent = 0;
  let recentDone = 0;
  let sampled = 0;

  for (const p of active) {
    const tasks = await getAll('/projects/' + p.gid + '/tasks', {
      opt_fields: 'created_at,completed,completed_at,created_by.name,assignee.name,'
        + 'due_on,due_at,start_on,num_subtasks,parent,notes,resource_subtype,'
        + 'custom_fields.name,custom_fields.display_value,tags.name,'
        + 'dependencies,dependents,followers,liked,memberships.section.name',
    });
    const inWindow = tasks.filter(t => t.created_at && t.created_at >= SINCE);
    const doneInWindow = tasks.filter(t => t.completed_at && t.completed_at >= SINCE);
    recent += inWindow.length;
    recentDone += doneInWindow.length;

    const sections = await getAll('/projects/' + p.gid + '/sections', { opt_fields: 'name' });
    feature.sections += sections.length;
    feature.sectionsNamed += sections.filter(s => !/^untitled/i.test(s.name || '')).length;

    console.log('   ' + pad(p.name.slice(0, 40), 42)
      + pad(tasks.length, 8)
      + pad(tasks.filter(t => !t.completed).length, 7)
      + pad(inWindow.length, 9)
      + pad(doneInWindow.length, 11)
      + String(p.modified_at || '').slice(0, 10));

    // Feature usage is counted over the WINDOW, not all time: what people do
    // now is the question, and a field abandoned in 2024 is not an argument
    // for keeping a plan.
    inWindow.forEach(t => {
      sampled++;
      bump(creators, t.created_by && t.created_by.name);
      if (t.assignee) feature.assigned++;
      if (t.due_on || t.due_at) feature.dueDates++;
      if (t.start_on) feature.startDates++;
      if (t.num_subtasks) feature.subtasks++;
      if (t.parent) feature.subtasks += 0;      // counted on the parent
      if ((t.dependencies || []).length || (t.dependents || []).length) feature.dependencies++;
      if ((t.followers || []).length > 1) feature.followersOver1++;
      if (t.liked) feature.liked++;
      if (String(t.notes || '').trim()) feature.notes++;
      if (t.resource_subtype === 'milestone') feature.milestones++;
      if (t.resource_subtype === 'approval') feature.approvals++;
      (t.tags || []).forEach(g => bump(feature.tags, g.name));
      (t.custom_fields || []).forEach(f => {
        if (f.display_value != null && String(f.display_value).trim() !== '') bump(feature.customFields, f.name);
      });
    });
    doneInWindow.forEach(t => {
      // completed_by is not on the task resource; the stories carry it, and one
      // request per task would be thousands. Reported as a gap rather than
      // guessed from the assignee, which is a different person often enough to
      // matter.
    });
  }

  console.log('\n   ' + pad('TOTAL', 42) + pad('', 8) + pad('', 7)
    + pad(recent, 9) + pad(recentDone, 11));

  console.log('\nWHO CREATES (last ' + DAYS + ' days, tasks created: ' + sampled + ')');
  top(creators).forEach(([n, c]) => console.log('   ' + pad(n, 34) + pad(c, 7) + pct(c, sampled)));
  console.log('\n   completed_by is NOT on the task resource. Getting it means one');
  console.log('   request per task — thousands of calls — so it is left blank rather');
  console.log('   than inferred from the assignee, who is a different person often');
  console.log('   enough to matter.');

  // ---- 3. features ---------------------------------------------------------
  console.log('\nFEATURES IN USE (over the ' + sampled + ' tasks created in the window)');
  const f = (label, n, note) => console.log('   ' + pad(label, 30) + pad(n, 7)
    + pad(pct(n, sampled), 7) + (note || ''));
  f('due date', feature.dueDates);
  f('assignee', feature.assigned);
  f('description written', feature.notes);
  f('subtasks', feature.subtasks);
  f('start date', feature.startDates);
  f('more than one follower', feature.followersOver1);
  f('dependencies', feature.dependencies);
  f('milestones', feature.milestones);
  f('approvals', feature.approvals);
  f('liked', feature.liked);
  console.log('   ' + pad('sections', 30) + pad(feature.sections, 7)
    + '       ' + feature.sectionsNamed + ' named, across all active projects');

  console.log('\n   custom fields with a value:');
  const cf = top(feature.customFields);
  if (cf.length) cf.forEach(([n, c]) => console.log('      ' + pad(n, 31) + pad(c, 7) + pct(c, sampled)));
  else console.log('      none');

  console.log('\n   tags:');
  const tg = top(feature.tags);
  if (tg.length) tg.forEach(([n, c]) => console.log('      ' + pad(n, 31) + pad(c, 7) + pct(c, sampled)));
  else console.log('      none');

  const portfolios = await getAll('/portfolios', { workspace: W, owner: 'me', opt_fields: 'name' })
    .catch(() => null);
  const goals = await getAll('/goals', { workspace: W, opt_fields: 'name' }).catch(() => null);
  console.log('\n   ' + pad('portfolios (owned by this token)', 34)
    + (portfolios === null ? 'not permitted on this plan' : portfolios.length));
  console.log('   ' + pad('goals', 34)
    + (goals === null ? 'not permitted on this plan' : goals.length));

  console.log('\n   NOT ANSWERABLE FROM THE API, and not guessed:');
  console.log('      rules / automations   no public endpoint');
  console.log('      forms                 no public endpoint');
  console.log('      connected apps        no public endpoint');
  console.log('      recurring tasks       Asana models these as new tasks; the recurrence');
  console.log('                            rule is not exposed on the task resource');
  console.log('      comments, attachments one request PER TASK; see the note below');

  // ---- 5. plan -------------------------------------------------------------
  console.log('\nPLAN AND LICENCES');
  console.log('   The Asana API does NOT expose the plan type or the number of paid');
  console.log('   seats. There is no billing endpoint, and the workspace resource has');
  console.log('   no plan field. What CAN be inferred, and only weakly:');
  console.log('      - goals and portfolios answering at all implies a paid tier');
  console.log('      - the user count above is SEATS SEEN, not seats paid for');
  console.log('   Read the plan and the seat count off the Asana admin console.');
}
