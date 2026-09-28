-- 064_leasing_week_sun_sat.sql
--
-- Leasing weeks move back to Sun–Sat. week_ending becomes the SATURDAY that
-- closes the week instead of the Sunday.
--
-- THIS IS THE THIRD RELABELLING OF THESE WEEKS. They were Mon–Sun, moved to
-- Sun–Sat on a claim that it matched AppFolio's convention, moved back to
-- Mon–Sun by migration 056 on 2026-09-21 once Lyndsay confirmed that claim was
-- wrong, and return to Sun–Sat here by her decision. AppFolio still has no
-- fixed week convention — its leasing reports are arbitrary ranges (Last 30
-- Days, Month-to-date) — so this is a choice about how the leasing team works,
-- not something the data dictates.
--
-- Worth recording, because it will be asked again: leasing is now the only
-- module in this dashboard on a Sunday start. The 6 PM report, End of Day,
-- tasks and call analytics all begin their week on Monday, so a week-over-week
-- comparison between leasing and any of those compares different seven-day
-- windows.
--
-- Run in the Supabase SQL editor. Idempotent; safe to re-run.

-- ── first_contact_date, persisted at last ──────────────────────────────────
--
-- "Traffic = First Contact Date" (Lyndsay, 2026-09-15) decides which week a
-- lead belongs to, but the date itself was never stored — the sync used it to
-- compute week_ending and discarded it. That is why migration 056 needed two
-- cases and could not simply recompute: for the rows where first contact and
-- interest_received fall in different weeks, the information was already gone.
--
-- Storing it means the next boundary change is one UPDATE instead of an
-- archaeology exercise.
alter table leasing_leads add column if not exists first_contact_date date;

create index if not exists leasing_leads_first_contact_idx
  on leasing_leads (first_contact_date);

-- ── week_ending recomputed to the Saturday ─────────────────────────────────
--
-- Derived from first_contact_date where we have it, and from interest_received
-- otherwise — the same precedence the sync applies, so a row recomputed here
-- and a row re-synced tomorrow land in the same week.
--
-- (interest_received at time zone 'America/Chicago')::date is the load-bearing
-- part: interest_received is a timestamptz, and casting it to date directly
-- would use the SERVER's zone. Render runs UTC, so a lead that arrived 7:27pm
-- Central reads as the next day and lands in the wrong week — and on a Saturday
-- evening, in the wrong week entirely.
--
-- The Saturday of a date d is d + (6 - dow) where dow is 0=Sunday..6=Saturday.
-- Postgres's extract(dow) uses exactly that numbering, so a Saturday stays put
-- and Sunday–Friday move forward.
-- Written out longhand rather than through a CTE. A WITH clause inside the SET
-- expression would have to reference the row being updated, and a correlated
-- outer reference inside a CTE is not something to rely on in a migration
-- somebody pastes into a SQL editor once.
update leasing_leads
   set week_ending =
         coalesce(first_contact_date, (interest_received at time zone 'America/Chicago')::date)
         + ((6 - extract(dow from
              coalesce(first_contact_date, (interest_received at time zone 'America/Chicago')::date)
            )::int) % 7)
 where coalesce(first_contact_date, (interest_received at time zone 'America/Chicago')::date) is not null;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Every week_ending should now be a Saturday. This returns 0 rows when correct:
--
--   select week_ending, extract(dow from week_ending) as dow, count(*)
--     from leasing_leads
--    where week_ending is not null and extract(dow from week_ending) <> 6
--    group by 1, 2 order by 1;
--
-- The weeks now present, newest first:
--
--   select week_ending, count(*) from leasing_leads
--    where week_ending is not null group by 1 order by 1 desc limit 8;
--
-- How many rows still have no first_contact_date (they fell back to
-- interest_received, and will fill in as the sync re-runs):
--
--   select count(*) filter (where first_contact_date is null) as no_first_contact,
--          count(*) as total
--     from leasing_leads;
