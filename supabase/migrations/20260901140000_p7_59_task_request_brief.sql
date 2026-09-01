-- ---------------------------------------------------------------------------
-- P7-59 — THE BRIEF WITHOUT THE CLIENT'S IDENTITY.
--
-- THE PROBLEM P7-58 GOT WRONG BY BEING TOO BLUNT.
--
-- `vizserve_pms_requests` is readable by the department's LEADS only, so a
-- member PIC opening their own client task could see no reference, no client
-- date, none of the answers the client gave on the form, and none of the files
-- they attached. P7-58 widened the row policy to fix that and was reverted,
-- correctly: it handed over the client's NAME, ORG and EMAIL as well, and the
-- client is deliberately never told who at VizServe holds their task (the Gate 3
-- payload returns no PIC, no department, no internal ids — see the note above
-- `vizserve_pms_read_token`). Anonymity that runs one way only is not anonymity.
--
-- The real line is not row-level at all. It is:
--
--     THE BRIEF      what was asked for — the PIC cannot do the work without it
--     THE IDENTITY   who asked — the PIC does not need it, and the client is
--                    not told who they are either
--
-- ⚠️ AND RLS CANNOT DRAW THAT LINE. Row-level security decides whether you get
-- a ROW, never which of its COLUMNS. Column privileges are granted per ROLE, and
-- every signed-in user here is the same role (`authenticated`), so revoking
-- `requester_name` would take it from the leads too.
--
-- So it is a SECURITY DEFINER projection, which is the house pattern for exactly
-- this — the public form and the Gate 3 approval page reach the database the
-- same way, because `anon` holds no table privileges at all.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES AND DOES NOT RETURN.
--
--   returns   reference_no · description (the client's own wording) ·
--             target_date · submitted_at · the form's field labels · the
--             answers · the attached files
--
--   NEVER     requester_name · requester_org · requester_email · the request's
--             own id (so no page can build a link to /requests/[id] that the
--             caller would be refused on anyway)
--
-- A lead still reads the row directly through RLS and still sees the identity.
-- This function is the same for everybody: it hands back the brief and nothing
-- else, so there is one projection to audit rather than one per caller.
--
-- ⚠️ ONE HOLE, NAMED SO IT IS NOT MISTAKEN FOR AN OVERSIGHT: `field_values` is
-- user-defined. A form built with a "Contact number" or "Company" field puts the
-- identity straight back into the answers, and no projection can catch that
-- because the columns are rows in `vizserve_pms_form_fields`. Closing it needs a
-- per-field "identifying" flag on that table and a filter here. Until then it is
-- a form-design matter, and forms are built by leads.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_task_request_brief(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_task    vizserve_pms_tasks;
  v_request vizserve_pms_requests;
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  -- No task, or internal work. Null rather than an error: the page calls this
  -- for every task and branches on the result.
  if not found or v_task.request_id is null then
    return null;
  end if;

  select * into v_request from vizserve_pms_requests where id = v_task.request_id;
  if not found then
    return null;
  end if;

  /*
   * AUTHORIZATION, IN THE FUNCTION, BECAUSE DEFINER RIGHTS BYPASSED THE POLICY
   * TO GET HERE. Two ways in, and they are the two that already exist:
   *
   *   a seat on the task   `vizserve_pms_is_on_task` — the PIC, the QA
   *                        reviewer, or a second assignee (P7-13).
   *   leading the form's   the same test `requests readable in department
   *   department           scope` makes, so this can never be a wider door than
   *                        reading the row itself.
   *
   * ⚠️ THE FORM'S DEPARTMENT, NOT THE TASK'S. They are normally the same and
   * they are not the same COLUMN — the requests policy joins through
   * `vizserve_pms_forms`, and matching it here is what keeps the two from
   * drifting into a function that grants what the policy refuses.
   */
  if not (
    vizserve_pms_is_on_task(p_task_id, auth.uid())
    or exists (
      select 1 from vizserve_pms_forms f
       where f.id = v_request.form_id
         and vizserve_pms_manages_department(f.department_id)
    )
  ) then
    return null;
  end if;

  return jsonb_build_object(
    'reference_no', v_request.reference_no,
    -- What the client actually wrote. The task's own brief may have been
    -- rewritten by the TL at Gate 1, and QA checks the work against this.
    'description', v_request.description,
    -- ⚠️ `target_date`, NOT `approved_target_date`. This answers "what did the
    -- client ask for", which is the number the due date is compared against.
    -- The agreed date is a different fact and Gate 3 uses it separately.
    'target_date', v_request.target_date,
    'submitted_at', v_request.submitted_at,
    'field_values', coalesce(v_request.field_values, '{}'::jsonb),
    -- Archived fields included, and deliberately: a historical answer must keep
    -- rendering with its label after the field is retired (D20/R5).
    'fields', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'field_key', ff.field_key,
            'label', ff.label,
            'is_active', ff.is_active
          )
          order by ff.sort_order
        )
        from vizserve_pms_form_fields ff
       where ff.form_id = v_request.form_id
      ),
      '[]'::jsonb
    ),
    'attachments', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', ra.id,
            'filename', ra.filename,
            'mime_type', ra.mime_type,
            'size_bytes', ra.size_bytes
          )
          order by ra.created_at
        )
        from vizserve_pms_request_attachments ra
       where ra.request_id = v_request.id
      ),
      '[]'::jsonb
    )
  );
end;
$$;

grant execute on function vizserve_pms_task_request_brief(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ...AND THE STORAGE PATH, or the list above is a list of files nobody can open.
--
-- `getRequestAttachmentUrl` reads `vizserve_pms_request_attachments` to find the
-- path to sign, and that read is policied the same way the request is — so for a
-- member PIC it returns no row and the download fails with "that file is not
-- available" on a file the list has just told them exists.
--
-- ⚠️ IT TAKES THE TASK AS WELL AS THE ATTACHMENT, and that is the whole safety
-- of it. Authorization is "you are on THIS task, and this file belongs to THAT
-- task's request". An attachment id on its own would make this a lookup anyone
-- signed in could walk.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_task_request_attachment_path(
  p_task_id uuid,
  p_attachment_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_task    vizserve_pms_tasks;
  v_request vizserve_pms_requests;
  v_path    text;
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id;
  if not found or v_task.request_id is null then
    return null;
  end if;

  select * into v_request from vizserve_pms_requests where id = v_task.request_id;
  if not found then
    return null;
  end if;

  -- The same two doors as the brief. Kept spelled out rather than factored into
  -- a shared helper: two callers is not a pattern, and a helper here would be a
  -- third place to check when the rule changes.
  if not (
    vizserve_pms_is_on_task(p_task_id, auth.uid())
    or exists (
      select 1 from vizserve_pms_forms f
       where f.id = v_request.form_id
         and vizserve_pms_manages_department(f.department_id)
    )
  ) then
    return null;
  end if;

  select ra.storage_path into v_path
    from vizserve_pms_request_attachments ra
   where ra.id = p_attachment_id
     -- The file must belong to THIS task's request.
     and ra.request_id = v_request.id;

  return v_path;
end;
$$;

grant execute on function vizserve_pms_task_request_attachment_path(uuid, uuid) to authenticated;
