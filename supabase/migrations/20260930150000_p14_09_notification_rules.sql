-- P14-09 — PER-STAGE NOTIFICATION RULES, PHASE 1: THE SCHEMA (30 Sep 2026).
--
-- Every stage of every process becomes an EVENT, and each event carries RULES:
-- who is told, with separate in-app and email switches. Admin edits them in
-- /admin/settings, grouped by process.
--
--   relationship  someone the process itself names (the requester, the PIC,
--                 the QA, the relievers, whoever the step waits on…). The
--                 calling function supplies the people; the rule says whether
--                 and how they are told.
--   role          everyone who HOLDS the role, whatever they are acting as.
--   user          one named person.
--
-- LOCKED rules are the people a step is waiting on: their in-app notification
-- cannot be switched off (a constraint says so), because one wrong untick would
-- stall approvals silently. Their email can.
--
-- THIS PHASE CHANGES NOTHING ANYBODY RECEIVES. The seeded rules reproduce
-- today's recipients, and every email switch is copied from the current
-- per-type settings so switches already flipped in production carry over.
-- Nothing calls vizserve_pms_emit until P14-10.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_08. Never `db:push`.


-- ===========================================================================
-- 1. EVENTS — the catalogue. Written by migrations, never by the app.
-- ===========================================================================
create table if not exists vizserve_pms_notification_events (
  key               text primary key,
  flow              text not null,
  flow_label        text not null,
  flow_sort         integer not null,
  stage_label       text not null,
  sort              integer not null,
  notification_type vizserve_pms_notification_type not null,
  ends_flow         boolean not null default false,
  description       text not null default ''
);

comment on table vizserve_pms_notification_events is
  'P14-09. One row per stage of a process that can notify anybody. The catalogue '
  'the notification settings screen is built from. Migrations only.';

alter table vizserve_pms_notification_events enable row level security;
revoke all on vizserve_pms_notification_events from anon;
grant select on vizserve_pms_notification_events to authenticated;
grant all on vizserve_pms_notification_events to service_role;

drop policy if exists "notification events readable by admin" on vizserve_pms_notification_events;
create policy "notification events readable by admin"
  on vizserve_pms_notification_events for select to authenticated
  using ((select vizserve_pms_is_system_admin()));


-- ===========================================================================
-- 2. RULES — who is told at each event.
-- ===========================================================================
create table if not exists vizserve_pms_notification_rules (
  id            uuid primary key default gen_random_uuid(),
  event_key     text not null references vizserve_pms_notification_events (key) on delete cascade,
  audience_kind text not null check (audience_kind in ('relationship', 'role', 'user')),
  audience      text,
  user_id       uuid references vizserve_pms_users (id) on delete cascade,
  in_app        boolean not null default true,
  email         boolean not null default false,
  locked        boolean not null default false,
  updated_at    timestamptz not null default now(),

  constraint vizserve_pms_notification_rules_shape check (
    (audience_kind = 'user' and user_id is not null and audience is null)
    or (audience_kind in ('relationship', 'role') and audience is not null and user_id is null)
  ),
  -- A step's waiting person is always told in-app.
  constraint vizserve_pms_notification_rules_locked_in_app check (not locked or in_app),
  -- Only the process itself names relationships; a locked row is one of those.
  constraint vizserve_pms_notification_rules_locked_is_relationship
    check (not locked or audience_kind = 'relationship')
);

create unique index if not exists vizserve_pms_notification_rules_one_per_audience
  on vizserve_pms_notification_rules (
    event_key, audience_kind, coalesce(audience, ''),
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

comment on table vizserve_pms_notification_rules is
  'P14-09. Who is told at each notification event, in-app and by email. Edited by '
  'Admin on /admin/settings. Resolved by vizserve_pms_emit().';

create or replace function vizserve_pms_notification_rules_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists vizserve_pms_notification_rules_touch on vizserve_pms_notification_rules;
create trigger vizserve_pms_notification_rules_touch
  before update on vizserve_pms_notification_rules
  for each row execute function vizserve_pms_notification_rules_touch();

-- A relationship row's identity is fixed: its switches may change, never who it
-- is about.
create or replace function vizserve_pms_notification_rules_guard()
returns trigger
language plpgsql
as $$
begin
  if old.audience_kind = 'relationship'
     and (new.audience_kind, new.audience, new.event_key, new.locked)
         is distinct from (old.audience_kind, old.audience, old.event_key, old.locked) then
    raise exception 'A process recipient can be switched on or off, not changed.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_notification_rules_guard on vizserve_pms_notification_rules;
create trigger vizserve_pms_notification_rules_guard
  before update on vizserve_pms_notification_rules
  for each row execute function vizserve_pms_notification_rules_guard();

alter table vizserve_pms_notification_rules enable row level security;
revoke all on vizserve_pms_notification_rules from anon;
grant select, insert, update, delete on vizserve_pms_notification_rules to authenticated;
grant all on vizserve_pms_notification_rules to service_role;

drop policy if exists "notification rules readable by admin" on vizserve_pms_notification_rules;
drop policy if exists "notification rules insertable by admin" on vizserve_pms_notification_rules;
drop policy if exists "notification rules updatable by admin" on vizserve_pms_notification_rules;
drop policy if exists "notification rules deletable by admin" on vizserve_pms_notification_rules;

create policy "notification rules readable by admin"
  on vizserve_pms_notification_rules for select to authenticated
  using ((select vizserve_pms_is_system_admin()));

-- Admin adds ROLE and PERSON recipients; relationships come from migrations.
create policy "notification rules insertable by admin"
  on vizserve_pms_notification_rules for insert to authenticated
  with check ((select vizserve_pms_is_system_admin()) and audience_kind <> 'relationship');

create policy "notification rules updatable by admin"
  on vizserve_pms_notification_rules for update to authenticated
  using ((select vizserve_pms_is_system_admin()))
  with check ((select vizserve_pms_is_system_admin()));

create policy "notification rules deletable by admin"
  on vizserve_pms_notification_rules for delete to authenticated
  using ((select vizserve_pms_is_system_admin()) and audience_kind <> 'relationship');


-- ===========================================================================
-- 3. NOTIFICATIONS CARRY AN IN-APP FLAG.
--
-- A row can now be email-only. The inbox reads `in_app` (P14-09 app change);
-- the email outbox is unchanged and still reads `send_email`.
-- ===========================================================================
alter table vizserve_pms_notifications
  add column if not exists in_app boolean not null default true;


-- ===========================================================================
-- 4. EMIT — the one way a process notifies anybody once P14-10 lands.
--
-- p_people: {"<relationship>": [uuid, …], …} — the people the calling process
-- names. Every rule for the event is resolved to people, merged per person (if
-- any rule says in-app, they get in-app; same for email), live accounts only,
-- minus p_exclude (usually the actor), and written as one row each.
-- ===========================================================================
create or replace function vizserve_pms_emit(
  p_event       text,
  p_people      jsonb,
  p_title       text,
  p_body        text default '',
  p_entity_type text default null,
  p_entity_id   uuid default null,
  p_link_path   text default null,
  p_exclude     uuid[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_type  vizserve_pms_notification_type;
  v_count integer;
begin
  select e.notification_type into v_type
    from vizserve_pms_notification_events e
   where e.key = p_event;

  if v_type is null then
    raise exception 'Unknown notification event %.', p_event using errcode = 'invalid_parameter_value';
  end if;

  with rules as (
    select * from vizserve_pms_notification_rules r where r.event_key = p_event
  ),
  candidates as (
    select nullif(person, '')::uuid as user_id, r.in_app, r.email
      from rules r,
           jsonb_array_elements_text(coalesce(p_people -> r.audience, '[]'::jsonb)) as person
     where r.audience_kind = 'relationship'
    union all
    select h.user_id, r.in_app, r.email
      from rules r
      join vizserve_pms_user_roles h on h.role::text = r.audience
     where r.audience_kind = 'role'
    union all
    select r.user_id, r.in_app, r.email
      from rules r
     where r.audience_kind = 'user'
  ),
  merged as (
    select c.user_id, bool_or(c.in_app) as in_app, bool_or(c.email) as email
      from candidates c
     where c.user_id is not null
       and not (c.user_id = any(coalesce(p_exclude, '{}')))
     group by c.user_id
    having bool_or(c.in_app) or bool_or(c.email)
  )
  insert into vizserve_pms_notifications
    (user_id, type, send_email, in_app, title, body, entity_type, entity_id, link_path)
  select m.user_id, v_type, m.email, m.in_app, p_title, coalesce(p_body, ''),
         p_entity_type, p_entity_id, p_link_path
    from merged m
   where vizserve_pms_account_is_live(m.user_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function vizserve_pms_emit(text, jsonb, text, text, text, uuid, text, uuid[]) from public, anon, authenticated;


-- ===========================================================================
-- 5. THE CATALOGUE.
-- ===========================================================================
insert into vizserve_pms_notification_events
  (key, flow, flow_label, flow_sort, stage_label, sort, notification_type, ends_flow, description)
values
  -- Client requests
  ('client.submitted',         'client_request', 'Client requests', 1, 'Submitted — waiting on Gate 1',   1, 'pending_approval', false, 'A client submitted a request.'),
  ('client.gate1_approved',    'client_request', 'Client requests', 1, 'Gate 1 approved',                 2, 'request_approved', false, 'The Team Leader approved it and it became a task.'),
  ('client.approved',          'client_request', 'Client requests', 1, 'Client approved',                 3, 'client_decision',  true,  'The client approved the work. The request is complete.'),
  ('client.changes_requested', 'client_request', 'Client requests', 1, 'Client asked for changes',        4, 'client_decision',  false, 'The client sent the work back.'),
  ('client.no_response',       'client_request', 'Client requests', 1, 'Closed with no client response',  5, 'client_decision',  true,  'The approval window passed without a reply.'),
  -- Leave
  ('leave.reliever_asked',     'leave', 'Leave', 2, 'Relievers asked to cover',   1, 'pending_approval',  false, 'The requester named relievers for their work.'),
  ('leave.team_leader_step',   'leave', 'Leave', 2, 'Waiting on the Team Leader', 2, 'pending_approval',  false, ''),
  ('leave.manager_step',       'leave', 'Leave', 2, 'Waiting on the Manager',     3, 'pending_approval',  false, ''),
  ('leave.approved',           'leave', 'Leave', 2, 'Approved',                   4, 'internal_decision', true,  ''),
  ('leave.rejected',           'leave', 'Leave', 2, 'Rejected',                   5, 'internal_decision', true,  ''),
  ('leave.withdrawn',          'leave', 'Leave', 2, 'Withdrawn',                  6, 'internal_decision', false, 'The requester took it back.'),
  -- Overtime, corrections, reimbursement
  ('internal.team_leader_step', 'internal', 'Overtime, corrections and reimbursements', 3, 'Waiting on the Team Leader', 1, 'pending_approval',  false, ''),
  ('internal.manager_step',     'internal', 'Overtime, corrections and reimbursements', 3, 'Waiting on the Manager',     2, 'pending_approval',  false, ''),
  ('internal.approved',         'internal', 'Overtime, corrections and reimbursements', 3, 'Approved',                   3, 'internal_decision', true,  ''),
  ('internal.rejected',         'internal', 'Overtime, corrections and reimbursements', 3, 'Rejected',                   4, 'internal_decision', true,  ''),
  ('internal.withdrawn',        'internal', 'Overtime, corrections and reimbursements', 3, 'Withdrawn',                  5, 'internal_decision', false, 'The requester took it back.'),
  -- Timesheets
  ('timesheet.submitted',      'timesheet', 'Timesheets', 4, 'Submitted — waiting on the Manager', 1, 'pending_approval',  false, ''),
  ('timesheet.approved',       'timesheet', 'Timesheets', 4, 'Approved',                           2, 'internal_decision', true,  ''),
  ('timesheet.returned',       'timesheet', 'Timesheets', 4, 'Sent back',                          3, 'internal_decision', false, ''),
  ('timesheet.withdrawn',      'timesheet', 'Timesheets', 4, 'Submission cancelled',               4, 'internal_decision', false, ''),
  -- Tasks
  ('task.assigned',            'task', 'Tasks', 5, 'Assigned to someone',    1, 'assigned',     false, 'Made PIC, or added to the task.'),
  ('task.qa_assigned',         'task', 'Tasks', 5, 'Made QA on a new task',  2, 'qa_requested', false, ''),
  ('task.ready_for_qa',        'task', 'Tasks', 5, 'Ready for QA',           3, 'qa_requested', false, ''),
  ('task.qa_returned',         'task', 'Tasks', 5, 'Sent back by QA',        4, 'qa_returned',  false, ''),
  ('task.mentioned',           'task', 'Tasks', 5, 'Mentioned in a comment', 5, 'mentioned',    false, ''),
  ('task.commented',           'task', 'Tasks', 5, 'New comment',            6, 'commented',    false, '')
on conflict (key) do update
   set flow = excluded.flow, flow_label = excluded.flow_label, flow_sort = excluded.flow_sort,
       stage_label = excluded.stage_label, sort = excluded.sort,
       notification_type = excluded.notification_type, ends_flow = excluded.ends_flow,
       description = excluded.description;


-- ===========================================================================
-- 6. TODAY'S RECIPIENTS, AS RULES.
--
-- (event, relationship, locked). Email is copied from the current per-type
-- switch for the event's notification type, so nothing anybody receives changes.
-- ===========================================================================
insert into vizserve_pms_notification_rules (event_key, audience_kind, audience, in_app, email, locked)
select v.event_key, 'relationship', v.audience, true,
       coalesce((select s.send_email from vizserve_pms_notification_type_settings s
                  where s.type = e.notification_type), false),
       v.locked
  from (values
    ('client.submitted',         'dept_team_leaders', true),
    ('client.gate1_approved',    'dept_team_leaders', false),
    ('client.approved',          'pic',               false),
    ('client.approved',          'qa',                false),
    ('client.approved',          'assignees',         false),
    ('client.approved',          'dept_team_leaders', false),
    ('client.changes_requested', 'pic',               true),
    ('client.no_response',       'pic',               false),
    ('client.no_response',       'qa',                false),

    ('leave.reliever_asked',     'relievers',         true),
    ('leave.team_leader_step',   'approvers',         true),
    ('leave.manager_step',       'approvers',         true),
    ('leave.approved',           'requester',         false),
    ('leave.rejected',           'requester',         false),
    ('leave.withdrawn',          'affected',          false),

    ('internal.team_leader_step', 'approvers',        true),
    ('internal.manager_step',     'approvers',        true),
    ('internal.approved',         'requester',        false),
    ('internal.rejected',         'requester',        false),
    ('internal.withdrawn',        'affected',         false),

    ('timesheet.submitted',      'approvers',         true),
    ('timesheet.approved',       'owner',             false),
    ('timesheet.returned',       'owner',             true),
    ('timesheet.withdrawn',      'approvers',         false),

    ('task.assigned',            'assignee',          true),
    ('task.qa_assigned',         'qa',                true),
    ('task.ready_for_qa',        'qa',                true),
    ('task.qa_returned',         'pic',               true),
    ('task.mentioned',           'mentioned',         false),
    ('task.commented',           'pic_and_qa',        false)
  ) as v(event_key, audience, locked)
  join vizserve_pms_notification_events e on e.key = v.event_key
on conflict do nothing;


-- ===========================================================================
-- 7. THE SIDEBAR'S UNREAD BADGE COUNTS IN-APP ROWS ONLY.
--
-- p12_01's function verbatim, plus `and n.in_app`: an email-only row must not
-- show as an unread item the inbox then refuses to list.
-- ===========================================================================
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
      and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
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
