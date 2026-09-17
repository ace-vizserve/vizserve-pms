-- ---------------------------------------------------------------------------
-- P7-72 — a form can be archived, restored and deleted, and a draft no longer
-- puts a list in the tasks rail.
--
-- THE LIFECYCLE, as agreed with Ace on 17 Sep 2026:
--
--   Draft      never published. No inbox list exists.
--   Published  `is_active`. The inbox list is created on FIRST publish, and
--              only for a CLIENT_REQUEST form — an internal form produces
--              responses, never tasks, so it never needs one.
--   Paused     unpublished after going live. The list, its tasks and any
--              pending requests stay exactly where they are.
--   Archived   `archived_at`. Refused while there are pending requests or open
--              tasks. Unpublishes the form and archives its inbox list; nothing
--              is deleted, and reports keep counting every task.
--
-- DELETE, and the rule that settles it: A LIST IS NEVER DELETED, ONLY ARCHIVED.
--
--   * nothing behind the form      → anyone who administers it may delete it
--   * submissions, none became a task → an OWNER may force it; requests,
--                                    responses and their files go with it
--   * any request became a task    → refused outright; archive instead
--
-- The third line is not caution for its own sake. `tasks.request_id` is
-- `on delete set null`, and a task with no request IS an internal task to this
-- app — so deleting the request would silently reclassify client work, strip
-- its gates and rewrite its history. Timesheet hours only ever hang off tasks,
-- so this rule also means no form delete can ever touch logged time.
--
-- Every delete writes ONE audit row carrying what was removed. Identifiers,
-- titles and statuses — deliberately NOT the clients' answers: the audit trail
-- is readable more widely than the requests were (p11_09), and copying names
-- and emails into it would widen who can read them.
--
-- ⚠️ APPLIED WITH `npm run db:push`. Idempotent throughout.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The two columns.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_forms
  add column if not exists archived_at timestamptz,
  -- What tells a DRAFT from a PAUSED form. Both are `is_active = false`, and
  -- they are different states: one has never been seen by anybody, the other
  -- has requests and tasks behind it.
  add column if not exists first_published_at timestamptz;

comment on column vizserve_pms_forms.archived_at is
  'P7-72. Set and cleared only by vizserve_pms_archive_form / vizserve_pms_restore_form. An archived form is never published.';
comment on column vizserve_pms_forms.first_published_at is
  'P7-72. Stamped the first time is_active becomes true, and never changed after. Null means the form is still a draft.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vizserve_pms_forms_archived_not_active'
  ) then
    alter table vizserve_pms_forms
      add constraint vizserve_pms_forms_archived_not_active
      check (archived_at is null or not is_active);
  end if;
end;
$$;

-- Backfill: anything live, or with anything submitted to it, has been published.
update vizserve_pms_forms f
   set first_published_at = coalesce(
         (select min(r.submitted_at) from vizserve_pms_requests r where r.form_id = f.id),
         (select min(fr.submitted_at) from vizserve_pms_form_responses fr where fr.form_id = f.id),
         f.created_at
       )
 where f.first_published_at is null
   and (
     f.is_active
     or exists (select 1 from vizserve_pms_requests r where r.form_id = f.id)
     or exists (select 1 from vizserve_pms_form_responses fr where fr.form_id = f.id)
   );


-- ---------------------------------------------------------------------------
-- 2. The lifecycle guard.
--
-- ⚠️ `archived_at` MOVES ONLY THROUGH THE FUNCTIONS BELOW. The update policies
-- let a lead write any column on their form, so without this a direct PostgREST
-- `update set archived_at = now()` would archive a form with pending requests
-- and skip every check. The functions raise a transaction-local flag; nothing
-- else can.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_forms_lifecycle_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_via_function boolean := coalesce(current_setting('vizserve_pms.form_lifecycle', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.archived_at is not null and not v_via_function then
      raise exception 'A new form cannot start archived.' using errcode = 'check_violation';
    end if;
    new.first_published_at := case when new.is_active then now() end;
    return new;
  end if;

  if new.archived_at is distinct from old.archived_at and not v_via_function then
    raise exception 'Archive or restore a form from the forms list, not by editing it.'
      using errcode = 'check_violation';
  end if;

  -- Readable before the CHECK constraint gets the chance to say it in Postgres.
  if new.archived_at is not null and new.is_active then
    raise exception 'An archived form cannot be published. Restore it first.'
      using errcode = 'check_violation';
  end if;

  -- Stamped once, never moved and never cleared.
  new.first_published_at := coalesce(
    old.first_published_at,
    case when new.is_active then now() end
  );

  return new;
end;
$$;

drop trigger if exists vizserve_pms_forms_lifecycle_guard on vizserve_pms_forms;
create trigger vizserve_pms_forms_lifecycle_guard
  before insert or update on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_lifecycle_guard();


-- ---------------------------------------------------------------------------
-- 3. The inbox list follows the lifecycle, not the department.
--
-- P7-18 created the list the moment a form had a department, which is why a
-- draft nobody had published sat in every lead's tasks rail. Now:
--
--   archived               → the list is archived
--   published (client)     → the list exists and is active
--   restored after going live → the list comes back
--   draft / paused         → the list is left exactly as it is
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_forms_sync_list()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.purpose <> 'CLIENT_REQUEST' then
    return new;
  end if;

  if new.archived_at is not null then
    update vizserve_pms_lists set is_active = false where form_id = new.id and is_active;
    return new;
  end if;

  if new.is_active then
    perform vizserve_pms_ensure_form_list(new.id);
    update vizserve_pms_lists set is_active = true where form_id = new.id and not is_active;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.archived_at is not null and new.first_published_at is not null then
    update vizserve_pms_lists set is_active = true where form_id = new.id and not is_active;
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_forms_sync_list on vizserve_pms_forms;
create trigger vizserve_pms_forms_sync_list
  after insert or update of department_id, is_active, archived_at, purpose on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_sync_list();

-- Only the trigger above should create an inbox list. Called directly, this
-- would put a draft's list back in the rail.
revoke execute on function vizserve_pms_ensure_form_list(uuid) from public, anon, authenticated;

-- Backfill: the lists that should never have appeared. A draft that never went
-- live, or an internal form, with no open work in its list. ARCHIVED, not
-- deleted and not detached — publishing the draft later brings the same list
-- back through the trigger above.
update vizserve_pms_lists l
   set is_active = false
  from vizserve_pms_forms f
 where l.form_id = f.id
   and l.is_active
   and (f.purpose <> 'CLIENT_REQUEST' or f.first_published_at is null)
   and not exists (
     select 1 from vizserve_pms_tasks t
      where t.list_id = l.id
        and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
   );


-- ---------------------------------------------------------------------------
-- 4. Deleting a form must never delete its list.
--
-- `lists.form_id` was `on delete cascade`. The delete function detaches the
-- list itself; this is the belt, so no path can take a list and its tasks'
-- filing with it. A null `form_id` in Client Requests is legal since P7-25.
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select c.conname into v_name
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.conrelid = 'vizserve_pms_lists'::regclass
     and c.contype = 'f'
     and a.attname = 'form_id';

  if v_name is not null then
    execute format('alter table vizserve_pms_lists drop constraint %I', v_name);
  end if;

  alter table vizserve_pms_lists
    add constraint vizserve_pms_lists_form_id_fkey
    foreign key (form_id) references vizserve_pms_forms (id) on delete set null;
end;
$$;

-- The raw DELETE path. Every delete now goes through the audited function.
drop policy if exists "forms deletable by admin" on vizserve_pms_forms;
revoke delete on vizserve_pms_forms from authenticated;


-- ---------------------------------------------------------------------------
-- 5. Who administers a form.
--
-- The union of the two UPDATE policies on `vizserve_pms_forms` ("forms
-- updatable in scope" and "forms editable by department admin"), which is also
-- what `assertCanEditForm` enforces in the app. An internal form is an owner's.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_administers_form(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_forms f
     where f.id = p_form_id
       and case
             when f.purpose = 'INTERNAL' then vizserve_pms_is_admin()
             else
               vizserve_pms_manages_department(f.department_id)
               or (f.department_id is not null and vizserve_pms_is_dept_admin(f.department_id))
               or (f.department_id is null and f.created_by = auth.uid())
           end
  )
$$;

revoke all on function vizserve_pms_administers_form(uuid) from public, anon;
grant execute on function vizserve_pms_administers_form(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. What is behind a form. Counts only — never a row.
--
-- The dialogs draw from this and the functions below decide from it, so the
-- number a person is shown is the number the refusal was based on.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_form_workload(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_list_id   uuid;
  v_list_name text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not vizserve_pms_administers_form(p_form_id) then
    raise exception 'That form does not exist, or is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  select id, name into v_list_id, v_list_name from vizserve_pms_lists where form_id = p_form_id;

  return jsonb_build_object(
    'requests',
      (select count(*) from vizserve_pms_requests r where r.form_id = p_form_id),
    'pending_requests',
      (select count(*) from vizserve_pms_requests r
        where r.form_id = p_form_id
          and r.status in ('SUBMITTED', 'PENDING_REVIEW', 'RETURNED')),
    'responses',
      (select count(*) from vizserve_pms_form_responses fr where fr.form_id = p_form_id),
    'tasks_from_requests',
      (select count(*) from vizserve_pms_tasks t
         join vizserve_pms_requests r on r.id = t.request_id
        where r.form_id = p_form_id),
    'open_tasks',
      (select count(*) from vizserve_pms_tasks t
        where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
          and (
            t.request_id in (select r.id from vizserve_pms_requests r where r.form_id = p_form_id)
            or (v_list_id is not null and t.list_id = v_list_id)
          )),
    'list_name', v_list_name
  );
end;
$$;

revoke all on function vizserve_pms_form_workload(uuid) from public, anon;
grant execute on function vizserve_pms_form_workload(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Archive and restore.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_archive_form(p_form_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_before   vizserve_pms_forms;
  v_after    vizserve_pms_forms;
  v_workload jsonb;
  v_pending  int;
  v_open     int;
begin
  v_workload := vizserve_pms_form_workload(p_form_id);  -- signed in, and in scope

  select * into v_before from vizserve_pms_forms where id = p_form_id for update;
  if v_before.archived_at is not null then
    return;
  end if;

  v_pending := (v_workload ->> 'pending_requests')::int;
  v_open := (v_workload ->> 'open_tasks')::int;

  if v_pending > 0 or v_open > 0 then
    raise exception 'This form still has % and %. Decide or close them first, then archive it.',
      v_pending || case when v_pending = 1 then ' pending request' else ' pending requests' end,
      v_open || case when v_open = 1 then ' open task' else ' open tasks' end
      using errcode = 'check_violation';
  end if;

  perform set_config('vizserve_pms.form_lifecycle', 'on', true);
  update vizserve_pms_forms
     set archived_at = now(), is_active = false
   where id = p_form_id
  returning * into v_after;
  perform set_config('vizserve_pms.form_lifecycle', 'off', true);

  perform vizserve_pms_write_audit_log(
    p_entity_type => 'form',
    p_entity_id   => p_form_id,
    p_action      => 'archived',
    p_actor_id    => auth.uid(),
    p_before      => to_jsonb(v_before) - 'schema',
    p_after       => to_jsonb(v_after) - 'schema'
  );
end;
$$;

revoke all on function vizserve_pms_archive_form(uuid) from public, anon;
grant execute on function vizserve_pms_archive_form(uuid) to authenticated;

-- Back to Paused (or Draft, if it never went live) — NOT back to published.
-- Putting a form in front of clients again is its own decision.
create or replace function vizserve_pms_restore_form(p_form_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_before vizserve_pms_forms;
  v_after  vizserve_pms_forms;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not vizserve_pms_administers_form(p_form_id) then
    raise exception 'That form does not exist, or is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from vizserve_pms_forms where id = p_form_id for update;
  if v_before.archived_at is null then
    return;
  end if;

  perform set_config('vizserve_pms.form_lifecycle', 'on', true);
  update vizserve_pms_forms set archived_at = null where id = p_form_id returning * into v_after;
  perform set_config('vizserve_pms.form_lifecycle', 'off', true);

  perform vizserve_pms_write_audit_log(
    p_entity_type => 'form',
    p_entity_id   => p_form_id,
    p_action      => 'restored',
    p_actor_id    => auth.uid(),
    p_before      => to_jsonb(v_before) - 'schema',
    p_after       => to_jsonb(v_after) - 'schema'
  );
end;
$$;

revoke all on function vizserve_pms_restore_form(uuid) from public, anon;
grant execute on function vizserve_pms_restore_form(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Delete.
--
-- Returns the storage paths of every file that went with it. The rows cascade;
-- the objects in the `request-attachments` bucket do not, and the server
-- action removes them once this has committed.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_delete_form(p_form_id uuid, p_force boolean default false)
returns text[]
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form        vizserve_pms_forms;
  v_workload    jsonb;
  v_submissions int;
  v_tasks       int;
  v_open        int;
  v_paths       text[];
  v_snapshot    jsonb;
begin
  v_workload := vizserve_pms_form_workload(p_form_id);  -- signed in, and in scope

  select * into v_form from vizserve_pms_forms where id = p_form_id for update;

  v_submissions := (v_workload ->> 'requests')::int + (v_workload ->> 'responses')::int;
  v_tasks := (v_workload ->> 'tasks_from_requests')::int;
  v_open := (v_workload ->> 'open_tasks')::int;

  if v_tasks > 0 then
    raise exception '% from this form became tasks, so it cannot be deleted. Archive it instead — nothing is lost, and its tasks stay client work.',
      v_tasks || case when v_tasks = 1 then ' request' else ' requests' end
      using errcode = 'restrict_violation';
  end if;

  if v_open > 0 then
    raise exception 'Its list still has %. Close or move them before deleting the form.',
      v_open || case when v_open = 1 then ' open task' else ' open tasks' end
      using errcode = 'restrict_violation';
  end if;

  if v_submissions > 0 and not p_force then
    raise exception 'This form has %. Deleting it deletes them too, which only an owner can do.',
      v_submissions || case when v_submissions = 1 then ' submission' else ' submissions' end
      using errcode = 'restrict_violation';
  end if;

  if v_submissions > 0 and not vizserve_pms_is_admin() then
    raise exception 'Only an owner can delete a form along with its submissions.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(path), '{}') into v_paths
    from (
      select ra.storage_path as path
        from vizserve_pms_request_attachments ra
        join vizserve_pms_requests r on r.id = ra.request_id
       where r.form_id = p_form_id
      union
      select pa.storage_path
        from vizserve_pms_pending_attachments pa
       where pa.form_id = p_form_id
    ) paths;

  v_snapshot := jsonb_build_object(
    'form', to_jsonb(v_form),
    'forced', p_force and v_submissions > 0,
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ff.id, 'field_key', ff.field_key, 'label', ff.label,
               'field_type', ff.field_type, 'is_active', ff.is_active
             ) order by ff.sort_order), '[]')
        from vizserve_pms_form_fields ff where ff.form_id = p_form_id
    ),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id, 'reference_no', r.reference_no, 'title', r.title,
               'status', r.status, 'submitted_at', r.submitted_at
             ) order by r.submitted_at), '[]')
        from vizserve_pms_requests r where r.form_id = p_form_id
    ),
    'responses', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', fr.id, 'submitted_at', fr.submitted_at
             ) order by fr.submitted_at), '[]')
        from vizserve_pms_form_responses fr where fr.form_id = p_form_id
    ),
    'files', to_jsonb(v_paths),
    'list', (
      select jsonb_build_object('id', l.id, 'name', l.name)
        from vizserve_pms_lists l where l.form_id = p_form_id
    )
  );

  -- Gate 1 decisions are polymorphic rows with no foreign key to the request.
  delete from vizserve_pms_approvals a
   using vizserve_pms_requests r
   where a.entity_type = 'request'
     and a.entity_id = r.id
     and r.form_id = p_form_id;

  -- Requests and responses BEFORE the form: `form_field_protect` refuses to drop
  -- a field that still has answers, and the cascade would hit it.
  delete from vizserve_pms_requests where form_id = p_form_id;
  delete from vizserve_pms_form_responses where form_id = p_form_id;

  -- The list is archived and detached, never deleted.
  update vizserve_pms_lists set is_active = false, form_id = null where form_id = p_form_id;

  perform vizserve_pms_write_audit_log(
    p_entity_type => 'form',
    p_entity_id   => p_form_id,
    p_action      => case when p_force and v_submissions > 0 then 'force_deleted' else 'deleted' end,
    p_actor_id    => auth.uid(),
    p_before      => v_snapshot,
    p_after       => null
  );

  delete from vizserve_pms_forms where id = p_form_id;

  return v_paths;
end;
$$;

revoke all on function vizserve_pms_delete_form(uuid, boolean) from public, anon;
grant execute on function vizserve_pms_delete_form(uuid, boolean) to authenticated;
