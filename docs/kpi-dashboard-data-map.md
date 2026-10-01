# Executive KPI Dashboard — data map and refresh ranges

Reference for Metric, written 2026-10-01 from `kpi_dashboard_17.html` and
`Data Source End of Last Week 09.20.26 to 09.26.26.xlsx`.

Read-only analysis: nothing was built, changed, or refreshed. This describes how
the report works today, not how it should work.

## How the two pieces fit together

The HTML is a self-contained page. You open it, upload the workbook, and it
parses the sheets in the browser with SheetJS. There is no server and no stored
data — **the numbers on screen are only ever as good as the workbook that was
dropped into it.**

It finds each sheet by name first (case-insensitive substring), and falls back
to scanning the report title in rows 1–5 if a tab has been renamed. So renaming
a tab is usually survivable; **deleting one makes its whole section disappear**,
silently in some places.

Parsers read **fixed column positions**, not column names. Adding or removing a
column in an AppFolio saved report shifts everything after it and will produce
wrong numbers rather than an error.

## 1. Sheet-by-sheet map

### Sheets the dashboard reads (17 of 19)

| Sheet | AppFolio report | Feeds | How |
|---|---|---|---|
| `occupancy` | Audit: Occupancy Summary As of Sunday | Occupancy, Occupied, Preleased, Vacant Rented/Unrented, Total Notices | Columns C `# of Units`, D `Occupied`, G `Average Market Rent`, H `Vacant Rented`, I `Vacant Unrented`, J `Notice Rented`, K `Notice Unrented`, summed per property. `Preleased = Occupied + Vacant Rented`; `On Notice = Notice Rented + Notice Unrented`; `% = Occupied / # of Units` |
| `occupancy goals` | *(hand-maintained, not AppFolio)* | Follow-Ups goal | Two columns, Property + Goal %. Drives `units needed = ceil(units × goal) − preleased`, then `leads = units ÷ (0.25 × 0.75 × 0.75)` and `follow-ups = leads × 5` |
| `box score` | Audit: Boxscore Last Week | Move-Ins, Move-Outs, New Notices | Column C `Event` is matched on the text "move-in"/"move in", "move-out"/"move out", "notice". Unit from D, tenant from E, move-out date from J, reason from K, move-in date from L |
| `rent roll` | Data: Rent Roll | Total Notices detail, rent per Vacant Rented unit, lease expirations | Per-unit Status gives the notice list (preferred over box score, which only has *new* notices). Rent matched to apps by unit number |
| `renewals` | KPI Renewal Summary | Renewals, Did Not Renew, upcoming move-outs | Columns A unit, B property, C tenant, D/E lease start/end, F/G previous lease, H previous rent, I rent, L status, M term |
| `apps` | Audit: Rental Applications | New Applications, Approved with Signed Lease, Denied, Canceled, Vacant Rented list | Column A applicant, B property, C received, E source, F status, M app status, J move-in, K lease start, O/P unit. **Vacant Rented = status "Converting"** (approved and moving toward move-in) — *not* "Converted", which means the move-in already happened |
| `guest card interests` | Audit: Guest Card Interests Last Week | Leads, Traffic Sources | Column J property, A name, B email, C phone, G move-in preference, I source |
| `guest card inquiries` | Guest Card Inquiries Last Week | Leads / inquiry funnel | Same shape, inquiry-side |
| `showings` | Audit: Showings Last Week | Tours | Column O property, J status — **only rows whose Status starts with "Completed" count as a tour**. Source from column AI |
| `work order open` | Audit: Work Orders Open | New Work Orders, Work Orders Open (Total) | Status text matched on "cancel", "complet", "wait" to classify |
| `work order closed` | Audit: Work Orders Completed Last Week | Work Orders Closed This Week | Filtered to the leasing-week window taken from `box score` |
| `delinquency` | Data: Delinquency as of last week | DQ Total, DQ by resident, Evictions in Process, Need To File Eviction, eviction stages | Aging buckets `0-30`, `31-60`, `61-90`. A resident counts as evicting when Tenant Status = `Evict` **or** any eviction status is set |
| `tenant custom fields` | Data: Occupancy Custom Fields | Overrides on the delinquency rows | Applied over `delinquency` after parsing |
| `MTD Cash` | Data: MTD Income Cash | MTD Income (Cash Receipts) | One column per property, `Rent Income` / `Net Income` rows |
| `MTD Accrual` | Data: MTD Income Accrual | MTD Expenses, expense by category | Same shape, accrual basis |
| `labor` | Data: Month to Date Labor | Labor hours (fallback) | `sum(Billable Hours)` by work order and date |
| `MTD Labor` | Data: Month to Date Labor | Labor hours (preferred) | **Same saved report as `labor` — identical id `7beceed8-511b-11f0`.** The two tabs are duplicates; the dashboard prefers `MTD Labor` and falls back to `labor` |

### Sheets the dashboard does NOT read (2 of 19)

| Sheet | Why it matters |
|---|---|
| `activities` | **Not referenced anywhere in the HTML.** Nothing on the dashboard comes from it |
| `call transcripts` | Also unreferenced |

Both are in the workbook and neither reaches the report. Worth knowing before
anyone spends time fixing them.

### Where the week label comes from

The "Leasing Week" shown in the header is read from the date-range preamble of
`box score`, falling back to `showings`, then `guest card interests`. The
"as of" date for occupancy and delinquency comes from the `occupancy` preamble.

**So the dates printed on the report are whatever those three sheets say.** If
one of them refreshes to a different window, the header follows it.

## 2. Date range each sheet needs

For a Monday report covering the previous **Sunday–Saturday** week
(e.g. 2026-09-20 to 2026-09-26):

| Sheet | Window it needs | What the 09/20–09/26 workbook actually had |
|---|---|---|
| `guest card interests` | Interest Received 09/20–09/26 | ✅ 09/20/2026 to 09/26/2026 |
| `guest card inquiries` | Date Range 09/20–09/26 | ✅ 09/20/2026 to 09/26/2026 |
| `showings` | Showing Time 09/20–09/26 | ✅ 09/20/2026 to 09/26/2026 |
| `box score` | Occurred 09/20–09/26 | ✅ 09/20/2026 to 09/26/2026 |
| `work order closed` | Last week | ✅ (filtered in the dashboard to the box-score week) |
| `occupancy` | **As of Saturday** 09/26 | ✅ As of: 09/26/2026 |
| `delinquency` | **As of Saturday** 09/26 | ✅ As of: 09/26/2026 |
| `rent roll` | **As of Saturday** 09/26 | ✅ As of: 09/26/2026 |
| `apps` | Rolling ~90 days (conversion needs history) | ✅ 07/04/2026 to 10/01/2026 — by design, not a bug |
| `renewals` | Forward-looking lease window | ✅ Oct 2026 to Apr 2027 |
| `work order open` | Point in time, no range | ✅ no range |
| `tenant custom fields` | Point in time, no range | ✅ no range |
| `call transcripts` | n/a — unused | ✅ no range |
| `MTD Cash` | **MTD of the reporting month** → Sep 2026 | ❌ **Oct 2026 to Oct 2026** |
| `MTD Accrual` | **MTD of the reporting month** → Sep 2026 | ❌ **Oct 2026 to Oct 2026** |
| `labor` | MTD of the reporting month → Sep 2026 | ❌ **10/01/2026 to 10/01/2026** |
| `MTD Labor` | MTD of the reporting month → Sep 2026 | ❌ **10/01/2026 to 10/01/2026** |
| `activities` | n/a — unused | ❌ **07/26/2026 to 08/01/2026**, exported 08/11 |
| `occupancy goals` | n/a — hand-maintained | — no preamble, no export date |

### What the "As of Date" actually controls

The add-in writes **one** As of Date into every saved report's URL as a
*relative-to* anchor. Every sheet in the 09/20–09/26 workbook carries the same
one — `2026-10-01`, the day of the refresh:

| Sheet | Filter in row 5 | Resolved to |
|---|---|---|
| `box score` | `occurred_on_relative_to=2026-10-01` | 09/20–09/26 ✅ |
| `showings` | `showing_date_relative_to=2026-10-01` | 09/20–09/26 ✅ |
| `guest card interests` | `received_on_relative_to=2026-10-01` | 09/20–09/26 ✅ |
| `guest card inquiries` | `received_on_relative_to=2026-10-01` | 09/20–09/26 ✅ |
| `occupancy` | `as_of_to=2026-10-01` | As of 09/26 ✅ |
| `delinquency` | `occurred_on_to=2026-10-01` | As of 09/26 ✅ |
| `rent roll` | `as_of_to=2026-10-01` | As of 09/26 ✅ |
| `work order closed` | `status_date_range_relative_to=2026-10-01` | 09/20–09/26 ✅ |
| `apps` | `received_on_relative_to=2026-10-01` | 07/04–10/01 ✅ |
| `renewals` | `start_on_relative_to=2026-10-01` | Oct 2026–Apr 2027 ✅ |
| `MTD Cash` | `posted_on_relative_to=2026-10-01` | **Oct 2026** ❌ |
| `MTD Accrual` | `posted_on_relative_to=2026-10-01` | **Oct 2026** ❌ |
| `labor` | `labor_performed_relative_to=2026-10-01` | **10/01 only** ❌ |
| `MTD Labor` | `labor_performed_relative_to=2026-10-01` | **10/01 only** ❌ |

So the As of Date is not a display label — **it is the anchor every relative
range is computed from**, and each report applies its own rule to it:

- a **"last week"** report returns the Sun–Sat week *before* the week holding
  the anchor;
- an **"as of Sunday"** report snaps back to the weekend *on or before* it;
- an **"MTD"** report returns the month *containing* it.

**The anchor must therefore be the refresh day, not the reporting Saturday.**
With an anchor of 09/26, "last week" would resolve to 09/13–09/19 and all six
weekly sheets would come back a week early. The ten sheets above that are
correct are correct *because* the anchor was 10/01.

Only the MTD family wants a different anchor, and only when the refresh day
falls in a different month from the reporting week.

## 3. What went wrong this week

### `activities` is frozen at 07/26–08/01

Evidence, from the sheet's own preamble:

```
r1  Data: Activities Summary Last Week
r2  Exported On: 08/11/2026 4:59 PM
r3  Due Date Range: 07/26/2026 to 08/01/2026
r4  Property Groups: All Active, …
r6  count(Activity) | Activity Date | Label | …
```

Compare a sheet that did refresh:

```
r1  Audit: Boxscore Last Week
r2  Exported On: 10/01/2026 9:41 AM
r3  Occurred Range: 09/20/2026 to 09/26/2026
r4  Property Groups: All Active, …
r5  headerSize=5&id=344b8651-11f1-11f1&filters…      ← present
r6  …
```

**`activities` has no row 5.** Every sheet the add-in refreshes carries a row 5
holding `headerSize=5&id=<saved report id>&filters…`; that id is what Refresh
All re-runs. `activities` does not have one, so there is nothing for the add-in
to re-run — it is a **static paste** from 2026-08-11, not a live connection.
Refresh All is not skipping it or failing on it; it is not a connected sheet at
all.

`occupancy goals` is the same kind of sheet, and that one is correct — it is
maintained by hand on purpose.

The export timestamps make the pattern visible:

| Exported On | Sheets |
|---|---|
| *(none)* | occupancy goals |
| **08/11/2026 4:59 PM** | **activities** |
| 10/01/2026 9:40–9:43 AM | the other 17 |

The seventeen live sheets all refreshed within a four-minute window. One sheet
is seven weeks old and one has never been connected.

**This did not affect any number on the dashboard**, because the HTML never
reads `activities`. Worth fixing or deleting so it stops looking like data.

### MTD breaks when the refresh crosses a month boundary

The four MTD sheets ran with an As of Date of **10/01/2026** while the report
covers **09/20–09/26**. Because the As of Date anchors the month:

| Sheet | Range it ran | What that means |
|---|---|---|
| `MTD Cash` | Oct 2026 to Oct 2026 | **one day** of October |
| `MTD Accrual` | Oct 2026 to Oct 2026 | **one day** of October |
| `labor` | 10/01 to 10/01 | one day |
| `MTD Labor` | 10/01 to 10/01 | one day |

The figures themselves are real, but they are the wrong month: cash rent income
of $124,636.31 and accrual rent of $293,696.02 are October 1 — rent due and
charged that morning — not September month-to-date.

The dashboard partly protects itself here. It computes its own labor window as
*the 1st of the month containing the leasing-week end date, through that date*,
so for a 09/26 week it looks for 09/01–09/26 labor. **The 10/01 sheet contains
no rows in that window, so labor hours come out as zero** rather than wrong.
MTD Income and MTD Expenses have no such guard and will show October's numbers
under a September heading.

**The fix is not a different As of Date for the whole workbook.** One anchor
cannot satisfy both families: the weekly reports need the refresh day, the MTD
reports need a day inside the reporting month. Moving the single As of Date back
to 09/26 would fix the four MTD sheets and break the ten that are currently
right.

**So: Refresh All with the refresh day as usual, and when the refresh day's
month differs from the reporting week's month, re-run just `MTD Cash`,
`MTD Accrual`, `labor` and `MTD Labor` with Refresh This Sheet and an As of
Date of the reporting Saturday.** That happens once a month, whenever a
reporting week ends on the last Saturday of a month.

## 4. Things worth knowing before anyone changes the workbook

- **Columns are read by position.** Adding a column to a saved AppFolio report
  shifts every column after it and produces wrong numbers with no error.
- **`labor` and `MTD Labor` are the same report twice.** Refreshing one and not
  the other creates a disagreement the dashboard resolves by preferring
  `MTD Labor`.
- **Tours count only `Status` beginning with "Completed".** Scheduled and
  cancelled showings are not tours.
- **Vacant Rented is apps with status "Converting"**, not "Converted". Changing
  that filter changes the occupancy projection.
- **Deleting a tab removes its section** from the dashboard; some sections
  simply do not render rather than reporting the gap.
