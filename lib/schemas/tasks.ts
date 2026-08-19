import { z } from "zod";

import type { VizservePmsTaskStatus } from "@/lib/database.types";

/**
 * PHASE 3 CONTRACT — the task schema and the legal-transition table (D3a, R11).
 *
 * The transition table below is a MIRROR of `vizserve_pms_task_transitions`.
 * The database is the authority — it is what rejects an illegal move from a
 * `curl` — and this copy exists so the UI can decide which buttons to draw
 * without a round trip per task.
 *
 * Two copies of a rule is exactly the drift this codebase keeps trying to avoid,
 * so `tests/db/tasks.test.ts` reads the table out of Postgres and asserts it
 * matches this constant row for row. If someone changes one, that test fails
 * rather than the app quietly offering a button the server will refuse.
 */

export const TASK_STATUSES = [
  "OPEN",
  "ONGOING",
  "WAITING_FOR_INFO",
  "FOR_QA",
  "QA_IN_PROGRESS",
  "FOR_CLIENT_APPROVAL",
  "COMPLETED",
  "COMPLETED_NO_RESPONSE",
] as const;

export type TaskStatus = VizservePmsTaskStatus;

export const taskStatusSchema = z.enum(TASK_STATUSES);

/**
 * Where every task starts, and the only stage a screen may offer to create one
 * in.
 *
 * `vizserve_pms_create_task` opens every task here and `status` sits outside the
 * column-level UPDATE grant, so a board column or a list group offering "add a
 * task" anywhere else would be promising something the database refuses. Stated
 * once, imported by both views, rather than each of them deciding for itself.
 */
export const INITIAL_TASK_STATUS: TaskStatus = "OPEN";

/**
 * P7-11 — how urgent a task is, as judged by whoever created it.
 *
 * DECLARED LOW → HIGH, and that order is load-bearing twice: Postgres compares
 * enum values by declaration order, so `priority >= 'HIGH'` and
 * `order by priority desc` work directly in SQL with no CASE and no lookup
 * table — the same trick the role enum already relies on. Reversing this list
 * silently inverts every sort in the app.
 *
 * NULLABLE, everywhere, and that is the whole design rather than an oversight.
 * The picker this came from offers a fifth option, "Clear", which does not mean
 * Normal — it means no priority on this task. Defaulting every row to NORMAL
 * would put a flag on every task in the system, and a mark carried by
 * everything marks nothing. Absence is the ordinary case; presence is the
 * judgement somebody made.
 *
 * WHO SETS IT: whoever creates the task. For personal work that is the member,
 * for internal work the team leader, and for client work the team leader at
 * Gate 1 — because `vizserve_pms_approve_request` is the statement that creates
 * the task, so there is no earlier moment at which anyone could have set it. A
 * client states urgency on the form, in `field_values`; the lead decides the
 * priority. Both survive, exactly as `target_date` and `approved_target_date`
 * already do on the request.
 */
export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Null is a real value here — "no priority set", not "unknown". */
export const taskPrioritySchema = z.enum(TASK_PRIORITIES).nullable();

/**
 * Exhaustive by construction: a `Record` keyed on the union fails to compile the
 * moment a value is added to `TASK_PRIORITIES` without a label to go with it.
 */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  NORMAL: "Normal",
  LOW: "Low",
};

/**
 * Highest first, then the ones nobody ranked.
 *
 * The SQL equivalent is `order by priority desc nulls last`, and this is its
 * mirror for the rare list that is already in memory. Both exist because a
 * priority nobody sorts by is a field people stop filling in.
 */
export function comparePriority(a: TaskPriority | null, b: TaskPriority | null): number {
  // Not `?? -1`: LOW is index 0, so a missing priority has to rank below the
  // lowest real one rather than tying with it.
  const rank = (value: TaskPriority | null) =>
    value === null ? -1 : TASK_PRIORITIES.indexOf(value);

  return rank(b) - rank(a);
}

/** Who is entitled to make a given move. */
export type TransitionActor = "pic" | "qa" | "client" | "system";

/**
 * Where a task came from, which decides how it is allowed to finish.
 *
 * Three kinds of work go through one table:
 *
 *   request   a shared form, approved by the TL at Gate 1 → the client signs off
 *   internal  the TL made it by hand → the QA reviewer closes it
 *   personal  the member made it for themselves → they close it
 *
 * `personal` is a subset of "has no request": every personal task is internal
 * work, but not every internal task is personal. `is_personal` is a stored
 * column rather than something derived from who the assignee is, because a
 * reassignment would otherwise silently change a task's category — and with it
 * which moves are legal to it.
 */
export type TaskCategory = "request" | "internal" | "personal";

/** Which categories a transition applies to. `any` means all three. */
export type TransitionScope = "any" | TaskCategory;

export type Transition = {
  from: TaskStatus;
  to: TaskStatus;
  actor: TransitionActor;
  /** 'resolution' — the task's own field must be non-empty. 'comment' — supply one. */
  requires: "resolution" | "comment" | null;
  /** Mirrors `vizserve_pms_task_transitions.applies_to`. */
  appliesTo: TransitionScope;
  /** The button, from the acting person's point of view. */
  label: string;
};

/**
 * The category of a task, from the two columns that record it.
 *
 * One definition, used by `availableTransitions` and by every screen that
 * labels a task — the SQL side asks the same question inside
 * `vizserve_pms_transition_task`, and these two must agree.
 */
export function taskCategory(task: {
  request_id: string | null;
  is_personal: boolean;
}): TaskCategory {
  if (task.request_id !== null) return "request";
  return task.is_personal ? "personal" : "internal";
}

/**
 * Human labels for the three. Shown on the task list, the board and the
 * dashboard.
 *
 * ⚠️ THESE USED TO READ "Client request" / "Assigned to you" / "Personal", and
 * both problems with that were the same problem.
 *
 *   1. THEY WERE NOT PARALLEL. "Client request" and "Assigned to you" answer
 *      two different questions — what it is, and who has it — so a column of
 *      them did not read as one distinction with three values. The single most
 *      consequential fact about a task, whether finishing it needs somebody
 *      outside the company, did not stand out because nothing lined up against
 *      it.
 *   2. "Assigned to you" WAS OFTEN FALSE. A lead reading their team's list, or
 *      anyone opening a colleague's task, saw work described as theirs when it
 *      was not. `taskCategory` says where a task CAME FROM; it has never known
 *      who is holding it.
 *
 * These also match the words on the task toolbar's own filter — All work /
 * Internal / Client — so the chip and the control that filters by it finally
 * use one vocabulary.
 */
export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  request: "Client",
  internal: "Internal",
  personal: "Personal",
};

/** Does a transition apply to a task of this category? */
export function scopeAllows(scope: TransitionScope, category: TaskCategory): boolean {
  if (scope === "any") return true;
  // `internal` covers personal work too — a personal task is internal work
  // whose owner happens to be allowed to close it directly as well.
  if (scope === "internal") return category !== "request";
  return scope === category;
}

/**
 * The whole legal set. Anything absent from this list is rejected server-side.
 *
 * The order is the corrected one: COMPLETED is terminal and comes AFTER the
 * client signs off. The Miro board had Testing/QA → Completed → Submit for Final
 * Approval, and Amier corrected himself live at 42:20. Ship the wrong order and
 * the word "Completed" means nothing, which breaks every Phase 6 report.
 */
export const TASK_TRANSITIONS: readonly Transition[] = [
  {
    from: "OPEN",
    to: "ONGOING",
    actor: "pic",
    requires: null,
    appliesTo: "any",
    label: "Start work",
  },
  {
    from: "ONGOING",
    to: "WAITING_FOR_INFO",
    actor: "pic",
    requires: "comment",
    appliesTo: "any",
    label: "Waiting for info",
  },
  {
    from: "WAITING_FOR_INFO",
    to: "ONGOING",
    actor: "pic",
    requires: null,
    appliesTo: "any",
    label: "Resume work",
  },
  // The resolution gate (P3-07). Enforced by the database, not by this label.
  {
    from: "ONGOING",
    to: "FOR_QA",
    actor: "pic",
    requires: "resolution",
    appliesTo: "any",
    label: "Send for QA",
  },
  // P7-02 — you made it for yourself, you close it. Still gated on a resolution:
  // every other route to COMPLETED passes through FOR_QA, which demands one, and
  // "every completed task says what was done" is what Phase 6 reporting reads.
  {
    from: "ONGOING",
    to: "COMPLETED",
    actor: "pic",
    requires: "resolution",
    appliesTo: "personal",
    label: "Mark it done",
  },
  {
    from: "FOR_QA",
    to: "QA_IN_PROGRESS",
    actor: "qa",
    requires: null,
    appliesTo: "any",
    label: "Start review",
  },
  {
    from: "QA_IN_PROGRESS",
    to: "ONGOING",
    actor: "qa",
    requires: "comment",
    appliesTo: "any",
    label: "Send back to PIC",
  },
  // Only work with a client goes to the client. Before P7-02 this was open to
  // every task, and a request-less one arriving here stranded: the token issuer
  // refuses it and there is no legal way back out.
  {
    from: "QA_IN_PROGRESS",
    to: "FOR_CLIENT_APPROVAL",
    actor: "qa",
    requires: null,
    appliesTo: "request",
    label: "Pass QA",
  },
  // ...which is why internal work needs its own exit. Reviewed, and there is
  // nobody outside to sign it off, so the reviewer closes it.
  {
    from: "QA_IN_PROGRESS",
    to: "COMPLETED",
    actor: "qa",
    requires: null,
    appliesTo: "internal",
    label: "Pass QA and close",
  },
  // P7-06 — work with no client moves freely. Every one of these still goes
  // through the state machine and still writes history; what changed is which
  // moves are legal, not how they happen.
  {
    from: "ONGOING",
    to: "OPEN",
    actor: "pic",
    requires: null,
    appliesTo: "internal",
    label: "Back to open",
  },
  {
    from: "WAITING_FOR_INFO",
    to: "OPEN",
    actor: "pic",
    requires: null,
    appliesTo: "internal",
    label: "Back to open",
  },
  {
    from: "OPEN",
    to: "WAITING_FOR_INFO",
    actor: "pic",
    requires: "comment",
    appliesTo: "internal",
    label: "Waiting for info",
  },
  {
    from: "FOR_QA",
    to: "ONGOING",
    actor: "pic",
    requires: null,
    appliesTo: "internal",
    label: "Take it back",
  },
  // Reopening. Only for work with no client — going behind a client's sign-off
  // is what Gate 3's own return path is for.
  {
    from: "COMPLETED",
    to: "ONGOING",
    actor: "pic",
    requires: null,
    appliesTo: "internal",
    label: "Reopen",
  },
  // Phase 4 owns these three. Present so the machine is complete; reachable in
  // Phase 3 only through an admin override.
  //
  // Left at `any` deliberately. `vizserve_pms_force_task_status` does not read
  // this table, so a forced task can still land in FOR_CLIENT_APPROVAL — and
  // scoping the EXITS would leave it there with no way out at all.
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "ONGOING",
    actor: "client",
    requires: "comment",
    appliesTo: "any",
    label: "Client rejected",
  },
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "COMPLETED",
    actor: "client",
    requires: null,
    appliesTo: "any",
    label: "Client approved",
  },
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "COMPLETED_NO_RESPONSE",
    actor: "system",
    requires: null,
    appliesTo: "any",
    label: "Auto-completed",
  },
] as const;

/** The moves available from a status, whoever is asking. */
export function transitionsFrom(status: TaskStatus): Transition[] {
  return TASK_TRANSITIONS.filter((transition) => transition.from === status);
}

/**
 * The moves THIS person can make right now.
 *
 * Presentation only — hiding a button protects nobody, and the same rules are
 * re-checked in `vizserve_pms_transition_task`. A TL leading the department may
 * act in either seat, because they are frequently the QA reviewer themselves.
 */
export function availableTransitions(
  status: TaskStatus,
  viewer: { isPic: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean },
  // Required, not optional. An optional third argument would let every existing
  // call site keep compiling while silently offering buttons the server refuses
  // — the exact failure this mirror exists to prevent.
  task: { request_id: string | null; is_personal: boolean },
): Transition[] {
  const category = taskCategory(task);

  /*
   * P7-13 — WORK WITH NO CLIENT MOVES FREELY, and the mirror has to say so or
   * the buttons will not be there to press.
   *
   * `vizserve_pms_transition_task` does not consult the transition table at all
   * for internal or personal work: any status to any status, no required
   * fields, by anyone on the task. This branch is that rule, and it is the one
   * place in this file that is NOT a copy of a table row.
   *
   * The single exclusion is `FOR_CLIENT_APPROVAL`, and it is not a gate — it is
   * a dead end. `vizserve_pms_issue_approval_token` refuses a task with no
   * request, so a task moved there could never be finished or moved back.
   *
   * Everyone on the task gets the same set. The QA seat means nothing here,
   * because there is no reviewer gate left for it to guard.
   */
  if (category !== "request") {
    if (!(viewer.isPic || viewer.isQa || viewer.leadsDepartment)) return [];

    return TASK_STATUSES.filter(
      (target) => target !== status && target !== "FOR_CLIENT_APPROVAL",
    ).map((target) => ({
      from: status,
      to: target,
      actor: "pic" as const,
      requires: null,
      appliesTo: "internal" as const,
      label: TASK_STATUS_LABELS[target],
    }));
  }

  return transitionsFrom(status).filter((transition) => {
    // A rule written for work without a client cannot be borrowed by work with
    // one — the mirror of the server's own check.
    if (!scopeAllows(transition.appliesTo, category)) return false;
    if (transition.actor === "pic") return viewer.isPic || viewer.leadsDepartment;
    if (transition.actor === "qa") return viewer.isQa || viewer.leadsDepartment;
    // The client and system rows belong to Phase 4's token flow.
    return viewer.isAdmin;
  });
}

/** Statuses that mean the work is finished, either way. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "COMPLETED_NO_RESPONSE"];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Human labels. Every status pill carries its label — never colour alone. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  OPEN: "Open",
  ONGOING: "Ongoing",
  WAITING_FOR_INFO: "Waiting for info",
  FOR_QA: "For QA",
  QA_IN_PROGRESS: "QA in progress",
  FOR_CLIENT_APPROVAL: "For client approval",
  COMPLETED: "Completed",
  // Deliberately distinct from COMPLETED. "The client approved" and "the clock
  // ran out" are different facts and Phase 6 reports the split.
  COMPLETED_NO_RESPONSE: "Completed (no response)",
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const transitionPayloadSchema = z.object({
  to_status: taskStatusSchema,
  comment: z.string().trim().max(2000).optional(),
});

export const overridePayloadSchema = z.object({
  to_status: taskStatusSchema,
  // Longer floor than an ordinary comment. An override is the thing that makes a
  // history untrustworthy if it is unexplained, so "fixed" is not enough.
  reason: z
    .string()
    .trim()
    .min(10, "Say why this had to be forced — the history is read by people who were not here."),
});

export const taskDetailsSchema = z.object({
  title: z.string().trim().min(1, "A task needs a title.").max(300),
  description: z.string().trim().default(""),
  /** What the member actually produced. The QA reviewer reviews against this. */
  resolution: z.string().trim().default(""),
  output_link: z.union([z.literal(""), z.url("Enter a full URL, including https://")]).default(""),
  due_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  start_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  list_id: z.uuid().nullable().default(null),
  /**
   * P7-11. Editable after the fact, unlike `status` — re-prioritising is
   * ordinary work rather than a state transition, which is why `priority` sits
   * INSIDE the column-level UPDATE grant and `status` does not.
   */
  priority: taskPrioritySchema.default(null),
  /**
   * P7-15. Minutes, like every other duration here — parse the field with
   * `parseCellDuration` so `2h` means the same thing as it does in a timesheet
   * cell. Null is "nobody estimated", which is most tasks.
   */
  estimate_minutes: z
    .number()
    .int("Give it in whole minutes.")
    .positive("An estimate of nothing is not an estimate.")
    .max(100_000, "That is more than ten working weeks — is it one task?")
    .nullable()
    .default(null),
});

export type TaskDetailsInput = z.infer<typeof taskDetailsSchema>;

/**
 * K3 — ONE FIELD AT A TIME, for editing in place on a list row or a board card.
 *
 * Separate from `taskDetailsSchema` rather than a `.partial()` of it, and the
 * difference is not cosmetic. That schema is a whole FORM: every key has a
 * default, so `.partial()` would still let an absent `title` arrive as `""` and
 * a `.default(null)` priority silently clear a priority nobody touched. A patch
 * has to be able to say "this key was not in the payload" — which is what
 * omitting the defaults buys.
 *
 * `.strict()` so a typo'd key is a validation error rather than a silent no-op,
 * and `status` is absent because it is not a writable column: it moves through
 * `vizserve_pms_transition_task` and nowhere else. A patch that accepted it
 * would compile, pass zod, and be dropped by Postgres privileges — which reads
 * as "the edit did not save" with no reason given.
 */
export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1, "A task needs a title.").max(300),
    // "" from a cleared date input means "no date", never the epoch. Both dates
    // stay nullable rather than required, because most internal work has one or
    // neither.
    due_date: z
      .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
      .nullable(),
    start_date: z
      .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
      .nullable(),
    list_id: z.uuid().nullable(),
    priority: taskPrioritySchema,
    estimate_minutes: z
      .number()
      .int("Give it in whole minutes.")
      .positive("An estimate of nothing is not an estimate.")
      .max(100_000, "That is more than ten working weeks — is it one task?")
      .nullable(),
  })
  .partial()
  .strict()
  // An empty patch is a bug at the call site, not a no-op to be swallowed: the
  // UPDATE would return a row and the caller would be told it saved.
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to change.",
  });

export type TaskPatchInput = z.infer<typeof taskPatchSchema>;

export const createTaskSchema = z.object({
  department_id: z.uuid("Choose the department this belongs to."),
  title: z.string().trim().min(1, "A task needs a title.").max(300),
  description: z.string().trim().default(""),
  assignee_id: z.uuid().nullable().default(null),
  qa_assignee_id: z.uuid().nullable().default(null),
  due_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  list_id: z.uuid().nullable().default(null),
  priority: taskPrioritySchema.default(null),
  /**
   * P7-06 / P7-15 — captured AT CREATION, not left for four edits afterwards.
   *
   * Neither is a parameter of `vizserve_pms_create_task`, so the action writes
   * them as a follow-up patch on the row it just made. That is a second write
   * and it is the honest cost of not changing an applied function's signature —
   * which would mean a drop and a regrant (trap 3) for two nullable columns.
   */
  start_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  estimate_minutes: z
    .number()
    .int("Give it in whole minutes.")
    .positive("An estimate of nothing is not an estimate.")
    .max(100_000, "That is more than ten working weeks — is it one task?")
    .nullable()
    .default(null),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * P7-01 — a task somebody records for themselves.
 *
 * Deliberately NOT `createTaskSchema` with optional fields. There is no
 * `department_id` and no `assignee_id` because neither is the caller's to
 * choose: both are resolved server-side from the signed-in user's own record,
 * so the question never reaches the client at all. A field that cannot be sent
 * is a rule that cannot be bent — the same reasoning as the DTR punch schema,
 * whose `in` branch has no `work_date` member.
 */
export const createPersonalTaskSchema = z.object({
  title: z.string().trim().min(1, "What are you working on?").max(300),
  description: z.string().trim().default(""),
  due_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  list_id: z.uuid().nullable().default(null),
  // Present here, unlike `department_id` and `assignee_id`: how urgent your own
  // work is IS yours to decide, which is exactly what those two are not.
  priority: taskPrioritySchema.default(null),
  /**
   * P7-06 / P7-15 — captured AT CREATION, not left for four edits afterwards.
   *
   * Neither is a parameter of `vizserve_pms_create_task`, so the action writes
   * them as a follow-up patch on the row it just made. That is a second write
   * and it is the honest cost of not changing an applied function's signature —
   * which would mean a drop and a regrant (trap 3) for two nullable columns.
   */
  start_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  estimate_minutes: z
    .number()
    .int("Give it in whole minutes.")
    .positive("An estimate of nothing is not an estimate.")
    .max(100_000, "That is more than ten working weeks — is it one task?")
    .nullable()
    .default(null),
});

export type CreatePersonalTaskInput = z.infer<typeof createPersonalTaskSchema>;

/**
 * P7-08 — a comment on a task.
 *
 * No `author_id`. It is taken from the session on the server and the INSERT
 * policy re-checks it against `auth.uid()`, so posting under somebody else's
 * name is not a request the server can be talked into.
 */
export const taskCommentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Say something.")
    .max(4000, "Keep a comment under 4000 characters."),
});

export type TaskCommentInput = z.infer<typeof taskCommentSchema>;

/**
 * P7-09 — moving a task under a parent, or pulling it back out.
 *
 * `null` detaches. One level only, and the same department as the parent —
 * both enforced by a trigger, because both need to read the parent row.
 */
export const taskParentSchema = z.object({
  parent_task_id: z.uuid().nullable(),
});

export const listSchema = z.object({
  department_id: z.uuid("Choose a department."),
  name: z.string().trim().min(1, "Give the list a name.").max(80),
  description: z.string().trim().default(""),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
  /**
   * P7-18. Null is the top level — a ClickUp "Folderless List", and what every
   * list made before P7-18 is. The folder must belong to the same department,
   * which `vizserve_pms_lists_group_guard` enforces because it has to read the
   * folder row and a CHECK cannot.
   */
  group_id: z.uuid().nullable().default(null),
});

export type ListInput = z.infer<typeof listSchema>;

/**
 * P7-18 — a folder: one level above lists, so the tree reads
 * Department → Folder → List → Task.
 *
 * DELIBERATELY THE SAME SHAPE AS `listSchema`. Two sibling levels that behave
 * differently for no reason is how people learn to trust neither.
 *
 * No `is_system` field, and that is the point rather than an omission: the
 * reserved "Client Requests" folder is created by
 * `vizserve_pms_ensure_client_folder` and guarded by a trigger that refuses to
 * let the flag be set or cleared. A form here would be a control that can only
 * ever produce an error.
 */
export const taskGroupSchema = z.object({
  department_id: z.uuid("Choose a department."),
  name: z.string().trim().min(1, "Give the folder a name.").max(80),
  description: z.string().trim().default(""),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

export type TaskGroupInput = z.infer<typeof taskGroupSchema>;
