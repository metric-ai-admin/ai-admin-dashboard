-- 067_email_followups.sql
--
-- Email Follow-Up Tracker. Lyndsay writes "*follow up needed" in the subject of
-- something she sends or forwards; it stays on her EOD every day until someone
-- replies, or until she writes in the same thread WITHOUT the tag.
--
-- Requested by Lyndsay 2026-09-15 — the same day she tagged the only live
-- example, which is still unanswered fourteen days later. That is the feature
-- in one sentence: a thing she asked someone for, and nobody came back.
--
-- WHAT THE MAILBOX ACTUALLY LOOKS LIKE, checked read-only on 2026-09-29 before
-- any of this was designed:
--
--   * Three tagged messages in the whole Sent Items history (18,356 messages).
--     One in 2026, two in 2024. This table will usually hold a handful of rows
--     and often none, and it is sized for that.
--   * The tag is NOT a prefix. The 2026-09-15 subject carries it at character
--     84 of 101, after a "Fw:". Anything keyed on the start of the subject
--     would never have seen it.
--   * She writes it more than one way. The 2024 pair say "**follow up **" —
--     double asterisk, space before the closing pair — which was not in the
--     spec. The matcher allows for that; this column records which form fired
--     so the next surprise shows up in the data instead of in a bug report.
--   * Replies INHERIT the tag in their subject. Sixteen messages in the
--     mailbox match "*follow" and most are replies quoting the subject line.
--     So a tagged message only counts when it is in Sent Items and from her;
--     a tagged message arriving from someone else is the reply that CLOSES a
--     follow-up, not a new one.
--
-- ONE ROW PER CONVERSATION, not per message. Re-tagging a thread means "still
-- waiting, as of now", so it updates sent_at and the day count restarts. Two
-- rows for one thread would put the same item on the EOD twice.
--
-- Read-only against the mailbox: nothing here moves, marks or sends mail.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that writes it.
-- Idempotent and safe to re-run.

create table if not exists email_followups (
  id              uuid primary key default gen_random_uuid(),

  -- Not hardcoded to Lyndsay. The day Jay wants the same thing this is a config
  -- line, not another migration.
  mailbox         text not null,

  -- Exchange's thread key, and the only reliable way to tell that a reply
  -- belongs to the message that was tagged. Its limits are real and worth
  -- writing down: a recipient who answers from a different address, changes the
  -- subject, or picks up the phone will not land in this conversation, and the
  -- follow-up stays open. That is what the "she wrote again without the tag"
  -- rule is for — it is the escape hatch, not an edge case.
  conversation_id text not null,

  -- The tagged message itself, kept for the audit trail rather than for lookup.
  message_id      text not null,
  subject         text not null,

  -- WHICH form of the tag matched, verbatim. "*follow up needed" and
  -- "**follow up **" are both real; recording the match means a new variant is
  -- visible in a query instead of being silently missed.
  tag_matched     text,

  -- When she sent the tagged message. The EOD's "days waiting" counts from
  -- here, and re-tagging moves it forward.
  sent_at         timestamptz not null,

  -- Who she is waiting on. Shown with real names in the EOD, which only goes to
  -- her — deliberately not in the Morning Report, which goes to the High Ops
  -- group chat.
  recipients      text[] not null default '{}',

  -- open | replied | resolved
  --   replied  — someone else answered in the thread
  --   resolved — she wrote in the thread again without the tag
  -- Resolved rows are KEPT. "What did I chase last month, and did it land?" is
  -- a question this can answer only if the answers stay.
  status          text not null default 'open',
  resolved_at     timestamptz,
  resolved_reason text,

  -- Who or what closed it. For a reply this is the sender; it exists so a
  -- follow-up that closed for the wrong reason can be traced back.
  resolved_by     text,

  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),

  constraint email_followups_status_chk
    check (status in ('open', 'replied', 'resolved')),

  -- The one-row-per-conversation rule, enforced rather than assumed.
  constraint email_followups_conv_uniq unique (mailbox, conversation_id)
);

-- "What is still waiting, oldest first?" — the only read the EOD makes.
create index if not exists email_followups_open_idx
  on email_followups (mailbox, status, sent_at);

-- FIRST RUN. The scanner looks back 30 days on its first pass and 14 after
-- that, and it decides which by asking whether this table holds any row for the
-- mailbox at all. That is why resolved rows are never deleted: emptying the
-- table would silently turn the next run back into a 30-day backfill.
--
-- The first run should find the 2026-09-15 message and nothing else.
--
-- Verify, after the first scan:
--
--   select status, count(*) from email_followups group by 1;
--
--   select sent_at::date,
--          date_part('day', now() - sent_at) as days_waiting,
--          tag_matched, subject
--     from email_followups
--    where status = 'open'
--    order by sent_at;
--
-- And the question this exists to answer, once it has some history:
--
--   select status, count(*), round(avg(extract(epoch from resolved_at - sent_at) / 86400), 1) as avg_days
--     from email_followups
--    where resolved_at is not null
--    group by 1;
