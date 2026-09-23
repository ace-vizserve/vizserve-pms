-- P7-79 — a client APPROVAL at Gate 3 tells the whole team on the task.
--
-- Was: `assignee_id` and `qa_assignee_id` only. Now, de-duplicated:
--
--   * the PIC                (`assignee_id`)
--   * the QA reviewer        (`qa_assignee_id`)
--   * every other assignee   (`vizserve_pms_task_assignees`)
--   * the department's Team Leader — a lead of the department whose home
--     department it is, any role (the P7-77c rule)
--
-- That is APPROVED only. CHANGES REQUESTED goes to the PIC alone — they have
-- the work to redo, and nobody else has to act (Ace, 23 Sep 2026). The
-- auto-close (no reply by the deadline) is a separate function, unchanged.
--
-- `vizserve_pms_record_client_decision` reproduced whole from
-- 20260804100000_p4_client_approval.sql; only the notify block changed.
-- Signature unchanged, so `anon`'s execute grant — the approval page — survives.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_record_client_decision(
  p_token         text,
  p_decision      vizserve_pms_client_decision,
  p_comment       text default null,
  p_approver_name text default null,
  p_ip            text default null,
  p_user_agent    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token     vizserve_pms_approval_tokens;
  v_task      vizserve_pms_tasks;
  v_reference text;
  v_comment   text := nullif(btrim(coalesce(p_comment, '')), '');
  v_new       vizserve_pms_task_status;
begin
  if p_decision = 'AUTO_COMPLETED' then
    raise exception 'Auto-completion is not a client decision.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked for the duration, so two clicks a millisecond apart cannot both pass
  -- the consumed check.
  select * into v_token
    from vizserve_pms_approval_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;

  if v_token.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.purpose <> 'approval' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Replay. The answer cannot be changed after the fact.
  if v_token.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  select * into v_task from vizserve_pms_tasks where id = v_token.task_id for update;

  -- The token is bound to a task, so cross-task reuse is impossible by
  -- construction. This catches the other case: a task that has moved on since
  -- the email went out — auto-completed, or pulled back by a TL override.
  if v_task.status <> 'FOR_CLIENT_APPROVAL' then
    return jsonb_build_object('ok', false, 'error', 'no_longer_open');
  end if;

  if p_decision = 'REVISION_REQUESTED' and v_comment is null then
    return jsonb_build_object('ok', false, 'error', 'comment_required');
  end if;

  v_new := case p_decision when 'APPROVED' then 'COMPLETED' else 'ONGOING' end;

  update vizserve_pms_tasks set status = v_new where id = v_task.id;

  -- actor_id is NULL: the client is a real actor with no user row, and
  -- attributing their decision to whoever happened to be signed in would be a
  -- lie in the one record a dispute turns on.
  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment)
  values
    (v_task.id, v_task.status, v_new, null,
     coalesce(v_comment, 'Client approved.'));

  insert into vizserve_pms_client_decisions
    (task_id, token_id, decision, comment, approver_name, ip, user_agent)
  values
    (v_task.id, v_token.id, p_decision, v_comment,
     nullif(btrim(coalesce(p_approver_name, '')), ''), p_ip, p_user_agent);

  update vizserve_pms_approval_tokens set consumed_at = now() where id = v_token.id;

  select r.reference_no into v_reference
    from vizserve_pms_requests r where r.id = v_task.request_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task.id, lower(p_decision::text), null,
    jsonb_build_object('status', v_task.status),
    jsonb_build_object(
      'status', v_new,
      'decision', p_decision,
      'comment', v_comment,
      'approver_name', nullif(btrim(coalesce(p_approver_name, '')), ''),
      'ip', p_ip
    )
  );

  -- Everyone who worked on it is told. A rejection means work resumes, and an
  -- approval closes the loop — both are worth an email (docs/12 §3).
  perform vizserve_pms_notify(
    person, 'client_decision',
    case p_decision
      when 'APPROVED' then 'Client approved: ' || coalesce(v_reference, v_task.title)
      else 'Client asked for changes: ' || coalesce(v_reference, v_task.title)
    end,
    coalesce(v_comment, ''), 'task', v_task.id, '/tasks/' || v_task.id::text
  )
  -- P7-79. APPROVED: PIC, QA, every assignee and the Team Leader, once each.
  -- CHANGES REQUESTED: the PIC only — they are the one with work to redo.
  from (
    select v_task.assignee_id as person
    union select v_task.qa_assignee_id
           where p_decision = 'APPROVED'
    union select a.user_id
            from vizserve_pms_task_assignees a
           where p_decision = 'APPROVED'
             and a.task_id = v_task.id
    union select md.user_id
            from vizserve_pms_user_managed_departments md
            join vizserve_pms_users u on u.id = md.user_id
           where p_decision = 'APPROVED'
             and md.department_id = v_task.department_id
             and u.is_active
             and u.primary_department_id = v_task.department_id
  ) as recipients
  where person is not null;

  -- task_id comes back so the caller can issue the feedback token. Safe to
  -- expose: the client already holds a token bound to this task, so it tells
  -- them nothing they could not already act on.
  return jsonb_build_object(
    'ok', true,
    'decision', p_decision,
    'status', v_new,
    'task_id', v_task.id
  );
end;
$$;
