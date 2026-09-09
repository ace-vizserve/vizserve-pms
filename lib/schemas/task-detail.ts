import { z } from "zod";

import { taskPrioritySchema, taskStatusSchema } from "@/lib/schemas/tasks";

/**
 * P12-06 CONTRACT — what `/tasks/[id]` reads, once the reads are the browser's.
 *
 * The D3a handoff artefact for the task detail page, and the direct descendant
 * of `lib/schemas/sidebar.ts`. Read that file's header first: the argument is
 * the same one, and it is the whole reason this file exists rather than a set of
 * `as` casts over PostgREST results.
 *
 * ⚠️ THESE ARE PARSED, NOT CAST, AND THAT IS THE POINT. Until this phase the
 * page read its rows in an RSC with the generated `Database` types, so the shape
 * was checked at the seam where the query was written. Moving the read into the
 * browser does NOT move that check with it — `read()` hands back whatever
 * PostgREST sent, and a column renamed, dropped from a `.select()` string, or
 * returned in a shape the deploy does not expect arrives as `undefined` with no
 * type error anywhere. On this page that would render as an unassigned task with
 * no dates and an empty history, which is a lie about somebody's work rather
 * than an error they can report.
 *
 * ⚠️ AND THE PARSE IS WHAT KEEPS THE DEPLOY-ORDER WINDOW SURVIVABLE. Migrations
 * here are pasted by hand AFTER the code ships (CLAUDE.md), so the window in
 * which this build expects a column or a function the database has not been
 * given yet is routine. A parse failure throws, `read()`'s contract puts it in
 * `isError`, and the surface can say it could not load instead of drawing an
 * empty task.
 *
 * ⚠️ THE FIELD NAMES ARE THE DATABASE'S, snake_case and unrenamed, because the
 * components on this page have taken the row's own names since P3-05 and a
 * mapping layer here would be one more thing to drift. The sidebar contract took
 * the opposite decision for the opposite reason — its SQL emits the component
 * prop names — and both are documented at the seam.
 */

/**
 * The task row itself: `qk.task(id)`.
 *
 * Exactly the columns `app/(app)/tasks/[id]/page.tsx` selected before this
 * phase. Nothing was added while moving it, so a diff of the two `.select()`
 * strings is a diff of nothing.
 */
export const taskRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  /** Rich text (P7-56). Sanitised at RENDER — see `lib/rich-text-dom.ts`. */
  description: z.string().nullable(),
  status: taskStatusSchema,
  /** Rich text, and the P3-07 gate reads the SAVED value of it. */
  resolution: z.string().nullable(),
  output_link: z.string().nullable(),
  due_date: z.string().nullable(),
  start_date: z.string().nullable(),
  assignee_id: z.uuid().nullable(),
  qa_assignee_id: z.uuid().nullable(),
  department_id: z.uuid(),
  list_id: z.uuid().nullable(),
  request_id: z.uuid().nullable(),
  is_personal: z.boolean(),
  priority: taskPrioritySchema,
  estimate_minutes: z.number().int().nullable(),
  /**
   * The snapshot of the client's answers taken at approval. Read by nothing on
   * this page — the panel deliberately shows the REQUEST's answers, not this
   * copy (see `page.tsx`) — but selected because it always was, and dropping a
   * column while moving a query is how a later reader finds it missing.
   */
  field_values: z.unknown().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.string(),
});

export type TaskRow = z.infer<typeof taskRowSchema>;

/**
 * P9-01 — who is holding this task while somebody is away.
 *
 * From `vizserve_pms_active_task_coverage`, which is `security_invoker`: a
 * reader who cannot see the leave request gets no row, which is the right answer
 * for a request whose reason they have no business reading. Ordinarily empty.
 */
export const taskCoverageSchema = z.object({
  reliever_id: z.uuid(),
  absent_user_id: z.uuid(),
  end_date: z.string(),
});

export type TaskCoverage = z.infer<typeof taskCoverageSchema>;

/**
 * One move in the trail: `qk.taskPart(id, "history")`.
 *
 * `actor_id` is NULLABLE and it is not an oversight — `vizserve_pms_decide_task`
 * writes the client's decision with a null actor, because the client is a real
 * actor with no user row and attributing it to whoever happened to be signed in
 * would be a lie in the one record a dispute turns on.
 */
export const taskHistoryEntrySchema = z.object({
  id: z.uuid(),
  from_status: taskStatusSchema.nullable(),
  to_status: taskStatusSchema,
  actor_id: z.uuid().nullable(),
  comment: z.string().nullable(),
  is_override: z.boolean(),
  created_at: z.string(),
});

export type TaskHistoryEntry = z.infer<typeof taskHistoryEntrySchema>;

/**
 * Gate 3, as the client left it.
 *
 * ⚠️ READ AND USED ONLY ALONGSIDE THE HISTORY, which is why it shares that key
 * rather than owning one. `vizserve_pms_decide_task` writes BOTH rows in one
 * statement — a history row carrying the client's comment, a decisions row
 * carrying the same comment plus the approver's name — so the page reads this
 * for the NAME and nothing else, matched on the timestamp the two inserts share
 * because they are the same transaction.
 */
export const clientDecisionSchema = z.object({
  id: z.uuid(),
  /** The enum, not a string: `GateTrack` takes `VizservePmsClientDecision`. */
  decision: z.enum(["APPROVED", "REVISION_REQUESTED", "AUTO_COMPLETED"]),
  comment: z.string().nullable(),
  approver_name: z.string().nullable(),
  created_at: z.string(),
});

export type ClientDecision = z.infer<typeof clientDecisionSchema>;

/** One comment: `qk.taskPart(id, "comments")`. Oldest first out of the query. */
export const taskCommentRowSchema = z.object({
  id: z.uuid(),
  /** Rich text. Sanitised at render — see `lib/rich-text-dom.ts`. */
  body: z.string(),
  author_id: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type TaskCommentRow = z.infer<typeof taskCommentRowSchema>;

/** P7-28 — one child: `qk.taskPart(id, "subtasks")`. One level deep (P7-09). */
export const subtaskRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: taskStatusSchema,
  due_date: z.string().nullable(),
  assignee_id: z.uuid().nullable(),
  priority: taskPrioritySchema,
});

export type SubtaskRow = z.infer<typeof subtaskRowSchema>;

/** An output file: `qk.taskPart(id, "attachments")`. */
export const taskAttachmentRowSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  uploaded_by: z.uuid().nullable(),
});

export type TaskAttachmentRow = z.infer<typeof taskAttachmentRowSchema>;

/**
 * P7-15 — one row of `vizserve_pms_task_time_tracked`.
 *
 * ⚠️ NEVER A SUM OF `vizserve_pms_timesheet_entries`. That table's SELECT policy
 * is owner-or-their-lead, so a member summing it for this task would see only
 * the hours THEY logged and read it as the task total — two people on one task
 * seeing two different figures on the same screen, and their lead a third. The
 * rollup is SECURITY DEFINER for exactly that reason.
 */
export const taskTimeTrackedSchema = z.object({
  task_id: z.uuid(),
  minutes: z.number(),
});

/*
 * ⚠️ THE LIST AND THE DIRECTORY MOVED TO `lib/schemas/task-list.ts` IN P12-07.
 *
 * `departmentListSchema` and `directoryPersonSchema` were defined here while
 * this page was the only browser reader of either. `/tasks` and `/tasks/board`
 * now read both from the SAME cache entries (`qk.listsVisible()`,
 * `qk.ref("users")`), and a shape shared by three surfaces cannot be declared in
 * the contract of one of them — see `visibleListSchema` and
 * `directoryPersonSchema` there for the superset argument.
 */

/**
 * P7-59 — the request row, WHICH IS THE LEAD'S VIEW AND ONLY THE LEAD'S.
 *
 * ⚠️ `requests readable in department scope` RETURNS NO ROW TO A MEMBER PIC,
 * deliberately: the client is never told who at VizServe holds their task, and
 * the anonymity runs both ways. So `null` here means "you may not see who
 * asked", never "nobody asked" — everything the person doing the work actually
 * needs comes from `vizserve_pms_task_request_brief`, which carries the brief
 * WITHOUT the identity.
 *
 * `reviewed_by` / `reviewed_at` cost no extra query and are the half of an
 * approval that matters when somebody asks later.
 */
export const taskRequestRowSchema = z.object({
  id: z.uuid(),
  reference_no: z.string(),
  /* NOT NULL in the schema, all four of these — the public form requires them.
     Stated strictly rather than defensively: a null arriving here is a shape
     fault worth hearing about, not a value to paper over. */
  requester_name: z.string(),
  requester_email: z.string(),
  requester_org: z.string(),
  description: z.string(),
  target_date: z.string().nullable(),
  submitted_at: z.string(),
  reviewed_by: z.uuid().nullable(),
  reviewed_at: z.string().nullable(),
  form_id: z.uuid(),
});

export type TaskRequestRow = z.infer<typeof taskRequestRowSchema>;
