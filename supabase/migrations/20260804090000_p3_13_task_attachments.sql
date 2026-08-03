-- P3-13 — Task attachments.
--
-- The PIC's output: the artwork, the corrected file, the screenshot of the fix.
-- Phase 4 surfaces these on the client approval page, which is what makes them
-- worth doing properly rather than as a link in a text field.
--
-- NO RECEIPT HANDSHAKE HERE, and that is not an inconsistency with P1-09.
--
-- The public form needs one because it is session-less: the upload and the
-- submission are separate requests from an anonymous caller, so the second has
-- to be told which file the first produced, and anything it is told can be
-- forged. A staff upload has neither problem — the caller is authenticated, the
-- task is known, and the upload IS the commit. There is no gap for a fabricated
-- path to live in, so adding a pending row would be ceremony rather than
-- security.
--
-- What DOES carry over is the rule underneath both: the server measures the
-- bytes. `size_bytes` and `mime_type` here are written by the upload action from
-- the real File, never from anything the browser claimed.

create table vizserve_pms_task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references vizserve_pms_tasks (id) on delete cascade,
  storage_path text not null unique,
  filename     text not null,
  mime_type    text not null,
  size_bytes   bigint not null,
  -- Distinguishes the PIC's output from a file the client sent with the
  -- original request. Phase 4 shows one and not the other.
  kind         text not null default 'output',
  uploaded_by  uuid references vizserve_pms_users (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint vizserve_pms_task_attachments_size_positive check (size_bytes > 0),
  constraint vizserve_pms_task_attachments_kind check (kind in ('output', 'reference'))
);

create index vizserve_pms_task_attachments_task_idx
  on vizserve_pms_task_attachments (task_id, created_at);

alter table vizserve_pms_task_attachments enable row level security;
revoke all on vizserve_pms_task_attachments from anon;

-- Visible to whoever can see the task — the same rule, expressed once more
-- rather than invented differently.
create policy "task attachments follow their task"
  on vizserve_pms_task_attachments for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

-- Uploading is doing the work, so the PIC and the QA reviewer may; a department
-- lead may too. The INSERT goes through the service role in practice (the
-- upload action holds the bytes), but the policy is here so the table is not
-- relying on that being the only caller.
create policy "task attachments insertable by participants"
  on vizserve_pms_task_attachments for insert to authenticated
  with check (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

-- Removing your own mistake is ordinary; removing somebody else's output is a
-- lead decision.
create policy "task attachments removable by uploader or lead"
  on vizserve_pms_task_attachments for delete to authenticated
  using (
    uploaded_by = auth.uid()
    or exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id and vizserve_pms_manages_department(t.department_id)
    )
  );
