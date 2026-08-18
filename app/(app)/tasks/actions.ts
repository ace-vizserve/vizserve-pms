"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow, requireRole } from "@/lib/auth/authorization";
import {
  removeStoredAttachments,
  signAttachmentUrl,
  uploadTaskAttachment,
} from "@/lib/attachments-server";
import { issueAndSendApproval } from "@/lib/client-approval-server";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import {
  createPersonalTaskSchema,
  createTaskSchema,
  listSchema,
  overridePayloadSchema,
  taskCommentSchema,
  taskDetailsSchema,
  taskParentSchema,
  taskPatchSchema,
  transitionPayloadSchema,
} from "@/lib/schemas/tasks";
import { createClient } from "@/utils/supabase/server";

/**
 * P3-06 / P3-07 / P3-12 — task mutations.
 *
 * Thin, like the Gate 1 actions and for the same reason. The state machine, the
 * resolution gate, the actor rules and the history write all live in
 * `vizserve_pms_transition_task`, because that is the copy a direct API call
 * cannot skip — and the `status` column is not even grantable to
 * `authenticated`, so there is no second path to keep in step.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Postgres raises a sentence; PostgREST wraps it. Show the sentence. */
function readableError(error: { message?: string } | null): string {
  const raw = error?.message ?? "";
  return (
    raw
      .replace(/^.*?(?:ERROR|error):\s*/i, "")
      .replace(/\s*CONTEXT:[\s\S]*$/, "")
      .trim() || "That did not go through. Try again."
  );
}

function refresh(taskId?: string) {
  revalidatePath("/tasks");
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
    p_comment: parsed.data.comment ?? null,
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
  await requireRole("team_leader");

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

/**
 * Saves the fields a task carries, including the resolution.
 *
 * An ordinary UPDATE, not an RPC — and safe as one precisely because `status` is
 * not in the column grant. The resolution is freely editable while the work is
 * in progress; the gate is not "you may not write this" but "you may not reach
 * FOR_QA without it", and that lives in the transition function.
 */
export async function updateTaskDetails(taskId: string, input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = taskDetailsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const values = parsed.data;
  const supabase = await createClient();

  // `.select()` because a policy-refused UPDATE is not an error — it is success
  // with zero rows (trap 9). Without it, somebody editing a task they are no
  // longer on is told "Saved".
  const { data, error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      title: values.title,
      description: values.description,
      resolution: values.resolution || null,
      output_link: values.output_link || null,
      // "" from a cleared date input means "no date", not the epoch.
      due_date: values.due_date || null,
      start_date: values.start_date || null,
      list_id: values.list_id,
      // P7-11 / P7-15. Both were in `taskDetailsSchema` from the day their
      // migrations landed and neither was ever written here, so the detail form
      // parsed a priority and an estimate and then dropped them.
      priority: values.priority,
      estimate_minutes: values.estimate_minutes,
    })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That task is not yours to edit." };

  refresh(taskId);
  return { ok: true, data: undefined };
}

/**
 * K3 — one field, edited in place on a list row or a board card.
 *
 * Every column this can write is already inside the column-level UPDATE grant
 * (`p7_11a` restated the list) and already scoped by the UPDATE policy, so there
 * is no backend behind this — which is exactly why it is worth having. What it
 * adds over `updateTaskDetails` is that it does not need the whole form: a row
 * that only knows the new due date cannot send a title and a description it
 * never displayed.
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
    body: parsed.data.body,
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
  // `.select` because a policy-refused UPDATE is not an error — it is success
  // with zero rows, and without this an attempt to edit somebody else's comment
  // would report "Saved".
  const { data, error } = await supabase
    .from("vizserve_pms_task_comments")
    .update({ body: parsed.data.body })
    .eq("id", commentId)
    .select("task_id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That comment is not yours to edit." };

  refresh(data[0]!.task_id);
  return { ok: true, data: undefined };
}

export async function deleteTaskComment(commentId: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_task_comments")
    .delete()
    .eq("id", commentId)
    .select("task_id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That comment is not yours to remove." };
  }

  refresh(data[0]!.task_id);
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
 * K3 — `+` on a row: create a task and nest it under this one, in one call.
 *
 * P7-09 shipped `vizserve_pms_set_task_parent`, a one-level trigger and a
 * same-department rule, and nothing has ever called it — the board only
 * displayed a count. This is that caller.
 *
 * TWO WRITES, and they live here rather than in the component so a child created
 * but not nested is reported as exactly that, instead of appearing as a stray
 * top-level task nobody meant to make. There is no create-with-parent function
 * and adding one would mean changing an applied signature (trap 3).
 *
 * The parent decides both things this cannot ask about:
 *
 *   department  the trigger requires them to match, so it is read off the parent
 *   is_personal a subtask of your own work is your own work — so a personal
 *               parent goes through `create_personal_task` and inherits `true`
 *
 * That second one matters more than it looks. Routing a personal parent's child
 * through `create_task` would produce a subtask its owner could not close
 * without a QA reviewer, hanging off a parent they can.
 */
export async function createSubtask(
  parentId: string,
  input: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  await requireAuthContextOrThrow();

  const parsed = z
    .object({ title: z.string().trim().min(1, "A subtask needs a title.").max(300) })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "A subtask needs a title." };
  }

  const supabase = await createClient();

  // Read through the caller's own client, so RLS decides whether they may see
  // the parent at all. A parent they cannot read is not one they may nest work
  // under, and this is the check that says so first.
  const { data: parent } = await supabase
    .from("vizserve_pms_tasks")
    .select("id, department_id, is_personal, assignee_id, parent_task_id")
    .eq("id", parentId)
    .maybeSingle();

  if (!parent) return { ok: false, error: "That task is not available." };

  // The trigger refuses this too. Saying it here costs nothing and names the
  // rule, rather than surfacing a constraint message about depth.
  if (parent.parent_task_id) {
    return { ok: false, error: "Subtasks go one level deep — this is already a subtask." };
  }

  const created = parent.is_personal
    ? await supabase.rpc("vizserve_pms_create_personal_task", {
        p_title: parsed.data.title,
        p_description: "",
        p_due_date: null,
        p_list_id: null,
        p_priority: null,
      })
    : await supabase.rpc("vizserve_pms_create_task", {
        p_department_id: parent.department_id,
        p_title: parsed.data.title,
        p_description: "",
        // Inherits the parent's PIC. A subtask that lands unassigned is one
        // nobody sees on their own list, which is where subtasks go to die.
        p_assignee_id: parent.assignee_id,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
        p_priority: null,
      });

  if (created.error) return { ok: false, error: readableError(created.error) };

  const taskId = (created.data as { task_id: string }).task_id;

  const { data: nested, error: nestError } = await supabase
    .from("vizserve_pms_tasks")
    .update({ parent_task_id: parentId })
    .eq("id", taskId)
    .select("id");

  // The child EXISTS at this point. Both branches say so rather than implying
  // nothing happened — it is a real task on somebody's list, just not nested.
  if (nestError) {
    refresh(parentId);
    return {
      ok: false,
      error: `The task was created but not nested: ${readableError(nestError).toLowerCase()}`,
    };
  }
  if (!nested || nested.length === 0) {
    refresh(parentId);
    return {
      ok: false,
      error: "The task was created, but it could not be nested under this one.",
    };
  }

  dispatchPendingEmailsInBackground();
  refresh(parentId);
  return { ok: true, data: { taskId } };
}

/**
 * K3 — "+ Add Task" at the foot of a status group or a board column.
 *
 * A title, Enter, done. It replaces the dialog for the common case; the dialog
 * stays for the time somebody wants to fill in everything at once.
 *
 * IT CAN ONLY EVER CREATE AT `OPEN`, and the callers are built around that
 * rather than around a parameter. `status` is not a writable column and both
 * create functions open every task at `INITIAL_TASK_STATUS`, so an "+ Add Task"
 * under the *In progress* heading could not make a task in progress. The two
 * honest options were to offer it in the first group only, or to create at OPEN
 * and immediately transition — and the second writes two history rows for one
 * button press, so the trail would show a task opened and started in the same
 * second by somebody who did one thing. The history is what this app protects
 * hardest, so: first group only.
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
       * Only ever the caller's own department or one they lead — and it is not
       * trusted from here: `vizserve_pms_create_task` re-reads the caller's row
       * and refuses anything else. Null means "file it as my own".
       */
      department_id: z.uuid().nullable().default(null),
      assignee_id: z.uuid().nullable().default(null),
    })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "A task needs a title." };
  }

  const values = parsed.data;
  const supabase = await createClient();

  const created = values.department_id
    ? await supabase.rpc("vizserve_pms_create_task", {
        p_department_id: values.department_id,
        p_title: values.title,
        p_description: "",
        p_assignee_id: values.assignee_id ?? context.userId,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
        p_priority: null,
      })
    : await supabase.rpc("vizserve_pms_create_personal_task", {
        p_title: values.title,
        p_description: "",
        p_due_date: null,
        p_list_id: null,
        p_priority: null,
      });

  if (created.error) return { ok: false, error: readableError(created.error) };

  dispatchPendingEmailsInBackground();
  refresh();

  return { ok: true, data: { taskId: (created.data as { task_id: string }).task_id } };
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
    p_description: values.description,
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
  const extras = await writeCreationExtras(supabase, taskId, values);

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
  values: { start_date: string; estimate_minutes: number | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!values.start_date && values.estimate_minutes === null) return { ok: true };

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
  // Trap 9. Reachable in one real case: a lead files work into a department they
  // lead but are not a participant in, so `create_task` succeeds inside its
  // SECURITY DEFINER and the follow-up UPDATE is judged by the policy instead.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "The task was created, but the start date and estimate could not be saved to it.",
    };
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
    p_description: values.description,
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
  const context = await requireRole("team_leader");

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const values = parsed.data;

  // RLS says the same thing, but saying it here too means the user gets a
  // sentence instead of an empty result they have to interpret.
  if (
    context.role !== "admin" &&
    !context.managedDepartmentIds.includes(values.department_id)
  ) {
    return { ok: false, error: "That department is outside your scope." };
  }

  const supabase = await createClient();

  if (listId) {
    const { error } = await supabase
      .from("vizserve_pms_lists")
      .update({
        name: values.name,
        description: values.description,
        is_active: values.is_active,
        sort_order: values.sort_order,
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
