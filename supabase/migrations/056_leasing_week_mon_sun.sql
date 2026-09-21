-- 056_leasing_week_mon_sun.sql
--
-- Leasing weeks move from Sun–Sat to Mon–Sun. week_ending becomes the SUNDAY
-- that closes the week instead of the Saturday.
--
-- Why: the Goal Board carried a comment asserting Sun–Sat matched "AppFolio's
-- own reporting convention". Checked with Lyndsay on 2026-09-21 — AppFolio has
-- NO fixed week convention; its leasing reports are arbitrary ranges (Last 30
-- Days, Month-to-date). The team works Mon–Sun. Sun–Sat also made leasing the
-- only module out of step with this dashboard: the 6 PM report, End of Day,
-- tasks and call analytics all start their week on Monday.
--
-- This is the second relabelling of these weeks. They were originally Mon–Sun,
-- were moved to Sun–Sat on the mistaken AppFolio assumption, and return here.
--
-- TWO CASES, because week_ending is not always derived from interest_received.
-- The sync prefers FIRST CONTACT DATE ("Traffic = First Contact Date", Lyndsay
-- 2026-09-15) and only falls back to interest_received. first_contact_date is
-- NOT persisted, so rows cannot simply be recomputed without discarding that
-- rule for the rows it applied to:
--
--   interest-derived (556 rows) — stored week_ending equals the old Saturday of
--       the Central interest date. Recomputed properly to the new Sunday.
--   first-contact-derived (23 rows) — it does not. These keep the week they were
--       deliberately assigned and only move their closing day, week_ending + 1.
--       That is exact unless the first contact itself fell on a Sunday, which
--       would need a 6-day correction; roughly 3 rows, and unknowable without
--       the source date. Persisting first_contact_date would remove the guess.
--
-- Net effect measured before running: 550 rows shift +1 day (a label change —
-- same week, new closing day) and 29 shift -6 days (leads that landed on a
-- Sunday, which under Mon–Sun belong to the week that Sunday CLOSES rather than
-- the one it opened). Every resulting week_ending is a Sunday.
--
-- Idempotent: re-running matches nothing, because after the first run no row's
-- week_ending equals the old Saturday expression and none is a Saturday to
-- increment. Verify with the check at the bottom before re-running anyway.

update leasing_leads l
set week_ending = case
    -- interest-derived: stored value is the OLD Saturday of the Central day
    when l.week_ending = (ct.d + (6 - extract(dow from ct.d)::int))
      then ct.d + ((7 - extract(dow from ct.d)::int) % 7)
    -- first-contact-derived: keep the assigned week, move the closing day
    else l.week_ending + 1
  end
from (
  select id, (interest_received at time zone 'America/Chicago')::date as d
  from leasing_leads
  where interest_received is not null
) ct
where ct.id = l.id
  and l.week_ending is not null
  and extract(dow from l.week_ending) = 6;   -- only rows still on a Saturday

-- Check — every row must now close on a Sunday (dow 0), and no Saturdays left:
--   select extract(dow from week_ending) as dow, count(*)
--   from leasing_leads group by 1 order by 1;
--   -- expect a single row: dow 0
--
--   select week_ending, count(*) from leasing_leads
--   group by 1 order by 1;
--   -- expect 15 weeks, 2026-06-21 .. 2026-09-27, all Sundays
