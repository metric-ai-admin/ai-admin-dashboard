# Inbox Tracking → Excel sync — occasional partial writes

**Status: KNOWN ISSUE, not yet fixed.** Low priority — the manual "Sync to
Excel" button surfaces exactly which rows failed, so a partial write is now
visible and one re-click fills the gaps.

**Raised:** 2026-08-31, by Arturo — a sync wrote 20 of 22 rows with no error he
could see.

## Symptom

`writeInboxTrackingToExcel()` (server.js) writes each tracked row's unread count
into one cell of the SharePoint "Inbox Tracking" sheet via a Graph
`PATCH …/range(address='…')`. Occasionally a couple of cells are not written —
e.g. 20 of 22 — while the rest succeed.

## What actually happens (read from the code, not assumed)

The write loop already retries, but **only HTTP 502 and 503**, three attempts
with a 600ms × attempt backoff:

```js
if (writeRes.status !== 502 && writeRes.status !== 503) break;   // everything else: no retry
```

Every failed cell IS recorded — the loop pushes `{ rowLabel, email, cell, error }`
into `results`, and the row keeps going (one bad cell never aborts the rest).
So the failures are captured, not silent. The visibility gap is by *path*:

- **Manual button** (`POST /api/email/inbox-tracking/sync-excel`) — the result
  is returned to the browser and the UI now shows `⚠️ N errored` with the
  per-row reason. Visible.
- **8 AM cron** (`writeInboxTrackingToExcel` on a schedule) — the result is only
  `logLine`'d to Render's logs (`[inbox-tracking-excel] wrote column …: <json>`).
  Nobody sees it unless they open Render. This is where "no visible error" came
  from — the reported 20/22 was almost certainly a cron run.

A thrown `fetchFn` (a real network timeout, socket hang-up) is a different case:
it is NOT caught inside the loop, so it would abort the whole function and 500
the endpoint — an all-or-nothing failure, not a 20/22. So the observed partial
writes are **non-OK responses on specific cells that are not 502/503**, not
thrown timeouts.

## Most likely causes for those non-2xx cells

- **423 Locked** — the workbook is open in Excel (desktop/online) by someone at
  the moment of the sync. Graph cannot PATCH a range in a locked session. This
  fits "archivo abierto en SharePoint" exactly, and 423 is not in the retry set.
- **429 Too Many Requests** — writing ~22 cells in quick succession against one
  workbook session can trip Graph throttling. 429 carries a `Retry-After` and is
  also not retried today.
- **504 Gateway Timeout** — a slow Graph/SharePoint round trip. Not retried.

## Future fix (evaluate, not scheduled)

Small, contained change in the write loop:

1. Widen the retry set to `429, 502, 503, 504` (and treat a thrown fetch the
   same as a retryable failure by wrapping the PATCH in try/catch, so a network
   blip retries instead of aborting the run).
2. Honor `Retry-After` on 429 instead of the fixed backoff.
3. Consider a longer backoff for 423 (Locked) — or just let it fail and rely on
   the button re-click, since a locked file will stay locked for the length of a
   sync anyway.
4. Surface the cron's result somewhere a human sees it — the auto_move_state
   pattern (a small state file the dashboard reads) would work, or write the
   last cron sync summary next to the manual one.

None of this is urgent: the manual button already makes a partial write obvious
and trivially recoverable. Left here so the next person changing the sync loop
sees the whole picture before touching the retry logic.
