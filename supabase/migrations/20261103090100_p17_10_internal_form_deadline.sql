-- P17-10 — a deadline on an internal form, a count in the sidebar, and an email
-- telling people the form is there (3 Nov 2026).
--
-- DEADLINE. `closes_on` is the last day an answer is taken, in Manila time. It is
-- optional, so every form that exists today stays open exactly as it was. The
-- INSERT policy is what closes a form; the screens only say so.
--
-- THE SIDEBAR COUNT. A member holds no SELECT on `vizserve_pms_form_responses`
-- (it is admin-read since 20260902140000), so "have I answered this?" has to be
-- asked through a SECURITY DEFINER function. It answers only about forms the
-- caller may already see, and only about the caller's own rows.
--
-- ⚠️ AN ANONYMOUS FORM CANNOT SAY WHO HAS ANSWERED. Its `submitted_by` is NULL by
-- policy and that is the promise on the page. So it is returned with its flag and
-- the browser takes it off the count once that browser has answered it
-- (`lib/form-builder/answered-here.ts`), which tells the server nothing. Recording
-- "this person answered" here, even in another table, would make the sentence
-- "nothing that identifies you" untrue, because the two writes line up in time.
--
-- THE EMAILS go through the ordinary outbox: `vizserve_pms_send_form_reminders`
-- writes notifications, `dispatch-emails` sends them within fifteen minutes.
--   New form    once, within the hour of being published.
--   Reminders   three days before the deadline and the day before, to whoever has
--               not answered. On an anonymous form that is the whole audience,
--               and the email says why.
-- It is a cron rather than a trigger on publish because the settings card writes
-- the audience AFTER the form row: a trigger would read the old audience and could
-- email the whole company about a survey that was being narrowed to one team.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after 20261103090000. Never `db:push`. Safe
-- to paste twice. Until it is pasted the app behaves as before: no deadline control,
-- no count, and the cron route reports that the function is missing.


alter table vizserve_pms_forms
  add column if not exists closes_on date,
  add column if not exists announced_at timestamptz,
  add column if not exists reminders_sent smallint not null default 0;

comment on column vizserve_pms_forms.closes_on is
  'P17-10. Internal forms only. Last day an answer is accepted, Manila time. Null means it stays open.';
comment on column vizserve_pms_forms.announced_at is
  'P17-10. When the audience was told this form exists. Null on a form still to be announced.';
comment on column vizserve_pms_forms.reminders_sent is
  'P17-10. 0 none, 1 the three-day reminder, 2 the last-day reminder. Reset when closes_on moves.';

alter table vizserve_pms_forms drop constraint if exists vizserve_pms_forms_closes_on_is_internal;
alter table vizserve_pms_forms
  add constraint vizserve_pms_forms_closes_on_is_internal
  check (closes_on is null or purpose = 'INTERNAL');

alter table vizserve_pms_forms drop constraint if exists vizserve_pms_forms_reminders_sent_range;
alter table vizserve_pms_forms
  add constraint vizserve_pms_forms_reminders_sent_range
  check (reminders_sent between 0 and 2);

-- Forms already live are not news. Without this, the first run after the paste
-- would email the audience of every internal form ever published.
update vizserve_pms_forms
   set announced_at = now()
 where purpose = 'INTERNAL'
   and is_active
   and announced_at is null;


-- A moved deadline is a new deadline: its reminders are owed again.
create or replace function vizserve_pms_forms_reset_reminders()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.closes_on is distinct from old.closes_on then
    new.reminders_sent := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_forms_reset_reminders on vizserve_pms_forms;
create trigger vizserve_pms_forms_reset_reminders
  before update on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_reset_reminders();


-- 20260902140000's policy with one condition added: the deadline.
drop policy if exists "form responses insertable by their author"
  on vizserve_pms_form_responses;

create policy "form responses insertable by their author"
  on vizserve_pms_form_responses for insert to authenticated
  with check (
    exists (
      select 1
        from vizserve_pms_forms f
       where f.id = form_id
         and f.purpose = 'INTERNAL'
         and f.is_active
         and (f.closes_on is null or f.closes_on >= (now() at time zone 'Asia/Manila')::date)
         and vizserve_pms_form_targets_me(f.id)
         and case
               when f.is_anonymous then submitted_by is null
               else submitted_by = auth.uid()
             end
    )
  );


-- Does this form ask anything? A form published before it has questions, or with
-- only headings and pictures, must not be counted or announced: there is nothing
-- to answer. The same test `splitCanvasFields` makes on the fill page.
create or replace function vizserve_pms_form_has_questions(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_form_fields ff
     where ff.form_id = p_form_id
       and ff.is_active
       and ff.field_type::text not in ('section', 'image', 'youtube')
  )
$$;

revoke all on function vizserve_pms_form_has_questions(uuid) from public, anon;
grant execute on function vizserve_pms_form_has_questions(uuid) to authenticated, service_role;


-- The forms still waiting on the caller, soonest deadline first.
create or replace function vizserve_pms_forms_awaiting_me()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', f.id, 'isAnonymous', f.is_anonymous)
      order by f.closes_on nulls last, f.name
    ),
    '[]'::jsonb
  )
  from vizserve_pms_forms f
  where f.purpose = 'INTERNAL'
    and f.is_active
    and (f.closes_on is null or f.closes_on >= (now() at time zone 'Asia/Manila')::date)
    and vizserve_pms_current_role() is not null
    and vizserve_pms_form_targets_me(f.id)
    and vizserve_pms_form_has_questions(f.id)
    and (
      f.is_anonymous
      or not exists (
        select 1
          from vizserve_pms_form_responses r
         where r.form_id = f.id
           and r.submitted_by = auth.uid()
      )
    )
$$;

revoke all on function vizserve_pms_forms_awaiting_me() from public, anon;
grant execute on function vizserve_pms_forms_awaiting_me() to authenticated;


-- The catalogue, so both show on /admin/settings beside every other stage.
insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('form_reminder', true,
   'P17-10. An internal form was published, or its deadline is close and you have not answered.')
on conflict (type) do nothing;

insert into vizserve_pms_notification_events
  (key, flow, flow_label, flow_sort, stage_label, sort, notification_type, ends_flow, description)
values
  ('form.published', 'internal_form', 'Internal forms', 6, 'A new form to answer', 1, 'form_reminder', false,
   'An internal form was published.'),
  ('form.reminder',  'internal_form', 'Internal forms', 6, 'Reminder before the deadline', 2, 'form_reminder', false,
   'Three days before the deadline and the day before, to whoever has not answered.')
on conflict (key) do update
   set flow = excluded.flow, flow_label = excluded.flow_label, flow_sort = excluded.flow_sort,
       stage_label = excluded.stage_label, sort = excluded.sort,
       notification_type = excluded.notification_type, ends_flow = excluded.ends_flow,
       description = excluded.description;

insert into vizserve_pms_notification_rules (event_key, audience_kind, audience, in_app, email, locked)
values
  ('form.published', 'relationship', 'form_audience', true, true, false),
  ('form.reminder',  'relationship', 'form_audience', true, true, false)
on conflict do nothing;


-- Run hourly by /api/cron/form-reminders. Service role only.
create or replace function vizserve_pms_send_form_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_today     date := (now() at time zone 'Asia/Manila')::date;
  v_form      record;
  v_days      integer;
  v_stage     smallint;
  v_when      text;
  v_people    jsonb;
  v_announced integer := 0;
  v_reminded  integer := 0;
begin
  -- Nobody wants a survey reminder at three in the morning. Whatever is owed is
  -- still owed at the next run inside these hours.
  if extract(hour from now() at time zone 'Asia/Manila') not between 8 and 18 then
    return jsonb_build_object('skipped', 'outside working hours');
  end if;

  for v_form in
    select f.*
      from vizserve_pms_forms f
     where f.purpose = 'INTERNAL'
       and f.is_active
       and (f.closes_on is null or f.closes_on >= v_today)
       and (f.announced_at is null or f.closes_on is not null)
       and vizserve_pms_form_has_questions(f.id)
       for update of f skip locked
  loop
    v_days := v_form.closes_on - v_today;
    v_stage := case
      when v_days is null then 0
      when v_days <= 1 then 2
      when v_days <= 3 then 1
      else 0
    end;

    -- Announced already, and this stage's reminder has gone. The usual case.
    if v_form.announced_at is not null and v_stage <= v_form.reminders_sent then
      continue;
    end if;

    v_when := case
      when v_days = 0 then 'today'
      when v_days = 1 then 'tomorrow'
      else 'on ' || to_char(v_form.closes_on, 'FMDD Mon YYYY')
    end;

    -- `form_targets_me` asks about the caller; a cron has no caller, so the same
    -- rule is stated for everybody. An anonymous form has no authors to subtract.
    select coalesce(jsonb_agg(u.id), '[]'::jsonb)
      into v_people
      from vizserve_pms_users u
     where u.is_active
       and (
         v_form.audience_is_all_departments
         or exists (
           select 1
             from vizserve_pms_form_audience_departments a
            where a.form_id = v_form.id
              and a.department_id = u.primary_department_id
         )
       )
       and (
         v_form.is_anonymous
         or not exists (
           select 1
             from vizserve_pms_form_responses r
            where r.form_id = v_form.id
              and r.submitted_by = u.id
         )
       );

    if v_form.announced_at is null then
      perform vizserve_pms_emit(
        'form.published',
        jsonb_build_object('form_audience', v_people),
        'New internal survey: ' || v_form.name,
        'We have an internal survey for you to answer: ' || v_form.name || '.'
          || case
               when v_days is null then ''
               else ' It closes ' || v_when || '.'
             end,
        'form', v_form.id, '/respond/' || v_form.slug
      );
      v_announced := v_announced + 1;

      -- The announcement already states the deadline, so a form published close
      -- to it does not get a second email an hour later.
      update vizserve_pms_forms
         set announced_at = now(),
             reminders_sent = greatest(reminders_sent, v_stage)
       where id = v_form.id;
    else
      perform vizserve_pms_emit(
        'form.reminder',
        jsonb_build_object('form_audience', v_people),
        'Reminder: ' || v_form.name || ' closes ' || v_when,
        case
          when v_form.is_anonymous then
            'If you have not answered the internal survey ' || v_form.name || ' yet, please do. '
              || 'It closes ' || v_when || '. Answers are anonymous, so we cannot tell who has '
              || 'answered. If you already have, you can ignore this.'
          else
            'We still need your answer to the internal survey ' || v_form.name || '. '
              || 'It closes ' || v_when || '.'
        end,
        'form', v_form.id, '/respond/' || v_form.slug
      );
      v_reminded := v_reminded + 1;

      update vizserve_pms_forms
         set reminders_sent = v_stage
       where id = v_form.id;
    end if;
  end loop;

  return jsonb_build_object('announced', v_announced, 'reminded', v_reminded);
end;
$$;

revoke all on function vizserve_pms_send_form_reminders() from public, anon, authenticated;
grant execute on function vizserve_pms_send_form_reminders() to service_role;


-- The rail reads it with everything else. 20261007110100's function, verbatim,
-- plus `forms_to_answer`.
create or replace function vizserve_pms_sidebar_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
with
  open_by_list as (
    select t.list_id, count(*)::int as n
    from vizserve_pms_tasks t
    where t.list_id is not null
      and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
    group by t.list_id
  ),
  -- P7-26. A pending request has no task; it is counted against the list it
  -- WILL land in, through its form.
  pending_by_list as (
    select f.default_list_id as list_id, count(*)::int as n
    from vizserve_pms_requests r
    join vizserve_pms_forms f on f.id = r.form_id
    where r.status = 'PENDING_REVIEW'
      and f.default_list_id is not null
    group by f.default_list_id
  ),
  dept_list as (
    select
      l.id,
      l.name,
      l.department_id,
      l.group_id,
      l.sort_order,
      coalesce(o.n, 0) as open_tasks,
      coalesce(p.n, 0) as pending_requests,
      jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'openTasks', coalesce(o.n, 0),
        'pendingRequests', coalesce(p.n, 0)
      ) as node
    from vizserve_pms_lists l
    left join open_by_list o on o.list_id = l.id
    left join pending_by_list p on p.list_id = l.id
    -- P11-06: a personal list carries a department but is not part of its tree.
    where l.owner_id is null
      and l.is_active
  ),
  folder as (
    select
      g.id,
      g.department_id,
      g.is_system,
      g.sort_order,
      g.name,
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'isSystem', g.is_system,
        'lists', coalesce(held.items, '[]'::jsonb),
        'openTasks', coalesce(held.open_tasks, 0),
        'pendingRequests', coalesce(held.pending_requests, 0)
      ) as node
    from vizserve_pms_task_groups g
    left join lateral (
      select
        jsonb_agg(l.node order by l.sort_order, l.name) as items,
        sum(l.open_tasks)::int as open_tasks,
        sum(l.pending_requests)::int as pending_requests,
        count(*)::int as n
      from dept_list l
      where l.group_id = g.id
        and l.department_id = g.department_id
    ) held on true
    where g.is_active
      -- The reserved folder is dropped while empty, and only that one.
      and (not g.is_system or coalesce(held.n, 0) > 0)
  )
select jsonb_build_object(
  -- RLS ("notifications read own") scopes this to the caller.
  'unread', (
    select count(*)::int
    from vizserve_pms_notifications n
    where n.read_at is null
      and n.in_app
  ),
  -- P7-50. Scoped by the requests policy, exactly as the old head count was.
  'awaiting_review', (
    select count(*)::int
    from vizserve_pms_requests r
    where r.status = 'PENDING_REVIEW'
  ),
  -- P17-10. Not a number: the browser takes off the anonymous ones it answered.
  'forms_to_answer', vizserve_pms_forms_awaiting_me(),
  'spaces', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'departmentId', d.id,
               'departmentName', d.name,
               -- Folderless lists, rendered ABOVE the folders.
               'lists', coalesce((
                 select jsonb_agg(l.node order by l.sort_order, l.name)
                 from dept_list l
                 where l.department_id = d.id
                   and l.group_id is null
               ), '[]'::jsonb),
               -- System folder last, tie-broken on the flag, not sort_order.
               'folders', coalesce((
                 select jsonb_agg(f.node order by f.is_system, f.sort_order, f.name)
                 from folder f
                 where f.department_id = d.id
               ), '[]'::jsonb)
             )
             order by d.name
           )
    from vizserve_pms_departments d
    where d.is_active
  ), '[]'::jsonb),
  -- P11-06. The caller's own lists, archived included: the Personal group is
  -- the only place a member can un-archive one.
  'personal', coalesce((
    select jsonb_agg(
             jsonb_build_object('id', l.id, 'name', l.name, 'isActive', l.is_active)
             order by l.sort_order, l.name
           )
    from vizserve_pms_lists l
    where l.owner_id = auth.uid()
  ), '[]'::jsonb)
);
$$;
