-- 044_accounting_tasks_kanban.sql
--
-- Upgrades Claudia's Accounting task board to match the main Task Manager:
-- priority-based kanban columns, a note history, and recurring tasks.
--
-- Uses the existing, already-isolated accounting_tasks table (rather than adding
-- a task_context filter to operational_tasks, which the MCP tools and the EOD
-- summary read) — accounting tasks are already separate from every other board.
--
--   priority_label  the kanban column: '🔴 Critical' | '🟡 Follow-up' |
--                   '🟢 In Progress' | '✅ Done' (matches the main Task Manager;
--                   the legacy `priority` urgent/normal/low column is left as-is)
--   recurrence      'none' | 'weekly' | 'monthly'
--   recurrence_day  day-of-week (0=Sun..6=Sat) for weekly, or day-of-month for monthly
--   completed_at    when it was marked Done
--   note_history    jsonb array of { text, createdAt }
--
-- Idempotent. Run in the Supabase SQL editor.

alter table accounting_tasks add column if not exists priority_label text;
alter table accounting_tasks add column if not exists recurrence     text default 'none';
alter table accounting_tasks add column if not exists recurrence_day  integer;
alter table accounting_tasks add column if not exists completed_at    timestamptz;
alter table accounting_tasks add column if not exists note_history    jsonb default '[]'::jsonb;
