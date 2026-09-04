-- 030_backfill_property_phone.sql
--
-- One-time backfill of properties.property_phone from the leasing-line numbers
-- captured in the original standalone BD CRM tool's baked exports
-- (data/Business Development CRM.html). 38 properties had a number on file.
--
-- NOTES
--   * Matches by property_name. Only fills rows where property_phone is currently
--     empty, so it never clobbers a number an agent has already entered.
--   * (512) 861-5152 recurs by design — it's the shared G&B answering line used
--     by every G&B-managed property.
--   * Properties added after the tool's last export (e.g. the Tambaleo units and
--     Oak Creek) are NOT here — enter those via the Phone Shop tab's
--     "+ Add Phone Number" button.
--
-- Idempotent. Run in the Supabase SQL editor. After the UPDATE, run the two
-- diagnostic SELECTs at the bottom to see what matched and what didn't.

with seed(name, phone) as (
  values
    ('2602 Hume Place', '(512) 861-5152'),
    ('402 Nova Apartments', '(310) 339-2030'),
    ('Alister Apartments', '(512) 442-6789'),
    ('Art at Bratton''s Edge', '(866) 963-5828'),
    ('Avia @ 26th', '(512) 453-8090'),
    ('Avon @ 22nd', '(512) 474-0111'),
    ('Azure', '(512) 419-0550'),
    ('Banister Heights', '(512) 861-5152'),
    ('Campus Edge Apartments', '(512) 861-5152'),
    ('Chimney Park Apartments', '(512) 861-5152'),
    ('City Scene', '(512) 861-5152'),
    ('Crestview Place', '(512) 410-7962'),
    ('Dalewood Townhomes', '(512) 346-9886'),
    ('Del Curto', '(512) 861-5152'),
    ('Eastwood Apartments', '(512) 344-9491'),
    ('Ekos City Heights', '(855) 696-3351'),
    ('Emerson Apartments', '(512) 729-1188'),
    ('Foxfire', '(512) 255-1475'),
    ('Harmon Square Apartments', '(512) 861-5152'),
    ('Hemphill Oaks', '(512) 861-5152'),
    ('La Casita', '(512) 861-5152'),
    ('Libertad Austin at Gardner', '(512) 813-0415'),
    ('Marian Condos', '(512) 472-3816'),
    ('Patton Apartments at Windsor Park', '(512) 298-4327'),
    ('Popolo Village', '(512) 374-0166'),
    ('Rio Heights Condos', '(512) 861-5152'),
    ('River Crossing Townhomes', '(512) 883-1429'),
    ('Riviera Lofts', '(512) 813-5112'),
    ('Sendero Ranch', '(830) 505-7013'),
    ('Stadium View Apartments', '(737) 221-4268'),
    ('Stone Hill Apartments', '(512) 861-5152'),
    ('The Canopy at South Congress', '(512) 861-5152'),
    ('The Colony of San Marcos', '(512) 353-8444'),
    ('The Creek at 52nd', '(512) 861-5152'),
    ('The Nelly', '(844) 483-2057'),
    ('The Summit at the Reserve', '(512) 764-5861'),
    ('The Works at Pleasant Valley', '(512) 284-9369'),
    ('Three Villas', '(512) 374-0166')
)
update properties p
   set property_phone = s.phone
  from seed s
 where p.property_name = s.name
   and (p.property_phone is null or p.property_phone = '');

-- Diagnostic 1 — seed names with NO matching property (resolve these by hand):
-- with seed(name, phone) as ( values
-- ('2602 Hume Place','(512) 861-5152'), ('402 Nova Apartments','(310) 339-2030'), ('Alister Apartments','(512) 442-6789'), ('Art at Bratton''s Edge','(866) 963-5828'), ('Avia @ 26th','(512) 453-8090'), ('Avon @ 22nd','(512) 474-0111'), ('Azure','(512) 419-0550'), ('Banister Heights','(512) 861-5152'), ('Campus Edge Apartments','(512) 861-5152'), ('Chimney Park Apartments','(512) 861-5152'), ('City Scene','(512) 861-5152'), ('Crestview Place','(512) 410-7962'), ('Dalewood Townhomes','(512) 346-9886'), ('Del Curto','(512) 861-5152'), ('Eastwood Apartments','(512) 344-9491'), ('Ekos City Heights','(855) 696-3351'), ('Emerson Apartments','(512) 729-1188'), ('Foxfire','(512) 255-1475'), ('Harmon Square Apartments','(512) 861-5152'), ('Hemphill Oaks','(512) 861-5152'), ('La Casita','(512) 861-5152'), ('Libertad Austin at Gardner','(512) 813-0415'), ('Marian Condos','(512) 472-3816'), ('Patton Apartments at Windsor Park','(512) 298-4327'), ('Popolo Village','(512) 374-0166'), ('Rio Heights Condos','(512) 861-5152'), ('River Crossing Townhomes','(512) 883-1429'), ('Riviera Lofts','(512) 813-5112'), ('Sendero Ranch','(830) 505-7013'), ('Stadium View Apartments','(737) 221-4268'), ('Stone Hill Apartments','(512) 861-5152'), ('The Canopy at South Congress','(512) 861-5152'), ('The Colony of San Marcos','(512) 353-8444'), ('The Creek at 52nd','(512) 861-5152'), ('The Nelly','(844) 483-2057'), ('The Summit at the Reserve','(512) 764-5861'), ('The Works at Pleasant Valley','(512) 284-9369'), ('Three Villas','(512) 374-0166')
-- )
-- select s.name, s.phone from seed s
--   left join properties p on p.property_name = s.name
--  where p.id is null order by s.name;

-- Diagnostic 2 — how many properties now have a phone:
-- select count(*) filter (where property_phone is not null and property_phone <> '') as with_phone,
--        count(*) as total from properties;
