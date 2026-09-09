import { z } from "zod";

import { taskPrioritySchema, taskStatusSchema } from "@/lib/schemas/tasks";

/**
 * P12-07 CONTRACT — what `/tasks` and `/tasks/board` read, once the reads are
 * the browser's.
 *
 * The D3a handoff artefact for the two task views, and the sibling of
 * `lib/schemas/task-detail.ts`. Read that file's header first: every argument
 * there applies here unchanged, and the short version is that moving a read into
 * the browser does NOT move the generated `Database` types with it — `read()`
 * hands back whatever PostgREST sent, and a column renamed, dropped from a
 * `.select()` string or returned in a shape this deploy does not expect arrives
 * as `undefined` with no type error anywhere. On these two surfaces that renders
 * as a board of unassigned, undated cards, which is a lie about eighty people's
 * work rather than an error somebody can report.
 *
 * ⚠️ THE FIELD NAMES ARE THE DATABASE'S, snake_case and unrenamed, because
 * `tasks-table.tsx` and the board have taken the row's own names since P3-03 and
 * a mapping layer here would be one more thing to drift.
 *
 * ⚠️ TWO OF THESE SCHEMAS ARE SHARED WITH `/tasks/[id]` and moved here from its
 * contract file for exactly that reason — `visibleListSchema` and
 * `directoryPersonSchema` below. A shape three surfaces read out of ONE cache
 * entry cannot live in the contract of one of them.
 */

/**
 * The columns `/tasks` selects for a row.
 *
 * ⚠️ EXACTLY THE FIFTEEN THE RSC SELECTED, and `tasks-table.tsx`'s own `TaskRow`
 * type is the shape this has to satisfy — a diff of the two is what keeps the
 * table from reading `undefined` off a column nobody dropped on purpose.
 * `resolution` is fetched and never rendered: the status control needs it to
 * answer "is the P3-07 resolution gate met", which is why it is in the select
 * string of a table that shows no prose.
 */
export const taskListRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: taskStatusSchema,
  due_date: z.string().nullable(),
  start_date: z.string().nullable(),
  assignee_id: z.uuid().nullable(),
  qa_assignee_id: z.uuid().nullable(),
  department_id: z.uuid(),
  created_by: z.uuid().nullable(),
  list_id: z.uuid().nullable(),
  request_id: z.uuid().nullable(),
  is_personal: z.boolean(),
  priority: taskPrioritySchema,
  estimate_minutes: z.number().int().nullable(),
  parent_task_id: z.uuid().nullable(),
  resolution: z.string().nullable(),
});

export type TaskListRow = z.infer<typeof taskListRowSchema>;

/**
 * The board's card, which is the list's row minus two columns and plus one.
 *
 * `output_link` earns its place — the card draws a link glyph for it — and
 * `estimate_minutes` does not, because a card has no estimate column. Stated as
 * its own schema rather than reusing the list's: the two `.select()` strings
 * genuinely differ, and a shared schema would have to make real columns optional
 * to cover both, which is how a missing column stops being a parse failure.
 */
export const boardTaskRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: taskStatusSchema,
  due_date: z.string().nullable(),
  start_date: z.string().nullable(),
  assignee_id: z.uuid().nullable(),
  qa_assignee_id: z.uuid().nullable(),
  department_id: z.uuid(),
  created_by: z.uuid().nullable(),
  request_id: z.uuid().nullable(),
  is_personal: z.boolean(),
  priority: taskPrioritySchema,
  output_link: z.string().nullable(),
  parent_task_id: z.uuid().nullable(),
  list_id: z.uuid().nullable(),
  resolution: z.string().nullable(),
});

export type BoardTaskRow = z.infer<typeof boardTaskRowSchema>;

/**
 * K5 — one child row, for the progress bar.
 *
 * ⚠️ FETCHED RATHER THAN DERIVED FROM THE ROWS ON SCREEN, and both surfaces say
 * why at their call sites: a status filter or the `mine` view hides most
 * children, and the board excludes the two terminal statuses outright, so
 * counting from the visible rows would report 0/3 on a task whose three subtasks
 * are all finished.
 */
export const taskChildRowSchema = z.object({
  id: z.uuid(),
  parent_task_id: z.uuid().nullable(),
  status: taskStatusSchema,
});

export type TaskChildRow = z.infer<typeof taskChildRowSchema>;

/**
 * P7-08 / K5 — one comment on one of the visible tasks.
 *
 * `task_id` is what makes this different from the detail page's version: the
 * whole thread of every row comes back in ONE query and is bucketed by task in
 * the browser. A query per row is an N+1 on the page people leave open all day.
 */
export const listCommentRowSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  /** Rich text. Sanitised at RENDER — see `lib/rich-text-dom.ts`. */
  body: z.string(),
  author_id: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ListCommentRow = z.infer<typeof listCommentRowSchema>;

/** P7-13 — one person on one visible task, from the join table. */
export const taskAssigneeLinkSchema = z.object({
  task_id: z.uuid(),
  user_id: z.uuid(),
});

export type TaskAssigneeLink = z.infer<typeof taskAssigneeLinkSchema>;

/**
 * P9-01 — who is holding one of these tasks while its owner is away.
 *
 * The detail page's version of this schema carries `absent_user_id` because it
 * writes a sentence naming both people; the list draws a monogram and needs the
 * reliever and the last day. Same view, two readings.
 */
export const listCoverageRowSchema = z.object({
  task_id: z.uuid(),
  reliever_id: z.uuid(),
  end_date: z.string(),
});

export type ListCoverageRow = z.infer<typeof listCoverageRowSchema>;

/**
 * K5 — DATE CLOSED, WHICH NEEDS NO COLUMN.
 *
 * `vizserve_pms_task_status_history` already records the move to COMPLETED /
 * COMPLETED_NO_RESPONSE with its timestamp, so reading it from there cannot
 * disagree with the trail — which a `completed_at` column eventually would.
 */
export const taskClosedRowSchema = z.object({
  task_id: z.uuid(),
  to_status: taskStatusSchema,
  created_at: z.string(),
});

export type TaskClosedRow = z.infer<typeof taskClosedRowSchema>;

/**
 * `qk.listsVisible()` — one active list the reader may see.
 *
 * ⚠️ THE SUPERSET, AND THAT IS THE WHOLE POINT OF THE SHAPE. It was `{id, name}`
 * under `qk.lists(departmentId)` while `/tasks/[id]` was the only browser reader
 * (see the note on `fetchVisibleLists`). The three extra columns are each one
 * consumer's: `group_id` for the folder filter (P7-18), `owner_id` for the
 * P11-06 split that keeps personal lists out of the filter dropdown while
 * leaving them in the breadcrumb and the row labels, and `department_id` for the
 * detail page's move picker, which offers the task's OWN department's lists
 * because that is the set the server will accept.
 */
export const visibleListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  group_id: z.uuid().nullable(),
  owner_id: z.uuid().nullable(),
  department_id: z.uuid(),
});

export type VisibleList = z.infer<typeof visibleListSchema>;

/** P7-18 — one folder, for the filter panel. `qk.ref("task-groups")`. */
export const taskFolderSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type TaskFolder = z.infer<typeof taskFolderSchema>;

/**
 * `qk.ref("users")` — one person in the directory, ACTIVE OR NOT.
 *
 * ⚠️ `is_active` IS A COLUMN HERE RATHER THAN A FILTER IN THE QUERY, and
 * `fetchDirectory` argues it: the people who leave are exactly the people whose
 * old comments and history rows still need a name, so the map that resolves
 * those has to hold them. Every consumer that offers somebody a SEAT — the
 * composer, the assignee picker, the reassign candidates — filters on this
 * column itself, and must, because each narrows by department in the same pass.
 */
export const directoryPersonSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  primary_department_id: z.uuid().nullable(),
  is_active: z.boolean(),
});

export type DirectoryPerson = z.infer<typeof directoryPersonSchema>;

/**
 * P7-26 — one request still waiting on Gate 1, as the task views show it.
 *
 * ⚠️ THE EMBED IS `!inner` AND IT IS NOT DECORATION. The form carries
 * `default_list_id` — the list this request's task will land in — which is what
 * the `?list=` filter goes through. `formName` is read for nothing on these two
 * surfaces today and is selected because `PendingRequest` has always carried it;
 * dropping a field while moving a query is how a later reader finds it missing.
 *
 * ⚠️ THIS SHAPE IS THE VIEWS' READING OF A REQUEST, NOT `/requests`'. Phase 4
 * gives that screen a far wider row under a key of its own — see
 * `qk.pendingRequests` for why the two must not share one.
 */
export const pendingRequestRowSchema = z.object({
  id: z.uuid(),
  reference_no: z.string(),
  title: z.string(),
  requester_name: z.string(),
  requester_org: z.string().nullable(),
  target_date: z.string().nullable(),
  submitted_at: z.string().nullable(),
  vizserve_pms_forms: z
    .object({ name: z.string(), default_list_id: z.uuid().nullable() })
    .nullable(),
});

export type PendingRequestRow = z.infer<typeof pendingRequestRowSchema>;
