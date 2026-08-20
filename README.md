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
