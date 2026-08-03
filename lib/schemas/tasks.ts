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

/** Who is entitled to make a given move. */
export type TransitionActor = "pic" | "qa" | "client" | "system";

export type Transition = {
  from: TaskStatus;
  to: TaskStatus;
  actor: TransitionActor;
  /** 'resolution' — the task's own field must be non-empty. 'comment' — supply one. */
  requires: "resolution" | "comment" | null;
  /** The button, from the acting person's point of view. */
  label: string;
};

/**
 * The whole legal set. Anything absent from this list is rejected server-side.
 *
 * The order is the corrected one: COMPLETED is terminal and comes AFTER the
 * client signs off. The Miro board had Testing/QA → Completed → Submit for Final
 * Approval, and Amier corrected himself live at 42:20. Ship the wrong order and
 * the word "Completed" means nothing, which breaks every Phase 6 report.
 */
export const TASK_TRANSITIONS: readonly Transition[] = [
  { from: "OPEN", to: "ONGOING", actor: "pic", requires: null, label: "Start work" },
  {
    from: "ONGOING",
    to: "WAITING_FOR_INFO",
    actor: "pic",
    requires: "comment",
    label: "Waiting for info",
  },
  { from: "WAITING_FOR_INFO", to: "ONGOING", actor: "pic", requires: null, label: "Resume work" },
  // The resolution gate (P3-07). Enforced by the database, not by this label.
  { from: "ONGOING", to: "FOR_QA", actor: "pic", requires: "resolution", label: "Send for QA" },
  { from: "FOR_QA", to: "QA_IN_PROGRESS", actor: "qa", requires: null, label: "Start review" },
  {
    from: "QA_IN_PROGRESS",
    to: "ONGOING",
    actor: "qa",
    requires: "comment",
    label: "Send back to PIC",
  },
  {
    from: "QA_IN_PROGRESS",
    to: "FOR_CLIENT_APPROVAL",
    actor: "qa",
    requires: null,
    label: "Pass QA",
  },
  // Phase 4 owns these three. Present so the machine is complete; reachable in
  // Phase 3 only through an admin override.
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "ONGOING",
    actor: "client",
    requires: "comment",
    label: "Client rejected",
  },
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "COMPLETED",
    actor: "client",
    requires: null,
    label: "Client approved",
  },
  {
    from: "FOR_CLIENT_APPROVAL",
    to: "COMPLETED_NO_RESPONSE",
    actor: "system",
    requires: null,
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
): Transition[] {
  return transitionsFrom(status).filter((transition) => {
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
  output_link: z
    .union([z.literal(""), z.url("Enter a full URL, including https://")])
    .default(""),
  due_date: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")])
    .default(""),
  list_id: z.uuid().nullable().default(null),
});

export type TaskDetailsInput = z.infer<typeof taskDetailsSchema>;

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
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const listSchema = z.object({
  department_id: z.uuid("Choose a department."),
  name: z.string().trim().min(1, "Give the list a name.").max(80),
  description: z.string().trim().default(""),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

export type ListInput = z.infer<typeof listSchema>;
