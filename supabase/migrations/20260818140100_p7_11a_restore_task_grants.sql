-- P7-11a — repairing the column UPDATE grant that P7-11 narrowed.
--
-- WHAT WENT WRONG, because the shape of this mistake will recur.
--
-- `20260818140000_p7_11_task_priority.sql` needed `priority` to be writable, and
-- did it the way 20260803130000_p3_tasks_qa.sql:191-196 does: revoke the whole
-- UPDATE privilege, then grant a fresh column list. It copied that list from the
-- P3 migration and appended `priority`.
--
-- But the list in P3 was no longer the list in the database. Two later
-- migrations had extended it ADDITIVELY, with no revoke:
--
--   20260818120000_p7_06_task_flexibility.sql:67  grant update (start_date)
--   20260818120300_p7_09_subtasks.sql:82          grant update (parent_task_id)
--
-- Neither appears anywhere near the P3 statement, so copying that statement
-- silently dropped both. The result was not an error: `start_date` and
-- `parent_task_id` simply became read-only for `authenticated` across the whole
-- application, and a policy-refused column UPDATE surfaces as a PostgREST error
-- only for a direct write — every screen that set a start date or nested a
-- subtask just stopped working. `tests/db/tasks.test.ts` caught it on the first
-- run after P7-11 was applied, in the P7-06 and P7-09 blocks.
--
-- THE RULE THIS ESTABLISHES: on `vizserve_pms_tasks`, column UPDATE grants are
-- ADDITIVE. Write `grant update (new_column) on vizserve_pms_tasks to
-- authenticated;` and nothing else. The revoke-then-restate form in P3 was
-- correct exactly once — when it was establishing the list for the first time —
-- and every use of it since is a chance to drop a column nobody notices for a
-- week. A statement whose correctness depends on remembering every other
-- migration that touched the same privilege is a statement that will be wrong.
--
-- This migration restates the list once more, because that is the only way to
-- get back to a known-good set from here. It is intended to be the LAST such
-- restatement.

grant update (
  -- P3-06, the original list.
  title, description, resolution, output_link,
  due_date, assignee_id, qa_assignee_id, list_id,
  -- P7-06 — the two P7-11 dropped.
  start_date,
  -- P7-09.
  parent_task_id,
  -- P7-11, the column that started all this.
  priority
) on vizserve_pms_tasks to authenticated;

-- Still absent, and still deliberately: `status` (the state machine is real
-- only because this column cannot be written directly) and `is_personal` (a
-- member who could flip it could reclassify assigned work as personal and close
-- it without review). Also absent: `request_id`, `department_id`,
-- `field_values`, `created_by` — none of which is a person's to edit after the
-- fact.
