-- P17-03 — reactions on a task comment (22 Oct 2026).
--
-- P7-08 wrote it down: "reactions need their own table". This is that table.
-- A 👍 under "uploaded the final cut" says "seen, thanks" without a second
-- comment that says exactly that and buries the thread.
--
-- THE SHAPE. One row per (comment, person, reaction). Pressing the same one
-- again deletes the row; there is no "update", so there is no UPDATE grant.
--
-- ⚠️ A FIXED SET, ENFORCED HERE. Six reaction ids, checked by a constraint —
-- ids rather than emoji characters, because the bar draws them as icons
-- (`components/ui/reactions.tsx`). A free picker would be the front end
-- deciding what is stored, and the front end will be bypassed (CLAUDE.md).
-- `COMMENT_REACTIONS` in `lib/schemas/tasks.ts` mirrors this list; change both
-- or neither.
--
-- ⚠️ `task_id` IS CARRIED ON THE ROW, and the INSERT policy checks it matches
-- the comment's. It is there so the thread reads its reactions with ONE
-- `task_id = X` filter instead of an `in (…every comment id…)` list in the URL
-- — the shape that broke at 444 ids in P9-05.
--
-- WHO SEES AND WHO REACTS: whoever can read the comment, which is whoever can
-- read the task — the same rule the comment policies use (P11-06). You remove
-- only your own reaction; nobody else's.
--
-- No audit trigger and no notification. A reaction changes nobody's work, and
-- an email for every 👍 is exactly what P8 set out to stop sending.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. The thread
-- reads this table in its own query and simply draws no reaction bar until it
-- exists, so deploy and paste can happen in either order.


create table if not exists vizserve_pms_task_comment_reactions (
  comment_id uuid not null references vizserve_pms_task_comments (id) on delete cascade,
  -- Denormalised from the comment; see the note above. Cascades with the task,
  -- which every task-delete function relies on (they delete comments, and the
  -- comment cascade reaches this table either way).
  task_id    uuid not null references vizserve_pms_tasks (id) on delete cascade,
  user_id    uuid not null references vizserve_pms_users (id) on delete cascade,
  reaction   text not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id, reaction),
  constraint vizserve_pms_task_comment_reactions_reaction_check
    check (reaction in ('like', 'love', 'celebrate', 'laugh', 'seen', 'done'))
);

create index if not exists vizserve_pms_task_comment_reactions_task_idx
  on vizserve_pms_task_comment_reactions (task_id);

comment on table vizserve_pms_task_comment_reactions is
  'P17-03. Reactions on a task comment. One row per comment, person and '
  'reaction; un-reacting deletes it. Readable by whoever can read the task.';

-- Both gates (CLAUDE.md): privileges first, then policies.
alter table vizserve_pms_task_comment_reactions enable row level security;
revoke all on vizserve_pms_task_comment_reactions from anon;
grant select, insert, delete on vizserve_pms_task_comment_reactions to authenticated;
grant all on vizserve_pms_task_comment_reactions to service_role;


drop policy if exists "comment reactions follow their task" on vizserve_pms_task_comment_reactions;
create policy "comment reactions follow their task"
  on vizserve_pms_task_comment_reactions for select to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

-- The comment must exist, be readable (its own policy follows the task), and
-- belong to the task the row names — otherwise `task_id` could be pointed at a
-- task the reaction is not on and the thread would draw it in the wrong place.
drop policy if exists "comment reactions added by the reader" on vizserve_pms_task_comment_reactions;
create policy "comment reactions added by the reader"
  on vizserve_pms_task_comment_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from vizserve_pms_task_comments c
       where c.id = comment_id and c.task_id = vizserve_pms_task_comment_reactions.task_id
    )
  );

drop policy if exists "comment reactions removed by their author" on vizserve_pms_task_comment_reactions;
create policy "comment reactions removed by their author"
  on vizserve_pms_task_comment_reactions for delete to authenticated
  using (user_id = auth.uid());
