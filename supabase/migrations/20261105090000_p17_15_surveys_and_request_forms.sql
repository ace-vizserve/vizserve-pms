-- P17-15 — Surveys & Quizzes and request forms become two products (5 Nov 2026).
--
-- THREE CHANGES, ALL DECIDED BY THE USER:
--
-- 1. WHO BUILDS A SURVEY. Team leaders and department admins may now create an
--    internal form for their own department. This REVERSES P7-66 Phase 5 ("only an
--    admin creates an internal form") for their own surveys only. The reason for
--    that rule still stands, so what they get is deliberately narrow:
--      * Only forms THEY CREATED. A lead gains nothing on a survey an admin built
--        that happens to be owned by their department, its answers included.
--      * Never company-wide. `not audience_is_all_departments` is in the policy, so
--        the database refuses it. Their audience rows must be departments they run.
--    `vizserve_pms_is_admin()` keeps everything it had.
--
-- 2. EXTERNAL RESPONDENTS. `accepts_external` puts a survey at /survey/<slug> for
--    anyone with the link. A SEPARATE COLUMN, NOT `is_public`: that one is tied to
--    client forms by a CHECK, and /request/<slug> serves anything carrying it, which
--    would turn a survey into a request queue.
--      * `anon` still holds no table privileges. The page and its action use the
--        service role, and `vizserve_pms_submit_external_response` is granted to
--        service_role ONLY, so the server's validation cannot be skipped.
--      * ONE ANSWER PER PERSON (P17-11) CANNOT HOLD HERE. There is no login, so an
--        external respondent can answer more than once. The rate limit below is
--        the only brake. Staff going through /respond are still held to one.
--      * On an anonymous form no name or email is asked for or stored. On a named
--        one both are required and are stored as typed, unverified.
--
-- 3. EVERY REQUEST HAS A PIC. `default_pic_id` on the form, copied to `pic_id` on
--    each request by a trigger as it arrives. A client form cannot be published
--    without one. Gate 1 can still choose someone else, and a task's assignee keeps
--    the request's PIC in step from then on.
--      * ⚠️ LIVE FORMS WITH NO DEFAULT ARE LEFT RUNNING. Taking client forms offline
--        to enforce this would be worse than the gap. Their requests have no PIC
--        until Gate 1, and a form-level fix is one save away. Find them with:
--          select id, name from vizserve_pms_forms
--           where purpose = 'CLIENT_REQUEST' and is_active and default_pic_id is null;
--      * A PIC who has since left is not copied: the request waits for Gate 1
--        rather than naming somebody who will never see it.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after 20261104100000. Never `db:push`. Safe to
-- paste twice. Until it is pasted the app reads both new settings as off, and a team
-- leader's New survey is refused.


-- ---------------------------------------------------------------------------
-- 1. Team leaders' own surveys.
-- ---------------------------------------------------------------------------

-- Could this person own a survey routed here? Null is an unrouted draft, the same
-- allowance `forms insertable by team leaders` gives a lead on a client form.
create or replace function vizserve_pms_can_own_survey(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    when p_department_id is null then vizserve_pms_has_role('team_leader')
    else vizserve_pms_manages_department(p_department_id)
         or vizserve_pms_is_dept_admin(p_department_id)
  end
$$;

revoke all on function vizserve_pms_can_own_survey(uuid) from public, anon;
grant execute on function vizserve_pms_can_own_survey(uuid) to authenticated;

-- Their own, still. As DEFINER because the policies on these tables read this
-- from inside policies on `vizserve_pms_forms`, like `form_targets_me`.
create or replace function vizserve_pms_owns_survey(p_form_id uuid)
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
       and f.purpose = 'INTERNAL'
       and f.created_by = auth.uid()
       and vizserve_pms_can_own_survey(f.department_id)
  )
$$;

revoke all on function vizserve_pms_owns_survey(uuid) from public, anon;
grant execute on function vizserve_pms_owns_survey(uuid) to authenticated;

-- ADDED BESIDE the existing policies, which stay as they are: policies are OR-ed,
-- and the purpose tests in them still stop a client form converting into a survey.
drop policy if exists "surveys readable by their author" on vizserve_pms_forms;
create policy "surveys readable by their author"
  on vizserve_pms_forms for select to authenticated
  using (
    purpose = 'INTERNAL'
    and created_by = auth.uid()
    and vizserve_pms_can_own_survey(department_id)
  );

drop policy if exists "surveys creatable by leads" on vizserve_pms_forms;
create policy "surveys creatable by leads"
  on vizserve_pms_forms for insert to authenticated
  with check (
    purpose = 'INTERNAL'
    and created_by = auth.uid()
    and not audience_is_all_departments
    and vizserve_pms_can_own_survey(department_id)
  );

drop policy if exists "surveys editable by their author" on vizserve_pms_forms;
create policy "surveys editable by their author"
  on vizserve_pms_forms for update to authenticated
  using (
    purpose = 'INTERNAL'
    and created_by = auth.uid()
    and vizserve_pms_can_own_survey(department_id)
  )
  with check (
    purpose = 'INTERNAL'
    and created_by = auth.uid()
    and not audience_is_all_departments
    and vizserve_pms_can_own_survey(department_id)
  );

-- Without this the three above are decorative: `save_form_schema` is SECURITY INVOKER
-- and writes the field rows directly (see 20260902140000, A.3).
drop policy if exists "survey questions follow their author" on vizserve_pms_form_fields;
create policy "survey questions follow their author"
  on vizserve_pms_form_fields for all to authenticated
  using (vizserve_pms_owns_survey(form_id))
  with check (vizserve_pms_owns_survey(form_id));

drop policy if exists "survey answers readable by their author" on vizserve_pms_form_responses;
create policy "survey answers readable by their author"
  on vizserve_pms_form_responses for select to authenticated
  using (vizserve_pms_owns_survey(form_id));

-- `set_form_audience` is SECURITY INVOKER, so this is what lets it write for a lead,
-- and the department test is what keeps the list to departments they run.
drop policy if exists "survey audience follows its author" on vizserve_pms_form_audience_departments;
create policy "survey audience follows its author"
  on vizserve_pms_form_audience_departments for all to authenticated
  using (vizserve_pms_owns_survey(form_id))
  with check (
    vizserve_pms_owns_survey(form_id)
    and department_id is not null
    and vizserve_pms_can_own_survey(department_id)
  );


-- ---------------------------------------------------------------------------
-- 2. External respondents.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_forms
  add column if not exists accepts_external boolean not null default false;

comment on column vizserve_pms_forms.accepts_external is
  'P17-15. INTERNAL only. Anyone with the link may answer at /survey/<slug>, without '
  'logging in. Not is_public, which is what /request/<slug> serves.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'vizserve_pms_forms_external_is_internal'
       and conrelid = 'vizserve_pms_forms'::regclass
  ) then
    alter table vizserve_pms_forms
      add constraint vizserve_pms_forms_external_is_internal
      check (not accepts_external or purpose = 'INTERNAL');
  end if;
end
$$;

alter table vizserve_pms_form_responses
  add column if not exists is_external boolean not null default false,
  add column if not exists respondent_name text,
  add column if not exists respondent_email extensions.citext;

comment on column vizserve_pms_form_responses.is_external is
  'P17-15. Came through /survey/<slug>, not a login. submitted_by is null on these '
  'whatever the form''s is_anonymous says, so null no longer proves the form is anonymous.';
comment on column vizserve_pms_form_responses.respondent_name is
  'P17-15. External answers on a named form only. Typed by them, not verified.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'vizserve_pms_form_responses_respondent_is_external'
       and conrelid = 'vizserve_pms_form_responses'::regclass
  ) then
    alter table vizserve_pms_form_responses
      add constraint vizserve_pms_form_responses_respondent_is_external
      check (is_external or (respondent_name is null and respondent_email is null));
  end if;
end
$$;

-- The action has validated `p_field_values` against the stored schema; this holds
-- everything about the form itself, and re-reads it in the transaction that writes.
create or replace function vizserve_pms_submit_external_response(
  p_slug         text,
  p_field_values jsonb,
  p_name         text default null,
  p_email        text default null,
  p_ip           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form    vizserve_pms_forms;
  v_limits  vizserve_pms_public_submission_limits;
  v_name    text := nullif(btrim(coalesce(p_name, '')), '');
  v_email   text := nullif(btrim(coalesce(p_email, '')), '');
  v_recent  integer;
  v_ip_key  text;
begin
  select * into v_form
    from vizserve_pms_forms
   where slug = p_slug
     and purpose = 'INTERNAL'
     and accepts_external
     and is_active
     and archived_at is null;

  if v_form.id is null then
    return jsonb_build_object('ok', false, 'error', 'form_not_found');
  end if;

  if v_form.closes_on is not null
     and v_form.closes_on < (now() at time zone 'Asia/Manila')::date then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;

  select * into v_limits from vizserve_pms_public_submission_limits where id;

  -- On an anonymous form the log holds a hash of the address, per form, so the limit
  -- still counts without an IP sitting beside the answer's timestamp. Not proof
  -- against someone with database access and time; like the P17-11 note, the point
  -- is that no screen or export can make the link.
  v_ip_key := case
    when p_ip is null then null
    when v_form.is_anonymous then encode(sha256(convert_to(p_ip || v_form.id::text, 'UTF8')), 'hex')
    else p_ip
  end;

  select count(*) into v_recent
    from vizserve_pms_public_submission_log
   where v_ip_key is not null
     and ip = v_ip_key
     and form_id = v_form.id
     and created_at > now() - interval '1 hour';

  if v_recent >= v_limits.per_ip_per_hour then
    insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
    values (v_form.id, v_ip_key, null, false);
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Never kept on an anonymous form, whatever was sent.
  if v_form.is_anonymous then
    v_name := null;
    v_email := null;
  elsif v_name is null or coalesce(v_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'identity_required');
  end if;

  insert into vizserve_pms_form_responses
    (form_id, submitted_by, field_values, is_external, respondent_name, respondent_email)
  values (v_form.id, null, coalesce(p_field_values, '{}'::jsonb), true, v_name, v_email);

  insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
  values (v_form.id, v_ip_key, v_email, true);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function vizserve_pms_submit_external_response(text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function vizserve_pms_submit_external_response(text, jsonb, text, text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3. Every request has a PIC.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_forms
  add column if not exists default_pic_id uuid references vizserve_pms_users (id) on delete set null;

alter table vizserve_pms_requests
  add column if not exists pic_id uuid references vizserve_pms_users (id) on delete set null;

comment on column vizserve_pms_forms.default_pic_id is
  'P17-15. Client forms. Who each new request is put under. Required to publish.';
comment on column vizserve_pms_requests.pic_id is
  'P17-15. Person in charge. The form''s default on arrival, then the task''s assignee '
  'once there is a task. Null only on a form published before this existed, or whose '
  'default PIC has left.';

create index if not exists vizserve_pms_requests_pic_idx on vizserve_pms_requests (pic_id);

-- Only where the department's work can actually reach them, and refused at the
-- moment of publishing rather than found out when the first request arrives.
create or replace function vizserve_pms_forms_require_pic()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.purpose <> 'CLIENT_REQUEST' then
    return new;
  end if;

  if new.is_active and new.default_pic_id is null
     and (tg_op = 'INSERT' or not old.is_active or old.default_pic_id is not null) then
    raise exception 'Choose a default PIC on the Settings tab before publishing.'
      using errcode = 'check_violation';
  end if;

  if new.default_pic_id is not null
     and (
       tg_op = 'INSERT'
       or new.default_pic_id is distinct from old.default_pic_id
       or new.department_id is distinct from old.department_id
     )
     and not exists (
       select 1 from vizserve_pms_users u
        where u.id = new.default_pic_id
          and u.is_active
          and vizserve_pms_is_department_member(new.department_id, u.id)
     ) then
    raise exception 'The default PIC must be an active member of this form''s department.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_forms_require_pic on vizserve_pms_forms;
create trigger vizserve_pms_forms_require_pic
  before insert or update on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_require_pic();

create or replace function vizserve_pms_requests_set_pic()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.pic_id is null then
    select u.id into new.pic_id
      from vizserve_pms_forms f
      join vizserve_pms_users u on u.id = f.default_pic_id and u.is_active
     where f.id = new.form_id;
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_requests_set_pic on vizserve_pms_requests;
create trigger vizserve_pms_requests_set_pic
  before insert on vizserve_pms_requests
  for each row execute function vizserve_pms_requests_set_pic();

-- A form that skips approval tells nobody otherwise (P16-01), and no task will ever
-- tell the PIC. A form with approval tells them at Gate 1, as it always has.
insert into vizserve_pms_notification_events
  (key, flow, flow_label, flow_sort, stage_label, sort, notification_type, ends_flow, description)
select 'request.pic_assigned', e.flow, e.flow_label, e.flow_sort,
       'A no-approval form was answered', 90, e.notification_type, false,
       'A form that skips approval was answered, and you are its PIC.'
  from vizserve_pms_notification_events e
 where e.key = 'client.submitted'
on conflict (key) do nothing;

insert into vizserve_pms_notification_rules (event_key, audience_kind, audience, in_app, email, locked)
values ('request.pic_assigned', 'relationship', 'pic', true, true, false)
on conflict do nothing;

create or replace function vizserve_pms_requests_tell_pic()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.pic_id is not null
     and not exists (
       select 1 from vizserve_pms_forms f where f.id = new.form_id and f.requires_approval
     ) then
    perform vizserve_pms_emit(
      'request.pic_assigned',
      jsonb_build_object('pic', jsonb_build_array(new.pic_id)),
      new.title || ' (' || new.reference_no || ')',
      'From ' || new.requester_name,
      'request', new.id, '/requests/' || new.id::text
    );
  end if;
  return null;
end;
$$;

drop trigger if exists vizserve_pms_requests_tell_pic on vizserve_pms_requests;
create trigger vizserve_pms_requests_tell_pic
  after insert on vizserve_pms_requests
  for each row execute function vizserve_pms_requests_tell_pic();

-- A trigger rather than an edit to `vizserve_pms_approve_request`: the PIC can also
-- change on the task afterwards, and every route there goes through this column.
create or replace function vizserve_pms_tasks_sync_request_pic()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update vizserve_pms_requests
     set pic_id = new.assignee_id
   where id = new.request_id
     and new.assignee_id is not null
     and pic_id is distinct from new.assignee_id;
  return null;
end;
$$;

drop trigger if exists vizserve_pms_tasks_sync_request_pic on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_sync_request_pic
  after insert or update of assignee_id on vizserve_pms_tasks
  for each row
  when (new.request_id is not null)
  execute function vizserve_pms_tasks_sync_request_pic();

-- Requests already through Gate 1 have had a PIC all along, on their task.
update vizserve_pms_requests r
   set pic_id = t.assignee_id
  from vizserve_pms_tasks t
 where t.request_id = r.id
   and t.assignee_id is not null
   and r.pic_id is distinct from t.assignee_id;

-- A PIC below Team Leader needs to open what they are in charge of. Additive:
-- `requests readable in department scope` is unchanged.
drop policy if exists "requests readable by their PIC" on vizserve_pms_requests;
create policy "requests readable by their PIC"
  on vizserve_pms_requests for select to authenticated
  using (pic_id = auth.uid());
