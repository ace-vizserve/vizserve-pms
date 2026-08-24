-- ---------------------------------------------------------------------------
-- P7-32 — gender on the staff record.
--
-- Asked for alongside leave balances (Amier, 24 Aug 2026) and landed as its own
-- migration because it has nothing to do with them: one is a demographic fact
-- on a person, the other is entitlement accounting. Bundling them would make
-- the leave-balance reversal harder to read in the history, and that reversal
-- is the one somebody will come looking for.
--
-- AN ENUM, not text, and this is the ordinary case rather than the exception
-- P7-12 argued for. Two values, structural, and nothing about them is policy
-- data that HR edits — unlike leave types, this list does not grow when a
-- statute changes. Text would let "M", "male", "Male " and "Female" all land in
-- the same column and make the first report that groups by it wrong.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

create type vizserve_pms_gender as enum ('MALE', 'FEMALE');

-- ---------------------------------------------------------------------------
-- NULLABLE IN THE DATABASE, REQUIRED IN THE FORM, and the split is deliberate.
--
-- "Required" was the instruction and the admin form enforces it — createUser and
-- updateUser both refuse to save without a value, so no human ever files a
-- staff record without one. What the DATABASE cannot demand is a value on rows
-- no human is filling in:
--
--   1. `vizserve_pms_handle_new_auth_user` inserts (id, email, full_name) the
--      instant an Entra identity first signs in. It has no gender to supply and
--      no way to ask. NOT NULL — or a NOT VALID check, which is still enforced
--      on INSERT — would make that trigger raise, and the visible symptom would
--      be "SSO is broken", three layers away from the cause.
--   2. Every account that already exists has no value, and there is no honest
--      way to backfill one. Guessing from a first name is exactly the kind of
--      inference this app should not be making about its own staff. The same
--      reasoning P7-12 applied to leave types and P7-16 to day halves: NOT VALID
--      leaves history alone, and here even NOT VALID is too strong because of
--      point 1.
--
-- So the column stays open and the requirement lives in `lib/schemas/users.ts`,
-- which is the layer that knows a person is sitting in front of it. Existing
-- rows read "Not set" in the admin list until somebody opens and saves them,
-- at which point the form makes them choose.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column gender vizserve_pms_gender;

comment on column vizserve_pms_users.gender is
  'P7-32. Required by the admin form, nullable here: the auth trigger creates '
  'profile rows with no gender to supply, and pre-existing accounts cannot be '
  'honestly backfilled. NULL means "not recorded yet", never "declined".';

-- No index. This is read as part of a row somebody already has by id, and the
-- staff list is a few dozen rows filtered in the browser — an index on a
-- two-value column over a table that size earns nothing and costs a write.
