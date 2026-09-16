-- 050_meeting_summaries_attendees_source.sql
--
-- Teams meeting summaries: record where the participant list came from so the EOD
-- report can label it honestly — 'transcript' (confirmed speakers, from the VTT)
-- or 'calendar' (invitees, when the transcript carried no speaker data).
--
-- Idempotent. Run in the Supabase SQL editor.

alter table meeting_summaries add column if not exists attendees_source text;
