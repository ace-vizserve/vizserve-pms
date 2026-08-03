-- P4 (fix) — EXECUTE grants for the service role.
--
-- THE GRANTS INCIDENT, AGAIN, in a corner nobody had swept.
--
-- `permission denied for function vizserve_pms_issue_approval_token`
--
-- Same diagnostic as before and the same lesson: that message is a missing
-- GRANT, never a failed policy. What was different this time is where the gap
-- was.
--
-- In Postgres, a newly created function grants EXECUTE to PUBLIC by default.
-- Every function in this codebase has been quietly relying on that for the
-- service role — and `20260729110000_p0_06_grants.sql` set ALTER DEFAULT
-- PRIVILEGES for TABLES and SEQUENCES but not for FUNCTIONS, so nothing else
-- was backing it up.
--
-- Then the Phase 4 migration did the correct, careful thing:
--
--   revoke all on function vizserve_pms_issue_approval_token(...) from public;
--
-- …to make sure `authenticated` could not mint an approval token, which would
-- let a staff member approve their own work as the client. That revoke also
-- removed the implicit grant the SERVICE ROLE was standing on, and issuance is
-- service-role-only by design — so the tightening locked out the one caller it
-- was meant to leave.
--
-- Worth noticing that the security intent was right and the blast radius was
-- the opposite of dangerous: the gate failed closed. Nobody could mint a token,
-- including us.

-- --- the three that broke ---------------------------------------------------
grant execute on function vizserve_pms_issue_approval_token(uuid, vizserve_pms_token_purpose) to service_role;
grant execute on function vizserve_pms_auto_complete_approvals() to service_role;
grant execute on function vizserve_pms_claim_approval_reminders(integer) to service_role;

-- --- the same latent gap, one phase earlier ---------------------------------
-- Revoked from PUBLIC in the same careful way and granted only to anon and
-- authenticated. Nothing calls them as the service role yet, so nothing has
-- failed — but a seed script or a cron job would, and finding it then is more
-- expensive than fixing it now.
grant execute on function vizserve_pms_submit_request(text, jsonb, jsonb, text) to service_role;
grant execute on function vizserve_pms_get_public_form(text) to service_role;
grant execute on function vizserve_pms_get_approval_page(text) to service_role;
grant execute on function vizserve_pms_record_client_decision(text, vizserve_pms_client_decision, text, text, text, text) to service_role;
grant execute on function vizserve_pms_submit_feedback(text, integer, text) to service_role;

-- --- so the next migration does not reintroduce it --------------------------
--
-- The missing half of the original grants fix. With this in place, a future
-- `revoke ... from public` on a new function no longer silently takes the
-- service role down with it.
alter default privileges in schema public
  grant execute on functions to service_role;
