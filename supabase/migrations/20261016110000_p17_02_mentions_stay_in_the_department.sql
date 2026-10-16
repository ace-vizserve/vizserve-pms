-- P17-02 — an @ mention stays inside the task's department (16 Oct 2026).
--
-- Kurt (VizBytes) could be @-mentioned on a VizMedia task. Two branches of
-- `vizserve_pms_task_mention_candidates` reached across departments:
--   * `u.role >= 'admin'` — every Admin, Business Manager and CEO was
--     mentionable on every task in the company;
--   * clause B, "within the actor's reach" — the commenter's own team and every
--     team they lead, whatever department the TASK is in.
-- Both are removed. Who may be mentioned on a task is now:
--   1–2. anybody on it (PIC, QA, co-assignees) — named on the work, so in range
--   3.   an active member of the task's department, main or sub (P17-01)
--   4.   a Team Leader who leads the task's department
--   6.   everybody, when the task is in a collaboration space (P13-01)
--
-- ONE RULE, BOTH ENDS: the picker (`vizserve_pms_mentionable_for_task`) and the
-- notifier (`vizserve_pms_notify_task_comment`, which intersects the names in
-- the body with this set) both read this function, so a typed-in @name for
-- somebody outside it is simply not notified.
--
-- Also: `vizserve_pms_mentionable_for_task` gains the P17-01 branch, or a sub
-- member's picker opened empty on their sub department's tasks.
--
-- Each function is its latest definition with only the marked changes.
-- ⚠️ APPLY BY HAND in the SQL editor, after P17-01. Never `db:push`.

-- vizserve_pms_task_mention_candidates — 20261016090000_p17_01_sub_departments.sql
create or replace function vizserve_pms_task_mention_candidates(
  p_task_id  uuid,
  p_actor_id uuid
)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select u.id, u.full_name
    from vizserve_pms_users u
   where u.is_active
     and (
       -- A. in range of the task
       exists (
         select 1
           from vizserve_pms_tasks t
          where t.id = p_task_id
            and (
              -- 1. on the task by name
              u.id = t.assignee_id
              or u.id = t.qa_assignee_id

              -- 2. on the task by the join table (P7-13)
              or exists (
                select 1 from vizserve_pms_task_assignees a
                 where a.task_id = t.id and a.user_id = u.id
              )

              -- 3. in the task's department (P11-03)
              or (
                t.department_id is not null
                and vizserve_pms_is_department_member(t.department_id, u.id)
              )

              -- 4. a Team Leader who leads the task's department. Spelled out
              --    rather than calling vizserve_pms_manages_department, which
              --    answers about `auth.uid()` and this asks about `u`.
              --    P17-02: the `u.role >= 'admin'` branch is gone — an Admin,
              --    Business Manager or CEO outside the department is not offered.
              or (
                u.role >= 'team_leader'
                and t.department_id is not null
                and exists (
                  select 1 from vizserve_pms_user_managed_departments md
                   where md.user_id = u.id
                     and md.department_id = t.department_id
                )
              )

              -- 6. P13-01 - THE TASK IS IN A COLLABORATION SPACE, so everybody
              --    active is in range of it. Clause 3 above asks
              --    `u.primary_department_id = t.department_id`, and nobody's
              --    primary department is the shared space (section 2) - so
              --    without this the roster for a company-wide task held only
              --    the people already named on it, and `@` in the one place
              --    built for working across teams offered almost nobody.
              or vizserve_pms_is_shared_department(t.department_id)
            )
       )

       -- P17-02. CLAUSE B (the actor's own reach) IS GONE. It offered the
       -- commenter's own team, every team they lead, and — for an Admin — the
       -- whole company, on every task. A mention now stays inside the task's
       -- department. `p_actor_id` is kept so the signature does not change.
       and p_actor_id is not null
       and exists (
         select 1 from vizserve_pms_users actor
          where actor.id = p_actor_id and actor.is_active
       )
     );
$fn$;


-- vizserve_pms_mentionable_for_task — 20260921090000_p13_01_collaboration_space.sql
create or replace function vizserve_pms_mentionable_for_task(p_task_id uuid)
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_task vizserve_pms_tasks;
begin
  select * into v_task from vizserve_pms_tasks t where t.id = p_task_id;
  if v_task.id is null then return; end if;

  if not (
    vizserve_pms_is_on_task(p_task_id, auth.uid())
    or (
      not v_task.is_personal
      and (
        vizserve_pms_manages_department(v_task.department_id)
        or v_task.department_id = vizserve_pms_my_department()
        -- P17-02. A sub member comments on that department's work too.
        or vizserve_pms_also_works_in(v_task.department_id)
        -- P13-01. The guard asks "may you comment here at all", and in a
        -- collaboration space everybody may. Without it the function returns
        -- EMPTY rather than refusing, so the picker would open on "No one to
        -- mention here" for a task the reader can plainly edit.
        or vizserve_pms_may_collaborate(v_task.department_id)
      )
    )
  ) then
    return;
  end if;

  return query
    -- The caller is the actor. There is no form of this that lets somebody ask
    -- about anybody else's reach — that is the whole reason the function below
    -- takes an actor and this one does not.
    select c.id, c.full_name
      from vizserve_pms_task_mention_candidates(p_task_id, auth.uid()) c
     -- Not yourself. Mentioning the person typing is a notification nobody
     -- needs, and a name in the list that does nothing reads as a bug.
     where c.id is distinct from auth.uid()
     order by c.full_name;
end;
$fn$;
