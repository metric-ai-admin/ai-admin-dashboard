# AI Admin Dashboard

Local Node/Express dashboard + MCP server for Arturo's AI Admin role at
Metric Property Management. Separate from `metric-dashboard` (maintenance
role) — runs on port 3001 so both can run at the same time.

Also deployed to Render (`https://ai-admin-dashboard-jkde.onrender.com`),
with runtime data persisted to a mounted disk at `DATA_DIR=/var/data` so it
survives redeploys.

## Architectural principle

The dashboard's own backend does background work on a schedule (node-cron),
independent of any chat session. Open a Claude chat and ask "read the
dashboard" — Claude reads current state via MCP tools and tells you what
needs attention. Claude cannot run in the background or push notifications;
all proactive monitoring lives in this server process.

## Modules

1. **Task Manager** (`/api/tasks`) — Lyndsay Review follow-ups, "To Review
   Together" items, admin requests, platform build tasks, Asana imports.
2. **SOPs Knowledge Base** (`/api/sops`) — searchable reference library.
3. **Asana Integration** (`/api/asana`) — read/import only, no auto-editing.
4. **Platform Projects Tracker** (`/api/platform-projects`) — Unified
   Operations Platform build (BD CRM → Leasing Board → Application Approval
   → Eviction Tracker + Ops view).
5. **Email & Calendar** (`/api/email`, `/api/calendar`) — Microsoft Graph API,
   both mailboxes (Arturo's + Lyndsay's). **Stub mode** until the Azure App
   Registration is created and `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` /
   `GRAPH_CLIENT_SECRET` are set in `.env`.
6. **End of Day Summary** (`/api/summary`) — bullet-point report: tasks
   done/open, meetings, still-flagged items, top 3 priorities for tomorrow.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` if starting fresh (already done in this repo —
`.env` reuses the Asana token from `metric-dashboard`). Fill in
`ASANA_EXTRA_PROJECTS` with the Asana project GID(s) for AI Admin work.

## Running

Double-click `Iniciar AI Admin Dashboard.bat`, or:

```bash
npm start
```

Dashboard: http://localhost:3001

## Claude Desktop MCP config

```json
{
  "mcpServers": {
    "ai-admin-dashboard": { "command": "node", "args": ["<full path>/mcp-server.mjs"] }
  }
}
```

## What's NOT built (by design)

- No WhatsApp integration — chats are pasted into a Claude chat manually.
- No auto-send to Lyndsay of any kind — every message is prepared as
  copy-paste text in the `lyndsay-queue` for Arturo to send himself.
- Email/Calendar module won't hit Microsoft Graph for real until the Azure
  App Registration is set up and credentials are added to `.env`.

## BD CRM — open issues

**Duplicate properties.** Every property exists twice (~502 rows for ~251
properties), so the Task Queue lists everything twice and returns 980 tasks.
A plain dedup `DELETE` would error on the UUID primary key and, worse, cascade
into the activity tables — two sampled pairs have call logs and follow-ups
split across *both* copies. Full analysis, census query and a guarded migration
plan: [docs/backlog/crm-duplicate-properties.md](docs/backlog/crm-duplicate-properties.md).
Needs a dedicated session; nothing has been deleted.

## Maintenance tab — roadmap

Known-incomplete areas, deliberately parked. Each is waiting on something
outside the code.

**SOPs Library** — the view and its search work, but the library is empty.
Populate it once Lyndsay's SOP Review project (`proj_sop_review`) settles the
categories and which SOPs are shared with whom.

**Maintenance Efficiency** — 4 of the 9 tracker metrics are exact; 3 are
approximate and 2 cannot be pulled at all. This is an AppFolio limitation, not
ours: `work_order.json` silently ignores the `status` filter, so per-status
counts are derived from work orders that have logged labour and undercount,
and the Canceled/Waiting billable totals are absent from every report the API
exposes. The view labels each number with its confidence rather than
presenting a wrong figure as real. Revisit if AppFolio enables the server-side
status filter.

**Command Center** — still renders an offline HTML snapshot imported through
`/api/lyndsay/import`. The plan is a drop zone for the master Excel that the
AppFolio plugin refreshes daily: six tabs (Work Orders, Billable, Labor,
Custom Fields, Inventory, Inspections) that generate the Command Center's
tasks and views. Needs the workbook's real column layout before anything is
built; `xlsx` is already a dependency.

**Asana Tasks** — shows Erick's board only once `ASANA_TOKEN_ERICK` is set in
the environment. `ASANA_TOKEN` is Arturo's and cannot see Erick's tasks.

**AppFolio Analyzer** — accepts CSV only. The local metric-dashboard also
takes PDFs and images via `tesseract.js` + `pdf-parse`; those were left out
here rather than shipping ~8 MB of OCR training data to Render for occasional
use.

**Role access** — Erick's role (`maintenance`) currently only reaches the CRM
tab. Giving him the Maintenance tab is one entry in `TAB_ACCESS` in
`public/app.js`, pending the decision to move him off MCP-only.
