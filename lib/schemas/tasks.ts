import { z } from "zod";

import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { richTextSchema } from "@/lib/schemas/rich-text";

/**
 * P7-56 — the ceiling on the two long-prose columns.
 *
 * `description` and `resolution` had no cap at all, and a rich column needs one:
 * the markup is what gets stored, so an unbounded field is an unbounded write.
 * 20,000 characters of PROSE — `richTextSchema` measures the flattened text —
 * is roughly four thousand words, far past any brief anyone has written here,
 * so it bounds the column without being a rule somebody meets in practice.
 */
const LONG_PROSE_MAX = 20_000;

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
 * P7-61 — WHAT A MOVE DOES, as opposed to where it lands.
 *
 * Client work offers one or two moves at a time and they are drawn as BUTTONS
 * rather than a dropdown (see `task-actions.tsx`), which means each one needs a
 * colour. The obvious source — the tone of the status it lands on — is the
 * wrong one, and wrong in the direction that matters:
 *
 *   "Pass QA"          → FOR_CLIENT_APPROVAL, which is `warning`
 *   "Send back to PIC" → ONGOING,             which is `brand`
 *
 * So the approving move would read cautionary and the rejecting one would read
 * like progress. A status tone answers "how should I feel about work SITTING
 * here"; a button has to answer "what happens if I press this". They are
 * different questions and only coincidentally have the same answer.
 *
 * Three answers, derived from the pair rather than listed beside every row —
 * a fourth column on `TASK_TRANSITIONS` is a fourth thing to keep in step:
 *
 *   advance   the work moves on to whoever has it next
 *   return    it goes BACK to somebody who already had it
 *   hold      it stops where it is and waits on someone outside the flow
 *
 * ⚠️ `WAITING_FOR_INFO` → `ONGOING` IS AN ADVANCE, NOT A RETURN. Resuming
 * parked work hands it to nobody; it picks up where it stopped.
 */
export type TransitionIntent = "advance" | "return" | "hold";

export function transitionIntent(transition: Pick<Transition, "from" | "to">): TransitionIntent {
  if (transition.to === "WAITING_FOR_INFO") return "hold";
  // Back to the start, from anywhere that is not already the start.
  if (transition.to === "OPEN") return "return";
  // Back to the PIC — from QA, from the client, or from a reopened close. The
  // two excluded origins are the ones where ONGOING is forward: OPEN is
  // starting, WAITING_FOR_INFO is resuming.
  if (
    transition.to === "ONGOING" &&
    transition.from !== "OPEN" &&
    transition.from !== "WAITING_FOR_INFO"
  ) {
    return "return";
  }
  return "advance";
}

/**
 * The tone a move is drawn in, from `docs/12`'s semantic set (§1.2) — one
 * mapping, so a button and the chip vocabulary around it cannot disagree.
 *
 * `advance` splits on whether it ENDS the task, because "send this on" and
 * "this is finished" are not the same promise: the first is the page's primary
 * action in brand, the second is the green every completed thing in this app
 * already wears. `return` takes `info`, which is the tone a returned request
 * carries everywhere else. `hold` takes `warning`, the waiting tone.
 */
export function transitionTone(
  transition: Pick<Transition, "from" | "to">,
): "brand" | "success" | "info" | "warning" {
  const intent = transitionIntent(transition);
  if (intent === "return") return "info";
  if (intent === "hold") return "warning";
  return isTerminal(transition.to) ? "success" : "brand";
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
  viewer: { isAssignee: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean },
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
    if (!(viewer.isAssignee || viewer.isQa || viewer.leadsDepartment)) return [];

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
    if (transition.actor === "pic") return viewer.isAssignee || viewer.leadsDepartment;
    if (transition.actor === "qa") return viewer.isQa || viewer.leadsDepartment;
    // The client and system rows belong to Phase 4's token flow.
    return viewer.isAdmin;
  });
}

/**
 * P7-28 — THE ONE MOVE WORTH A BUTTON.
 *
 * `availableTransitions` answers "what may I do"; this answers "what would I
 * almost certainly do next". The dropdown keeps every legal move — free
 * movement means an internal task offers seven — and this promotes exactly one
 * of them to a primary button so the common move is not as hard to find as the
 * rare one.
 *
 * DERIVED FROM `availableTransitions`, never from a second table. The returned
 * Transition is the one that function produced, so `requires` is whatever the
 * server will actually enforce; only the `label` is upgraded (below). If a move
 * is not on offer it can never be promoted, which is what stops this drawing a
 * button the server refuses.
 *
 * FOUR THINGS ARE NEVER THE NEXT STEP, and each exclusion is a different rule:
 *
 *   WAITING_FOR_INFO      A PAUSE, NOT A STEP. It is declared between ONGOING
 *                         and FOR_QA, so a naive "next in enum order" makes
 *                         "Waiting for info" the headline move on every task
 *                         that is going fine. Parking work is a decision
 *                         somebody makes; it is not the default.
 *   COMPLETED_NO_RESPONSE Only the auto-complete cron reaches it.
 *   a `client` or `system` actor
 *                         The person at the keyboard is not the actor. An admin
 *                         may force a client's answer from the dropdown; a
 *                         one-click "Client approved" is not a button anyone
 *                         should be able to press by reflex.
 *   `requires: "comment"` A button cannot satisfy a requirement that needs
 *                         typing. Those moves stay in the dropdown, which asks
 *                         for the comment in place.
 *
 * `requires: "resolution"` IS kept, and deliberately: it is a field on this very
 * screen, sitting directly under the button, so a disabled "Send for QA" and
 * the empty box that disables it are in one glance.
 *
 * Returns null when the work is finished, when nobody holds a seat on it, and
 * at FOR_CLIENT_APPROVAL — where the honest answer is that it is not the team's
 * move at all.
 */
export function nextStep(
  status: TaskStatus,
  viewer: { isAssignee: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean },
  task: { request_id: string | null; is_personal: boolean },
): Transition | null {
  // Nothing follows a finished task. Internal work can legally be reopened
  // (P7-06) and that move stays in the dropdown, but "reopen" is not what a
  // primary button on a closed task should invite.
  if (isTerminal(status)) return null;

  const category = taskCategory(task);
  const moves = availableTransitions(status, viewer, task).filter(
    (move) => move.actor !== "client" && move.actor !== "system" && move.requires !== "comment",
  );
  if (moves.length === 0) return null;

  const promote = (move: Transition): Transition => ({
    ...move,
    // The verb, where the canonical table has one. Free movement synthesises
    // its transitions with the STATUS NAME as the label, so an internal task
    // would offer "▶ For QA" where client work offers "▶ Send for QA" for the
    // identical move. Borrowing the wording — and only the wording — makes the
    // button read the same on both without importing a `requires` the server
    // does not enforce for internal work.
    label:
      TASK_TRANSITIONS.find(
        (row) =>
          row.from === move.from && row.to === move.to && scopeAllows(row.appliesTo, category),
      )?.label ?? move.label,
  });

  // Parked work has exactly one move worth promoting: un-park it. It is off the
  // spine below in both directions, so it is answered here rather than by an
  // index comparison that would read "resume" as going backwards.
  if (status === "WAITING_FOR_INFO") {
    const resume = moves.find((move) => move.to === "ONGOING");
    return resume ? promote(resume) : null;
  }

  /*
   * The nearest stage ahead of here that is actually on offer.
   *
   * "Ahead" is measured against `TASK_STATUSES` rather than against a position
   * IN the spine, because a task can legitimately be standing somewhere its own
   * category has no stage for: personal work sent to QA through the dropdown
   * (P7-13a lets it), or anything an admin forced into FOR_CLIENT_APPROVAL. An
   * index into the spine would be -1 for both and the button would vanish from
   * exactly the tasks that most need a way onward.
   */
  const here = TASK_STATUSES.indexOf(status);

  for (const target of forwardSpine(category)) {
    if (TASK_STATUSES.indexOf(target) <= here) continue;
    const move = moves.find((candidate) => candidate.to === target);
    if (move) return promote(move);
  }

  return null;
}

/**
 * The happy path for a category, as a list of statuses — FILTERED FROM
 * `TASK_STATUSES` rather than written out, so adding a status cannot leave a
 * second order behind to drift.
 *
 * It is the same shape the lifecycle rail draws: five stages for client work,
 * four for internal, three for personal.
 */
function forwardSpine(category: TaskCategory): TaskStatus[] {
  return TASK_STATUSES.filter((status) => {
    // A pause and a cron's ending. Neither is a step anyone takes.
    if (status === "WAITING_FOR_INFO" || status === "COMPLETED_NO_RESPONSE") return false;
    // Work with no client has no client gate — it is a dead end there, not a
    // stage (see `availableTransitions`).
    if (status === "FOR_CLIENT_APPROVAL") return category === "request";
    // P7-02 — you made it for yourself, you close it. QA is still REACHABLE on
    // personal work through the dropdown; it is simply not the expected route,
    // so it is not what the button offers.
    if (status === "FOR_QA" || status === "QA_IN_PROGRESS") return category !== "personal";
    return true;
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
  comment: richTextSchema({ max: 2000 }).optional(),
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

/**
 * P7-55. The link rule, extracted so the CLIENT can hold the same predicate.
 *
 * `/tasks/[id]` autosaves this field on a timer, which means it has to decide
 * for itself whether a half-typed value is worth sending — `https:` is invalid
 * on the way to being valid, and a save attempt per keystroke pause is both
 * pointless traffic and a flashing error. The field calls
 * `outputLinkSchema.safeParse(draft)` and simply does not write until it
 * passes. One predicate and one message, shared, rather than a second copy of
 * the rule drifting from this one.
 *
 * `""` is deliberately valid and means "clear the link".
 */
export const outputLinkSchema = z.union([
  z.literal(""),
  z.url("Enter a full URL, including https://"),
]);

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
 *
 * ⚠️ P7-55 ADDED `description`, `resolution` AND `output_link`, and gave them no
 * default for exactly the reason the paragraph above gives. This is now the ONLY
 * writer of every task column — `updateTaskDetails` and `taskDetailsSchema` were
 * deleted with the Save button on `/tasks/[id]`, because a second path to the
 * same column is a second set of rules to keep in step. If you are about to add
 * `.default("")` to one of these three to make a form tidier, that is the bug:
 * it would turn "I did not touch the resolution" into "clear the resolution" on
 * every patch that omits it.
 */
export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1, "A task needs a title.").max(300),
    /**
     * The Gate 1 brief. Editable through this patch since P7-55, though no
     * screen currently offers the control — the key exists so the column has a
     * writer at all.
     */
    description: richTextSchema({ max: LONG_PROSE_MAX }),
    /**
     * What the member actually produced. The QA reviewer reviews against this.
     *
     * ⚠️ P7-56 — `richTextSchema` NORMALISES AN EMPTY DOCUMENT TO `""`, and the
     * resolution gate depends on it. `vizserve_pms_transition_task` refuses the
     * move to FOR_QA when `length(btrim(resolution)) = 0`; an empty editor
     * serialises to `<p></p>`, which is seven characters that check would read
     * as content. Without the transform, a visually empty resolution would open
     * the gate.
     */
    resolution: richTextSchema({ max: LONG_PROSE_MAX }),
    output_link: outputLinkSchema,
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
  description: richTextSchema({ max: LONG_PROSE_MAX }).default(""),
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
  description: richTextSchema({ max: LONG_PROSE_MAX }).default(""),
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
  body: richTextSchema({
    min: 1,
    max: 4000,
    requiredMessage: "Say something.",
    tooLongMessage: "Keep a comment under 4000 characters.",
  }),
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

// ---------------------------------------------------------------------------
// P7-59 — the brief a client task came from, WITHOUT the client's identity.
// ---------------------------------------------------------------------------

/**
 * What `vizserve_pms_task_request_brief` hands back.
 *
 * ⚠️ IT IS THE CONTRACT FOR A SECURITY DEFINER FUNCTION, so the shape here is
 * the shape the migration builds — not a convenience type over the requests
 * table. Adding a field to this without adding it to
 * `20260901140000_p7_59_task_request_brief.sql` produces `undefined` at runtime
 * and no type error, which is why the parse below is not optional.
 *
 * ⚠️ AND IT HAS NO IDENTITY IN IT, BY DESIGN. `requester_name`, `requester_org`
 * and `requester_email` are absent because the client is never told who at
 * VizServe holds their task, and the anonymity is meant to run both ways. A
 * department lead reads those from the request row itself, through RLS.
 */
export const taskRequestBriefSchema = z.object({
  reference_no: z.string(),
  /** The client's own wording. The task's brief may have been rewritten at Gate 1. */
  description: z.string().nullable(),
  /** What the CLIENT asked for — not the team's due date, and not the agreed date. */
  target_date: z.string().nullable(),
  submitted_at: z.string().nullable(),
  field_values: z.record(z.string(), z.unknown()).default({}),
  /** Archived fields included — a historical answer keeps its label (D20/R5). */
  fields: z
    .array(
      z.object({
        field_key: z.string(),
        label: z.string(),
        is_active: z.boolean(),
      }),
    )
    .default([]),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string(),
        mime_type: z.string(),
        size_bytes: z.number(),
      }),
    )
    .default([]),
});

export type TaskRequestBrief = z.infer<typeof taskRequestBriefSchema>;

/**
 * The function returns SQL NULL for internal work, for a task that does not
 * exist, and for a caller with no seat on it — three different reasons, one
 * answer, because the page does the same thing with all of them.
 */
export function parseTaskRequestBrief(value: unknown): TaskRequestBrief | null {
  if (value === null || value === undefined) return null;
  const parsed = taskRequestBriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
