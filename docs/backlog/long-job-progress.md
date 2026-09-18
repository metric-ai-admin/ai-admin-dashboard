# Real-time progress for long-running jobs

**Status: NOT BUILT.** Feature request, filed for a later session — deliberately
not started on 2026-09-18 so it would not interleave with the rubric v2.0
re-grade that was running at the time.

**Raised:** 2026-09-18, by Arturo, during the v2.0 re-grade. Grade All Calls ran
for 8–15 minutes behind a greyed-out button with no indication it was alive.

## The problem

Several jobs run long enough that the UI stops being believable, and none of
them report anything until they finish:

| Job | Endpoint | Typical duration | What the user sees now |
|---|---|---|---|
| Grade All Calls | `POST /api/sv/grade/backfill` | 8–15 min for 221 calls | greyed button, nothing else |
| AppFolio Reports Sync (all) | `POST /api/appfolio/reports/sync-all` | 30–60 s | already fire-and-poll; the one good example |
| Teams transcript capture | `POST /api/capture-transcripts` | 1–3 min | blocks until done |
| Email auto-move / Lyndsay message rules | `POST /api/email/lyndsay/message-rules` | seconds to a minute | blocks until done |

Everything except Reports Sync is a synchronous request. Three consequences:

1. **No feedback.** The operator cannot tell a working job from a hung one.
2. **Gateway timeouts.** Render cuts a long request; the work continues
   server-side but the browser reports failure. Grade All is idempotent so a
   re-click is safe, but nothing on screen says so.
3. **Progress is only visible in Render logs.** Every one of these jobs already
   `console.log`s per item — the information exists, it just never reaches the
   person who started it. This is the actual debugging complaint.

## Requested design

**Server.** Emit progress per job, either Server-Sent Events or a small Supabase
table polled by the client:

    job_id, job_type, total, completed, failed, status, started_at, updated_at, result

**Dashboard.** One progress component any tab can mount:

- `Grading calls… 47 / 221 (21%)` with a live bar
- estimated time remaining
- per-item errors surfaced as they happen, not only at the end
- terminal line, e.g. `Done — 219 graded, 2 not scoreable`

**Apply to, in order:** Grade All Calls (worst today), Reports Sync, Teams
transcript capture, email rules apply.

## Notes for whoever picks this up

**`runSyncAll` in metric-routes.js already does the fire-and-poll version.** It
returns `202` immediately with a `jobSnapshot()`, and
`GET /api/appfolio/reports/sync-all/status` is polled by reports-sync.js. Read
that first — the pattern is established, in-process and in-memory, and the
comment there explains why it was done that way (eight reports paced by a
7-req/15s limiter risks a gateway timeout behind Render's proxy). Generalising
it is likely less work than introducing SSE.

**In-memory job state does not survive a deploy or a restart.** Render restarts
on every deploy, so a job tracked only in memory shows as running forever, or
vanishes. The Supabase table in the request handles this and is the reason to
prefer it over SSE alone — a page reloaded mid-job can still find the job.

**SSE behind Render's proxy needs checking before committing to it.** Buffering
and idle-timeout behaviour on the starter plan is unverified; polling a table
every few seconds is duller and known to work.

**The per-item logging already exists.** `autoGradeDay` logs each graded call,
`ensureLyndsayMessageRules` logs per-rule outcomes, `captureMeetingTranscripts`
logs per meeting. This work is mostly about routing what those already produce
to the browser rather than instrumenting from scratch.

**Grade All currently requests `days=90` from the client** (public/app.js,
`svgBackfill`) regardless of what needs grading, and the server walks 90 dates
skipping already-graded calls. A progress bar should count what will ACTUALLY be
graded, not 90 days of dates, or it will sit at 0% through dozens of no-op days.
`/api/calls/grade-progress` already computes the true eligible-and-ungraded
figure and is the right source for the denominator.

**Auth:** these endpoints are admin-only as of 2026-09-18, so any polling route
added alongside them needs the same `requireAuth, requireRole('admin')` gate.
