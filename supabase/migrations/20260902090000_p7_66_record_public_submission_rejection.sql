-- ---------------------------------------------------------------------------
-- P7-66 — THE RATE LIMITER MUST SEE THE ATTEMPTS THE SERVER ACTION REFUSES.
--
-- ⚠️ UNAPPLIED. Nothing in this file has been run anywhere — no local Postgres
-- was stood up (Docker's daemon is down; the only installed server belongs to
-- another application), so this has never been parsed by Postgres. It is written
-- to be applied BY HAND in the Supabase SQL editor, as one transaction, like
-- every other P7 migration. The application is the test.
--
-- ⚠️ THIS CLOSES A SECURITY REGRESSION INTRODUCED THIS PHASE, on four live
-- published forms with real client traffic. It is not new capability.
--
-- P1-15 caps public submissions at ten per IP and five per email per hour, and
-- it does it by COUNTING ROWS in `vizserve_pms_public_submission_log` with no
-- `accepted` filter. `vizserve_pms_submit_request` (20260729100200) is the only
-- writer of that table, and it logs a refusal as carefully as an acceptance —
-- which is what makes the cap bite. A bot posting rubbish is refused rubbish ten
-- times and then refused outright.
--
-- P7-66 put a server-side validation gate in FRONT of that function
-- (app/request/[slug]/actions.ts). Everything it rejects returns before the RPC
-- is reached, so those attempts stopped being logged and stopped counting: a bot
-- posting valid core fields with an empty `field_values` against a form with one
-- required field could loop from one IP for ever without either cap tripping.
-- The gate added to make the endpoint stricter made it unbounded.
--
-- WHY A SECOND FUNCTION RATHER THAN JUST CALLING THE RPC ANYWAY. Because the two
-- validation layers are deliberately not identical, and the RPC's own loop says
-- so in its comments ("not exhaustive validation"). It reads
-- `vizserve_pms_form_fields`, which since P7-66 is a PROJECTION of
-- `vizserve_pms_forms.schema` rather than the schema itself. Anywhere the two
-- disagree — a stricter entity validator, a row that has not been projected, and
-- today on all four live forms every row, because there are none — the RPC
-- ACCEPTS what the action rejected: mints a reference number, inserts a request,
-- notifies a team leader and emails the client. A call made purely for its
-- logging side effect is not a side effect when it can commit a job.
--
-- WHY NOT COUNT IN TYPESCRIPT INSTEAD. The count and the insert have to be one
-- decision — check, then write, from a server action is two round trips with a
-- race between them — and the rule belongs where its twin already lives
-- (CLAUDE.md: rules live in the database). The tunables are not duplicated at
-- all: this reads the same `vizserve_pms_public_submission_limits` singleton.
--
-- Re-runnable: `create or replace`, and the grants are idempotent.
--
-- Back-out: `drop function vizserve_pms_record_public_submission_rejection(text,
-- text, text);` — the action's `readRejectionRecord` fails open on the resulting
-- error, so the endpoint returns to exactly the behaviour it has today.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_record_public_submission_rejection(
  p_slug  text,
  p_ip    text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form_id      uuid;
  v_limits       vizserve_pms_public_submission_limits;
  v_email        text := btrim(coalesce(p_email, ''));
  v_recent_ip    integer;
  v_recent_email integer;
begin
  -- The same `where` clause the two public functions use, so a form that is
  -- closed here is closed there. NULL is fine and is not an error: the log
  -- column is `references … on delete set null`, and an attempt against a slug
  -- that resolves to nothing still counts against the sender.
  select f.id into v_form_id
    from vizserve_pms_forms f
   where f.slug = p_slug and f.is_public and f.is_active;

  select * into v_limits from vizserve_pms_public_submission_limits where id;

  -- ⚠️ COUNTED BEFORE THE INSERT, so this attempt does not count itself. Same
  -- order, same window and same guards as the rate-limiting block in
  -- `vizserve_pms_submit_request`; the two must stay in step, and this is the
  -- second of the two places to change if the window ever moves.
  select count(*) into v_recent_ip
    from vizserve_pms_public_submission_log
   where ip = p_ip
     and p_ip is not null
     and created_at > now() - interval '1 hour';

  select count(*) into v_recent_email
    from vizserve_pms_public_submission_log
   where email = v_email
     and v_email <> ''
     and created_at > now() - interval '1 hour';

  -- `accepted = false`: this row exists BECAUSE the submission was refused.
  -- Identical to the two refusal paths in `vizserve_pms_submit_request`, which
  -- is what makes the row indistinguishable to the counter — the whole point.
  insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
  values (v_form_id, p_ip, nullif(v_email, ''), false);

  -- `coalesce` on the limits: the row is a seeded singleton and cannot be
  -- missing, but a NULL here would return `{"throttled": null}`, which the
  -- caller parses as unreadable and fails open on. The defaults repeated are the
  -- column defaults from 20260729100200.
  return jsonb_build_object(
    'throttled',
    v_recent_ip >= coalesce(v_limits.per_ip_per_hour, 10)
      or v_recent_email >= coalesce(v_limits.per_email_per_hour, 5)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ⚠️ NOT GRANTED TO `anon`, AND THAT IS THE SECURITY DECISION IN THIS FILE.
--
-- `vizserve_pms_submit_request` is granted to `anon` because a browser has to be
-- able to reach it. This one must not be: it writes a row keyed by IP and email
-- and returns nothing a client needs, so execute on it is a gift-wrapped denial
-- of service — call it five times with a competitor's address and that client
-- cannot submit to any live form for an hour.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, which includes `anon`, so
-- the implicit grant is revoked and the one role that needs it is named. The
-- service role is granted EXPLICITLY: revoking from PUBLIC also removes the
-- implicit grant it was standing on, which is exactly what took
-- `vizserve_pms_issue_approval_token` down in Phase 4.
--
-- `authenticated` is not granted either. The only caller is the public submit
-- action, which uses the service-role client because the endpoint has no
-- session to scope by.
-- ---------------------------------------------------------------------------
revoke all on function vizserve_pms_record_public_submission_rejection(text, text, text) from public;
grant execute on function vizserve_pms_record_public_submission_rejection(text, text, text) to service_role;
