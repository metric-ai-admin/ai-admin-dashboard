-- Maintenance board — translate the seeded task text to English
--
-- Lyndsay asked for the dashboard to be entirely in English. The UI already is:
-- a sweep of public/*.{html,js,css} found no Spanish UI copy at all. What she is
-- reading is this data — the 33 tasks bulk-inserted on 2026-08-26. They were
-- supplied as a JSON batch, not typed by Erick, which is why translating them is
-- editing our own seed rather than rewriting someone's working notes.
--
-- IMPORTANT — this is Erick's live board. He works in Spanish. Confirm with him
-- or with Jay before running this.
--
-- Both columns have to move together. note_history is a JSONB array of
-- {text, createdAt} and the UI renders it in three places (the task card's Notes
-- disclosure, the maintenance card, and the EOD summary), so updating notes
-- alone would leave the Spanish on screen. Each of these rows has exactly one
-- history entry whose text matches notes; the guard on jsonb_array_length makes
-- that assumption explicit and skips the row instead of corrupting it if a new
-- note has been added since this was written.
--
-- Names stay as they are: Raúl, Rocío, Josue are people, not copy.
-- Run in the Supabase SQL editor. Re-running is harmless.

-- Before: how much Spanish is in there now
-- select count(*) from operational_tasks
--  where title ~* '(diario|revisar|tareas|horas|vence|sin |con )' or notes ~* '(asignad|pendiente|debe|días)';


update operational_tasks set
  title = 'Daily billing review (Ready to Bill)'
 where id = 'op_1787761851170_3880'
;

update operational_tasks set
  title = 'Daily QC — Work Done queue'
 where id = 'op_1787761850755_8238'
;

update operational_tasks set
  title = 'Follow up Dial One / Sunset Palms meters'
 where id = 'op_1787761850348_7607'
;

update operational_tasks set
  title = 'Daily Activities Report — check for occupancy in AppFolio'
 where id = 'op_1787761849943_543'
;

update operational_tasks set
  title = 'Check Outlook 2-3x a day — Microsoft 365 connected'
 where id = 'op_1787761849536_9270'
;

update operational_tasks set
  title = 'Review hours logged per technician — commitment to Lyndsay'
 where id = 'op_1787761849119_1761'
;

update operational_tasks set
  title = 'Export AppFolio MDaily/MWeekly/MMonthly — upload to Lyndsay''s dashboard'
 where id = 'op_1787761848700_2255'
;

update operational_tasks set
  title = 'Asana — review and clear daily tasks (first thing)'
 where id = 'op_1787761848278_2940'
;

update operational_tasks set
  title = 'HPS 221 Conversations — Gracen Noble + Dominic Manzo'
  , notes = 'Two conversations assigned yesterday, still unreviewed (Rocío and Danny).'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Two conversations assigned yesterday, still unreviewed (Rocío and Danny).'::text))
 where id = 'op_1787761847861_2973'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'WO #22520-1 Sunset Palms 112 / Ismael Bravo — Package'
  , notes = 'Still UNASSIGNED. Assign to Raúl Martínez now.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Still UNASSIGNED. Assign to Raúl Martínez now.'::text))
 where id = 'op_1787761847459_8312'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Ascent 9-219 / Maria Pastrana — Roaches · WO #22490-1'
  , notes = 'Emerson assigned. Coordinate with It''s Bugs R Us.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Emerson assigned. Coordinate with It''s Bugs R Us.'::text))
 where id = 'op_1787761847052_9138'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'HPS-213 / Kamran Ahmed — Rats · WO #22474-1'
  , notes = 'Angel assigned. Coordinate with It''s Bugs R Us.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Angel assigned. Coordinate with It''s Bugs R Us.'::text))
 where id = 'op_1787761846632_9431'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Pending/Review inspections — 82 total'
  , notes = 'Work through in batches of ~5 a day. Jay''s process: check occupancy, cancel if occupied, create WOs only for new issues.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Work through in batches of ~5 a day. Jay''s process: check occupancy, cancel if occupied, create WOs only for new issues.'::text))
 where id = 'op_1787761846201_1277'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'iConic RR Pool Gate — WO #19105-1'
  , notes = 'Parts with Josue since 08/04, still unconfirmed. Re-activate the Code Violation flag in AppFolio.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Parts with Josue since 08/04, still unconfirmed. Re-activate the Code Violation flag in AppFolio.'::text))
 where id = 'op_1787761845789_5539'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Chateau + Highlander — annual fire inspections'
  , notes = 'Impact Fire is not responding. Switch to Johnson Safety (Todd 512-922-9304). Create WOs with the Code Violation flag.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Impact Fire is not responding. Switch to Johnson Safety (Todd 512-922-9304). Create WOs with the Code Violation flag.'::text))
 where id = 'op_1787761845371_4835'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = '73 WOs missing notes/labor'
  , notes = 'Start with the oldest: #22542 Highlander, #22618 Chateau, #22674 iConic RR.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Start with the oldest: #22542 Highlander, #22618 Chateau, #22674 iConic RR.'::text))
 where id = 'op_1787761844972_486'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Missing hours — Angel, Raúl, Josue'
  , notes = 'Command Center flags unlogged hours. Confirm and correct in AppFolio.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Command Center flags unlogged hours. Confirm and correct in AppFolio.'::text))
 where id = 'op_1787761844548_9630'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'After-Hours — WO #23089 HPS / Angel Martinez'
  , notes = 'Check whether the after-hours rate was applied correctly.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Check whether the after-hours rate was applied correctly.'::text))
 where id = 'op_1787761844117_1196'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'WOs in Work Done without QC — 5 cases over 7 days'
 where id = 'op_1787761843689_2182'
;

update operational_tasks set
  title = 'Mia Saavedra (HPS 221) — washer still not repaired'
  , notes = 'Two months without a washer. Check the existing WO and reply to her today.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Two months without a washer. Check the existing WO and reply to her today.'::text))
 where id = 'op_1787761843266_3889'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Ascent 4-120 — broken window'
  , notes = 'Check whether a WO exists, or create one. Emerson / Jose DeSantiago.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Check whether a WO exists, or create one. Emerson / Jose DeSantiago.'::text))
 where id = 'op_1787761842829_8832'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Code Violations Tracker — 14 open WOs'
  , notes = 'WOs #23419, #23423, #23438 (iConic RR, 10-11 days) and #23440 (HPS, 10 days). WO #23553 Ascent is in Work Done and needs QC.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('WOs #23419, #23423, #23438 (iConic RR, 10-11 days) and #23440 (HPS, 10 days). WO #23553 Ascent is in Work Done and needs QC.'::text))
 where id = 'op_1787761842407_9303'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'The Highlander 209 — Unit Turn due 08/28'
  , notes = 'Kane Rocha moved out 08/18. Angel must start ALL categories NOW. Due in 2 days.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Kane Rocha moved out 08/18. Angel must start ALL categories NOW. Due in 2 days.'::text))
 where id = 'op_1787761841988_4351'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'iConic DT 205 — Unit Turn overdue (target was 08/24)'
  , notes = 'Only 3 of 7 categories started. Raúl still to complete: Trash Out, Maintenance/Repair, Paint, Floors, Appliances.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Only 3 of 7 categories started. Raúl still to complete: Trash Out, Maintenance/Repair, Paint, Floors, Appliances.'::text))
 where id = 'op_1787761841573_5731'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'WO #18547-1 Sunset Bldg 2 — stuck in WAITING'
  , notes = 'Marked Work Done on 07/23 with no notes, hours or photos. Cannot be closed or billed until the documentation is complete.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Marked Work Done on 07/23 with no notes, hours or photos. Cannot be closed or billed until the documentation is complete.'::text))
 where id = 'op_1787761841144_7759'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Sunset Palms meters — Dial One Electrical · WO #18978-1'
  , notes = 'Permit #2026-050720 EP is active. No confirmed date from Jessica Barrios. If she does not reply today, escalate to Rebekah for an alternate electrician.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Permit #2026-050720 EP is active. No confirmed date from Jessica Barrios. If she does not reply today, escalate to Rebekah for an alternate electrician.'::text))
 where id = 'op_1787761840723_4073'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'iConic RR — Fire Extinguishers · WO #22051-1 / #22084'
  , notes = '7 extinguishers. Vendor: Johnson Safety / Todd 512-922-9304. Quote pending approval from Rebekah/Kara. Confirm the Fire Dept reinspection date.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('7 extinguishers. Vendor: Johnson Safety / Todd 512-922-9304. Quote pending approval from Rebekah/Kara. Confirm the Fire Dept reinspection date.'::text))
 where id = 'op_1787761840288_4563'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Crystal Mendez (City of Austin) — still no reply'
  , notes = 'Email of 08/25 asking about WOs at Ascent at Northgate Unit 117 (1804 W Rundberg). Reply today.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Email of 08/25 asking about WOs at Ascent at Northgate Unit 117 (1804 W Rundberg). Reply today.'::text))
 where id = 'op_1787761839858_4183'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Lopez LLC — replace on 3 permit cases'
  , notes = 'WO #14986 (Ascent Bldg 5, 332 days) · WO #19639 (Ascent 9-120, 186 days) · WO #19669 (Sunset fence permit, 186 days). Jay/Rebekah to decide on a replacement vendor.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('WO #14986 (Ascent Bldg 5, 332 days) · WO #19639 (Ascent 9-120, 186 days) · WO #19669 (Sunset fence permit, 186 days). Jay/Rebekah to decide on a replacement vendor.'::text))
 where id = 'op_1787761839451_8754'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'WO #22304-1 Sunset Palms — 3 violations from 08/13, not yet assessed'
  , notes = 'Exterior exposed wiring + uncovered condenser + structural bracket with spalling. Raúl was due to assess on 08/18 — no report. Escalate to Jay/Rebekah today.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Exterior exposed wiring + uncovered condenser + structural bracket with spalling. Raúl was due to assess on 08/18 — no report. Escalate to Jay/Rebekah today.'::text))
 where id = 'op_1787761839045_186'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'HPS-106 / Melva Ramos — Sewer Backup · WO #22425-1'
  , notes = 'Sewage in the tub and toilet, broken pipe. Decision on an outside plumber pending with Rebekah/Jay since 08/20.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Sewage in the tub and toilet, broken pipe. Decision on an outside plumber pending with Rebekah/Jay since 08/20.'::text))
 where id = 'op_1787761838599_5331'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Sunset Palms Laundry Room — exposed wires, NO WO'
  , notes = 'Case 2025-105489 CV · Conduit disconnected from the meter box. Create the WO, assign Raúl, set Code Violation = Yes.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('Case 2025-105489 CV · Conduit disconnected from the meter box. Create the WO, assign Raúl, set Code Violation = Yes.'::text))
 where id = 'op_1787761838183_7993'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;

update operational_tasks set
  title = 'Sunset Palms Pool — ACTIVE CLOSURE ORDER'
  , notes = 'WO #20643-1 · Pool closed, permit expired. Verify the permit with Austin Public Health TODAY. Parts (rope + mesh) identified 08/04 with Josue — purchase unconfirmed.'
  , note_history = jsonb_set(note_history, '{0,text}', to_jsonb('WO #20643-1 · Pool closed, permit expired. Verify the permit with Austin Public Health TODAY. Parts (rope + mesh) identified 08/04 with Josue — purchase unconfirmed.'::text))
 where id = 'op_1787761837689_285'
   and jsonb_array_length(coalesce(note_history, '[]'::jsonb)) = 1
;


-- After — should return no rows:
-- select id, title, notes from operational_tasks
--  where title ~* '(diario|revisar|tareas|horas faltantes|vence|expuestos)'
--     or notes  ~* '(asignad|pendiente|debe |días|sin confirmar)';
--
-- Any row this skipped (someone added a note since) — reconcile by hand:
-- select id, title, jsonb_array_length(note_history) as history_len
-- from operational_tasks where jsonb_array_length(coalesce(note_history,'[]'::jsonb)) <> 1;
