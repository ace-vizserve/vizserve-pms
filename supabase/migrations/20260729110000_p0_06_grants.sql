-- P0-06 (fix) — table privileges.
--
-- RLS and GRANTs are two different gates and both must pass. The earlier policy
-- migration revoked from `anon` and assumed Supabase's default privileges would
-- cover `authenticated` and `service_role`. They did not apply, so every table
-- was reachable by nobody:
--
--   ERROR: permission denied for table vizserve_pms_users
--
-- That error is a missing GRANT, never a failed policy — a policy that denies
-- returns zero rows, which is exactly the distinction the P0-12 scope tests
-- assert on. Worth remembering the next time a query returns "denied" rather
-- than empty.
--
-- The model below is the standard Supabase one:
--   * service_role — full privileges, bypasses RLS (seeding, cron, the public
--     submission path). Its power comes from the key never reaching a browser.
--   * authenticated — full DML, with RLS deciding which rows. Broad grants are
--     safe here ONLY because every table has RLS enabled and a restrictive
--     policy set.
--   * anon — nothing at all. The public form and the Phase 4 approval page
--     reach the database exclusively through SECURITY DEFINER functions.

grant usage on schema public to anon, authenticated, service_role;

-- --- service_role -----------------------------------------------------------
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- --- authenticated ----------------------------------------------------------
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- --- anon: nothing ----------------------------------------------------------
-- Runs last so it undoes anything the blanket grants above handed out.
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;

-- The two functions the public surface genuinely needs. Both are
-- SECURITY DEFINER and validate everything themselves.
grant execute on function vizserve_pms_submit_request(text, jsonb, jsonb, text) to anon;
grant execute on function vizserve_pms_get_public_form(text) to anon;

-- --- future objects ---------------------------------------------------------
-- So the next migration does not reintroduce this bug.
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
