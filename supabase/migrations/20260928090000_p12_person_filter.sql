-- P12 — THE PERSON FILTER ON THE TASK LIST AND BOARD.
--
-- "Show me Juan's tasks", "tasks where I am one of the assignees". A task has
-- three ways to hold a person — the PIC (`assignee_id`), the QA reviewer
-- (`qa_assignee_id`) and a row in `vizserve_pms_task_assignees` — and PostgREST
-- cannot OR a column test with an EXISTS on another table in one filter. The
-- only other way to say it is to fetch that person's task ids and send them
-- back as `id.in.(…)`, which is the unbounded-URL bug `task-filters.test.ts`
-- exists to keep out of this repo.
--
-- So the question is asked here, and PostgREST treats the result like the table:
-- the caller still chains `.select()`, `.eq()`, `.order()` and `.range()` on it.
--
-- ⚠️ SECURITY INVOKER. It returns only rows the tasks policy already returns to
-- the caller, and its EXISTS reads `vizserve_pms_task_assignees` under that
-- table's own policy. It widens nothing: filtering by a person the caller cannot
-- see simply returns fewer rows.
--
-- p_role:
--   'pic'      — the person in charge
--   'qa'       — the QA reviewer
--   'assignee' — on the task as a doer: the PIC, or a row in the assignee table
--   anything else ('any') — any of the three

create or replace function vizserve_pms_tasks_for_person(p_user uuid, p_role text default 'any')
returns setof vizserve_pms_tasks
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select t.*
    from vizserve_pms_tasks t
   where case p_role
           when 'pic' then t.assignee_id = p_user
           when 'qa' then t.qa_assignee_id = p_user
           when 'assignee' then
             t.assignee_id = p_user
             or exists (
               select 1 from vizserve_pms_task_assignees a
                where a.task_id = t.id and a.user_id = p_user
             )
           else
             t.assignee_id = p_user
             or t.qa_assignee_id = p_user
             or exists (
               select 1 from vizserve_pms_task_assignees a
                where a.task_id = t.id and a.user_id = p_user
             )
         end;
$$;

revoke all on function vizserve_pms_tasks_for_person(uuid, text) from public, anon;
grant execute on function vizserve_pms_tasks_for_person(uuid, text) to authenticated;

comment on function vizserve_pms_tasks_for_person(uuid, text) is
  'P12. The tasks a person is on, by role (pic | qa | assignee | any). SECURITY '
  'INVOKER: returns only rows the tasks policy already returns to the caller. '
  'Used as the base of the task list/board query when a person filter is set, '
  'so PostgREST filters, orders and pages it like the table.';
