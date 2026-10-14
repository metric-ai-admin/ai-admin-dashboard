-- 096 — the move-out section of Kara's 6 AM email, off until somebody turns it on.
--
-- Arturo, 2026-10-16: the section does not go in the email until Erick has
-- finished cleaning up the inspections. That was agreed on 10/14, and
-- KARA_BRIEF_TO is live, so the next 6 AM send would have carried it.
--
-- THIS MIGRATION IS NOT WHAT TURNS IT OFF. lib/kara-brief.js treats an absent
-- column, an absent row and a null all as FALSE, so the section is already off
-- without running anything. The column exists so it can be turned ON later
-- without a deploy:
--
--   UPDATE brief_thresholds SET move_out_section_enabled = true WHERE property = '*';
--
-- THE DEFAULT IS THE OPPOSITE OF make_ready_caveat's, on purpose. A caveat that
-- fails open is a warning nobody sees. A SECTION that fails open is a page of
-- alerts built on records Erick has just shown us are empty, in the inbox of
-- the person who would act on them.
--
-- Collections and Maintenance are NOT affected. Erick needs the register to do
-- the clean-up; it is the email that waits.

alter table brief_thresholds
  add column if not exists move_out_section_enabled boolean;

comment on column brief_thresholds.move_out_section_enabled is
  'Read from the ''*'' row only. NULL or absent = OFF. Set true to put the move-out section back in the 6 AM email.';

-- Verify:
--   select property, move_out_section_enabled from brief_thresholds;
