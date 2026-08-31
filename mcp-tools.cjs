/**
 * AI Admin Dashboard — shared MCP tool definitions.
 *
 * Single source of truth for every tool exposed to Claude, used by BOTH
 * transports:
 *  - mcp-server.mjs (stdio, for Claude Desktop talking to the local dashboard)
 *  - server.js's /mcp route (StreamableHTTP, for the cloud instance)
 *
 * Every tool here just calls the dashboard's own REST API (via the
 * getJSON/doFetch helpers passed in) — there is no business logic duplicated
 * here, only the tool-to-endpoint mapping.
 */

const { z } = require('zod');

function registerAllTools(server, { BASE, getJSON, doFetch, text }) {
  // ── Task Manager ──────────────────────────────────────────────────────────

  server.registerTool('get_operational_tasks', {
    title: 'View AI Admin tasks',
    description: 'Returns the Task Manager tasks: Lyndsay Review follow-ups, "To Review Together", admin requests, platform tasks, and Asana imports.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/tasks')));

  server.registerTool('add_operational_task', {
    title: 'Add task',
    description: 'Creates a new task in the Task Manager. Use it when something comes up that needs doing and you want it on record.',
    inputSchema: {
      title: z.string().describe('Short description of the task (required)'),
      type: z.enum(['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other'])
        .optional().describe('Type of task'),
      source: z.string().optional().describe('Where it came from (e.g. "Lyndsay", "Roxanne", email, WhatsApp)'),
      priority: z.enum(['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done']).optional(),
      notes: z.string().optional().describe('Notes or extra context'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not create the task: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task created with id ${data.id}`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running? Start it with "Iniciar AI Admin Dashboard.bat".');
    }
  });

  server.registerTool('update_operational_task', {
    title: 'Edit task',
    description: 'Updates fields on an existing task by id (use get_operational_tasks to see the ids).',
    inputSchema: {
      id: z.string().describe('The id of the task, e.g. "task_1719421234567_4892"'),
      title: z.string().optional(),
      type: z.enum(['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other']).optional(),
      source: z.string().optional(),
      priority: z.enum(['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done']).optional().describe('Set to "✅ Done" to mark it complete.'),
      notes: z.string().optional(),
    },
  }, async ({ id, ...fields }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not update the task: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task "${data.title}" updated`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('complete_operational_task', {
    title: 'Mark task complete',
    description: 'Marks a task as complete (Done). Use it when Arturo says he has finished something.',
    inputSchema: { id: z.string().describe('The id of the task — get it from get_operational_tasks') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task "${data.title}" marked complete`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('delete_operational_task', {
    title: 'Delete task',
    description: 'Permanently deletes a task by id. Always confirm with Arturo before deleting.',
    inputSchema: { id: z.string().describe('The id of the task to delete') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '🗑️ Task deleted' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── SOPs ──────────────────────────────────────────────────────────────────

  server.registerTool('list_sops', {
    title: 'List SOPs',
    description: 'Lists every procedure (SOP) in the AI Admin knowledge base, including source, category and the Slab link (slab_url) where there is one, so it can be shared.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/sops')));

  server.registerTool('get_sop', {
    title: 'Read a full SOP',
    description: 'Returns the full text of a SOP by id (use list_sops to get the ids).',
    inputSchema: { id: z.string().describe('The id of the SOP, e.g. sop_email_folders') },
  }, async ({ id }) => text(await getJSON(`/api/sops/${encodeURIComponent(id)}`)));

  server.registerTool('search_sops', {
    title: 'Search the SOPs',
    description: 'Searches every SOP for a term and returns the matching snippets.',
    inputSchema: { query: z.string().describe('Term or phrase to search for') },
  }, async ({ query }) => text(await getJSON(`/api/sops/search/${encodeURIComponent(query)}`)));

  server.registerTool('add_sop', {
    title: 'Add a SOP',
    description: 'Adds a new procedure to the knowledge base (e.g. the invoice forwarding address, calendar rules).',
    inputSchema: {
      title: z.string().describe('Title of the SOP'),
      text: z.string().describe('Full text of the procedure'),
      tags: z.array(z.string()).optional().describe('Optional tags, e.g. ["email","calendar"]'),
      source: z.string().optional().describe('Source, e.g. "Slab — metric.slab.com" or "Jay Manuel — 08/14/2026"'),
      category: z.string().optional().describe('Category, e.g. "Email Management"'),
      slab_url: z.string().optional().describe('Link to the original Slab article, if there is one'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/sops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ SOP "${data.title}" added`, sop: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── Asana ─────────────────────────────────────────────────────────────────

  server.registerTool('get_my_asana_tasks', {
    title: 'My Asana tasks',
    description: 'Returns the Asana tasks assigned to Arturo (or that he is a collaborator on), from the projects connected to the AI Admin dashboard.',
    inputSchema: {},
  }, async () => {
    const me = await getJSON('/api/asana/me');
    const data = await getJSON('/api/asana/tasks');
    if (data._error) return text(data._error);
    const myGid = me && me.gid;
    const mine = myGid ? data.tasks.filter(t => t.assignee_gid === myGid || (t.follower_gids || []).includes(myGid)) : data.tasks;
    const simplified = mine.map(t => ({
      name: t.name, project: t.project, due_on: t.due_on,
      completed: t.completed, assignee: t.assignee, notes: t.notes_preview,
    }));
    return text({ count: simplified.length, lastUpdated: data.lastUpdated, tasks: simplified });
  });

  server.registerTool('import_asana_tasks', {
    title: 'Import Asana tasks into the Task Manager',
    description: 'Imports the open tasks of an Asana project (by gid) into the dashboard Task Manager, so they sit alongside the rest of the AI Admin tasks in one place. It does not complete or edit anything in Asana — read/import only.',
    inputSchema: {
      projectGid: z.string().describe('The gid of the Asana project to import tasks from'),
    },
  }, async ({ projectGid }) => {
    try {
      const res = await doFetch(`${BASE}/api/asana/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectGid }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not import: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ ${data.imported} new tasks imported (of ${data.total} open in the project)`, imported: data.imported, total: data.total });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── Platform Projects Tracker ─────────────────────────────────────────────

  server.registerTool('get_platform_projects', {
    title: 'View multi-department platform tracking',
    description: 'Returns the status of each Unified Operations Platform module (BD CRM, Leasing Goal Board, Application Approval Board, Eviction Tracker, Operations Aggregate View): phase, blockers, last update and next action.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/platform-projects')));

  server.registerTool('update_platform_project', {
    title: 'Update a platform module',
    description: 'Updates the phase, blockers or next action of a module in the Unified Operations Platform build. Use get_platform_projects to see the ids.',
    inputSchema: {
      id: z.string().describe('The id of the project, e.g. "proj_bd_crm" — get it from get_platform_projects'),
      phase: z.enum(['Not started', 'Discovery', 'In Development', 'Testing', 'Live']).optional(),
      blockers: z.string().optional(),
      nextAction: z.string().optional(),
    },
  }, async ({ id, ...fields }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ "${data.module}" moved to phase "${data.phase}"`, project: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('add_platform_project', {
    title: 'Create a new project in the Platform Projects Tracker',
    description: 'Creates a new module/project in the Unified Operations Platform build tracker. Useful for recording new projects without the web UI.',
    inputSchema: {
      id: z.string().optional().describe('Custom ID, e.g. "proj_maintenance_dashboard". Generated automatically if omitted.'),
      module: z.string().describe('Name of the module or project'),
      phase: z.enum(['Not started', 'Discovery', 'In Development', 'Testing', 'Live']).optional(),
      order: z.number().optional().describe('Position in the list (whole number)'),
      nextAction: z.string().optional(),
      blockers: z.string().optional(),
    },
  }, async ({ id, module, phase, order, nextAction, blockers }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, module, phase, order, nextAction, blockers }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Project "${data.module}" created with id "${data.id}"`, project: data });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('add_platform_project_subtask', {
    title: 'Add a subtask to a platform project',
    description: 'Adds a subtask to an existing project in the Platform Projects Tracker. Use get_platform_projects to get the project id.',
    inputSchema: {
      projectId: z.string().describe('The id of the project, e.g. "proj_bd_crm"'),
      title: z.string().describe('Title of the subtask'),
      done: z.boolean().optional().describe('Whether the subtask is already complete (default: false)'),
    },
  }, async ({ projectId, title, done }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(projectId)}/subtasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, done: done === true }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      const sub = (data.subtasks || []).slice(-1)[0];
      return text({ ok: true, message: `✅ Subtask "${sub?.title}" added to project "${data.module}"`, subtask: sub });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('complete_platform_project_subtask', {
    title: 'Mark a subtask done/undone',
    description: 'Toggles a subtask between done and undone. Use get_platform_projects to get the projectId and subId.',
    inputSchema: {
      projectId: z.string().describe('The id of the project'),
      subId: z.string().describe('The id of the subtask, e.g. "sub_1787589937376_3761"'),
      done: z.boolean().describe('true = complete, false = pending'),
    },
  }, async ({ projectId, subId, done }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(subId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      const sub = (data.subtasks || []).find(s => s.id === subId);
      return text({ ok: true, message: `✅ Subtask "${sub?.title}" marked as ${done ? 'done' : 'pending'}`, subtask: sub });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('delete_platform_project', {
    title: 'Delete a project from the Platform Projects Tracker',
    description: 'Permanently deletes a project from the tracker. Use get_platform_projects to confirm the id before deleting.',
    inputSchema: {
      id: z.string().describe('The id of the project to delete'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Project "${data.deleted}" deleted` });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  // ── Email / Calendar (stub until Graph API credentials are set) ──────────

  server.registerTool('get_email_triage_status', {
    title: 'Email triage status',
    description: 'Returns the real unread and total counts for both mailboxes (Lyndsay and Arturo), plus the senders Lyndsay has most unread mail from. Requires Graph API to be connected — otherwise it reports configured:false or authRequired:true.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/triage')));

  server.registerTool('get_lyndsay_inbox', {
    title: "Read Lyndsay's inbox (or Arturo's)",
    description: "Reads mail from Lyndsay's Inbox (or Arturo's) via the Graph API — sender, subject, preview, read state and whether it has attachments. Use it for the daily triage: Claude reads and classifies mail without Chrome or Outlook being open. Read-only — it does not mark as read, move, or delete anything.",
    inputSchema: {
      mailbox: z.enum(['lyndsay', 'arturo', 'both']).optional().describe('Which mailbox to read. Defaults to lyndsay'),
      limit: z.number().optional().describe('Number of emails to return. Defaults to 50, maximum 100'),
      unread_only: z.boolean().optional().describe('If true, returns only unread mail. Defaults to false'),
    },
  }, async ({ mailbox, limit, unread_only } = {}) => {
    const params = new URLSearchParams();
    if (mailbox) params.set('mailbox', mailbox);
    if (limit) params.set('limit', String(limit));
    if (unread_only) params.set('unread', 'true');
    const qs = params.toString();
    return text(await getJSON(`/api/email/inbox${qs ? `?${qs}` : ''}`));
  });

  server.registerTool('get_email_body', {
    title: 'Read the full body of an email',
    description: 'Reads the full body of one email by its Graph message ID. Use it after get_lyndsay_inbox when you need more context to classify a message correctly. Read-only.',
    inputSchema: {
      message_id: z.string().describe('The Graph message ID from get_lyndsay_inbox'),
      mailbox: z.enum(['lyndsay', 'arturo']).describe('Which mailbox the message belongs to'),
    },
  }, async ({ message_id, mailbox }) => text(await getJSON(`/api/email/message/${encodeURIComponent(message_id)}?mailbox=${mailbox}`)));

  server.registerTool('get_lyndsay_folders', {
    title: "List the folders in Lyndsay's mailbox",
    description: "Lists every folder in Lyndsay's mailbox (or Arturo's) with its unread and total counts. Use it to discover which folders exist (Lyndsay Review, Need to File, Rhoxie To Do, Client Emails, and so on) before reading a specific one with get_lyndsay_folder_emails.",
    inputSchema: {
      mailbox: z.enum(['lyndsay', 'arturo', 'both']).optional().describe('Which mailbox to list. Defaults to lyndsay'),
    },
  }, async ({ mailbox } = {}) => text(await getJSON(`/api/email/folders${mailbox ? `?mailbox=${mailbox}` : ''}`)));

  server.registerTool('get_lyndsay_folder_emails', {
    title: 'Read mail from a specific folder',
    description: "Reads mail from one specific folder in Lyndsay's mailbox (or Arturo's) — not just the Inbox. Use the folder name exactly as get_lyndsay_folders returns it (e.g. \"Need to File\", \"Lyndsay Review\", \"Rhoxie To Do\"). Read-only.",
    inputSchema: {
      folder_name: z.string().describe('Exact folder name, e.g. "Need to File", "Lyndsay Review", "Rhoxie To Do"'),
      mailbox: z.enum(['lyndsay', 'arturo']).optional().describe('Which mailbox the folder belongs to. Defaults to lyndsay'),
      limit: z.number().optional().describe('Maximum emails to return. Defaults to 25'),
      unread_only: z.boolean().optional().describe('If true, returns only unread mail. Defaults to false'),
    },
  }, async ({ folder_name, mailbox, limit, unread_only } = {}) => {
    const params = new URLSearchParams();
    params.set('folder', folder_name);
    params.set('mailbox', mailbox || 'lyndsay');
    params.set('limit', String(limit || 25));
    if (unread_only) params.set('unread', 'true');
    return text(await getJSON(`/api/email/inbox?${params.toString()}`));
  });

  server.registerTool('search_lyndsay_email', {
    title: 'Search mail across every folder',
    description: "Searches EVERY folder in Lyndsay's mailbox (or Arturo's) — not just the Inbox — for a term. Use it when you need to find one specific email (an invoice, a receipt) without knowing which of the ~65 folders it is in.",
    inputSchema: {
      query: z.string().describe('Search term, e.g. "OpenAI receipt", "Slab invoice"'),
      mailbox: z.enum(['lyndsay', 'arturo']).optional().describe('Which mailbox to search. Defaults to lyndsay'),
      limit: z.number().optional().describe('Maximum results. Defaults to 10'),
    },
  }, async ({ query, mailbox, limit } = {}) => {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('mailbox', mailbox || 'lyndsay');
    params.set('limit', String(limit || 10));
    return text(await getJSON(`/api/email/search?${params.toString()}`));
  });

  server.registerTool('get_flagged_for_lyndsay', {
    title: 'Items flagged for Lyndsay',
    description: 'Returns the emails and items that need Arturo to weigh in before deciding whether Lyndsay has to see them.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/flagged-for-lyndsay')));

  server.registerTool('mark_email_handled', {
    title: 'Mark an email handled',
    description: 'Marks a flagged email item as handled.',
    inputSchema: { id: z.string().describe('The id of the flagged item — get it from get_flagged_for_lyndsay') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/email/${encodeURIComponent(id)}/handled`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Marked as handled' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('get_todays_meetings', {
    title: "Today's meetings",
    description: "Returns today's meetings with time, platform (Teams/Zoom/in-person) and attendees, filterable by mailbox (\"arturo\" | \"lyndsay\"). Flags conflicts between the two calendars. Stub mode until the Graph API is configured.",
    inputSchema: { mailbox: z.enum(['arturo', 'lyndsay']).optional().describe('Filter by calendar; omit to return both') },
  }, async ({ mailbox } = {}) => text(await getJSON(`/api/calendar/today${mailbox ? `?mailbox=${mailbox}` : ''}`)));

  server.registerTool('get_pending_lyndsay_messages', {
    title: 'Queue of messages ready for Lyndsay',
    description: 'Returns the queue of reminder messages ready to copy and send to Lyndsay (WhatsApp/call). Includes reminders auto-generated from her calendar and messages added by hand. They are NEVER sent automatically.',
    inputSchema: {},
  }, async () => {
    const queue = await getJSON('/api/lyndsay-queue');
    if (queue._error) return text(queue._error);
    const shaped = queue.map(q => ({
      id: q.id,
      eventId: q.eventId || null,
      message: q.text,
      meetingTitle: q.meetingTitle || null,
      meetingTime: q.meetingTime || null,
      meetingType: q.meetingType || null,
      reminderMinutesBefore: q.reminderMinutesBefore ?? null,
      createdAt: q.createdAt,
      sent: !!q.sent,
    }));
    return text(shaped);
  });

  server.registerTool('get_inbox_tracking', {
    title: 'Inbox Tracking — every Metric mailbox and personal folder',
    description: 'Returns the unread and total counts for every row tracked in the daily Inbox Tracking report: the Inbox of each department mailbox (support, collections, hello, maintenance, leasing, accounting, marketing, admin) and the personal folders assigned to each person inside those mailboxes (e.g. the "Arturo" folder inside support@, "Karla" inside collections@). Replaces the manual process where each person reports their own count. The full row mapping lives in INBOX_TRACKING_MAPPING (.env).',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/inbox-tracking')));

  server.registerTool('get_all_folders_tracking', {
    title: 'Every folder in every Metric mailbox',
    description: 'Lists every folder and its unread count across ALL Metric mailboxes (support, collections, hello, maintenance, leasing, accounting, marketing, admin). Includes system folders (Inbox, Sent, Deleted) and per-person folders (e.g. "Arturo" inside support@, "Rocío" inside collections@). Essential for automating the full Inbox Tracking report in SharePoint.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/all-folders-tracking')));

  server.registerTool('add_lyndsay_message_to_queue', {
    title: "Add a message to Lyndsay's queue",
    description: 'Adds a text message (ready to copy and paste) to the reminder queue for Lyndsay. It is never sent automatically — Arturo copies it and sends it himself.',
    inputSchema: {
      text: z.string().describe('The message text, ready to copy and paste'),
      reason: z.string().optional().describe('Why this message is being sent (e.g. "Meeting in 30 min", "Needs to sign X")'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay-queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Message added to the queue', item: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('mark_lyndsay_message_sent', {
    title: 'Mark a Lyndsay message as sent',
    description: 'Marks a message in the Lyndsay queue as sent so it drops off the pending list. Use it after Arturo confirms he copied and sent it by WhatsApp or call.',
    inputSchema: {
      id: z.string().describe('The id of the message — get it from get_pending_lyndsay_messages'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay-queue/${encodeURIComponent(id)}/sent`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Message marked as sent' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── End of Day Summary ────────────────────────────────────────────────────

  server.registerTool('get_end_of_day_summary', {
    title: 'End of day summary',
    description: "End of day summary: tasks completed and still open, today's meetings, items still flagged for Lyndsay, and tomorrow's top priorities. Bulleted and ready to share with Lyndsay.",
    inputSchema: {},
  }, async () => text(await getJSON('/api/summary')));

  // ══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE TOOLS — Erick Frey (Maintenance Coordinator)
  // These tools operate on metric-dashboard data: operational_tasks,
  // property_assignments, lyndsay_snapshots, and the AppFolio analyzer.
  // All names are prefixed with "maintenance_" to avoid collision with the
  // AI Admin tools above (which target Arturo's /api/tasks, not Erick's
  // /api/operational or the Supabase operational_tasks table).
  // ══════════════════════════════════════════════════════════════════════════

  server.registerTool('maintenance_get_tasks', {
    title: 'View maintenance tasks',
    description: "Returns every task on Erick's maintenance board (operational_tasks in Supabase). Includes priority, owner, notes and history.",
    inputSchema: {},
  }, async () => text(await getJSON('/api/operational')));

  server.registerTool('maintenance_add_task', {
    title: 'Add a maintenance task',
    description: "Creates a new task on Erick's maintenance board.",
    inputSchema: {
      title: z.string().describe('Description of the task (required)'),
      type: z.enum(['WO Follow-up','Translation','Resident Contact','Tech Contact','Escalation','Billing QC','Daily Recurring','Other']).optional(),
      person: z.string().optional().describe('Technician or person responsible'),
      action: z.string().optional().describe('Action to take, or detailed context'),
      priority: z.enum(['🔴 Critical','🟡 Follow-up','🟢 In Progress','🔁 Daily Task','✅ Done']).optional(),
      notes: z.string().optional(),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/operational`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task created (${data.id})`, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_update_task', {
    title: 'Edit a maintenance task',
    description: "Updates fields on an existing task on Erick's board. Passing notes appends an entry to the history.",
    inputSchema: {
      id: z.string().describe('Task ID (op_...)'),
      title: z.string().optional(),
      type: z.enum(['WO Follow-up','Translation','Resident Contact','Tech Contact','Escalation','Billing QC','Daily Recurring','Other']).optional(),
      person: z.string().optional(),
      action: z.string().optional(),
      priority: z.enum(['🔴 Critical','🟡 Follow-up','🟢 In Progress','🔁 Daily Task','✅ Done']).optional(),
      notes: z.string().optional().describe('Note to append to the history'),
    },
  }, async ({ id, ...rest }) => {
    try {
      const res = await doFetch(`${BASE}/api/operational/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rest) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_complete_task', {
    title: 'Complete a maintenance task',
    description: "Marks one of Erick's maintenance tasks as complete.",
    inputSchema: {
      id: z.string().describe('Task ID (op_...)'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/operational/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task completed`, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_property_assignments', {
    title: 'View assignments by property',
    description: 'Returns the maintenance assignment table by property: grounds tech, maintenance tech, pest control, landscaping.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/assignments')));

  server.registerTool('maintenance_update_property', {
    title: 'Update a property assignment',
    description: 'Updates the assignment fields for one property.',
    inputSchema: {
      property: z.string().describe('Exact property name'),
      units: z.number().optional(),
      hasPool: z.boolean().optional(),
      groundsTech: z.string().optional(),
      groundsFrequency: z.string().optional(),
      maintenanceTech: z.string().optional(),
      pestControl: z.string().optional(),
      landscaping: z.string().optional(),
    },
  }, async ({ property, ...rest }) => {
    try {
      const res = await doFetch(`${BASE}/api/assignments/${encodeURIComponent(property)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ property, ...rest }) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, assignment: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  // ── Technicians ───────────────────────────────────────────────────────────
  // Backed by the Supabase `technicians` table, the single source of truth that
  // replaced the five hardcoded lists (supabase/migrations/002_technicians.sql).

  server.registerTool('maintenance_list_technicians', {
    title: 'View technicians',
    description: 'Lists the maintenance technicians with their position, assigned properties, skills (AC, plumbing, electrical, and so on) and their AppFolio names. Use it to decide who to assign a work order to based on what they are qualified for.',
    inputSchema: {
      includeInactive: z.boolean().optional().describe('Include deactivated technicians (active only by default)'),
    },
  }, async ({ includeInactive }) =>
    text(await getJSON('/api/technicians?active=' + (includeInactive ? 'all' : '1'))));

  server.registerTool('maintenance_add_technician', {
    title: 'Add a technician',
    description: 'Registers a new technician. The id is generated from the name if you do not supply one. appfolioAliases must carry the name EXACTLY as it appears in AppFolio (usually with a trailing initial, e.g. "Angel Martinez C"), because the zero-hours alert depends on it.',
    inputSchema: {
      fullName: z.string().describe('Full name (required)'),
      position: z.enum(['field_supervisor', 'senior_maint_tech', 'maint_tech', 'make_ready', 'housekeeper', 'grounds', 'other']).optional(),
      appfolioAliases: z.array(z.string()).optional().describe('Exact names as they appear in AppFolio'),
      expectDailyHours: z.boolean().optional().describe('Must log hours daily — drives the zero-hours alert'),
      propertiesLabel: z.string().optional(),
      notes: z.string().optional(),
    },
  }, async ({ fullName, position, appfolioAliases, expectDailyHours, propertiesLabel, notes }) => {
    try {
      const res = await doFetch(`${BASE}/api/technicians`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName, position, appfolio_aliases: appfolioAliases,
          expect_daily_hours: expectDailyHours, properties_label: propertiesLabel, notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, technician: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_update_technician', {
    title: 'Update a technician',
    description: 'Updates an existing technician: position, skills, AppFolio aliases, map location, or deactivate with active:false. Use maintenance_list_technicians to see the ids. Skills accept: highest, yes, minor, maybe, no, na.',
    inputSchema: {
      id: z.string().describe('The id of the technician, e.g. "angel-martinez"'),
      fullName: z.string().optional(),
      active: z.boolean().optional().describe('false to deactivate without deleting the history'),
      position: z.enum(['field_supervisor', 'senior_maint_tech', 'maint_tech', 'make_ready', 'housekeeper', 'grounds', 'other']).optional(),
      appfolioAliases: z.array(z.string()).optional(),
      expectDailyHours: z.boolean().optional(),
      showOnMap: z.boolean().optional(),
      homeZip: z.string().optional(),
      homeLat: z.number().optional(),
      homeLng: z.number().optional(),
      showsInMakeReady: z.boolean().optional(),
      propertiesLabel: z.string().optional(),
      capAc: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capElectrical: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPlumbing: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPool: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capWelding: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPainting: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capResurfacing: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capCleaning: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      notes: z.string().optional(),
    },
  }, async ({ id, ...rest }) => {
    const map = {
      fullName: 'full_name', active: 'active', position: 'position',
      appfolioAliases: 'appfolio_aliases', expectDailyHours: 'expect_daily_hours',
      showOnMap: 'show_on_map', homeZip: 'home_zip', homeLat: 'home_lat', homeLng: 'home_lng',
      showsInMakeReady: 'shows_in_make_ready', propertiesLabel: 'properties_label',
      capAc: 'cap_ac', capElectrical: 'cap_electrical', capPlumbing: 'cap_plumbing',
      capPool: 'cap_pool', capWelding: 'cap_welding', capPainting: 'cap_painting',
      capResurfacing: 'cap_resurfacing', capCleaning: 'cap_cleaning', notes: 'notes',
    };
    const body = {};
    for (const [camel, snake] of Object.entries(map)) {
      if (rest[camel] !== undefined) body[snake] = rest[camel];
    }
    if (!Object.keys(body).length) return text('No fields were sent to update.');
    try {
      const res = await doFetch(`${BASE}/api/technicians/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, technician: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_lyndsay_tasks', {
    title: "View Lyndsay's tasks (maintenance)",
    description: "Returns the most recent task snapshot from Lyndsay's Daily Command Center with its completion state.",
    inputSchema: {},
  }, async () => text(await getJSON('/api/lyndsay/tasks')));

  server.registerTool('maintenance_complete_lyndsay_task', {
    title: 'Mark a Lyndsay task done',
    description: "Marks a task on Lyndsay's Command Center as complete. Accepts task IDs (e.g. \"code:14986\") and routine IDs (e.g. \"routine:qc\").",
    inputSchema: {
      id: z.string().describe('Task ID (e.g. "code:14986" or "routine:qc")'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay/tasks/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task marked done`, id });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_appfolio_analysis', {
    title: 'View the latest AppFolio analysis',
    description: 'Returns the most recent AppFolio work order analysis: the urgent, followup and ready-for-QC groups.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/appfolio/latest')));

  server.registerTool('maintenance_get_eod_summary', {
    title: 'End of day summary (maintenance)',
    description: "Erick's end of day summary: operational tasks completed and still open, AppFolio work orders, and tomorrow's priorities.",
    inputSchema: {},
  }, async () => text(await getJSON('/api/maintenance/summary')));

  server.registerTool('maintenance_get_daily_report', {
    title: 'Daily work report (Erick)',
    description: "A detailed report of Erick's day: tasks completed, daily tasks, notes added, and the AppFolio summary. Ready to share with Lyndsay.",
    inputSchema: {},
  }, async () => text(await getJSON('/api/report')));

  server.registerTool('maintenance_list_sops', {
    title: 'List maintenance SOPs',
    description: 'Lists the standard operating procedure documents for the maintenance department.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/maintenance/sops')));

  server.registerTool('maintenance_get_sop', {
    title: 'View a maintenance SOP',
    description: 'Returns the full contents of a maintenance SOP by ID.',
    inputSchema: {
      id: z.string().describe('SOP ID (sop_...)'),
    },
  }, async ({ id }) => text(await getJSON(`/api/maintenance/sops/${encodeURIComponent(id)}`)));

  server.registerTool('maintenance_search_sops', {
    title: 'Search the maintenance SOPs',
    description: 'Searches the maintenance SOPs by keyword. Returns the relevant snippets.',
    inputSchema: {
      query: z.string().describe('Search term'),
    },
  }, async ({ query }) => text(await getJSON(`/api/maintenance/sops/search/${encodeURIComponent(query)}`)));
}

module.exports = { registerAllTools };
