-- ---------------------------------------------------------------------------
-- P7-51 — a public "track your request" page, linked from the acknowledgement.
--
-- Asked for on 25 Aug 2026, with LBC's Track & Trace as the reference: the
-- client gets a link, opens it, and sees where their request has got to without
-- emailing anybody to ask.
--
-- ⚠️ WHY THIS IS NOT `/status/VIZ-2026-0004`, which is the obvious design and is
-- badly wrong here. `reference_no` is SEQUENTIAL — VIZ-2026-0001, -0002, -0003.
-- Anybody holding one could count upwards and read every client's request title,
-- brief and decision history. LBC gets away with a bare tracking number because
-- a waybill tells you almost nothing; a request here carries a brief somebody
-- wrote in confidence.
--
-- So the URL carries an unguessable TOKEN, and this file follows P4's approval
-- tokens exactly:
--
--   * only the SHA-256 hash is stored. The raw value exists once, in the email
--     that was sent, so a dump of this table yields nothing replayable.
--   * every failure returns the same shape. Distinguishing "no such token" from
--     anything else tells an enumerator which guesses were close.
--
-- NO EXPIRY, and that is the deliberate difference from an approval token. That
-- one grants an ACTION and must stop working; this one grants a READ of the
-- client's own request, and a link that dies three days after it arrives is a
-- link that is dead every time somebody actually wants it.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_requests
  add column status_token_hash text unique;

comment on column vizserve_pms_requests.status_token_hash is
  'P7-51. SHA-256 of the tracking token emailed to the requester. The raw value '
  'is never stored. NULL on requests that predate this column — their link was '
  'never issued and cannot be reconstructed.';

-- Partial: most lookups are by this and the column is null on older rows.
create index vizserve_pms_requests_status_token_idx
  on vizserve_pms_requests (status_token_hash)
  where status_token_hash is not null;

-- ---------------------------------------------------------------------------
-- The page's data, as one call.
--
-- SECURITY DEFINER because `anon` holds no table privileges at all (CLAUDE.md)
-- — the public form and the Gate 3 approval page reach the database the same
-- way. This is the only route in, and the projection below IS the access rule.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN, and every omission is a decision:
--
--   the brief          the client wrote it, but this link may be forwarded, sat
--                      behind in an open tab, or pasted into a group chat. A
--                      status page needs to say WHERE it is, not restate what
--                      was asked for.
--   staff names        who the PIC is, who reviewed it, who is doing QA. None of
--                      that is the client's business and all of it invites them
--                      to contact people directly, around the queue.
--   internal comments  QA notes and status-change comments are colleagues
--                      talking to each other about the work.
--   the department     single-tenant, and it tells the client nothing.
--   any id             nothing here may be looked up or acted on.
--
-- What it DOES return is the reference, the title, the dates, and a timeline of
-- stages with times — the shape of an LBC trace.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_get_request_status(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_request  vizserve_pms_requests;
  v_task     vizserve_pms_tasks;
  v_timeline jsonb := '[]'::jsonb;
  v_row      record;
begin
  -- An empty or absent token must not match a row whose hash is null.
  if coalesce(btrim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_request
    from vizserve_pms_requests
   where status_token_hash = encode(digest(p_token, 'sha256'), 'hex');

  -- One shape of answer for every failure. See the header.
  if v_request.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- ------------------------------------------------------------------ stage 1
  -- Received. Always first, always true — the request exists.
  v_timeline := v_timeline || jsonb_build_object(
    'at', v_request.submitted_at,
    'label', 'Request received',
    'detail', 'We have your request and it is queued for review.'
  );

  -- ------------------------------------------------------------------ stage 2
  -- The Gate 1 decision, from the approval engine's own record rather than the
  -- request's current status: the status is where it IS, the approval row is
  -- when it MOVED, and a timeline needs the second.
  --
  -- The reason is included for a return or a rejection ONLY. Those two were
  -- already emailed to this client verbatim (P2-08/09), so it is not new
  -- information — and it is the one thing they need in order to act. An
  -- APPROVAL's reason is an internal note between colleagues.
  for v_row in
    select a.decision, a.reason, a.created_at
      from vizserve_pms_approvals a
     where a.entity_type = 'request'
       and a.entity_id = v_request.id
     order by a.created_at
  loop
    v_timeline := v_timeline || jsonb_build_object(
      'at', v_row.created_at,
      'label', case v_row.decision
                 when 'approved' then 'Approved — work scheduled'
                 when 'returned' then 'More information needed'
                 else 'Not proceeding'
               end,
      'detail', case v_row.decision
                  when 'approved' then 'A team member has been assigned and work is scheduled.'
                  else coalesce(v_row.reason, 'See the email we sent you for details.')
                end
    );
  end loop;

  -- ------------------------------------------------------------------ stage 3
  -- The work itself. One task per approved request (P2-07).
  select * into v_task
    from vizserve_pms_tasks
   where request_id = v_request.id
   order by created_at
   limit 1;

  if v_task.id is not null then
    for v_row in
      select h.to_status, h.created_at
        from vizserve_pms_task_status_history h
       where h.task_id = v_task.id
         -- CLIENT-VISIBLE STAGES ONLY. `WAITING_FOR_INFO` is deliberately
         -- absent: it usually means the team is waiting on somebody internal,
         -- and surfacing it reads to a client as "we are waiting on YOU" when
         -- nobody has asked them for anything.
         and h.to_status in (
           'ONGOING', 'FOR_QA', 'FOR_CLIENT_APPROVAL', 'COMPLETED', 'COMPLETED_NO_RESPONSE'
         )
       order by h.created_at
    loop
      v_timeline := v_timeline || jsonb_build_object(
        'at', v_row.created_at,
        'label', case v_row.to_status
                   when 'ONGOING' then 'Work in progress'
                   when 'FOR_QA' then 'In quality check'
                   when 'FOR_CLIENT_APPROVAL' then 'Sent to you for approval'
                   when 'COMPLETED' then 'Completed'
                   else 'Closed'
                 end,
        'detail', case v_row.to_status
                    when 'ONGOING' then 'Somebody is actively working on this.'
                    when 'FOR_QA' then 'The work is done and being checked before it reaches you.'
                    when 'FOR_CLIENT_APPROVAL' then 'Check your email — we have sent it over for your sign-off.'
                    when 'COMPLETED' then 'Signed off and closed. Thank you.'
                    -- COMPLETED_NO_RESPONSE is deliberately NOT called
                    -- "approved" anywhere in this app: the clock ran out, which
                    -- is a different fact, and the wording has to survive a
                    -- dispute about it.
                    else 'Closed automatically — the approval window passed without a reply.'
                  end
      );
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reference_no', v_request.reference_no,
    'title', v_request.title,
    'requester_name', v_request.requester_name,
    'submitted_at', v_request.submitted_at,
    'status', v_request.status,
    -- The AGREED date where there is one, otherwise what was asked for. The
    -- page labels which it is showing; conflating them would have the app
    -- confirming a date nobody committed to.
    'target_date', v_request.target_date,
    'approved_target_date', v_request.approved_target_date,
    'timeline', v_timeline
  );
end;
$$;

-- `revoke from public` first, then grant deliberately — the same order P4 uses.
-- A SECURITY DEFINER function left executable by PUBLIC is a hole that no
-- policy underneath can close.
revoke all on function vizserve_pms_get_request_status(text) from public;
grant execute on function vizserve_pms_get_request_status(text) to anon, authenticated;

comment on function vizserve_pms_get_request_status(text) is
  'P7-51. The public tracking page, by unguessable token. Returns reference, '
  'title, dates and a stage timeline — never the brief, staff names, internal '
  'comments or any id. One error shape for every failure, so the endpoint '
  'cannot be used to probe for valid tokens.';
