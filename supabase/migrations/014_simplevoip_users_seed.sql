-- SimpleVOIP roster — the 5 users we can confirm today
--
-- These came out of Rebekah's own call records: when a call rings a group,
-- each cdr_analysis row lists the other people it rang in
-- answered_elsewhere_user_ids / _names. So every id below appeared incidentally
-- in a call Rebekah was part of — not from crawling anyone's history.
--
-- The other 7 of the 12 SmartPBX users are deliberately NOT here. Reaching them
-- meant querying each user's full call log in turn, which is exactly the
-- cross-user access still pending Lyndsay's decision (2026-08-31) on who may
-- read whose calls. They get added by hand once someone with SmartPBX admin
-- reads them from the portal.
--
-- Names are stored exactly as SimpleVOIP returns them ("… Metric" and all),
-- because that string is the authority the portal shows — not our preferred
-- spelling. role is left null: the admin gate in resolveVoipUser reads the
-- dashboard session (req.svUser), never this column.
--
-- Run in the Supabase SQL editor. ON CONFLICT makes it safe to re-run and safe
-- to run before or after the manual 7 are added.

insert into simplevoip_users (name, user_id, role) values
  ('Rebekah Tuckner', '411fb7f8aa67284fb921c65d2560ed1f', null),
  ('Danny Metric',    '55d5c9d49e6c4d8a7dadfd6076ae094c', null),
  ('Daria Rodriguez', 'b0ea505cbf9f4aa946fa8edbf6322cf1', null),
  ('Oscar Metric',    '8cba8e7a25e4f0b2cca836615ad12f36', null),
  ('Rocio Metric',    '5648599c1528f9bf4c4ce156b2340466', null)
on conflict (user_id) do nothing;

-- Check — should be 5 rows until the manual 7 are added:
-- select name, user_id, role, active from simplevoip_users order by name;
