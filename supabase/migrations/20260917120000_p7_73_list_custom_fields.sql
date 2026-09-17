-- ---------------------------------------------------------------------------
-- P7-73 — custom fields on a list.
--
-- ClickUp's custom fields, as a feature reference (D21): a list carries fields
-- of seven types, every task in the list can hold a value for each, and the
-- task list shows them as columns that sort and filter.
--
-- AGREED WITH ACE, 17 Sep 2026:
--
--   * a field belongs to ONE list
--   * any member of the list's department manages its fields — the P11-07 rule
--     for lists themselves — and a personal list's owner manages theirs
--   * every field is OPTIONAL. "Required" was discussed and left out of v1: it
--     raises a question for every path a task can enter a list by (approval,
--     move, copy, subtask), and none of them is worth blocking yet. Adding it
--     later is a flag here and a check at create — nothing below changes.
--
-- WHERE THE VALUES LIVE. A jsonb column on the task, keyed by field id, rather
-- than a row per value. `/tasks` reads every task row in one query already, so
-- the values arrive with it; a separate table would mean a second read keyed by
-- a list of task ids, which is the URL-length failure P12-20 was about.
--
-- WHAT THE COLUMN IS NOT: `field_values`. That one is a snapshot of a client's
-- form answers taken at Gate 1 and is outside the UPDATE grant. These are the
-- team's own fields and they are edited constantly. Two columns, two meanings.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor (this machine is not linked).
-- Idempotent throughout.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The field definitions.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'vizserve_pms_list_field_type') then
    create type vizserve_pms_list_field_type as enum
      ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'DROPDOWN', 'LABELS', 'CHECKBOX');
  end if;
end;
$$;

create table if not exists vizserve_pms_list_fields (
  id          uuid primary key default gen_random_uuid(),
  -- `restrict`: lists are archived, never deleted, and a field's values are
  -- keyed to it on every task that ever held one.
  list_id     uuid not null references vizserve_pms_lists (id) on delete restrict,
  name        text not null,
  field_type  vizserve_pms_list_field_type not null,
  -- Dropdown and Labels only: `[{ "id", "label", "color", "is_active" }]`.
  -- ARRAY ORDER IS THE OPTION ORDER, and the column sorts by it — a dropdown of
  -- "Low, Medium, High" must not sort as "High, Low, Medium".
  options     jsonb not null default '[]'::jsonb,
  -- Number only. How many places the value is shown to.
  decimals    smallint,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_by  uuid references vizserve_pms_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint vizserve_pms_list_fields_name_present
    check (length(btrim(name)) between 1 and 60),
  constraint vizserve_pms_list_fields_options_are_an_array
    check (jsonb_typeof(options) = 'array'),
  constraint vizserve_pms_list_fields_options_only_on_choice_types
    check (field_type in ('DROPDOWN', 'LABELS') or options = '[]'::jsonb),
  constraint vizserve_pms_list_fields_decimals_only_on_numbers
    check (
      (field_type = 'NUMBER' and decimals between 0 and 4)
      or (field_type <> 'NUMBER' and decimals is null)
    )
);

create index if not exists vizserve_pms_list_fields_list_idx
  on vizserve_pms_list_fields (list_id, sort_order);

-- Two active fields called "Stage" on one list would be two columns nobody can
-- tell apart. An archived one may share the name of its replacement.
create unique index if not exists vizserve_pms_list_fields_name_per_list
  on vizserve_pms_list_fields (list_id, lower(btrim(name))) where is_active;

drop trigger if exists vizserve_pms_list_fields_updated_at on vizserve_pms_list_fields;
create trigger vizserve_pms_list_fields_updated_at
  before update on vizserve_pms_list_fields
  for each row execute function vizserve_pms_set_updated_at();

-- P11-03's condition for widening edits was that everything is audited.
drop trigger if exists vizserve_pms_list_fields_audit_update on vizserve_pms_list_fields;
create trigger vizserve_pms_list_fields_audit_update
  after update on vizserve_pms_list_fields
  for each row execute function vizserve_pms_audit_row_update('list_field', '{updated_at}');

comment on table vizserve_pms_list_fields is
  'P7-73. A custom field on one list. Values live in vizserve_pms_tasks.custom_fields, keyed by this id. Archived via is_active, never deleted.';


-- ---------------------------------------------------------------------------
-- 2. The values.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_tasks
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vizserve_pms_tasks_custom_fields_object'
  ) then
    alter table vizserve_pms_tasks
      add constraint vizserve_pms_tasks_custom_fields_object
      check (jsonb_typeof(custom_fields) = 'object');
  end if;
end;
$$;

comment on column vizserve_pms_tasks.custom_fields is
  'P7-73. The team''s own custom field values, keyed by vizserve_pms_list_fields.id. Not field_values, which is the client''s form snapshot.';

-- ADDITIVE, per 20260818140100_p7_11a_restore_task_grants.sql. The existing
-- `vizserve_pms_tasks_audit_update` trigger logs every change to it.
grant update (custom_fields) on vizserve_pms_tasks to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Who manages a list's fields.
--
-- The same people who may create and rename lists: a lead of the department, a
-- department admin, any active member of it (P11-07) — and, on a personal list,
-- only its owner (P11-06). Department clauses never reach a personal list
-- (P11-10), and that holds here too.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_can_manage_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_lists l
     where l.id = p_list_id
       and (
         (
           l.owner_id is null
           and (
             vizserve_pms_manages_department(l.department_id)
             or vizserve_pms_is_dept_admin(l.department_id)
             or exists (
               select 1 from vizserve_pms_users u
                where u.id = auth.uid()
                  and u.is_active
                  and u.primary_department_id = l.department_id
             )
           )
         )
         or (
           l.owner_id = auth.uid()
           and exists (select 1 from vizserve_pms_users u where u.id = auth.uid() and u.is_active)
         )
       )
  )
$$;

revoke all on function vizserve_pms_can_manage_list(uuid) from public, anon;
grant execute on function vizserve_pms_can_manage_list(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. RLS on the definitions.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_list_fields enable row level security;

revoke all on vizserve_pms_list_fields from anon;
grant select, insert, update on vizserve_pms_list_fields to authenticated;
-- Archived, never deleted: a field's id is a key in every task that held a
-- value for it.
revoke delete on vizserve_pms_list_fields from authenticated;
grant all privileges on vizserve_pms_list_fields to service_role;

-- Readable by whoever can read the list — OR any task in it. A colleague from
-- another department assigned to a task can open that task without being able
-- to read the list, and the fields on the task page must not go blank for them.
-- Both subqueries run under the caller's own RLS, so neither widens anything.
drop policy if exists "list fields readable with their list" on vizserve_pms_list_fields;
create policy "list fields readable with their list"
  on vizserve_pms_list_fields for select to authenticated
  using (
    exists (select 1 from vizserve_pms_lists l where l.id = list_id)
    or exists (select 1 from vizserve_pms_tasks t where t.list_id = vizserve_pms_list_fields.list_id)
  );

drop policy if exists "list fields creatable by the list's managers" on vizserve_pms_list_fields;
create policy "list fields creatable by the list's managers"
  on vizserve_pms_list_fields for insert to authenticated
  with check (vizserve_pms_can_manage_list(list_id));

drop policy if exists "list fields editable by the list's managers" on vizserve_pms_list_fields;
create policy "list fields editable by the list's managers"
  on vizserve_pms_list_fields for update to authenticated
  using (vizserve_pms_can_manage_list(list_id))
  with check (vizserve_pms_can_manage_list(list_id));


-- ---------------------------------------------------------------------------
-- 5. The definition guard.
--
--   * options are well-formed: an id, a label, one of the six chip tones, and an
--     active flag; ids unique
--   * an option is ARCHIVED, never removed — tasks hold its id
--   * `list_id` never moves
--   * `field_type` never changes once any task holds a value: "3" as a Number
--     would otherwise become a Date nobody can read
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_list_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_option jsonb;
  v_ids    text[] := '{}';
  v_id     text;
begin
  for v_option in select value from jsonb_array_elements(new.options) loop
    if jsonb_typeof(v_option) <> 'object'
       or jsonb_typeof(v_option -> 'id') <> 'string'
       or length(v_option ->> 'id') = 0
       or jsonb_typeof(v_option -> 'label') <> 'string'
       or length(btrim(v_option ->> 'label')) not between 1 and 80
       or coalesce(v_option ->> 'color', '') not in ('neutral', 'brand', 'info', 'success', 'warning', 'danger')
       or jsonb_typeof(v_option -> 'is_active') <> 'boolean'
    then
      raise exception 'Every option needs a label of up to 80 characters and a colour.'
        using errcode = 'check_violation';
    end if;

    if (v_option ->> 'id') = any (v_ids) then
      raise exception 'Two options share an id.' using errcode = 'check_violation';
    end if;
    v_ids := v_ids || (v_option ->> 'id');
  end loop;

  if tg_op = 'UPDATE' then
    if new.list_id <> old.list_id then
      raise exception 'A field cannot move to another list.' using errcode = 'check_violation';
    end if;

    for v_id in select value ->> 'id' from jsonb_array_elements(old.options) loop
      if not (v_id = any (v_ids)) then
        raise exception 'An option cannot be removed once it exists — archive it instead, so tasks that hold it keep their value.'
          using errcode = 'restrict_violation';
      end if;
    end loop;

    if new.field_type <> old.field_type and exists (
      select 1 from vizserve_pms_tasks t where t.custom_fields ? old.id::text
    ) then
      raise exception 'The type of "%" cannot change: tasks already hold values for it. Archive it and add a new field instead.',
        old.name
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_list_fields_guard on vizserve_pms_list_fields;
create trigger vizserve_pms_list_fields_guard
  before insert or update on vizserve_pms_list_fields
  for each row execute function vizserve_pms_list_fields_guard();


-- ---------------------------------------------------------------------------
-- 6. The value guard.
--
-- Only keys that CHANGED are checked. A task moved to another list keeps the
-- old list's values untouched — they are not shown there, and they come back if
-- it moves back — and an option archived after a task picked it stays valid on
-- that task. What is refused is WRITING a value that does not fit: a field of
-- another list, an archived field or option, or the wrong shape for the type.
--
-- SECURITY DEFINER so the check reads every field regardless of the caller's
-- RLS on the definitions. It only refuses; it returns nothing to anybody.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_tasks_custom_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key    text;
  v_value  jsonb;
  v_field  vizserve_pms_list_fields;
  v_item   jsonb;
  v_active text[];
  v_seen   text[];
begin
  for v_key, v_value in select key, value from jsonb_each(new.custom_fields) loop
    if tg_op = 'UPDATE' and old.custom_fields -> v_key is not distinct from v_value then
      continue;
    end if;

    select * into v_field
      from vizserve_pms_list_fields f
     where f.id::text = v_key;

    if v_field.id is null then
      raise exception 'That custom field does not exist.' using errcode = 'check_violation';
    end if;
    if not v_field.is_active then
      raise exception 'The field "%" is archived.', v_field.name using errcode = 'check_violation';
    end if;
    if new.list_id is distinct from v_field.list_id then
      raise exception 'The field "%" belongs to a different list.', v_field.name
        using errcode = 'check_violation';
    end if;

    select coalesce(array_agg(o ->> 'id'), '{}') into v_active
      from jsonb_array_elements(v_field.options) o
     where (o ->> 'is_active')::boolean;

    case v_field.field_type
      when 'TEXT' then
        if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 500 then
          raise exception '"%" takes one line of text, up to 500 characters.', v_field.name
            using errcode = 'check_violation';
        end if;
      when 'TEXTAREA' then
        if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 10000 then
          raise exception '"%" takes text up to 10,000 characters.', v_field.name
            using errcode = 'check_violation';
        end if;
      when 'NUMBER' then
        if jsonb_typeof(v_value) <> 'number' then
          raise exception '"%" takes a number.', v_field.name using errcode = 'check_violation';
        end if;
      when 'DATE' then
        if jsonb_typeof(v_value) <> 'string'
           or (v_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'
           or to_char(to_date(v_value #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') <> (v_value #>> '{}')
        then
          raise exception '"%" takes a date.', v_field.name using errcode = 'check_violation';
        end if;
      when 'CHECKBOX' then
        if jsonb_typeof(v_value) <> 'boolean' then
          raise exception '"%" is a checkbox.', v_field.name using errcode = 'check_violation';
        end if;
      when 'DROPDOWN' then
        if jsonb_typeof(v_value) <> 'string' or not ((v_value #>> '{}') = any (v_active)) then
          raise exception 'Pick one of the options for "%".', v_field.name
            using errcode = 'check_violation';
        end if;
      when 'LABELS' then
        if jsonb_typeof(v_value) <> 'array' then
          raise exception 'Pick labels from the options for "%".', v_field.name
            using errcode = 'check_violation';
        end if;
        v_seen := '{}';
        for v_item in select value from jsonb_array_elements(v_value) loop
          if jsonb_typeof(v_item) <> 'string'
             or not ((v_item #>> '{}') = any (v_active))
             or (v_item #>> '{}') = any (v_seen)
          then
            raise exception 'Pick labels from the options for "%", each once.', v_field.name
              using errcode = 'check_violation';
          end if;
          v_seen := v_seen || (v_item #>> '{}');
        end loop;
    end case;
  end loop;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_tasks_custom_fields_guard on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_custom_fields_guard
  before insert or update of custom_fields on vizserve_pms_tasks
  for each row execute function vizserve_pms_tasks_custom_fields_guard();


-- ---------------------------------------------------------------------------
-- 7. Setting one value.
--
-- ⚠️ ONE KEY, ATOMICALLY. A plain `update set custom_fields = <whole object>`
-- from the browser is a lost update the moment two people edit two different
-- fields on one task: the second save writes back the first person's old value.
-- `||` and `-` change only the key named.
--
-- SECURITY INVOKER: the task UPDATE policy (P11-03) and the column grant above
-- decide who may, exactly as for every other task edit.
--
-- An empty value CLEARS the field — null, "", [] and false alike — so "no value"
-- has one representation and filters and sorts never have to tell them apart.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_set_task_field(
  p_task_id  uuid,
  p_field_id uuid,
  p_value    jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_clear boolean := p_value is null
    or p_value = 'null'::jsonb
    or p_value = '""'::jsonb
    or p_value = '[]'::jsonb
    or p_value = 'false'::jsonb
    or (jsonb_typeof(p_value) = 'string' and btrim(p_value #>> '{}') = '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  update vizserve_pms_tasks
     set custom_fields = case
           when v_clear then custom_fields - p_field_id::text
           else custom_fields || jsonb_build_object(p_field_id::text, p_value)
         end
   where id = p_task_id;

  if not found then
    raise exception 'That task does not exist, or you cannot edit it.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function vizserve_pms_set_task_field(uuid, uuid, jsonb) from public, anon;
grant execute on function vizserve_pms_set_task_field(uuid, uuid, jsonb) to authenticated;
