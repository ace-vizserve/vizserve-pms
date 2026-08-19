-- ---------------------------------------------------------------------------
-- P7-23 — an approved request lands in a list, and there are no spare copies of
-- the function that decides so.
--
-- TWO THINGS, and the second is why the first is worth a migration rather than
-- a screen change.
--
-- ===========================================================================
-- 1. THREE OVERLOADS OF `vizserve_pms_approve_request` ARE LIVE RIGHT NOW.
-- ===========================================================================
--
-- `create or replace function` replaces a function with THE SAME SIGNATURE. Add
-- a parameter and it creates a second function beside the first. That has
-- happened twice:
--
--   20260803110000 (P2-07)  (uuid, uuid, uuid, date, text, text)
--                           — no list. Granted.
--   20260803120000 (P1-10)  same six. Granted again.
--   20260804140000 (P2-06)  + p_list_id  — seven. Granted.
--   20260818140000 (P7-11)  + p_priority — eight. NEVER GRANTED.
--
-- So the database holds a six-argument version that knows nothing about lists,
-- a seven-argument one that does, and an eight-argument one that nobody can
-- execute. PostgREST resolves by ARGUMENT NAME, so which one runs depends on
-- exactly which keys the client happened to send — and the six-argument version
-- files every approved request with `list_id` left to the form default with no
-- way for the reviewer to override it.
--
-- P7-16 hit this same trap on `vizserve_pms_submit_internal_request` and
-- recorded the fix: DROP the old signatures explicitly, and re-grant, because
-- DROP takes the grant with it. This does that for all three.
--
-- ===========================================================================
-- 2. AN APPROVED REQUEST MUST LAND SOMEWHERE.
-- ===========================================================================
--
-- `v_list_id` was allowed to stay null, which creates a task belonging to no
-- list — invisible on /tasks/lists, absent from every folder, findable only by
-- scrolling the flat task list. Reported as "when approving a request the
-- TL/TM must select a list where the task will be under".
--
-- THIS IS A SAFETY NET, NOT A NEW BURDEN. P7-18 gives every form an inbox list
-- and sets `forms.default_list_id` from it by trigger, so the fallback below
-- already resolves for any properly-formed form and nobody has to choose
-- anything they did not choose before. The raise fires only when a form somehow
-- has no default AND the reviewer sent nothing — which is precisely the case
-- that used to produce a loose task in silence.
--
-- The screen is where the CHOICE now lives: the review panel no longer offers
-- "No list", and can create one without leaving the page. This is the half that
-- makes the rule true rather than merely displayed.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it
-- stands at that moment.
-- ---------------------------------------------------------------------------

-- The two stale signatures. `if exists` so a database that has only some of
-- them applies this file cleanly — unlike the policy DROP in P7-22, a function
-- that is not there cannot be left alive beside the new one under a different
-- name, so silence is safe here.
drop function if exists vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text);
drop function if exists vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text, uuid);

-- The surviving signature, reproduced whole from 20260818140000 with the list
-- requirement added. `create or replace` is correct for this one: it is the
-- shape that stays.
create or replace function vizserve_pms_approve_request(
  p_request_id           uuid,
  p_assignee_id          uuid,
  p_qa_assignee_id       uuid,
  p_approved_target_date date default null,
  p_title                text default null,
  p_description          text default null,
  p_list_id              uuid default null,
  p_priority             vizserve_pms_task_priority default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_task_id       uuid;
  v_title         text;
  v_description   text;
  v_due           date;
  v_reference     text;
  v_list_id       uuid;
begin
  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  select f.department_id, f.default_list_id
    into v_department_id, v_list_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- The TL's choice wins; the form's default is the fallback. Null from the
  -- caller means "unchanged", not "clear it" — clearing is not something the
  -- review screen offers, and treating an absent parameter as a deletion is how
  -- a default silently stops applying.
  v_list_id := coalesce(p_list_id, v_list_id);

  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, 'approved', null
  );

  if p_assignee_id is null then
    raise exception 'Choose who will do the work.' using errcode = 'check_violation';
  end if;

  -- P7-23. Checked beside "choose who will do the work" because it is the same
  -- kind of rule: an approval that does not say where the work goes is not a
  -- complete approval. The sentence names the way out, since a reviewer looking
  -- at a form with no inbox list cannot be expected to know P7-18 exists.
  if v_list_id is null then
    raise exception 'Choose the list this task will go under. This form has no default list set.'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and u.primary_department_id = v_department_id
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_qa_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_qa_assignee_id and u.is_active
       and (u.primary_department_id = v_department_id
            or vizserve_pms_manages_department_for(u.id, v_department_id))
  ) then
    raise exception 'That QA reviewer is not available for this department.'
      using errcode = 'check_violation';
  end if;

  -- Same rule as manual creation: a list belongs to one department, and a task
  -- filed under another department's list is invisible to the team that owns it.
  --
  -- The null branch is kept even though the raise above makes it unreachable:
  -- it costs nothing, and a future edit that softens the requirement should not
  -- silently turn this into a null-comparison that admits everything.
  if v_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = v_list_id and l.department_id = v_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  v_title       := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_request.title);
  v_description := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_request.description);
  v_due         := coalesce(p_approved_target_date, v_request.target_date);

  update vizserve_pms_requests
     set status               = 'APPROVED',
         approved_target_date = v_due,
         title                = v_title,
         description          = v_description,
         reviewed_by          = auth.uid(),
         reviewed_at          = now()
   where id = p_request_id
  returning reference_no into v_reference;

  -- `field_values` travels with the task. It always has — the reason the
  -- client's answers looked "neglected" was P7-22's policy, and a form with no
  -- custom fields having nothing to carry. Left here as the note saying so.
  insert into vizserve_pms_tasks (
    request_id, department_id, list_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, field_values, created_by, priority
  ) values (
    p_request_id, v_department_id, v_list_id, v_title, v_description, 'OPEN',
    p_assignee_id, p_qa_assignee_id, v_due, v_request.field_values, auth.uid(), p_priority
  )
  returning id into v_task_id;

  -- P2-03 — recorded only when something genuinely changed. A trail where every
  -- approval logs an edit is a trail in which a real edit is invisible.
  if v_title is distinct from v_request.title
     or v_description is distinct from v_request.description
     or v_due is distinct from v_request.target_date
  then
    perform vizserve_pms_write_audit_log(
      'request', p_request_id, 'edited', auth.uid(),
      jsonb_build_object(
        'title', v_request.title,
        'description', v_request.description,
        'target_date', v_request.target_date
      ),
      jsonb_build_object(
        'title', v_title,
        'description', v_description,
        'approved_target_date', v_due
      )
    );
  end if;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', auth.uid(), null,
    jsonb_build_object(
      'request_id', p_request_id,
      'reference_no', v_reference,
      'assignee_id', p_assignee_id,
      'qa_assignee_id', p_qa_assignee_id,
      'due_date', v_due,
      'list_id', v_list_id,
      'priority', p_priority
    )
  );

  perform vizserve_pms_notify(
    p_assignee_id,
    'assigned',
    'Assigned to you: ' || v_reference,
    v_title,
    'task',
    v_task_id,
    '/tasks/' || v_task_id::text
  );

  if p_qa_assignee_id is not null and p_qa_assignee_id <> p_assignee_id then
    perform vizserve_pms_notify(
      p_qa_assignee_id,
      'qa_requested',
      'You are QA on ' || v_reference,
      v_title,
      'task',
      v_task_id,
      '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due,
    'list_id', v_list_id
  );
end;
$$;

-- THE REGRANT. The two DROPs above took their grants with them, and the
-- eight-argument version was never granted in the first place — so without this
-- line every approval reads `permission denied for function`, which is a GRANT
-- diagnosis and never a policy one.
grant execute on function vizserve_pms_approve_request(
  uuid, uuid, uuid, date, text, text, uuid, vizserve_pms_task_priority
) to authenticated;

comment on function vizserve_pms_approve_request(
  uuid, uuid, uuid, date, text, text, uuid, vizserve_pms_task_priority
) is
  'P2-07 Gate 1, atomic. The ONLY signature — P7-23 dropped the six- and '
  'seven-argument overloads left behind by create-or-replace. Requires a list: '
  'the caller''s, or forms.default_list_id, and it raises if neither exists.';
