# BD CRM — duplicate properties

**Status:** open, needs a dedicated session
**Raised:** 2026-08-25, by Lyndsay (502 properties showing where 251 were expected)
**Do not run a plain `DELETE` on this.** See *Why the obvious fix is unsafe*.

## What is wrong

The `properties` table contains every property twice. This is a double import,
not gradual drift: the duplication is exact.

| Measure | Value |
|---|---|
| Rows in `properties` | ~502 |
| Distinct properties | ~251 |
| Properties visible in the task queue | 244 (the 7 missing have no assignee, so they generate no tasks) |
| Names with more than one `property_id` | **244 of 244** |
| Copies per name | **exactly 2**, never more |
| Duplicate rows to reconcile | 488 |

Because every property is doubled, so is everything derived from it: the task
queue returns **980 tasks** where it should return roughly half, and each
property appears twice in the Task Queue list.

Measured from `GET /api/crm/tasks` on production, 2026-08-25.

## Why the obvious fix is unsafe

The instinctive cleanup:

```sql
-- DO NOT RUN
DELETE FROM properties
WHERE id NOT IN (SELECT MIN(id) FROM properties GROUP BY property_name);
```

fails on three counts:

1. **It errors.** `properties.id` is `UUID` (`001_bd_crm.sql:7`) and Postgres has
   no `min(uuid)` aggregate. The statement aborts with
   `function min(uuid) does not exist`.
2. **It would pick a random survivor.** `gen_random_uuid()` is random, not
   sequential, so "the minimum UUID" bears no relation to oldest or most
   complete. Use `created_at`.
3. **It cascades.** Four child tables are `ON DELETE CASCADE` on
   `properties(id)` — `phone_shops`, `online_shops`, `follow_ups`,
   `outreach_drafts` (`001_bd_crm.sql:73, 94, 113, 135`). Deleting the wrong
   copy destroys its call logs, shops, follow-ups and drafts permanently.
   `appointments` and `inspections` also reference properties but were created
   outside `001_bd_crm.sql`; their delete behaviour is unverified.

## How the activity is distributed

Sampled 15 duplicate pairs (30 property fetches) on 2026-08-25:

| Situation | Pairs | Handling |
|---|---|---|
| Neither copy has activity | 13 / 15 | Mechanical — keep one, delete the other |
| **Both copies have activity** | **2 / 15** | **Needs a merge before anything is deleted** |
| Only one copy has activity | 0 / 15 | — |

The two with split activity:

| Property | Copy A | Copy B |
|---|---|---|
| Cannon South | 8 records (2 phone, 2 online, 2 follow-ups) | 7 records (2 phone, 1 online, 2 follow-ups) |
| River Crossing Townhomes | 2 records | 2 records |

Cannon South in full:

| id | created_at | phone | online | follow-ups |
|---|---|---|---|---|
| `f8eed5ac-6af6-45d0-913a-76cacbaa0cff` | 2026-08-24 16:38 | 2 | 2 | 2 |
| `9a8fdead-d291-48b5-82b6-8cf37442fb4e` | 2026-08-21 20:15 | 2 | 1 | 2 |

So most of the cleanup is trivial, and a minority genuinely needs care. The
sample is 15 of 244 pairs — run the census query below for the real split
before planning the session.

## Plan

### 1. Census — which pairs need a merge

```sql
SELECT p.property_name,
       COUNT(*) FILTER (WHERE act.total > 0) AS copies_with_activity,
       COUNT(*)                              AS copies,
       SUM(act.total)                        AS total_records
FROM properties p
CROSS JOIN LATERAL (
  SELECT (SELECT COUNT(*) FROM phone_shops     s WHERE s.property_id = p.id)
       + (SELECT COUNT(*) FROM online_shops    o WHERE o.property_id = p.id)
       + (SELECT COUNT(*) FROM follow_ups      f WHERE f.property_id = p.id)
       + (SELECT COUNT(*) FROM outreach_drafts d WHERE d.property_id = p.id)
       AS total
) act
GROUP BY p.property_name
HAVING COUNT(*) > 1
ORDER BY copies_with_activity DESC, total_records DESC;
```

Rows with `copies_with_activity >= 2` are the merge set. Everything else is
mechanical.

### 2. Back up first — non-negotiable

```sql
CREATE TABLE properties_backup_20260825    AS SELECT * FROM properties;
CREATE TABLE phone_shops_backup_20260825   AS SELECT * FROM phone_shops;
CREATE TABLE online_shops_backup_20260825  AS SELECT * FROM online_shops;
CREATE TABLE follow_ups_backup_20260825    AS SELECT * FROM follow_ups;
CREATE TABLE outreach_drafts_backup_20260825 AS SELECT * FROM outreach_drafts;
```

### 3. Merge the split pairs

Repoint child rows from the doomed copy onto the survivor, then the delete has
nothing left to cascade. Survivor = **most recent** `created_at`, per Arturo's
call, since the newer import carries the fresher field data.

```sql
-- Per pair. :keep = survivor id, :drop = the other.
UPDATE phone_shops     SET property_id = :keep WHERE property_id = :drop;
UPDATE online_shops    SET property_id = :keep WHERE property_id = :drop;
UPDATE follow_ups      SET property_id = :keep WHERE property_id = :drop;
UPDATE outreach_drafts SET property_id = :keep WHERE property_id = :drop;
UPDATE appointments    SET property_id = :keep WHERE property_id = :drop;
UPDATE inspections     SET property_id = :keep WHERE property_id = :drop;
```

Watch for duplicated activity: if the same call was logged against both copies,
merging produces two identical `phone_shops` rows. Check `shop_date` +
`agent_name` + `notes` for exact matches after merging and drop the copies.
Cannon South already looks like this — both copies show two calls on
2026-07-05 by Lyndsay.

Also reconcile the property fields themselves before deleting: the surviving row
should keep any `assigned_to`, `rop_status`, `lead_score_override`,
`lyndsay_reviewed` or `notes` that only the other copy has.

### 4. Delete, guarded

```sql
BEGIN;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY property_name ORDER BY created_at DESC, id) AS rn
  FROM properties
)
DELETE FROM properties WHERE id IN (
  SELECT r.id FROM ranked r
  WHERE r.rn > 1
    AND NOT EXISTS (SELECT 1 FROM phone_shops     s WHERE s.property_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM online_shops    o WHERE o.property_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM follow_ups      f WHERE f.property_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM outreach_drafts d WHERE d.property_id = r.id)
);

SELECT COUNT(*) AS remaining FROM properties;   -- expect ~251
-- COMMIT;  only if the number is right, otherwise ROLLBACK;
```

The `NOT EXISTS` guards mean this **cannot** destroy activity: any copy still
holding records survives the statement and shows up as a leftover, which is the
signal that step 3 was not finished for that pair.

### 5. Prevent a recurrence

The table has no uniqueness constraint on the property name, which is what let
the import run twice. Adding one needs a decision first: can two genuinely
different properties share a name across submarkets? If not:

```sql
CREATE UNIQUE INDEX properties_name_unique ON properties (lower(property_name));
```

If they can, the key should be name + address or name + submarket.

## Verification once done

- `SELECT COUNT(*) FROM properties;` → ~251
- `GET /api/crm/tasks` returns roughly 490 tasks, not 980
- Task Queue shows each property once
- Cannon South opens with all its calls on one record
