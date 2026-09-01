-- Accounting / Billing module — Claudia Villalobos (Accounting/QC)
--
-- Vendor registry, bill tracking, and QC/payment tasks. First build: three
-- flat tables, no roll-ups. All access is requireAuth (Arturo + Claudia); no
-- role gate yet.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS / ON
-- CONFLICT and safe to re-run; the editor does not honour BEGIN/COMMIT.

-- ── Vendors ────────────────────────────────────────────────────────────────
create table if not exists accounting_vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  type       text,                          -- 'vendor' | 'contractor' | 'utility'
  email      text,
  phone      text,
  w9_status  text not null default 'missing',-- 'missing' | 'on_file' | 'outdated'
  w9_year    integer,
  notes      text,
  created_at timestamptz not null default now()
);

-- Names are how the seed dedupes and how a human reads the registry, so the
-- same vendor cannot be entered twice under the same casing.
create unique index if not exists accounting_vendors_name_key
  on accounting_vendors (lower(btrim(name)));

-- ── Bills ──────────────────────────────────────────────────────────────────
create table if not exists accounting_bills (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid references accounting_vendors(id) on delete set null,
  property       text,
  work_order_ref text,                        -- AppFolio WO number
  amount         numeric,
  status         text not null default 'pending', -- 'pending'|'approved'|'paid'|'disputed'
  due_date       date,
  paid_date      date,
  notes          text,
  created_at     timestamptz not null default now()
);
create index if not exists accounting_bills_status_idx  on accounting_bills (status);
create index if not exists accounting_bills_vendor_idx  on accounting_bills (vendor_id);

-- ── Tasks ──────────────────────────────────────────────────────────────────
create table if not exists accounting_tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  type        text,                          -- 'qc_review'|'vendor_payment'|'utility_billing'|'w9_followup'|'other'
  status      text not null default 'open',  -- 'open'|'in_progress'|'done'
  assigned_to text not null default 'Claudia',
  priority    text not null default 'normal',-- 'urgent'|'normal'|'low'
  due_date    date,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists accounting_tasks_status_idx on accounting_tasks (status);

-- ── Seed: known vendors ────────────────────────────────────────────────────
-- iConic Downtown: W9 from 2024 in AppFolio, needs update (per Erick 08/27).
insert into accounting_vendors (name, type, w9_status, w9_year, notes) values
  ('iConic Downtown', 'vendor', 'outdated', 2024, 'W9 from 2024 in AppFolio — needs update per Erick 08/27')
on conflict (lower(btrim(name))) do nothing;

-- Check:
-- select name, w9_status, w9_year from accounting_vendors order by name;
-- select status, count(*) from accounting_bills group by status;
-- select status, count(*) from accounting_tasks group by status;
