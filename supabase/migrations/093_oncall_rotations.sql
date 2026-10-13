-- 093 — the monthly on-call rotation (Erick, 2026-10-06).
--
-- One row per month. The generated rotation, the edits made by hand on top of
-- it, and who approved it.
--
-- THE WHOLE DRAFT IS jsonb for the reason migration 060 gives about
-- call_grades_history: the shape will change — a ninth property, a technician
-- with two home locations, a week that needs a note — and a mirrored set of
-- columns drifts, losing exactly the fields nobody thought to add. What has to
-- be queryable (which month, what state, who approved) is columns; the rest is
-- the document.
--
-- Generated MONTH BY MONTH, never two at a time: a technician can join or
-- leave, so a November calendar built in October would be built from the wrong
-- roster. The unique index on (year, month) is what enforces one per month.

create table if not exists oncall_rotations (
  id          uuid primary key default gen_random_uuid(),
  year        integer not null,
  month       integer not null check (month between 1 and 12),

  -- draft | pending_approval | approved. Text rather than an enum so adding a
  -- state later does not need a migration with a lock on the table.
  state       text not null default 'draft',

  -- The document: weeks, pairs, property assignment, the reason for each
  -- assignment, the carry-in, the fairness table, who was excluded and why.
  draft       jsonb not null,

  -- Every change made by hand after generation, so a reviewer can tell what the
  -- rule produced from what a person decided. An approval that cannot
  -- distinguish them covers both without anybody noticing there was one.
  edits       jsonb not null default '[]'::jsonb,

  -- [{ by, at, note }] — one per approver. Josué, Bekah and Jay.
  approvals   jsonb not null default '[]'::jsonb,

  -- The carry-in, denormalised out of `draft` because "who is on call on the
  -- 1st" is the question somebody asks on the 1st.
  carry_pair  text[],
  carry_from  text,

  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One rotation per month. A second generate REPLACES the draft rather than
-- creating a rival calendar nobody can tell apart from the first.
create unique index if not exists oncall_rotations_month_idx
  on oncall_rotations (year, month);

create index if not exists oncall_rotations_state_idx
  on oncall_rotations (state, year desc, month desc);

comment on column oncall_rotations.draft is
  'The generated rotation with any hand edits applied. lib/oncall-rotation.js build()/applyEdits() own the shape.';
comment on column oncall_rotations.edits is
  'Append-only log of hand edits: {week, type, from, to, by, at}. Never rewritten when the month is regenerated.';

-- Verify:
--   select year, month, state, jsonb_array_length(edits) as edits,
--          jsonb_array_length(approvals) as approvals
--     from oncall_rotations order by year desc, month desc;
