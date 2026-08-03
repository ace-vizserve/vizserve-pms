"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow, requireRole } from "@/lib/auth/authorization";
import {
  removeStoredAttachments,
  signAttachmentUrl,
  uploadTaskAttachment,
} from "@/lib/attachments-server";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import {
  createTaskSchema,
  listSchema,
  overridePayloadSchema,
  taskDetailsSchema,
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

  // FOR_QA and a QA send-back both write notification rows inside the
  // transaction. Draining is outside it — an email failure must not undo a
  // status change somebody has already been told about on screen.
  dispatchPendingEmailsInBackground();

  refresh(taskId);
  return { ok: true, data: { status: (data as { status: string }).status } };
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

  const { error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      title: values.title,
      description: values.description,
      resolution: values.resolution || null,
      output_link: values.output_link || null,
      // "" from a cleared date input means "no date", not the epoch.
      due_date: values.due_date || null,
      list_id: values.list_id,
    })
    .eq("id", taskId);

  if (error) return { ok: false, error: readableError(error) };

  refresh(taskId);
  return { ok: true, data: undefined };
}

/**
 * Reassigning is a Team Leader decision, not a self-service one.
 *
 * Split from `updateTaskDetails` because RLS lets the PIC update their own task,
 * and without the split a member could hand their work to somebody else — or
 * quietly make themselves the QA on it.
 */
export async function reassignTask(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireRole("team_leader");

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

  const { error } = await supabase
    .from("vizserve_pms_tasks")
    .update({
      assignee_id: parsed.data.assignee_id,
      qa_assignee_id: parsed.data.qa_assignee_id,
    })
    .eq("id", taskId);

  if (error) return { ok: false, error: readableError(error) };

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

export async function createTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  await requireRole("team_leader");

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
  });

  if (error) return { ok: false, error: readableError(error) };

  dispatchPendingEmailsInBackground();
  refresh();

  return { ok: true, data: { taskId: (data as { task_id: string }).task_id } };
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
