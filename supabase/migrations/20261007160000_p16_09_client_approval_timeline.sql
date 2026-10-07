-- P16-09 — the client sees how their request got here (7 Oct 2026).
--
-- The approval page and the Gate 3 email said WHAT was done and nothing about
-- WHO or WHEN. A client checking work against their brief now also sees the
-- milestones — requested, accepted, started, finished (with the PIC) and
-- checked by QA (with the reviewer) — and then their own step.
--
-- ⚠️ THIS REVERSES A RECORDED RULE, deliberately. `approvalPageSchema` said the
-- public page carries "no PIC name", because a public endpoint that leaks the
-- org chart compounds. That was decided against on 7 Oct 2026: the client is
-- told who did the work and who checked it. Two FIRST AND LAST NAMES, nothing
-- else — still no department, no email, no user id, and no internal comments.
-- The P16-08 QA comment is NOT exposed here; it was written for the team.
--
-- ONE HELPER, TWO READERS. The page reads it inside its SECURITY DEFINER
-- function; the email reads it through the service role. Computing the same
-- milestones twice is two answers to "when was this finished", and the client
-- would be holding one of each.
--
-- MILESTONES, NOT RAW HISTORY. The history table is the team's: a send-back, a
-- "waiting for info", an override are internal events. The client gets the
-- latest finish and the latest QA pass, so a reworked job reads as finished
-- when it was last finished — which is the date that is true for what they are
-- looking at.

create or replace function vizserve_pms_client_timeline(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
    t as (select * from vizserve_pms_tasks where id = p_task_id),
    r as (select rq.* from vizserve_pms_requests rq join t on rq.id = t.request_id),
    h as (select * from vizserve_pms_task_status_history where task_id = p_task_id),
    passed as (
      select created_at, actor_id from h
       where to_status = 'FOR_CLIENT_APPROVAL'
       order by created_at desc
       limit 1
    )
  select jsonb_build_object(
    'requested_at', (select submitted_at from r),
    -- Gate 1. Null on a form that skips approval (P16-01) — the step is then
    -- simply not drawn.
    'accepted_at',  (select reviewed_at from r),
    'started_at',   (select min(created_at) from h where to_status = 'ONGOING'),
    'finished_at',  (select max(created_at) from h where to_status = 'FOR_QA'),
    'reviewed_at',  (select created_at from passed),
    'pic_name',     (select u.full_name from t join vizserve_pms_users u on u.id = t.assignee_id),
    -- Whoever actually passed it, which is not always the assigned reviewer: a
    -- lead may QA in either seat. The assigned reviewer is the fallback for a
    -- task forced here with no pass on record.
    'qa_name', coalesce(
      (select u.full_name from passed join vizserve_pms_users u on u.id = passed.actor_id),
      (select u.full_name from t join vizserve_pms_users u on u.id = t.qa_assignee_id)
    )
  );
$$;

-- Not callable by a browser. The page reaches it from inside its own SECURITY
-- DEFINER function; the mailer through the service role.
revoke all on function vizserve_pms_client_timeline(uuid) from public, anon, authenticated;
grant execute on function vizserve_pms_client_timeline(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The approval page carries the timeline. p16_06's function otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_get_approval_page(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token   vizserve_pms_approval_tokens;
  v_task    vizserve_pms_tasks;
  v_request vizserve_pms_requests;
begin
  select * into v_token
    from vizserve_pms_approval_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');

  -- One shape of answer for every kind of failure. Distinguishing "no such
  -- token" from "expired" tells an enumerator which guesses were close.
  if v_token.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select * into v_task from vizserve_pms_tasks where id = v_token.task_id;
  select * into v_request from vizserve_pms_requests where id = v_task.request_id;

  return jsonb_build_object(
    'ok', true,
    'purpose', v_token.purpose,
    -- A consumed token still renders, showing what was decided. A dead link is
    -- what makes a client ring up to ask whether their click worked.
    'consumed', v_token.consumed_at is not null,
    'task_id', v_task.id,
    'status', v_task.status,
    'reference_no', v_request.reference_no,
    'title', v_task.title,
    'requester_name', v_request.requester_name,
    -- P16-06. Who this link is for, and where they sit in the chain.
    'approver_name', coalesce(
      (select a.name from vizserve_pms_request_approvers a
        where a.request_id = v_request.id and a.step = v_token.step),
      v_request.requester_name
    ),
    'step', v_token.step,
    'steps', 1 + (select count(*) from vizserve_pms_request_approvers a where a.request_id = v_request.id),
    'submitted_at', v_request.submitted_at,
    'agreed_date', coalesce(v_request.approved_target_date, v_request.target_date),
    'resolution', v_task.resolution,
    'output_link', v_task.output_link,
    'auto_complete_at', v_token.auto_complete_at,
    -- Approving against what they asked for, not re-opening the brief
    -- (Amier 44:30).
    'field_values', v_request.field_values,
    'fields', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('field_key', ff.field_key, 'label', ff.label)
          order by ff.sort_order
        )
        from vizserve_pms_form_fields ff where ff.form_id = v_request.form_id
      ),
      '[]'::jsonb
    ),
    'attachments', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('id', ta.id, 'filename', ta.filename, 'size_bytes', ta.size_bytes)
          order by ta.created_at
        )
        from vizserve_pms_task_attachments ta
        where ta.task_id = v_task.id and ta.kind = 'output'
      ),
      '[]'::jsonb
    ),
    -- P16-09.
    'timeline', vizserve_pms_client_timeline(v_task.id)
  );
end;
$$;
