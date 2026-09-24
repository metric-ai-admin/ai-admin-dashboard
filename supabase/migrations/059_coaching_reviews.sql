-- Coaching review — Lyndsay accepting or correcting the grader, in the tool.
--
-- Today she sends these as WhatsApp notes, which means the correction and the
-- call it refers to live in different places and nothing accumulates. This
-- table is the accumulation: every rejected coaching note is a candidate rubric
-- change, with the call and the criterion still attached to it.
--
-- ONE ROW PER (call, criterion). Reviewing the same coaching twice updates the
-- verdict rather than stacking rows — she changes her mind, and the latest
-- judgement is the one that counts. History is not kept on purpose: this feeds
-- a rubric revision, and a half-retracted opinion in the pile makes that
-- harder, not easier.
--
-- Separate from call_grade_flags (migration 058). That flags a WHOLE CALL as
-- misgraded; this is per-criterion and carries the correction. A call can have
-- both — the flag says "look at this", a review says "this specific line is
-- wrong and here is what it should say".
--
-- Run in the Supabase SQL editor. IF NOT EXISTS throughout and safe to re-run.

create table if not exists coaching_reviews (
  id             uuid primary key default gen_random_uuid(),

  -- recording_id, not call_grades.id: regrading a call replaces that row, and a
  -- correction about the grading has to survive the regrade it argues for.
  recording_id   text not null,
  -- The criterion this coaching belongs to. Free text because the model names
  -- its own categories — 519 distinct names across 681 calls at last count —
  -- so there is no enum to point at.
  criterion      text not null,

  verdict        text not null check (verdict in ('accepted', 'needs_revision')),
  -- What it should have said. Required by the route when the verdict is
  -- needs_revision — a rejection with no correction is not a rubric suggestion,
  -- it is a shrug.
  revision_note  text,

  -- What the grader actually said, copied in at review time. The call_grades
  -- row can be replaced by a regrade, and a suggestion that no longer shows
  -- what it was arguing against cannot be acted on months later.
  original_note  text,
  criterion_score integer,

  reviewed_by    text not null,
  reviewed_at    timestamptz not null default now(),

  -- Set when the suggestion has been folded into the rubric. Kept rather than
  -- deleted so "what have we already changed" stays answerable, and so the
  -- pending count means pending rather than merely recent.
  applied        boolean not null default false,
  applied_by     text,
  applied_at     timestamptz,

  updated_at     timestamptz not null default now(),

  unique (recording_id, criterion)
);

create index if not exists coaching_reviews_verdict_idx on coaching_reviews (verdict);
-- The badge counts needs_revision AND NOT applied, so it reads straight off this.
create index if not exists coaching_reviews_pending_idx on coaching_reviews (verdict, applied);
create index if not exists coaching_reviews_recording_idx on coaching_reviews (recording_id);
