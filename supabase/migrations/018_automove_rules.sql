-- Email Auto-Move Phase 2 — config-driven routing rules
--
-- Replaces the hardcoded 2-condition engine with rules stored here, so a new
-- rule is a row, not a deploy. cold_outreach_senders stays and is evaluated
-- AFTER these rules (lowest priority) for backward compatibility.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS / ON
-- CONFLICT and safe to re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists automove_rules (
  id            uuid primary key default gen_random_uuid(),
  priority      integer not null default 50,   -- lower = evaluated first
  match_type    text not null,                 -- sender_exact | sender_domain | header | subject_contains | subject_startswith
  match_value   text not null,                 -- compared lowercased on both sides
  action        text not null,                 -- move | move_read | archive | archive_read | move_unsubscribe
  target_folder text,                          -- folder name in Lyndsay's mailbox (null for archive)
  mark_read     boolean not null default false,
  active        boolean not null default true,
  confidence    numeric not null default 1.0,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists automove_rules_active_priority
  on automove_rules (active, priority);

-- The log gets a rule reference so a moved message can be traced to the rule
-- that moved it. Nullable: legacy cold_outreach_senders matches have no rule.
alter table auto_move_log add column if not exists rule_id uuid;

-- ── Seed: confirmed patterns from the triage history ────────────────────────
-- Idempotent: skip if a rule with the same (match_type, match_value, action)
-- already exists, so re-running does not duplicate the seed.
insert into automove_rules (priority, match_type, match_value, action, target_folder, mark_read, notes)
select v.priority, v.match_type, v.match_value, v.action, v.target_folder, v.mark_read, v.notes
from (values
  -- MPM Team
  (10, 'sender_domain', '@metricpropertymanagement.com', 'move', 'MPM Team', false, 'Internal Metric team emails'),
  (10, 'sender_domain', '@livewithmetric.com', 'move', 'MPM Team', false, 'Internal Metric team emails'),
  (10, 'sender_domain', '@slab.com', 'move', 'MPM Team', true, 'Slab SOP updates'),
  -- Rocío
  (20, 'sender_domain', '@managebuilding.com', 'move', 'Rocio', false, 'Rental applications'),
  (20, 'subject_contains', 'countersign', 'move', 'Rocio', true, 'AppFolio countersign notifications'),
  (20, 'subject_contains', 'lease countersign', 'move', 'Rocio', true, 'AppFolio lease countersign'),
  -- Bekah Follow Up
  (30, 'subject_contains', 'obligo', 'move', 'Bekah Follow Up', false, 'Obligo move-out charges'),
  -- Financial
  (40, 'sender_exact', 'americanexpress@welcome.americanexpress.com', 'move', 'Financial', true, 'AmEx confirmations'),
  (40, 'sender_domain', '@swbc.com', 'move_read', 'Financial', true, 'SWBC payroll/HR notices'),
  (40, 'subject_contains', 'payment confirmation', 'move', 'Financial', true, 'Payment confirmations'),
  (40, 'subject_contains', 'wire transfer', 'move', 'Financial', false, 'Wire transfers - review'),
  -- Personal
  (50, 'sender_domain', '@parentSquare.com', 'move', 'Personal', true, 'School notifications'),
  (50, 'subject_contains', 'tippit middle school', 'move', 'Personal', true, 'School notifications'),
  -- Newsletters with an unsubscribe header
  (60, 'header', 'list-unsubscribe', 'move_unsubscribe', 'Unsubscribe Needed', false, 'Newsletter unsubscribe'),
  -- Cold outreach confirmed senders (supplement cold_outreach_senders)
  (70, 'sender_domain', '@rsgsv.net', 'archive_read', null, true, 'Sundek marketing network'),
  (70, 'sender_domain', '@alndata.com', 'archive_read', null, true, 'ALN Data newsletters'),
  (70, 'sender_domain', '@covethrivenow.info', 'archive_read', null, true, 'Brian Boone cold outreach'),
  (70, 'sender_domain', '@thestamina-impact.online', 'archive_read', null, true, 'Camila Rodriguez cold outreach'),
  (70, 'sender_domain', '@multifamilyinvestornation.com', 'archive_read', null, true, 'Cold outreach'),
  (70, 'sender_domain', '@webinarorganizers.com', 'archive_read', null, true, 'Webinar cold outreach'),
  (70, 'sender_domain', '@multifamilyxconsulting.com', 'archive_read', null, true, 'Cold outreach')
) as v(priority, match_type, match_value, action, target_folder, mark_read, notes)
where not exists (
  select 1 from automove_rules r
  where r.match_type = v.match_type and lower(r.match_value) = lower(v.match_value) and r.action = v.action
);

-- Check:
-- select priority, match_type, match_value, action, target_folder, mark_read, active
-- from automove_rules order by priority, match_type;
