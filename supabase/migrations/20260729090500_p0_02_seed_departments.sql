-- P0-02 — Department seed.
--
-- "Departments are real from day one; users are not" (docs/04). These four are
-- production data (D14), so they belong in a migration rather than seed.sql —
-- seed.sql only runs on a local `db reset` and would leave staging and
-- production without them.
--
-- Fixed UUIDs so every environment agrees, and so tests and fixtures can refer
-- to a department without a lookup.
--
-- Team Leaders are NOT set here. A TL is a user with `team_leader` or above
-- plus a row in vizserve_pms_user_managed_departments — there is deliberately
-- no `team_leader_id` column, because Joel leads two departments and Amier is
-- an admin who also leads one.

insert into vizserve_pms_departments (id, name) values
  ('a1000000-0000-4000-8000-000000000001', 'VizBytes'),
  ('a1000000-0000-4000-8000-000000000002', 'VizAssists'),
  ('a1000000-0000-4000-8000-000000000003', 'VizBooks'),
  ('a1000000-0000-4000-8000-000000000004', 'VizMedia')
on conflict (name) do nothing;
