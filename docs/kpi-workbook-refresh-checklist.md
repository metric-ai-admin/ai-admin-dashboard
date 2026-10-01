# Weekly KPI workbook refresh — checklist

For Katie, every Monday. The workbook feeds Lyndsay's Executive KPI Dashboard,
and the dashboard shows whatever the workbook says — there is no second check
downstream.

## The As of Date is the whole thing

Everything in the workbook is calculated **relative to the As of Date**, not to
a date typed into each report. "Last week" means the week before it. "As of
Sunday" means the weekend on or before it. "Month to date" means the month
*containing* it.

**Use the day you are refreshing — the Monday. Not the Saturday.**

The weekly reports are built to look backwards from the refresh day. Refreshing
on Monday 09/28 with As of = 09/28 gives "last week" = **09/20–09/26**, which is
what you want. Setting it to the Saturday 09/26 instead would make "last week"
mean **09/13–09/19** and every weekly tab would come back one week early.

**The one exception is the four MTD tabs**, and only when the Monday falls in a
different month from the reporting week — step 6.

---

## The 10 steps

1. **Open the workbook** and note the week you are reporting on: last
   Sunday-to-Saturday. Write down its Saturday — you only need it for the
   checks in steps 7 to 9, not for the refresh itself.

2. **Set the As of Date in the add-in to today** — the Monday you are
   refreshing on. The weekly reports work backwards from it on their own.

3. **Run Refresh All Sheets** and let it finish. It takes a few minutes; the
   sheets refresh one after another.

4. **Check the "Exported On" date on every tab** (row 2 of each sheet). All of
   them should show today, within a few minutes of each other. Last week's
   refresh ran 9:40–9:43 AM across seventeen tabs.

5. **Any tab whose Exported On is not today did not refresh.** Two tabs are
   expected to have no date and are fine: `occupancy goals` (you maintain it by
   hand) and `activities` (not a connected sheet — it is a static paste and the
   dashboard does not use it).

6. **Is today's month the same as the reporting week's month?** If yes, skip to
   step 8 — nothing more to do. If no (the week is in September and you are
   refreshing in October), do step 7.

7. **Refresh the four MTD tabs on their own**, with a different As of Date:
   set the As of Date to **the Saturday that closes the reporting week**, then
   use **Refresh This Sheet** on `MTD Cash`, `MTD Accrual`, `labor` and
   `MTD Labor` — one at a time, not Refresh All. Then check row 3 of each: it
   must name the reporting week's month. Set the As of Date back to today
   afterwards so the next Refresh All is not left pointing at an old date.

8. **Spot-check the three week tabs** — `box score`, `showings`,
   `guest card interests`. Row 3 of each should show your Sunday-to-Saturday
   dates. The dashboard takes the week it prints in its header from these.

9. **Check the three "as of" tabs** — `occupancy`, `delinquency`, `rent roll`.
   Row 3 should read `As of: <your Saturday>`.

10. **Save the file with the week in the name** (for example
    `Data Source End of Last Week 09.20.26 to 09.26.26.xlsx`) and send it on.

---

## Two tabs that are expected to look odd

| Tab | What you will see | Is it a problem? |
|---|---|---|
| `occupancy goals` | No Exported On, no date range | No — you keep this one by hand |
| `activities` | Exported On stuck in the past | No — it is not connected to AppFolio and the dashboard does not read it |

Everything else should carry today's Exported On after a good refresh.

## If something looks wrong

Send the workbook anyway and say what you saw. A wrong number that somebody
knows about is much easier to deal with than one that nobody mentioned.
