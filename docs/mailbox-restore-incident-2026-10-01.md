# Lyndsay's mailbox — restore incident, 2026-10-01

Record of what happened, what was done, and the one thing that did not work.
Written 2026-10-02.

## What happened

Emptying Deleted Items triggered a restore of ~2,600 messages, and Exchange put
them back in their **original folders** rather than in Deleted Items. The purge
then ran to completion and took the rest — about 78,000 messages — to
Recoverable Items. Deleted Items emptied to zero over roughly an hour.

## What was done

**2,563 messages moved back to Deleted Items.** Identified, verified against
thirteen folder counts Arturo measured in Outlook that morning (2,563 = 2,563,
exact in all thirteen folders), and moved by id. Every folder landed on
`before − moved`, and Deleted Items rose by exactly 2,563.

Scripts, all of which move and none of which delete:

- `scripts/restore-incident-scan.js` — read-only survey
- `scripts/restore-incident-capture.js` — captures the ids
- `scripts/restore-incident-move-by-id.js` — the move
- `scripts/watch-deleted-items.js` — read-only watcher

**The lesson worth keeping: `lastModifiedDateTime` drifts.** The first
selector was "modified inside the 35-minute restore window". Something — almost
certainly the mailbox assistant digesting the purge — kept rewriting that field
all afternoon, so the same query returned 1,651 at 14:34, 565 at 16:10 and 222
at 16:30 while the folders themselves did not change. A Graph message id does
not drift; it changes only when the message moves. **Capture ids, move by id,
never re-run a date query against a mailbox that is still settling.**

The selector that did reconstruct the set exactly:

```
receivedDateTime < today  AND  lastModifiedDateTime >= 2026-10-01T14:05:00Z
```

The lower bound matters. "Modified today" alone over-selected by 17 — those had
been touched at 04:27 and 13:52, ordinary morning activity hours before the
restore began.

## The big folder: a 504 that was not a failure

Arturo restored the ~78,000 from Recoverable Items into a root-level folder,
**"Recovered Deleted Items (Oct 1)"**, 80,333 items. Moving it into Deleted
Items looked like it failed twice:

- **Outlook web** refused it outright — too large.
- **Graph**, one call, `POST /mailFolders/{id}/move` with
  `destinationId: "deleteditems"`:

  ```
  HTTP 504 Gateway Timeout
  {"error":{"code":"UnknownError","message":"","innerError":{
    "date":"2026-10-02T13:49:42",
    "request-id":"76ba73df-1a7d-46b5-a03b-e73e08b7858c",
    "client-request-id":"76ba73df-1a7d-46b5-a03b-e73e08b7858c"}}}
  ```

  **Request id, kept in case Microsoft ever needs it:**
  `76ba73df-1a7d-46b5-a03b-e73e08b7858c`

**It worked anyway.** Checked immediately after the 504, the folder was still
at root with all 80,333 items and Deleted Items had no subfolders — the move
had not started. Checked once more fifteen minutes later, read-only:

```
Recovered Deleted Items (Oct 1)
  totalItemCount : 80,333      unchanged
  at root level  : no
Deleted Items    : 2,591       unchanged, 1 subfolder
  └─ Recovered Deleted Items (Oct 1) — 80,333
```

The folder is a subfolder of Deleted Items, it kept every item, and Deleted
Items' own count did not move because a subfolder counts separately.

**The lesson: a 504 on a bulk Graph operation is not an answer about whether it
happened.** The gateway gave up on a synchronous call over 80,333 items; the
store accepted the work and finished it in the background. Retrying on the 504
would have issued a second move against an operation already in flight, which
is how a folder gets duplicated or split. The right move was to wait and look
once — which is what was done, and nothing had to be retried, batched or
deleted.
