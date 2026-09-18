"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  canManageDepartmentTree,
  canShapeDepartment,
  requireAuthContextOrThrow,
  requireDepartmentShape,
} from "@/lib/auth/authorization";
import { sweepCommentImages } from "@/lib/comment-images-server";
import { HEAD_BYTES, readImageSize } from "@/lib/image-size";
import {
  bulkEditSchema,
  checklistItemSchema,
  checklistToggleSchema,
  copySchema,
} from "@/lib/schemas/tasks";
import { taskImageSrc } from "@/lib/rich-text";
import { sanitizeRichText } from "@/lib/rich-text-server";
import {
  removeStoredAttachments,
  signAttachmentUrl,
  uploadTaskAttachment,
} from "@/lib/attachments-server";
import { issueAndSendApproval } from "@/lib/client-approval-server";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import {
  INITIAL_TASK_STATUS,
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  createPersonalTaskSchema,
  createTaskSchema,
  listSchema,
  overridePayloadSchema,
  personalListSchema,
  taskCommentSchema,
  listOrderSchema,
  taskGroupOrderSchema,
  taskGroupSchema,
  taskParentSchema,
  taskPatchSchema,
  taskStatusSchema,
  transitionPayloadSchema,
} from "@/lib/schemas/tasks";
import { createClient } from "@/utils/supabase/server";
import { flattenIssues, readableError } from "@/lib/action-result";

/**
 * P3-06 / P3-07 / P3-12 — task mutations.
 *
 * Thin, like the Gate 1 actions and for the same reason. The state machine, the
 * resolution gate, the actor rules and the history write all live in
 * `vizserve_pms_transition_task`, because that is the copy a direct API call
 * cannot skip — and the `status` column is not even grantable to
 * `authenticated`, so there is no second path to keep in step.
 */

// Re-exported because components import the type from the action file they
// call, and moving the definition should not move 40 import statements.
import type { ActionResult } from "@/lib/action-result";
export type { ActionResult };

/*
 * ⚠️ EVERY ROUTE THAT SHOWS A TASK HAS TO BE IN HERE, because as of P11-05 this
 * is the ONLY thing that repaints them. The controls used to call
 * `router.refresh()` afterwards, which papered over any path missing from this
 * list at the cost of a second round trip on every mutation.
 *
 * `/tasks/board` was the one missing, and it is the one that would have gone
 * stale first — dragging a card is a task mutation and the board is where you
 * watch it land.
 *
 * `revalidatePath` does NOT execute a route; it marks it stale, and the cost
 * lands on the next visit. So listing `/` and `/dashboard` here is close to free
 * and is what stops the badge counts lying after a move.
 */
function refresh(taskId?: string) {
  revalidatePath("/tasks");
  revalidatePath("/tasks/board");
  revalidatePath("/tasks/lists");
  revalidatePath("/");
  revalidatePath("/dashboard");
  if (taskId) revalidatePath(`/tasks/${taskId}`);
}

// ---------------------------------------------------------------------------
// P3-06 — move a task
// ---------------------------------------------------------------------------

export async function transitionTask(
  taskId: string,
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  // A member is the floor: a PIC is a member, and being ON the task is what
  // grants the move. The database decides which seat they are in.
  await requireAuthContextOrThrow();

  const parsed = transitionPayloadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: parsed.data.to_status,
    p_comment: parsed.data.comment ? sanitizeRichText(parsed.data.comment) : null,
  });

  if (error) return { ok: false, error: readableError(error) };

  const status = (data as { status: string }).status;

  // P4-02 — Gate 3 opens here. Passing QA is what sends the client their link,
  // so token issuance hangs off the transition rather than off a button
  // somebody has to remember to press.
  //
  // Awaited, unlike the notification drain: if the email fails the QA reviewer
  // should be told now, while they are looking at the screen, rather than three
  // days later when the task auto-completes without the client ever hearing.
  if (status === "FOR_CLIENT_APPROVAL") {
    const issued = await issueAndSendApproval(taskId);

    if (!issued.ok) {
      // The task HAS moved — the transition committed. Say so plainly rather
      // than implying nothing happened.
      refresh(taskId);
      return {
        ok: false,
        error:
          "QA passed, but the client could not be emailed. The task is waiting for client approval with no link sent — tell a team leader.",
      };
    }
  }

  // FOR_QA and a QA send-back both write notification rows inside the
  // transaction. Draining is outside it — an email failure must not undo a
  // status change somebody has already been told about on screen.
  dispatchPendingEmailsInBackground();

  refresh(taskId);
  return { ok: true, data: { status } };
}

/**
 * Q5 — the override.
 *
 * Separate action, separate confirmation, mandatory reason. Deliberately not
 * folded into `transitionTask` with a flag: "I am forcing this" should be a
 * different thing to do, not a checkbox on the ordinary path.
 */
export async function overrideTaskStatus(
  taskId: string,
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  /*
   * P8-01c — WAS `requireRole("team_leader")`, AND A DEPARTMENT ADMIN MAY BE A
   * MEMBER. `p8_01c` widened `vizserve_pms_force_task_status`'s own guard to
   * `or vizserve_pms_is_dept_admin(department_id)`; leaving the rank floor here
   * would have refused the caller before the widened function was ever reached.
   *
   * ⚠️ THIS IS THE BELT AND IT ASKS THE WEAKER QUESTION, deliberately. The
   * task's department is not in hand yet — the id is all this action is given —
   * so the only honest thing to ask here is "does this person shape ANY
   * department". `vizserve_pms_force_task_status` is SECURITY DEFINER and asks
   * the real, per-department question about THIS task, and its refusal is a
   * sentence written for a person. Fetching the row here to re-ask it would be a
   * second copy of a rule that is already enforced, which is what this codebase
   * says not to do.
   */
  await requireDepartmentShape();

  const parsed = overridePayloadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_force_task_status", {
    p_task_id: taskId,
    p_to_status: parsed.data.to_status,
    p_reason: parsed.data.reason,
  });

  if (error) return { ok: false, error: readableError(error) };

  refresh(taskId);
  return { ok: true, data: { status: (data as { status: string }).status } };
}

// ---------------------------------------------------------------------------
// Editing the task itself
// ---------------------------------------------------------------------------

/*
 * P7-55 REMOVED `updateTaskDetails` FROM HERE.
 *
 * It wrote the whole form in one statement, behind the Save button on
 * `/tasks/[id]`. That page now autosaves per field, so the button went — and
 * with it the last caller. It is not merely redundant: it took `title` and
 * `description` from props the card never displayed, so pressing Save after a
 * rename in another tab wrote the old title back over the new one.
 *
 * `updateTaskField` below is now the ONLY writer of any task column, which is
 * what `editable-title.tsx` has argued for since it landed: a second path to
 * the same column is a second set of rules to keep in step.
 */

/**
 * K3 — one field, edited in place on a list row or a board card.
 *
 * Every column this can write is already inside the column-level UPDATE grant
 * (`p7_11a` restated the list) and already scoped by the UPDATE policy, so there
 * is no backend behind this — which is exactly why it is worth having. It does
 * not need the whole form: a row that only knows the new due date cannot send a
 * title and a description it never displayed.
 *
 * ⚠️ SINCE P7-55 THIS IS THE ONLY WRITER OF ANY TASK COLUMN. The task detail
 * page autosaves through it field by field, so a patch that arrives here is the
 * whole of what somebody changed — never a form echoing back values it was
 * handed. Adding a second whole-form action would reintroduce exactly the
 * clobber that one was deleted for.
 *
 * `status` is deliberately unreachable here. See `taskPatchSchema`.
 */
export async function updateTaskField(taskId: string, input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = taskPatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That change is not valid.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const patch = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      // Only the keys that arrived. Spreading conditionally rather than writing
      // `?? null` for each keeps "not sent" and "cleared" distinct — a row that
      // never showed the estimate must not be able to erase it.
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      // P7-55. `|| null` on the two text columns, not on `description`, and the
      // asymmetry is deliberate: `updateTaskDetails` stored `""` as NULL for
      // these two, and the DB resolution gate TRIMS before it checks, so a
      // column holding `''` where the rest of the app holds NULL is a
      // divergence that surfaces as "it says I wrote a resolution and QA says I
      // did not". `description` was always written raw.
      ...(patch.description !== undefined
        ? { description: sanitizeRichText(patch.description) }
        : {}),
      ...(patch.resolution !== undefined
        ? { resolution: patch.resolution ? sanitizeRichText(patch.resolution) : null }
        : {}),
      ...(patch.output_link !== undefined ? { output_link: patch.output_link || null } : {}),
      ...(patch.due_date !== undefined ? { due_date: patch.due_date || null } : {}),
      ...(patch.start_date !== undefined ? { start_date: patch.start_date || null } : {}),
      ...(patch.list_id !== undefined ? { list_id: patch.list_id } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.estimate_minutes !== undefined
        ? { estimate_minutes: patch.estimate_minutes }
        : {}),
    })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  // Trap 9 again, and this is the bug the timesheet already shipped twice: zero
  // rows is a REFUSAL reported as success. Every inline editor depends on this
  // line to tell the difference.
  if (!data || data.length === 0) return { ok: false, error: "That task is not yours to edit." };

  refresh(taskId);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// P7-08 — the conversation on a task
// ---------------------------------------------------------------------------

/**
 * P7-71 — the names `@` may offer on this task.
 *
 * ⚠️ WHO IS ON THE LIST DEPENDS ON WHO IS ASKING. Amier's rule: "if i am under
 * vizbytes i can only mention my team member, but if i am manager and admin
 * role i can mention everyone since i have access on each department". So a
 * member reaches their own team, a lead reaches the departments they oversee,
 * an admin reaches everybody — and on top of that, anybody in range of the TASK
 * is always offered, because the PIC and the QA reviewer may sit outside your
 * department and are the two people most likely to need naming.
 *
 * ⚠️ AN RPC RATHER THAN A QUERY, AND THAT IS THE WHOLE POINT. Neither half of
 * that rule is reachable with a `select` from here. A manager usually sits
 * OUTSIDE the department they oversee, so an ordinary member cannot read their
 * user row at all — `users read own department` (p7_17) stops at their own
 * department's roster — and a member cannot enumerate another department to
 * find out that an admin may address it either. A plain query would quietly
 * return the department and drop everything else.
 *
 * `vizserve_pms_mentionable_for_task` is `SECURITY DEFINER`, checks the caller
 * can see the task before it answers, and then applies the caller's own reach.
 * It is the SAME set the notify trigger intersects the posted body against —
 * asked there about the comment's author — so the menu cannot offer a name the
 * database would refuse to notify.
 *
 * ⚠️ CALLED FROM THE EDITOR, ON THE FIRST `@`, NOT ON PAGE LOAD. The comment
 * sheet opens from a list row that has no people loaded and no way to get any
 * without threading a roster through the table, the board and the sheet — three
 * call sites that would each have to agree about scope. One lazy call keeps the
 * answer in one place.
 */
export async function mentionableForTask(
  taskId: string,
): Promise<{ id: string; full_name: string }[]> {
  await requireAuthContextOrThrow();

  if (!z.uuid().safeParse(taskId).success) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_mentionable_for_task", {
    p_task_id: taskId,
  });

  /*
   * An empty list rather than a thrown error, on both paths. This feeds a menu
   * that opens while somebody is typing: "No one to mention here" is a fine
   * thing for it to say, and an exception out of a keystroke handler is not.
   * A caller who cannot see the task gets the same answer as a task with nobody
   * on it, which is also the correct answer.
   */
  if (error) return [];
  return data ?? [];
}

/**
 * No authorization beyond "signed in", and that is correct: the INSERT policy
 * requires the author to be the caller AND to be on the task, so a comment on
 * work somebody cannot see is refused by the database rather than by a check
 * here that would eventually drift from it.
 *
 * The notification to the other people on the task is a trigger, not a call
 * from here — a comment that only notifies when it arrives through the app is
 * one that silently notifies nobody the first time anything else writes one.
 */
export async function addTaskComment(taskId: string, input: unknown): Promise<ActionResult> {
  const context = await requireAuthContextOrThrow();

  if (!z.uuid().safeParse(taskId).success) {
    return { ok: false, error: "That task does not exist." };
  }

  const parsed = taskCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the comment.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("vizserve_pms_task_comments").insert({
    task_id: taskId,
    // Written explicitly because the column is NOT NULL. The policy still has
    // the final say — this value only ever equals auth.uid(), and a mismatched
    // one is refused rather than trusted.
    author_id: context.userId,
    body: sanitizeRichText(parsed.data.body),
  });

  if (error) return { ok: false, error: readableError(error) };

  refresh(taskId);
  return { ok: true, data: undefined };
}

export async function editTaskComment(commentId: string, input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = taskCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the comment.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();

  /*
   * P7-67 — READ THE OLD BODY FIRST, because after the update it is gone and
   * with it the only record of which pictures this comment used to hold. Read
   * through the user's own client, so a comment they cannot see returns nothing
   * and the update below refuses it anyway.
   */
  const { data: before } = await supabase
    .from("vizserve_pms_task_comments")
    .select("body")
    .eq("id", commentId)
    .maybeSingle();

  const body = sanitizeRichText(parsed.data.body);

  // `.select` because a policy-refused UPDATE is not an error — it is success
  // with zero rows, and without this an attempt to edit somebody else's comment
  // would report "Saved".
  const { data, error } = await supabase
    .from("vizserve_pms_task_comments")
    .update({ body })
    .eq("id", commentId)
    .select("task_id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That comment is not yours to edit." };

  const taskId = data[0]!.task_id;

  /*
   * ⚠️ AWAITED, AND AFTER THE UPDATE HAS SUCCEEDED. Before it, an edit that the
   * policy refused would still have deleted the files. Awaited rather than
   * fired and forgotten because a serverless function that returns does not
   * promise to finish anything still running — the cleanup would be dropped on
   * exactly the deployments where it matters.
   *
   * `sanitizeRichText` ran on both sides, so the two bodies are compared in the
   * form they are stored in. Comparing a raw draft against a stored body would
   * see markup differences that are not image differences.
   */
  await sweepCommentImages({ taskId, previousBody: before?.body, nextBody: body });

  refresh(taskId);
  return { ok: true, data: undefined };
}

export async function deleteTaskComment(commentId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  // `body` as well as `task_id`: a DELETE returns the row it removed, which is
  // the last chance to see which pictures went with it (P7-67).
  const { data, error } = await supabase
    .from("vizserve_pms_task_comments")
    .delete()
    .eq("id", commentId)
    .select("task_id, body");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That comment is not yours to remove." };
  }

  const removed = data[0]!;

  // No `nextBody` — the comment is gone, so every image it held is a candidate.
  // Whether each one actually goes is decided against the REMAINING comments.
  await sweepCommentImages({ taskId: removed.task_id, previousBody: removed.body });

  refresh(removed.task_id);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// P7-09 — subtasks
// ---------------------------------------------------------------------------

/**
 * Attach a task to a parent, or detach it with `null`.
 *
 * The two rules that make this safe — one level deep, and the same department
 * as the parent — are a trigger, because both have to read the parent row.
 * Nothing is re-checked here; the sentences the trigger raises are the ones
 * worth showing.
 */
export async function setTaskParent(taskId: string, input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = taskParentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a task to nest this under." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_tasks")
    .update({ parent_task_id: parsed.data.parent_task_id })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That task is not available." };

  refresh(taskId);
  return { ok: true, data: undefined };
}

/**
 * K3 — inline creation. The one action behind every "+ Add" in the tasks views.
 *
 * The foot of a status group, the foot of a board column, and the `+` on a row
 * that nests the result under a parent. THERE WAS A SECOND ACTION for that last
 * one — `createSubtask`, with its own title-only form — and it is gone: a subtask
 * is just another task with a parent, and two actions for "make a task" is how
 * the subtask one ends up without the fields the other one grew. `parent_task_id`
 * is one more optional field here.
 *
 * P7-09's rules are untouched by the merge. One level deep and same-department
 * are both a trigger, so the nesting UPDATE below re-checks nothing; and a
 * personal parent produces a personal child because the assignee defaults to the
 * caller, which is the branch that sets `is_personal`.
 *
 * IT ADDS AT ANY STAGE, and this REVERSES the plan's original call (19 Aug, at
 * Amier's instruction). That call was "first group only", on the grounds that
 * creating at OPEN and immediately transitioning writes two history rows for one
 * button press.
 *
 * Two things make the reversal right rather than a concession:
 *
 *   1. Everything this creates is INTERNAL OR PERSONAL work — there is no
 *      `request_id`, because a client task is only ever born from an approved
 *      request at Gate 1. So P7-13a's free movement always applies to it: any
 *      status to any status, no required fields, by anyone on the task. The
 *      transition below can never hit a gate, because the only work that has
 *      gates is the work this cannot create.
 *   2. The two history rows are not a lie. Somebody DID create the task and DID
 *      put it in that stage, and the trail saying so in two rows a second apart
 *      is a more complete record than one row claiming it was born there. The
 *      original objection assumed the trail would misrepresent one action; on
 *      re-reading, it represents it exactly.
 *
 * `FOR_CLIENT_APPROVAL` IS STILL REFUSED, and that is not the same rule. It is
 * a dead end rather than a gate: `vizserve_pms_issue_approval_token` refuses a
 * task with no request, so work moved there could never be finished or moved
 * back. `availableTransitions` excludes it from free movement for the same
 * reason, and this refuses it in the same words rather than letting the create
 * succeed and the move strand the task.
 *
 * Which function it calls is the same `is_personal` decision the dialog makes. A
 * member adding a line to their own list is recording their own work.
 */
export async function quickAddTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  const context = await requireAuthContextOrThrow();

  const parsed = z
    .object({
      title: z.string().trim().min(1, "A task needs a title.").max(300),
      /**
       * WHO IT IS FOR, and it is the only thing that decides the department.
       *
       * There is deliberately no `department_id` parameter any more. It was one,
       * and a caller could pass a department that disagreed with the assignee —
       * `vizserve_pms_create_task` would have refused the pair, but only after
       * the composer had already offered it. Deriving the department from the
       * person removes the disagreement instead of validating it.
       *
       * Null, or the caller themselves, means personal work.
       */
      assignee_id: z.uuid().nullable().default(null),
      /**
       * The stage the group or column this was typed into represents.
       *
       * Defaults to `INITIAL_TASK_STATUS`, so an omitted stage costs no second
       * write at all — the ordinary "add to Open" case is exactly one insert,
       * as it was before.
       */
      status: taskStatusSchema.default(INITIAL_TASK_STATUS),
      // The rest of the row. Every one of these is optional, because the fast
      // path is still a title and Enter — the fields are there for the times
      // somebody already knows the answer and would otherwise have to come back
      // and edit the row four times.
      /*
       * REQUIRED, matching the two dialogs. The composer already collects all
       * of these — priority, both dates and an assignee are fields in it — so
       * this is validation catching up with the form rather than a new demand
       * on the person typing.
       *
       * ⚠️ `assignee_id` STAYS NULLABLE HERE, and that is not an oversight.
       * `assignable` excludes the caller, so in this composer NULL IS how "mine"
       * is expressed — it is what routes to `create_personal_task`. Requiring a
       * non-null id would make a personal task impossible to add inline. If the
       * composer ever grows an explicit "Me" option, this becomes required too.
       */
      priority: z.enum(TASK_PRIORITIES, { error: "Choose a priority." }),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a due date."),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date."),
      estimate_minutes: z
        .number()
        .int("Give it in whole minutes.")
        .positive("An estimate of nothing is not an estimate.")
        .max(100_000, "That is more than ten working weeks — is it one task?")
        .nullable()
        .default(null),
      /**
       * P7-09. Set when the composer was opened from a task's `+` rather than
       * from the foot of a group — a subtask IS just another task, nested.
       */
      parent_task_id: z.uuid().nullable().default(null),
      /**
       * ⚠️ THIS FIELD DID NOT EXIST, AND EVERY TASK TYPED INLINE WAS FILED
       * NOWHERE.
       *
       * Both dialogs pass a list. This action does not CALL them — it
       * re-implements what they do, dispatching to the same two RPCs itself —
       * so it carried its own copy of the payload, and that copy sent
       * `p_list_id: null` hardcoded to both. Three call sites building one
       * payload; two of them right.
       *
       * The failure was invisible in the way that matters most: the task WAS
       * created and the toast said so, then it did not appear in the list it
       * had been typed into, because it was not in that list. It read as a save
       * that had silently failed.
       *
       * The real repair is for this action to call `createTask` /
       * `createPersonalTask` rather than duplicate them. Until then this is the
       * third copy, kept honest.
       */
      list_id: z.uuid().nullable().default(null),
    })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "A task needs a title." };
  }

  const values = parsed.data;

  // Checked before anything is written. Creating the task and then discovering
  // the move is impossible would leave a stray task at OPEN that nobody asked
  // for — see `availableTransitions` for why this status is excluded.
  if (values.status === "FOR_CLIENT_APPROVAL") {
    return {
      ok: false,
      error:
        "Work with no client cannot sit at For client approval — there would be no client to approve it.",
    };
  }

  const supabase = await createClient();

  /*
   * PERSONAL OR ASSIGNED, decided exactly as the dialog decides it (P7-01).
   *
   * Assigned to me, or to nobody, is my own work: `create_personal_task` sets
   * `is_personal = true` and I can close it myself. Assigned to a colleague is
   * not personal, whoever typed it. The choice is recorded in a column that sits
   * outside the UPDATE grant and can never change again, which is why it has to
   * be made correctly here and not derived later (correction 1).
   */
  const forSomebodyElse = values.assignee_id !== null && values.assignee_id !== context.userId;

  let departmentId: string | null = null;

  /*
   * ⚠️ A SUBTASK INHERITS ITS PARENT'S LIST, AND WITHOUT THIS IT VANISHES.
   *
   * `list_id` defaults to null and the composer on the task page has no list
   * picker — there is nothing to pick, the parent already decided. So a subtask
   * added from `/tasks/[id]` was created with NO LIST, and both views that
   * matter are list-filtered: `/tasks` redirects to the index unless `?list=`
   * is set, and the board honours the same parameter. The subtask existed, the
   * parent's page listed it, and it appeared on neither the list nor the board
   * — which reads as the add having silently failed.
   *
   * The DEPARTMENT comes from the parent for the same reason and one stronger:
   * `vizserve_pms_check_subtask_parent` refuses a child whose department
   * differs, so deriving it from the assignee — who may sit in another
   * department — turned a legal action into "A subtask belongs to the same
   * department as the task above it" at the last step, after the task had
   * already been created.
   */
  let inheritedListId = values.list_id;

  if (values.parent_task_id) {
    const { data: parent } = await supabase
      .from("vizserve_pms_tasks")
      .select("department_id, list_id")
      .eq("id", values.parent_task_id)
      .maybeSingle();

    if (!parent) {
      return { ok: false, error: "That task is no longer available to add a subtask to." };
    }

    departmentId = parent.department_id;
    // The caller's own list wins only if they actually named one; the composer
    // on the task page does not, which is the case this exists for.
    inheritedListId = values.list_id ?? parent.list_id;
  }

  // ⚠️ `!departmentId`: a parent has already decided, and its answer outranks
  // the assignee's own department — see the subtask note above.
  if (forSomebodyElse && !departmentId) {
    // The DEPARTMENT COMES FROM THE PERSON. Read through the caller's own client
    // so RLS decides whether they can see that colleague at all — and
    // `vizserve_pms_create_task` re-checks the department against the caller's
    // own row afterwards, so this is the convenient half, never the enforcing
    // one.
    const { data: assignee } = await supabase
      .from("vizserve_pms_users")
      .select("primary_department_id")
      .eq("id", values.assignee_id!)
      .eq("is_active", true)
      .maybeSingle();

    if (!assignee?.primary_department_id) {
      return { ok: false, error: "That person is not an active member of any department." };
    }

    departmentId = assignee.primary_department_id;
  }

  const created = departmentId
    ? await supabase.rpc("vizserve_pms_create_task", {
        p_department_id: departmentId,
        p_title: values.title,
        p_description: "",
        p_assignee_id: values.assignee_id,
        p_qa_assignee_id: null,
        p_due_date: values.due_date || null,
        // The list the composer was typed into. create_task refuses one outside
        // the task's own department, so this is a proposal, not an authority.
        p_list_id: inheritedListId,
        p_priority: values.priority,
      })
    : await supabase.rpc("vizserve_pms_create_personal_task", {
        p_title: values.title,
        p_description: "",
        p_due_date: values.due_date || null,
        // create_personal_task RAISES on a list in another department, so a
        // stale one surfaces as a sentence rather than filing the task nowhere.
        p_list_id: inheritedListId,
        p_priority: values.priority,
      });

  if (created.error) return { ok: false, error: readableError(created.error) };

  const taskId = (created.data as { task_id: string }).task_id;

  // Neither create function takes a start date or an estimate, so they are a
  // follow-up patch on the row that now exists — the same helper the dialogs
  // use, and the same reason (trap 3: widening an applied signature means a drop
  // and a regrant for two nullable columns).
  const extras = await writeCreationExtras(supabase, taskId, values);
  if (!extras.ok) {
    refresh();
    return { ok: false, error: extras.error };
  }

  /*
   * P7-09 — nesting, when this was opened from a task's `+`.
   *
   * A subtask IS just another task with a parent, which is why it comes through
   * the same composer and the same action rather than a second path that would
   * drift from it. The one-level rule and the same-department rule are both a
   * trigger, so nothing is re-checked here.
   */
  if (values.parent_task_id) {
    const { data: nested, error: nestError } = await supabase
      .from("vizserve_pms_tasks")
      .update({ parent_task_id: values.parent_task_id })
      .eq("id", taskId)
      .select("id");

    if (nestError || !nested || nested.length === 0) {
      refresh();
      return {
        ok: false,
        error: nestError
          ? `The task was created but not nested: ${readableError(nestError).toLowerCase()}`
          : "The task was created, but it could not be nested under that one.",
      };
    }
  }

  /*
   * The second write, and only when there is one to make.
   *
   * `vizserve_pms_transition_task` is the ONLY path that changes a status —
   * `status` stays outside the column UPDATE grant — so this goes through it
   * like every other move and writes its history row like every other move.
   * Free movement means no gates; it has never meant no record.
   */
  if (values.status !== INITIAL_TASK_STATUS) {
    const moved = await supabase.rpc("vizserve_pms_transition_task", {
      p_task_id: taskId,
      p_to_status: values.status,
      p_comment: null,
    });

    if (moved.error) {
      // The task EXISTS at OPEN. Say which half worked rather than implying
      // nothing happened — the same rule `transitionTask` follows when the
      // client email fails after the move has committed.
      refresh();
      return {
        ok: false,
        error: `Added, but it stayed in ${TASK_STATUS_LABELS[INITIAL_TASK_STATUS]}: ${readableError(moved.error).toLowerCase()}`,
      };
    }
  }

  dispatchPendingEmailsInBackground();
  refresh();

  return { ok: true, data: { taskId } };
}

/**
 * P7-13 — the OTHER people on a task.
 *
 * `assignee_id` stays the ACCOUNTABLE name: one person the task is filed under,
 * what the board sorts by, what "assigned to you" in a notification means. This
 * join table is who is WORKING on it, and every one of them is a full
 * participant — the SELECT and UPDATE policies, `may_log_time` and the
 * transition ownership guard all run through `vizserve_pms_is_on_task`, so a
 * second assignee can see it, edit it, log time against it and move it.
 *
 * THE TABLE HAS NO INSERT OR DELETE POLICY. These two functions are the only way
 * in or out, which is what makes "who is on this task" a decision with an
 * `added_by` and an `added_at` on it rather than a row anybody can write.
 *
 * The functions have been applied since 18 Aug and NOTHING HAS EVER CALLED THEM.
 * The whole several-assignees model was reachable only through the API.
 */
export async function addTaskAssignee(taskId: string, userId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(userId).success) {
    return { ok: false, error: "That task or person does not exist." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_add_task_assignee", {
    p_task_id: taskId,
    p_user_id: userId,
  });

  if (error) return { ok: false, error: readableError(error) };

  // A new participant needs telling, exactly as a new PIC does. Same type, same
  // link — from their side, being added to a task IS being assigned to it.
  const { data: detail } = await supabase
    .from("vizserve_pms_tasks")
    .select("title")
    .eq("id", taskId)
    .maybeSingle();

  await supabase.rpc("vizserve_pms_notify", {
    p_user_id: userId,
    p_type: "assigned",
    p_title: `You are on: ${detail?.title ?? "a task"}`,
    p_body: "",
    p_entity_type: "task",
    p_entity_id: taskId,
    p_link_path: `/tasks/${taskId}`,
  });

  dispatchPendingEmailsInBackground();
  refresh(taskId);
  return { ok: true, data: undefined };
}

export async function removeTaskAssignee(taskId: string, userId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_remove_task_assignee", {
    p_task_id: taskId,
    p_user_id: userId,
  });

  if (error) return { ok: false, error: readableError(error) };

  // Deliberately no notification. Being taken off a task is not news somebody
  // needs an email about, and the removal is visible on the task itself.
  refresh(taskId);
  return { ok: true, data: undefined };
}

/**
 * P7-14 — reassignment is no longer a Team Leader decision.
 *
 * IT USED TO BE `requireRole("team_leader")`, and that line outlived the rule it
 * enforced. `p7_14` widened the tasks UPDATE policy's WITH CHECK to accept any
 * active member of the task's department precisely so a member could hand work
 * to a colleague without a lead — and while this action kept the role gate, the
 * applied migration was unreachable from the app. A rule the database allows and
 * the action refuses is worse than either alone, because the tests pass.
 *
 * The department boundary is the guard that remains, and it is enforced twice on
 * purpose: the check below turns it into a sentence somebody can read, and the
 * policy's WITH CHECK is what makes it true. This function being the polite copy
 * is the reason it may be relaxed safely.
 *
 * Note what is NOT relaxed: `USING` still requires the caller to be a
 * participant or lead the department, so a member cannot reassign work they were
 * never part of.
 */
export async function reassignTask(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const schema = z.object({
    assignee_id: z.uuid().nullable(),
    qa_assignee_id: z.uuid().nullable(),
  });

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Choose valid people.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();

  const { data: task } = await supabase
    .from("vizserve_pms_tasks")
    .select("department_id, assignee_id")
    .eq("id", taskId)
    .maybeSingle();

  if (!task) return { ok: false, error: "That task is not available." };

  // Same rule as approval and manual creation: work belongs to the department
  // doing it, or somebody holds a task their own TL cannot see.
  if (parsed.data.assignee_id) {
    const { data: candidate } = await supabase
      .from("vizserve_pms_users")
      .select("id")
      .eq("id", parsed.data.assignee_id)
      .eq("primary_department_id", task.department_id)
      .eq("is_active", true)
      .maybeSingle();

    if (!candidate) {
      return {
        ok: false,
        error: "That person is not an active member of this task's department.",
      };
    }
  }

  const { data: updated, error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      assignee_id: parsed.data.assignee_id,
      qa_assignee_id: parsed.data.qa_assignee_id,
    })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  // Trap 9. Now that this is open to members, the policy is the thing actually
  // deciding — and a refusal arrives as zero rows, not as an error. Without this
  // line a member reassigning outside their scope is told "Reassigned" and then
  // watches the page refresh unchanged.
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That task is not yours to reassign." };
  }

  // A new PIC needs telling; the old one already knows they handed it over.
  if (parsed.data.assignee_id && parsed.data.assignee_id !== task.assignee_id) {
    const { data: detail } = await supabase
      .from("vizserve_pms_tasks")
      .select("title")
      .eq("id", taskId)
      .maybeSingle();

    await supabase.rpc("vizserve_pms_notify", {
      p_user_id: parsed.data.assignee_id,
      p_type: "assigned",
      p_title: `Assigned to you: ${detail?.title ?? "a task"}`,
      p_body: "",
      p_entity_type: "task",
      p_entity_id: taskId,
      p_link_path: `/tasks/${taskId}`,
    });

    dispatchPendingEmailsInBackground();
  }

  refresh(taskId);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// P3-12 — a task with no request behind it
// ---------------------------------------------------------------------------

/**
 * P7-14 — a member creates work for a colleague in their OWN department.
 *
 * The role gate came off for the same reason it came off `reassignTask`: the
 * applied migration resolves the caller's department from their own row and
 * raises *"That department is outside your scope."* for anything else, so the
 * boundary is in the function that a `curl` cannot skip. Keeping
 * `requireRole("team_leader")` here left P7-14 applied and unreachable.
 *
 * `p_department_id` IS still a parameter, and that looks like the hole. It is
 * not: `vizserve_pms_create_task` admits it only when the caller leads that
 * department or it is their own. A member passing somebody else's department id
 * gets the exception, which is why this action can pass it through untrusted.
 */
export async function createTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  await requireAuthContextOrThrow();

  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const values = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_create_task", {
    p_department_id: values.department_id,
    p_title: values.title,
    p_description: sanitizeRichText(values.description),
    p_assignee_id: values.assignee_id,
    p_qa_assignee_id: values.qa_assignee_id,
    p_due_date: values.due_date || null,
    p_list_id: values.list_id,
    // ⚠️ P7-11. OPTIONAL to the compiler, because the SQL parameter has a
    // default — so leaving it out is not a type error, it just files every task
    // as unranked. `tests/db/tasks.test.ts` is the guard, not tsc.
    p_priority: values.priority,
  });

  if (error) return { ok: false, error: readableError(error) };

  const taskId = (data as { task_id: string }).task_id;
  const extras = await writeCreationExtras(supabase, taskId, {
    ...values,
    /*
     * ⚠️ THE PIC IS NOT ONE OF THE OTHERS. `vizserve_pms_create_task` has
     * already written them to `assignee_id`, and a picker that lets somebody be
     * ticked as both would put them on the join table as well — a second row
     * for a person who is already on the task, which `AssigneePicker` then has
     * to filter back out on every render. Deduped for the same reason: two
     * clicks on one name must not become two calls.
     */
    extra_assignee_ids: [...new Set(values.extra_assignee_ids)].filter(
      (id) => id !== values.assignee_id,
    ),
  });

  dispatchPendingEmailsInBackground();
  refresh();

  // The task EXISTS either way — say which part failed rather than implying
  // nothing happened, which is the same rule `transitionTask` follows when the
  // client email fails after the move committed.
  if (!extras.ok) return { ok: false, error: extras.error };

  return { ok: true, data: { taskId } };
}

/**
 * The start date and the estimate, written after the row exists.
 *
 * `vizserve_pms_create_task` and `vizserve_pms_create_personal_task` have neither
 * parameter, and widening an applied function's argument list means a drop and a
 * regrant with PostgREST resolving overloads by argument NAME (trap 3) — too
 * much ceremony for two nullable columns that the column-level UPDATE grant
 * already permits.
 *
 * Returns ok when there was nothing to write, so the ordinary case costs no
 * round trip at all.
 */
async function writeCreationExtras(
  supabase: Awaited<ReturnType<typeof createClient>>,
  taskId: string,
  values: {
    start_date: string;
    estimate_minutes: number | null;
    /**
     * Everybody on the task BESIDES the accountable owner.
     *
     * ⚠️ `assignee_id` AND `vizserve_pms_task_assignees` ARE NOT THE SAME
     * THING, and the split is deliberate (P7-13). The column is the ONE person
     * answerable for the work; the join table is everyone doing it. A task with
     * four people still has exactly one name against it, which is what stops
     * "assigned to the team" meaning assigned to nobody.
     *
     * So the create RPCs keep their single `p_assignee_id` and these are added
     * afterwards, one call each — there is no bulk function, and inventing one
     * would duplicate the rules `vizserve_pms_add_task_assignee` already
     * enforces: the person must be an active member of the TASK'S department,
     * and the caller must be on the task or lead it.
     */
    extra_assignee_ids?: string[];
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const extraAssignees = values.extra_assignee_ids ?? [];

  if (!values.start_date && values.estimate_minutes === null && extraAssignees.length === 0) {
    return { ok: true };
  }

  /*
   * ⚠️ GUARDED, BECAUSE AN EMPTY PATCH IS NOT A NO-OP. When only people were
   * added — no start date, no estimate — this used to build `.update({})`,
   * which PostgREST rejects rather than ignoring. The columns and the people
   * are two independent writes now and each runs only if it has something.
   */
  if (values.start_date || values.estimate_minutes !== null) {
    const { data, error } = await supabase
      .from("vizserve_pms_tasks")
      .update({
        ...(values.start_date ? { start_date: values.start_date } : {}),
        ...(values.estimate_minutes !== null
          ? { estimate_minutes: values.estimate_minutes }
          : {}),
      })
      .eq("id", taskId)
      .select("id");

    if (error) {
      return { ok: false, error: `The task was created, but ${readableError(error).toLowerCase()}` };
    }
    // Trap 9. Reachable in one real case: a lead files work into a department
    // they lead but are not a participant in, so `create_task` succeeds inside
    // its SECURITY DEFINER and the follow-up UPDATE is judged by the policy.
    if (!data || data.length === 0) {
      return {
        ok: false,
        error: "The task was created, but the start date and estimate could not be saved to it.",
      };
    }
  }

  /*
   * The additional people, one call each, AFTER the row exists.
   *
   * ⚠️ SEQUENTIAL, NOT `Promise.all`. Each call is a separate transaction that
   * can be refused on its own — somebody deactivated between opening the form
   * and saving it, somebody in the wrong department — and the message has to
   * name which one. A parallel batch would report the first rejection and leave
   * the caller guessing which of four names it meant.
   *
   * ⚠️ THE TASK IS ALREADY CREATED BY THIS POINT and is not rolled back. That
   * is the honest shape: the row is real, the work exists, and one name failed
   * to attach. Saying so beats discarding a task somebody just typed, and the
   * assignee can be added from the task page in one click.
   */
  for (const userId of extraAssignees) {
    const { error: assigneeError } = await supabase.rpc("vizserve_pms_add_task_assignee", {
      p_task_id: taskId,
      p_user_id: userId,
    });

    if (assigneeError) {
      return {
        ok: false,
        error: `The task was created, but one of the people could not be added: ${readableError(
          assigneeError,
        ).toLowerCase()}`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// P7-01 — a task somebody records for themselves
// ---------------------------------------------------------------------------

/**
 * `requireAuthContextOrThrow`, NOT `requireRole` — and that is the whole point
 * of the slice. Creating work for somebody else stays at team_leader (see
 * `createTask` above); recording your own does not.
 *
 * There is no department check here and no assignee to validate, because
 * neither is in the payload. `vizserve_pms_create_personal_task` reads both off
 * the caller's own user row, so the only thing this action can get wrong is the
 * title.
 */
export async function createPersonalTask(
  input: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  await requireAuthContextOrThrow();

  const parsed = createPersonalTaskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const values = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_create_personal_task", {
    p_title: values.title,
    p_description: sanitizeRichText(values.description),
    p_due_date: values.due_date || null,
    p_list_id: values.list_id,
    // P7-11. Present here where department and assignee are not: how urgent
    // your own work is IS yours to decide.
    p_priority: values.priority,
  });

  if (error) return { ok: false, error: readableError(error) };

  const taskId = (data as { task_id: string }).task_id;
  const extras = await writeCreationExtras(supabase, taskId, values);

  // No `dispatchPendingEmailsInBackground` — nothing was sent. The create
  // function deliberately notifies nobody, because the only person involved is
  // the one who just pressed the button.
  refresh();

  if (!extras.ok) return { ok: false, error: extras.error };

  return { ok: true, data: { taskId } };
}

// ---------------------------------------------------------------------------
// P3-13 — task attachments
// ---------------------------------------------------------------------------

/**
 * Uploads the PIC's output against a task.
 *
 * The order here is the point, and it is the same order as the request
 * attachment download: ESTABLISH SCOPE FIRST, through the user's own client so
 * RLS decides, and only then hand the bytes to the service-role uploader. Doing
 * it the other way round means a scope bug has already written a file.
 */
export async function uploadTaskOutput(
  formData: FormData,
): Promise<ActionResult<{ id: string; filename: string }>> {
  const context = await requireAuthContextOrThrow();

  const taskId = formData.get("task_id");
  const file = formData.get("file");

  if (typeof taskId !== "string" || !(file instanceof File)) {
    return { ok: false, error: "Nothing was uploaded." };
  }

  const supabase = await createClient();

  // Zero rows here means out of scope OR nonexistent, and the caller learns the
  // same thing either way — which is correct.
  const { data: task } = await supabase
    .from("vizserve_pms_tasks")
    .select("id, status")
    .eq("id", taskId)
    .maybeSingle();

  if (!task) return { ok: false, error: "That task is not available." };

  if (task.status === "COMPLETED" || task.status === "COMPLETED_NO_RESPONSE") {
    return { ok: false, error: "That task is finished — its files are now a record." };
  }

  const result = await uploadTaskAttachment({
    taskId,
    file,
    uploadedBy: context.userId,
  });

  if (!result.ok) return result;

  revalidatePath(`/tasks/${taskId}`);
  return {
    ok: true,
    data: { id: result.attachment.id, filename: result.attachment.filename },
  };
}

// ---------------------------------------------------------------------------
// P7-70 — acting on a selection
//
// ⚠️ TWO ACTIONS, NOT ONE, AND THE SPLIT IS THE DATABASE'S. Assignee, dates and
// priority are ordinary columns: one UPDATE covers the whole selection and RLS
// decides it row by row. `status` is not a column anybody may write — it is
// outside the UPDATE grant, and `vizserve_pms_transition_task` is the only way
// a task moves. That function refuses illegal moves, the QA gate and a missing
// resolution, per task, so a bulk move is N calls that can partly fail.
//
// Collapsing the two behind one "apply" would mean an action that is sometimes
// atomic and sometimes not, reported the same way both times.
// ---------------------------------------------------------------------------

/**
 * Set the same fields on every selected task.
 *
 * ⚠️ ONE STATEMENT, NOT A LOOP. These are ordinary column writes and RLS filters
 * the `in` list for us — a row the caller may not edit is simply not returned,
 * which is how the count of what changed comes back honest without asking about
 * each row first.
 */
export async function bulkEditTasks(
  taskIds: string[],
  input: unknown,
): Promise<ActionResult<{ changed: number; refused: number }>> {
  await requireAuthContextOrThrow();

  if (taskIds.length === 0) return { ok: false, error: "Nothing is selected." };

  const parsed = bulkEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Nothing to change." };
  }

  const patch = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      // Only the keys that arrived — "not sent" and "cleared" stay distinct, or
      // a bulk edit of the due date would wipe the priority off forty rows.
      ...(patch.assignee_id !== undefined ? { assignee_id: patch.assignee_id } : {}),
      ...(patch.due_date !== undefined ? { due_date: patch.due_date || null } : {}),
      ...(patch.start_date !== undefined ? { start_date: patch.start_date || null } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    })
    .in("id", taskIds)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };

  const changed = data?.length ?? 0;

  refresh();
  return { ok: true, data: { changed, refused: taskIds.length - changed } };
}

/**
 * Move every selected task to one status.
 *
 * ⚠️ ONE CALL PER TASK, AND A REFUSAL IS THE NORMAL CASE RATHER THAN AN ERROR.
 * `vizserve_pms_transition_task` enforces the legal-transition table, the QA
 * gate and the resolution gate, so moving eight tasks to FOR_QA legitimately
 * produces "five moved, three need a resolution first". Reporting that as a
 * failure would be wrong, and reporting it as success would be worse.
 *
 * The reasons are collected and counted rather than listed one per toast: eight
 * toasts saying the same sentence is not eight pieces of information.
 */
export async function bulkTransitionTasks(
  taskIds: string[],
  toStatus: unknown,
): Promise<ActionResult<{ moved: number; refused: number; reasons: string[] }>> {
  await requireAuthContextOrThrow();

  if (taskIds.length === 0) return { ok: false, error: "Nothing is selected." };

  const parsed = taskStatusSchema.safeParse(toStatus);
  if (!parsed.success) return { ok: false, error: "That is not a status." };

  const supabase = await createClient();

  let moved = 0;
  const reasons = new Map<string, number>();

  for (const taskId of taskIds) {
    const { error } = await supabase.rpc("vizserve_pms_transition_task", {
      p_task_id: taskId,
      p_to_status: parsed.data,
      /* No comment on a bulk move. The single-task path asks for one where the
         transition table demands it (a QA return), and those moves are exactly
         the ones nobody should be making forty at a time without saying why. */
      p_comment: null,
    });

    if (error) {
      const reason = readableError(error);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      continue;
    }

    moved += 1;
  }

  if (moved > 0) refresh();

  return {
    ok: true,
    data: {
      moved,
      refused: taskIds.length - moved,
      // Commonest first: with a mixed selection the leading reason is the one
      // worth reading.
      reasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => (count > 1 ? `${reason} (${count} tasks)` : reason)),
    },
  };
}

// ---------------------------------------------------------------------------
// P7-69 — copying tasks
// ---------------------------------------------------------------------------

/**
 * Where these tasks can be copied TO, and who they can be assigned to.
 *
 * ⚠️ IT ANSWERS THE DEPARTMENT QUESTION BEFORE THE DIALOG ASKS IT. A copy stays
 * inside its own department (see the migration), so a selection spanning two
 * departments has no single set of targets — and that is a thing to say up
 * front rather than a refusal to discover after picking a list. `spans` is that
 * sentence.
 *
 * The lists come back through the user's own client, so RLS has already removed
 * anything they cannot see.
 */
export async function selectionTargets(taskIds: string[]): Promise<
  ActionResult<{
    lists: { id: string; name: string }[];
    people: { id: string; full_name: string }[];
    spans: boolean;
  }>
> {
  await requireAuthContextOrThrow();

  if (taskIds.length === 0) return { ok: false, error: "Nothing is selected." };

  const supabase = await createClient();

  const { data: tasks, error } = await supabase
    .from("vizserve_pms_tasks")
    .select("id, department_id")
    .in("id", taskIds);

  if (error) return { ok: false, error: readableError(error) };
  if (!tasks || tasks.length === 0) return { ok: false, error: "Those tasks are not available." };

  const departments = new Set(tasks.map((task) => task.department_id));
  if (departments.size > 1) return { ok: true, data: { lists: [], people: [], spans: true } };

  const department = [...departments][0]!;

  const { data: lists } = await supabase
    .from("vizserve_pms_lists")
    .select("id, name")
    .eq("department_id", department)
    /* P11-06 — a personal list is one person's own, invisible even to their
       lead. It is not a filing cabinet for the team's work, so the picker never
       offers one. `owner_id`, not a flag: null is an ordinary department list. */
    .is("owner_id", null)
    /* An archived list is not a place to put new work. */
    .eq("is_active", true)
    .order("name");

  /*
   * P7-70 — the same call answers "who can this be assigned to". One round trip
   * for both because both dialogs open from the same bar and both need the
   * department resolved first; and the rule is the same rule `quickAddTask`
   * applies — work belongs to the department doing it, so offering anybody else
   * is offering a door the server does not open.
   */
  const { data: people } = await supabase
    .from("vizserve_pms_users")
    .select("id, full_name")
    .eq("primary_department_id", department)
    .eq("is_active", true)
    .order("full_name");

  return { ok: true, data: { lists: lists ?? [], people: people ?? [], spans: false } };
}

/**
 * Copy every selected task into one list.
 *
 * ⚠️ ONE AT A TIME, AND A FAILURE DOES NOT STOP THE REST. Seven tasks is seven
 * calls; the sixth being a client-backed task somebody may not copy must not
 * lose the other six. The count that comes back is what actually happened, and
 * the caller reports both halves — "5 copied, 2 could not be" is the truth and
 * "Done" is not.
 *
 * Sequential rather than `Promise.all`: these are writes against one list, and
 * a burst of seven that half-fails is harder to reason about than seven that
 * fail in order.
 */
export async function copyTasks(
  taskIds: string[],
  input: unknown,
): Promise<ActionResult<{ copied: number; failed: number; firstError: string | null }>> {
  await requireAuthContextOrThrow();

  const parsed = copySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the copy options." };
  if (taskIds.length === 0) return { ok: false, error: "Nothing is selected." };

  const supabase = await createClient();

  let copied = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const taskId of taskIds) {
    const { error } = await supabase.rpc("vizserve_pms_copy_task", {
      p_task_id: taskId,
      p_list_id: parsed.data.listId,
      p_include: parsed.data.include,
    });

    if (error) {
      failed += 1;
      firstError = firstError ?? readableError(error);
      continue;
    }

    copied += 1;
  }

  // One refresh at the end rather than one per task: the list is re-read once
  // however many landed on it.
  if (copied > 0) refresh();

  return { ok: true, data: { copied, failed, firstError } };
}

// ---------------------------------------------------------------------------
// P7-68 — checklists
//
// Four actions, and between them they are the whole feature: add a step, tick
// it, rename it, remove it. No reorder yet — `position` steps by 10 so one can
// be added later without renumbering, which is the cheap half of leaving that
// door open.
//
// ⚠️ EVERY ONE OF THEM GOES THROUGH THE USER'S OWN CLIENT, so RLS decides. The
// policies say "anyone who can open the task", which is the same audience that
// can comment on it and log time against it (P11-03/P11-06). Nothing here
// re-checks that in TypeScript: restating a policy is how the two drift, and the
// policy is the one that cannot be bypassed.
//
// ⚠️ A REFUSED WRITE IS ZERO ROWS, NOT AN ERROR. Every one of these selects what
// it changed and treats an empty result as a refusal — without that, ticking an
// item on a task you cannot see reports "Saved".
// ---------------------------------------------------------------------------

export async function addChecklistItem(
  taskId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  await requireAuthContextOrThrow();

  if (!z.uuid().safeParse(taskId).success) {
    return { ok: false, error: "That task does not exist." };
  }

  const parsed = checklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the step.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();

  /*
   * ⚠️ THROUGH THE RPC, NOT A DIRECT INSERT, and only for the position. Two
   * people adding a step at the same moment would both read "the last is 30"
   * and both write 40, and the order of a procedure becomes arbitrary. The
   * function computes it inside the insert. It is `security invoker`, so the
   * policies decide exactly as they would here.
   */
  const { data, error } = await supabase.rpc("vizserve_pms_add_checklist_item", {
    p_task_id: taskId,
    p_label: parsed.data.label,
  });

  if (error) return { ok: false, error: readableError(error) };
  if (!data) return { ok: false, error: "That task is not available." };

  refresh(taskId);
  return { ok: true, data: { id: data.id } };
}

export async function setChecklistItemDone(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = checklistToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That step does not exist." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_task_checklist_items")
    .update({ is_done: parsed.data.is_done })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };

  /*
   * ⚠️ NO `refresh` ON A TICK. The box is optimistic in the browser and a tick
   * changes nothing else on the page — re-rendering the route would throw away
   * a step somebody is typing in the box below, to redraw a checkbox that has
   * already moved. Adding and removing DO refresh: those change the list itself.
   */
  void taskId;
  return { ok: true, data: undefined };
}

export async function renameChecklistItem(
  taskId: string,
  itemId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = checklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the step.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_task_checklist_items")
    .update({ label: parsed.data.label })
    .eq("id", itemId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };

  refresh(taskId);
  return { ok: true, data: undefined };
}

export async function removeChecklistItem(taskId: string, itemId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_task_checklist_items")
    .delete()
    .eq("id", itemId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };

  refresh(taskId);
  return { ok: true, data: undefined };
}

/**
 * P7-67 — an image pasted or dropped into a comment box.
 *
 * ⚠️ IT COMMITS ON PASTE, BEFORE THE COMMENT IS SENT, and that is not the
 * two-step handshake P1-09 built for the public form. It does not need to be:
 * the caller is authenticated, the task is known, and the `src` that ends up in
 * the body is an attachment id this action minted — there is no gap for a
 * fabricated path to live in. What it costs is an orphan when somebody pastes a
 * screenshot and then closes the tab. Written down in the migration; a few
 * hundred kilobytes is the right trade against a comment box that cannot show
 * you the picture until you press Send.
 *
 * ⚠️ IMAGES ONLY, and a tighter list than `vizserve_pms_attachment_rules`
 * carries. That table is the rule for FILES — a client may attach a .docx to a
 * brief, a PIC may upload a PDF as an output. This is the rule for a thing that
 * has to render inside a paragraph, so anything that would draw a broken icon
 * is refused here rather than accepted and then not displayed. `image/svg+xml`
 * is absent for the reason P1-09 gives at length: an SVG is a script container.
 *
 * SCOPE FIRST, THROUGH THE VIEWER'S OWN CLIENT, then the service-role uploader —
 * the same order as `uploadTaskOutput` above, for the same reason. But NOT its
 * `COMPLETED` refusal: a finished task can still be commented on (P7-08 puts no
 * status in the comment policy), and a comment you can write but cannot
 * illustrate is a worse rule than either.
 */
const COMMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export async function uploadCommentImage(
  formData: FormData,
): Promise<
  ActionResult<{
    id: string;
    src: string;
    /** Null when the header could not be read — see `lib/image-size.ts`. */
    width: number | null;
    height: number | null;
    orientation: "landscape" | "portrait" | "square" | null;
  }>
> {
  const context = await requireAuthContextOrThrow();

  const taskId = formData.get("task_id");
  const file = formData.get("file");

  if (typeof taskId !== "string" || !(file instanceof File)) {
    return { ok: false, error: "Nothing was uploaded." };
  }

  if (!COMMENT_IMAGE_TYPES.includes((file.type || "").toLowerCase())) {
    return { ok: false, error: "Only PNG, JPEG, GIF and WebP images can go in a comment." };
  }

  const supabase = await createClient();

  // Zero rows means out of scope OR nonexistent, and the caller learns the same
  // thing either way.
  const { data: task } = await supabase
    .from("vizserve_pms_tasks")
    .select("id")
    .eq("id", taskId)
    .maybeSingle();

  if (!task) return { ok: false, error: "That task is not available." };

  const result = await uploadTaskAttachment({
    taskId,
    file,
    uploadedBy: context.userId,
    kind: "comment",
  });

  if (!result.ok) return result;

  /*
   * ⚠️ MEASURED FROM THE BYTES, AFTER THE UPLOAD, AND NEVER FATAL.
   *
   * The dimensions decide how the picture is capped in a thread (§ `.rich-text
   * img` in globals.css), so they are read here rather than asked of the
   * browser — the one participant that can lie about them. A header this cannot
   * parse returns nulls, the editor writes no orientation, and the image gets
   * the fallback cap. A picture laid out slightly worse is not a reason to
   * refuse an upload that already succeeded.
   */
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const measured = readImageSize(head);

  /*
   * No `revalidatePath`. Nothing on the page has changed yet — the row exists
   * but nothing references it until the author presses Send, and refreshing the
   * route here would throw away the draft they are still typing.
   */
  return {
    ok: true,
    data: {
      id: result.attachment.id,
      src: taskImageSrc(result.attachment.id),
      width: measured?.width ?? null,
      height: measured?.height ?? null,
      orientation: measured?.orientation ?? null,
    },
  };
}

/**
 * A signed URL for a task attachment.
 *
 * Same shape as the request-attachment download: read through RLS, then sign.
 * Sixty seconds — long enough to click, short enough that a URL pasted into a
 * chat is dead before anyone opens it.
 */
export async function getTaskAttachmentUrl(
  attachmentId: string,
): Promise<ActionResult<{ url: string }>> {
  await requireAuthContextOrThrow();
  const supabase = await createClient();

  const { data: attachment } = await supabase
    .from("vizserve_pms_task_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!attachment) return { ok: false, error: "That file is not available." };

  const url = await signAttachmentUrl(attachment.storage_path, 60);
  if (!url) return { ok: false, error: "That file could not be opened." };

  return { ok: true, data: { url } };
}

/**
 * P7-22 — opening a file the CLIENT attached, from the task.
 *
 * A separate action from `getAttachmentDownloadUrl` in the requests module, and
 * the difference is the whole point: that one opens with
 * `requireRole("team_leader")` because it serves the Gate 1 review, which is a
 * lead's screen. The person who most needs the client's reference images is the
 * member doing the work, and they are not a team leader.
 *
 * No role check here at all, and that is not a relaxation. RLS on
 * `vizserve_pms_request_attachments` is the gate — P7-22 widened its SELECT
 * policy to anyone who can see the task the request became, so a row that comes
 * back is a row this person is entitled to. A row they cannot see returns
 * nothing and this refuses, exactly as `getTaskAttachmentUrl` above does.
 */
export async function getRequestAttachmentUrl(
  attachmentId: string,
  /**
   * P7-59 — the task the file is being opened FROM, where there is one.
   *
   * `vizserve_pms_request_attachments` is policied to the department's leads, so
   * the direct read below returns nothing for a member PIC — and the task page
   * would list a client's reference image and then refuse to open it. With the
   * task id the fallback authorizes on a SEAT instead: you are on this task, and
   * this file belongs to that task's request.
   *
   * ⚠️ IT IS THE FUNCTION THAT DECIDES, NOT THIS ARGUMENT. Passing a task id you
   * are not on returns null from the RPC and the download still fails.
   */
  taskId?: string,
): Promise<ActionResult<{ url: string }>> {
  await requireAuthContextOrThrow();
  const supabase = await createClient();

  const { data: attachment } = await supabase
    .from("vizserve_pms_request_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  // The lead's path first, because it is one query and it is most callers.
  let path = attachment?.storage_path ?? null;

  if (!path && taskId) {
    const { data } = await supabase.rpc("vizserve_pms_task_request_attachment_path", {
      p_task_id: taskId,
      p_attachment_id: attachmentId,
    });
    path = (data as string | null) ?? null;
  }

  if (!path) return { ok: false, error: "That file is not available." };

  // Sixty seconds, matching every other signed URL in the app: long enough to
  // click, short enough that a URL pasted into a chat is dead before anyone
  // opens it.
  const url = await signAttachmentUrl(path, 60);
  if (!url) return { ok: false, error: "That file could not be opened." };

  return { ok: true, data: { url } };
}

export async function removeTaskAttachment(
  attachmentId: string,
  taskId: string,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();
  const supabase = await createClient();

  // The delete policy decides whether this is allowed: your own upload, or
  // anything if you lead the department. A row that does not match simply is
  // not deleted, so the storage object is only removed once the row has gone.
  const { data: deleted, error } = await supabase
    .from("vizserve_pms_task_attachments")
    .delete()
    .eq("id", attachmentId)
    .select("storage_path");

  if (error) return { ok: false, error: readableError(error) };

  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "That file is not yours to remove." };
  }

  await removeStoredAttachments(deleted.map((row) => row.storage_path));

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// P3-01 — lists
// ---------------------------------------------------------------------------

export async function saveList(
  listId: string | null,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  /*
   * P11-07 — THEY ARE THE SAME ACT AGAIN, and the note below is kept because
   * the bug it describes was only half fixed.
   *
   * P11-03 split them: renaming dropped its `requireDepartmentShape()` and
   * creating kept it. But the `canShapeDepartment` check further down ran on
   * BOTH branches, so the member path it opened was never reachable — a
   * colleague renaming a list still got "That department is outside what you
   * administer." before RLS was consulted. The policy was right; the app layer
   * overrode it, and nothing failed loudly enough to notice.
   *
   * `p11_07` then made the whole tree the department's, so both acts take the
   * same predicate and there is one gate again.
   *
   * ORIGINAL NOTE — P11-03 — CREATING A LIST AND RENAMING ONE ARE NOT THE SAME ACT.
   *
   * This was `requireDepartmentShape()` for both, which threw "This area is for
   * team leaders and department admins." at a plain member before RLS was ever
   * consulted — so widening the policy on `vizserve_pms_lists` would have
   * changed nothing on its own.
   *
   * Creating still needs a shaper: a new list reshapes the project tree for
   * everybody in the department. Editing one does not, and a colleague who
   * spots a typo in a list name should fix it.
   *
   * ⚠️ THE MEMBER PATH IS NOT UNGUARDED — it is guarded by RLS instead of by a
   * rank. `p11_03` admits an active member of THAT list's department and nobody
   * else, and the update is audited by trigger. What is removed here is the
   * app-layer floor that made the policy unreachable, not the policy.
   */
  const context = await requireAuthContextOrThrow();

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const values = parsed.data;

  // RLS says the same thing, but saying it here too means the user gets a
  // sentence instead of an empty result they have to interpret.
  //
  // P11-07: `canManageDepartmentTree` — "shapes it, or belongs to it". NOT
  // `canShapeDepartment`, which still answers for forms: those are a
  // client-facing contract and stay with leads and the Admin tick.
  if (!canManageDepartmentTree(context, values.department_id)) {
    return { ok: false, error: "That department is not yours to organise." };
  }

  const supabase = await createClient();

  if (listId) {
    /*
     * P7-18. A form's inbox list may be RENAMED but not ARCHIVED.
     *
     * The database guards structure — `vizserve_pms_lists_group_guard` refuses
     * to let this list leave the Client Requests folder — but it says nothing
     * about `is_active`, because archiving is not a structural change. It is a
     * silent one, though: `vizserve_pms_approve_request` is deliberately
     * untouched by P7-18 and keeps filing approved requests into
     * `forms.default_list_id`, so archiving the inbox of a live form means
     * client work keeps landing in a list nobody can see.
     *
     * Renaming stays allowed on purpose. `form_id` is the link; the name is only
     * a label, and a team may well prefer "Collateral Requests" to whatever the
     * form is called.
     */
    if (!values.is_active) {
      const { data: existing } = await supabase
        .from("vizserve_pms_lists")
        .select("form_id")
        .eq("id", listId)
        .maybeSingle();

      if (existing?.form_id) {
        return {
          ok: false,
          error: "This list is a form's inbox. Archive the form instead.",
        };
      }
    }

    const { error } = await supabase
      .from("vizserve_pms_lists")
      .update({
        name: values.name,
        description: values.description,
        is_active: values.is_active,
        sort_order: values.sort_order,
        // ⚠️ THIS BRANCH WHITELISTS COLUMNS while the insert below spreads
        // `values`. Leave `group_id` out and CREATING a list into a folder works
        // while MOVING one silently does nothing — and the dialog still reports
        // "List saved". `department_id` stays out deliberately (see the insert).
        group_id: values.group_id,
      })
      .eq("id", listId);

    if (error) {
      return error.code === "23505"
        ? {
            ok: false,
            error: "That department already has a list with this name.",
            fieldErrors: { name: ["Already in use."] },
          }
        : { ok: false, error: readableError(error) };
    }

    revalidatePath("/tasks/lists");
    return { ok: true, data: { id: listId } };
  }

  const { data, error } = await supabase
    .from("vizserve_pms_lists")
    .insert({ ...values, created_by: context.userId })
    .select("id")
    .single();

  if (error) {
    return error.code === "23505"
      ? {
          ok: false,
          error: "That department already has a list with this name.",
          fieldErrors: { name: ["Already in use."] },
        }
      : { ok: false, error: readableError(error) };
  }

  revalidatePath("/tasks/lists");
  return { ok: true, data: { id: data.id } };
}

// ---------------------------------------------------------------------------
// P11-06 — a list of your own
// ---------------------------------------------------------------------------

/**
 * Create, rename or archive a PERSONAL list.
 *
 * `requireAuthContextOrThrow`, not `requireDepartmentShape` — and that is the
 * entire slice, exactly as `createPersonalTask` is to `createTask`. Making a
 * list for a DEPARTMENT reshapes the project tree for everybody in it, which is
 * why `saveList` still asks for a shaper. Making one for yourself reshapes
 * nothing anybody else can see.
 *
 * ⚠️ THREE THINGS ARE NOT PARAMETERS HERE, and each is a rule rather than an
 * omission:
 *
 *   owner_id       always `context.userId`. Sending it would offer the browser a
 *                  chance to make a list on somebody else's behalf, and
 *                  `personal lists belong to their owner` would refuse it —
 *                  after the form had already collected it.
 *   department_id  derived by `vizserve_pms_lists_owner_guard` from the owner's
 *                  own row. The insert below sends `context.primaryDepartmentId`
 *                  because the column is NOT NULL and something has to satisfy
 *                  it; the trigger then overwrites it with the same value.
 *   group_id       refused outright by `vizserve_pms_lists_personal_is_loose`. A
 *                  personal list is never in a folder.
 *
 * NO DELETE, ONLY `is_active`. The tasks in a personal list are real work with
 * real timesheet hours logged against them — the no-hard-delete rule that covers
 * every other list covers this one, and archiving is what the sidebar hides on.
 */
export async function savePersonalList(
  listId: string | null,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const context = await requireAuthContextOrThrow();

  const parsed = personalListSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const supabase = await createClient();

  /*
   * Said here as well as in the trigger, because the two produce different
   * sentences for the same fact. The trigger raises when the row is already
   * halfway written; this catches it before the person has pressed anything, and
   * it is the one case where a brand-new account genuinely cannot proceed.
   */
  if (!context.primaryDepartmentId) {
    return {
      ok: false,
      error: "You are not assigned to a department yet, so there is nowhere to file a list.",
    };
  }

  if (listId) {
    /*
     * ⚠️ NO `.eq("owner_id", context.userId)` HERE, AND THAT IS DELIBERATE. The
     * policy is the enforcement: `personal lists belong to their owner` is the
     * only one that admits a row with an owner, so an id belonging to somebody
     * else matches nothing and the update touches zero rows. Restating the
     * filter would imply the policy were optional — the standing rule in this
     * codebase.
     */
    const { error } = await supabase
      .from("vizserve_pms_lists")
      .update({ name: values.name, is_active: values.is_active })
      .eq("id", listId);

    if (error) {
      return error.code === "23505"
        ? {
            ok: false,
            error: "You already have a list with this name.",
            fieldErrors: { name: ["Already in use."] },
          }
        : { ok: false, error: readableError(error) };
    }

    refresh();
    return { ok: true, data: { id: listId } };
  }

  const { data, error } = await supabase
    .from("vizserve_pms_lists")
    .insert({
      name: values.name,
      is_active: values.is_active,
      owner_id: context.userId,
      // NOT NULL, and overwritten by the guard with this same value. See above.
      department_id: context.primaryDepartmentId,
      created_by: context.userId,
    })
    .select("id")
    .single();

  if (error) {
    return error.code === "23505"
      ? {
          ok: false,
          error: "You already have a list with this name.",
          fieldErrors: { name: ["Already in use."] },
        }
      : { ok: false, error: readableError(error) };
  }

  refresh();
  return { ok: true, data: { id: data.id } };
}

// ---------------------------------------------------------------------------
// P7-18 — folders
// ---------------------------------------------------------------------------

/**
 * Create or edit a folder.
 *
 * Mirrors `saveList` deliberately, down to the shape of the error mapping — two
 * sibling levels that behave differently for no reason is how people learn to
 * trust neither.
 *
 * NOTHING HERE HANDLES THE SYSTEM FOLDER, and that is not an omission.
 * `vizserve_pms_task_groups_system_guard` refuses to rename, archive, delete or
 * reflag the reserved "Client Requests" folder, and it raises `check_violation`
 * with a sentence written for a person — which `readableError` already passes
 * through untouched. Restating those rules here would be a second copy that can
 * disagree with the one that is actually enforced.
 */
export async function saveTaskGroup(
  groupId: string | null,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  // P11-07, mirroring `saveList` exactly — two sibling levels that gate
  // differently for no reason is how people learn to trust neither. A folder is
  // the shape of the tree and a list is a shelf in it, but both belong to the
  // department that works in them.
  const context = await requireAuthContextOrThrow();

  const parsed = taskGroupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;

  // P11-07, and the same predicate `saveList` uses. See the note there for why
  // this is not `canShapeDepartment`.
  if (!canManageDepartmentTree(context, values.department_id)) {
    return { ok: false, error: "That department is not yours to organise." };
  }

  const supabase = await createClient();

  const collision = {
    ok: false as const,
    error: "That department already has a folder with this name.",
    fieldErrors: { name: ["Already in use."] },
  };

  if (groupId) {
    const { error } = await supabase
      .from("vizserve_pms_task_groups")
      .update({
        name: values.name,
        description: values.description,
        is_active: values.is_active,
        sort_order: values.sort_order,
        // `department_id` is absent for the same reason it is in `saveList`:
        // moving a folder between departments would strand every list in it,
        // and the guard trigger refuses it anyway.
      })
      .eq("id", groupId);

    if (error) {
      return error.code === "23505" ? collision : { ok: false, error: readableError(error) };
    }

    revalidatePath("/tasks/lists");
    return { ok: true, data: { id: groupId } };
  }

  const { data, error } = await supabase
    .from("vizserve_pms_task_groups")
    .insert({ ...values, created_by: context.userId })
    .select("id")
    .single();

  if (error) {
    return error.code === "23505" ? collision : { ok: false, error: readableError(error) };
  }

  revalidatePath("/tasks/lists");
  return { ok: true, data: { id: data.id } };
}

/**
 * P7-74 — rearrange a department's folders from the sidebar.
 *
 * ⚠️ `canShapeDepartment`, NOT `canManageDepartmentTree`, AND THE NARROWING IS
 * DELIBERATE. P11-07 lets any member of a department create and rename folders,
 * and the policy under this still admits them. But the ORDER of the rail is what
 * the whole department looks at all day, and Amier asked for it to be the
 * owner's, the leads' and the managers' to decide — so this is the lead-or-admin
 * predicate, and the grip is only drawn for the same people.
 *
 * `sort_order` is written as position × 10 so a later hand edit on /tasks/lists
 * can still slot a folder between two others without renumbering the lot.
 *
 * The reserved Client Requests folder is never sent — the rail pins it last
 * regardless of `sort_order` (sidebar-panel.tsx) — and `department_id` on every
 * update means an id from another department matches nothing rather than moving.
 */
export async function reorderTaskGroups(input: unknown): Promise<ActionResult<null>> {
  const context = await requireAuthContextOrThrow();

  const parsed = taskGroupOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That order could not be read." };
  }

  const { department_id: departmentId, group_ids: groupIds } = parsed.data;

  if (!canShapeDepartment(context, departmentId)) {
    return { ok: false, error: "Only team leaders, managers and admins can rearrange folders." };
  }

  if (new Set(groupIds).size !== groupIds.length) {
    return { ok: false, error: "That order lists a folder twice." };
  }

  const supabase = await createClient();

  const results = await Promise.all(
    groupIds.map((id, index) =>
      supabase
        .from("vizserve_pms_task_groups")
        .update({ sort_order: (index + 1) * 10 })
        .eq("id", id)
        .eq("department_id", departmentId)
        .eq("is_system", false)
        .select("id"),
    ),
  );

  const failed = results.find((result) => result.error);
  if (failed?.error) return { ok: false, error: readableError(failed.error) };

  // Zero rows is RLS or a stale id, and either way the rail the reader dragged
  // is not the rail in the database. Say so rather than report a save.
  if (results.some((result) => (result.data ?? []).length === 0)) {
    return { ok: false, error: "The folders changed while you were dragging. Refresh and try again." };
  }

  // The rail is in the (app) layout, on every page — not under any one path.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/**
 * P7-74 — rearrange the lists inside one folder, or a department's folderless
 * lists, from the sidebar. Same gate, same numbering and same stale-order check
 * as `reorderTaskGroups` above; see the notes there.
 *
 * `group_id` is MATCHED, never written. A drag reorders within a folder and
 * cannot refile a list into another one — that stays on /tasks/lists, where the
 * folder picker makes it a deliberate act. `owner_id is null` keeps a personal
 * list out of it even if its id were sent.
 */
export async function reorderLists(input: unknown): Promise<ActionResult<null>> {
  const context = await requireAuthContextOrThrow();

  const parsed = listOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That order could not be read." };
  }

  const { department_id: departmentId, group_id: groupId, list_ids: listIds } = parsed.data;

  if (!canShapeDepartment(context, departmentId)) {
    return { ok: false, error: "Only team leaders, managers and admins can rearrange lists." };
  }

  if (new Set(listIds).size !== listIds.length) {
    return { ok: false, error: "That order lists a list twice." };
  }

  const supabase = await createClient();

  const results = await Promise.all(
    listIds.map((id, index) => {
      const query = supabase
        .from("vizserve_pms_lists")
        .update({ sort_order: (index + 1) * 10 })
        .eq("id", id)
        .eq("department_id", departmentId)
        .is("owner_id", null);

      return (groupId ? query.eq("group_id", groupId) : query.is("group_id", null)).select("id");
    }),
  );

  const failed = results.find((result) => result.error);
  if (failed?.error) return { ok: false, error: readableError(failed.error) };

  if (results.some((result) => (result.data ?? []).length === 0)) {
    return { ok: false, error: "The lists changed while you were dragging. Refresh and try again." };
  }

  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// P7-19 — deleting an internal task
// ---------------------------------------------------------------------------

export type TaskDeleteImpact =
  | { ok: false; reason: string }
  | {
      ok: true;
      title: string;
      subtasks: number;
      tracked_minutes: number;
      comments: number;
      attachments: number;
    };

/**
 * What deleting this task would destroy.
 *
 * Called when the confirm dialog OPENS, not when it submits, so the consequence
 * is on screen before the button is pressed rather than in a toast afterwards.
 *
 * A refusal comes back as `{ ok: false, reason }` rather than as a thrown error:
 * the dialog has to render it, and translating an exception into a sentence at
 * the call site is how two different wordings end up in two different screens.
 */
export async function taskDeleteImpact(taskId: string): Promise<ActionResult<TaskDeleteImpact>> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_task_delete_impact", {
    p_task_id: taskId,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: data as unknown as TaskDeleteImpact };
}

/**
 * Delete an internal task and everything beneath it.
 *
 * Every rule lives in `vizserve_pms_delete_task` — internal work only, lead or
 * creator or personal owner, audit row written before the row goes. Nothing is
 * re-checked here, because a second copy of a rule is a second thing to keep in
 * step, and the sentences the function raises are the ones worth showing.
 */
export async function deleteTask(taskId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

  if (error) return { ok: false, error: readableError(error) };

  // No `refresh(taskId)` — that path is gone, and revalidating a deleted task's
  // page would only re-render a 404.
  revalidatePath("/tasks");
  revalidatePath("/tasks/board");
  revalidatePath("/");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

/** Deleting several at once, for the list view's selection bar. */
export async function deleteTasks(
  taskIds: string[],
): Promise<ActionResult<{ deleted: number; failures: string[] }>> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const failures: string[] = [];
  let deleted = 0;

  /*
   * ONE AT A TIME, deliberately, and not in a transaction.
   *
   * A selection can legitimately mix work the caller may delete with work they
   * may not — a client-backed task, or a colleague's. Doing them together means
   * one refusal rolls back the rest, so pressing Delete on ten tasks removes
   * none of them and explains why in terms of a task the person may not even
   * have meant to include. Each is decided on its own; the caller is told how
   * many went and what stopped the others.
   */
  for (const id of taskIds) {
    const { error } = await supabase.rpc("vizserve_pms_delete_task", { p_task_id: id });
    if (error) failures.push(readableError(error));
    else deleted += 1;
  }

  revalidatePath("/tasks");
  revalidatePath("/tasks/board");
  revalidatePath("/");
  revalidatePath("/dashboard");

  return { ok: true, data: { deleted, failures: [...new Set(failures)] } };
}
