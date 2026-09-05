-- P9-07 — THE TURN-OVER CONFIRMATION BECOMES A DATABASE RULE.
--
-- "(Required)" was true in three places and enforced in two of them:
--
--   the checkbox label ..... says Required. Says. A label is not a rule.
--   the zod schema ......... refuses a hand-over with the box unticked
--   the submit function .... raises 'Confirm the turn-over before submitting.'
--
-- Two real gates, so nobody filing leave through the app has ever got past it.
-- What was missing is the one CLAUDE.md actually asks for:
--
--   "Rules live in the database, not just the UI. Required-fields validation,
--    the resolution gate, field_key immutability and the no-hard-delete guard
--    are all constraints or triggers. The front end will be bypassed."
--
-- A SECURITY DEFINER function is not a constraint. It is the only writer today,
-- and "the only writer today" is exactly the assumption that stops being true —
-- a backfill, an admin script, a second submit path for HR filing on somebody's
-- behalf. Any of those can write a VACATION row with no confirmation and no
-- reliever, and nothing would notice: the request would route to a team leader
-- carrying an attestation nobody made, about a hand-over that does not exist.
--
-- This file makes it a rule.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT.
--
-- A CHECK cannot do either half. Whether the confirmation is required at all
-- depends on `vizserve_pms_leave_types.requires_reliever` — a different table —
-- and "at least one reliever exists" depends on
-- `vizserve_pms_internal_request_relievers`, a third. CHECK expressions must be
-- immutable and single-row; both of those are subqueries.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS DEFERRED, and this is the part that would break if it were not.
--
-- `vizserve_pms_submit_internal_request` inserts the REQUEST first and its
-- reliever rows afterwards — it has to, because the reliever rows carry the
-- request id. A row-level trigger firing at insert time would count zero
-- relievers on a perfectly valid hand-over and refuse every one of them.
--
-- `deferrable initially deferred` moves the check to COMMIT, by which point the
-- whole transaction is visible to it.
--
-- ---------------------------------------------------------------------------
-- ⚠️ INSERT ONLY, AND THAT IS DELIBERATE.
--
-- VACATION requests filed before P9-01 have no confirmation and no relievers,
-- because neither concept existed. They are still sitting in queues. An UPDATE
-- trigger would fire on `vizserve_pms_decide_internal_request` — which updates
-- status, reviewed_by and reviewed_at — and make every one of those legacy rows
-- IMPOSSIBLE TO APPROVE OR REJECT, with an error about a checkbox their author
-- was never shown.
--
-- Same call P7-12 made with `not valid` on the shape constraint, for the same
-- reason: enforce it on everything from here, leave history alone. There is no
-- honest way to backfill an attestation — it is a statement somebody made, and
-- inventing one is worse than not having it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_check_turnover()
returns trigger
language plpgsql
-- SECURITY DEFINER so the count below is not filtered by the relievers policy.
-- A trigger that could only see the rows the CALLER may read would pass for
-- anybody whose own policy hides them, which is the opposite of a guard.
security definer
set search_path = public, extensions
as $$
declare
  v_requires boolean;
  v_relievers integer;
begin
  -- Only leave, and only leave that named a type. A row with no
  -- `leave_type_id` is either not leave or predates P7-12; the shape constraint
  -- has its own opinion about that and it is not this trigger's business.
  if new.request_type <> 'LEAVE' or new.leave_type_id is null then
    return new;
  end if;

  select lt.requires_reliever into v_requires
    from vizserve_pms_leave_types lt
   where lt.id = new.leave_type_id;

  if not coalesce(v_requires, false) then
    return new;
  end if;

  -- The attestation itself.
  if new.turnover_confirmed_at is null then
    raise exception
      'This kind of leave needs the turn-over confirmation before it can be filed.'
      using errcode = 'check_violation';
  end if;

  -- And the thing it attests TO. The sentence is "all major and critical tasks
  -- have been listed above and each has been assigned a corresponding
  -- reliever" — a confirmation with no reliever behind it is a claim about an
  -- empty list, which is worse than no claim at all.
  select count(*) into v_relievers
    from vizserve_pms_internal_request_relievers r
   where r.request_id = new.id;

  if v_relievers = 0 then
    raise exception
      'The turn-over confirmation was given but no reliever was named.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_check_turnover() is
  'P9-07. Backstop for the turn-over confirmation. Nobody filing through the '
  'app reaches it — zod and vizserve_pms_submit_internal_request both refuse '
  'first, with better sentences. This is the rule that survives a second write '
  'path. INSERT only: legacy VACATION rows predate the concept and must stay '
  'decidable.';

drop trigger if exists vizserve_pms_internal_requests_turnover
  on vizserve_pms_internal_requests;

create constraint trigger vizserve_pms_internal_requests_turnover
  after insert on vizserve_pms_internal_requests
  deferrable initially deferred
  for each row execute function vizserve_pms_check_turnover();

-- ---------------------------------------------------------------------------
-- HOW TO PROVE IT WORKS, since the app can no longer reach it.
--
-- As the service role, in the SQL editor — both of these must fail, and the
-- failure arrives at COMMIT rather than at the INSERT:
--
--   begin;
--     insert into vizserve_pms_internal_requests
--       (request_type, requester_id, department_id, reason, start_date,
--        end_date, leave_type_id, approval_stage)
--     select 'LEAVE', u.id, u.primary_department_id, 'probe', '2099-01-04',
--            '2099-01-05', lt.id, 1
--       from vizserve_pms_users u, vizserve_pms_leave_types lt
--      where lt.code = 'VACATION' and u.is_active limit 1;
--   commit;   -- expected: turn-over confirmation ... before it can be filed
--
-- Add `turnover_confirmed_at = now()` and it fails the second way instead —
-- no reliever named. Both are rollbacks; neither leaves a row.
-- ---------------------------------------------------------------------------
