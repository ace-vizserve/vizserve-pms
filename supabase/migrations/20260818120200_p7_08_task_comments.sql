-- P7-08 — a task can hold a conversation.
--
-- Until now the only text that travelled with a task was a transition comment
-- and the resolution field. Both are records of a decision; neither is a place
-- to ask "did the client ever send the logo?".
--
-- That was a defensible gap while ClickUp was still there to have the
-- conversation in. Under D21 it is not — this app IS the internal ClickUp, and
-- the discussion has to live next to the work.
--
-- Deliberately flat. No threads, no replies, no reactions, no mentions. A
-- department of sixteen people discussing one task does not need a tree, and
-- every one of those features is easier to add later than to remove.

create table vizserve_pms_task_comments (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references vizserve_pms_tasks (id) on delete cascade,
  author_id uuid not null references vizserve_pms_users (id) on delete restrict,

  body text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An empty comment is not a comment. Same shape as the note constraint on
  -- timesheet entries: whitespace is not content.
  constraint vizserve_pms_task_comments_body_present
    check (length(btrim(body)) > 0),

  -- Long enough for a paragraph of context, short enough that nobody pastes a
  -- document in and calls it a discussion.
  constraint vizserve_pms_task_comments_body_length
    check (length(body) <= 4000)
);

-- Read in one order, always: oldest first, down the task page.
create index vizserve_pms_task_comments_task_idx
  on vizserve_pms_task_comments (task_id, created_at);

create trigger vizserve_pms_task_comments_updated_at
  before update on vizserve_pms_task_comments
  for each row execute function vizserve_pms_set_updated_at();

alter table vizserve_pms_task_comments enable row level security;
revoke all on vizserve_pms_task_comments from anon;

-- ---------------------------------------------------------------------------
-- Scope follows the task, exactly like the status history does.
--
-- Not repeated as its own predicate: if you can see the task you can see the
-- conversation about it, and if you cannot, the conversation does not exist as
-- far as you are concerned. Writing a different rule here would eventually
-- drift from the one on the task and leak a comment about work somebody cannot
-- open.
-- ---------------------------------------------------------------------------
create policy "task comments follow their task"
  on vizserve_pms_task_comments for select to authenticated
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

-- Anyone who can see the task can comment on it, under their own name only.
-- `author_id = auth.uid()` is what stops a comment being posted as somebody
-- else, which no amount of UI care can prevent on its own.
create policy "task comments writable by people on the task"
  on vizserve_pms_task_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

-- Your own words, yours to fix or withdraw. A lead cannot edit or delete
-- somebody else's comment: moderation is not a feature anybody asked for, and
-- silently editable discussion is worse than none.
create policy "task comments editable by their author"
  on vizserve_pms_task_comments for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy "task comments deletable by their author"
  on vizserve_pms_task_comments for delete to authenticated
  using (author_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Telling the other people on the task.
--
-- A trigger rather than a call in a server action: a comment that notifies only
-- when it arrives through the app is a comment that silently notifies nobody
-- the first time anything else writes one.
--
-- Inbox only — `commented` is seeded `send_email = false` below. Docs/12 spends
-- the email budget on things that cross a boundary or block somebody; a
-- colleague adding a note to a shared task is neither.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_notify_task_comment()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task      vizserve_pms_tasks;
  v_author    text;
  v_recipient uuid;
begin
  select * into v_task from vizserve_pms_tasks where id = new.task_id;
  if v_task.id is null then return new; end if;

  select full_name into v_author from vizserve_pms_users where id = new.author_id;

  -- The PIC and the QA reviewer, never the author, never twice. A lead who is
  -- neither is not notified: they have the department view, and a comment on
  -- every task in the department is how an inbox becomes wallpaper.
  for v_recipient in
    select unnest(array[v_task.assignee_id, v_task.qa_assignee_id])
    except
    select new.author_id
  loop
    if v_recipient is not null then
      perform vizserve_pms_notify(
        v_recipient,
        'commented',
        coalesce(v_author, 'Somebody') || ' commented on ' || v_task.title,
        left(new.body, 200),
        'task',
        new.task_id,
        '/tasks/' || new.task_id::text
      );
    end if;
  end loop;

  return new;
end;
$$;

create trigger vizserve_pms_task_comments_notify
  after insert on vizserve_pms_task_comments
  for each row execute function vizserve_pms_notify_task_comment();

-- The enum value was added alone in 20260818120100; this is the first file that
-- may name it.
insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('commented', false, 'Somebody commented on a task you are on. Inbox only — discussion is not an interruption.')
on conflict (type) do nothing;

-- The grants incident (docs/13): default privileges do not reach tables created
-- by these migrations, and a missing GRANT reads as `permission denied for
-- table` while a failing policy returns zero rows. Never the same fix.
grant select, insert, update, delete on vizserve_pms_task_comments to authenticated;
