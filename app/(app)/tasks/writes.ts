"use client";

import { z } from "zod";

import { flattenIssues, readableError, type ActionResult } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";
import { browserClient } from "@/lib/query/browser-client";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import { setRecurrenceSchema } from "@/lib/recurrence";
import { taskFieldValueSchema, toListField } from "@/lib/schemas/list-fields";
import {
  checklistItemSchema,
  checklistToggleSchema,
  overridePayloadSchema,
  taskCommentSchema,
  taskParentSchema,
  taskPatchSchema,
} from "@/lib/schemas/tasks";

import { drainEmailOutbox } from "./email-drain";

/**
 * P12 Phase B — the task writes that were a single policy-checked call,
 * browser → Supabase, no server hop.
 *
 * ⚠️ SAME CALLS, SAME CHECKS, SAME SENTENCES AS `actions.ts`. Each of these was
 * one update, insert, delete or database function that re-checks the caller
 * itself (P11-03's department rule, the checklist and assignee functions, the
 * forced-move function's lead check). Moving them changes where the request
 * starts, not what is allowed.
 *
 * ⚠️ WHAT STAYED ON THE SERVER, AND WHY:
 *   - `transitionTask` — reaching client approval issues and emails a signed
 *     link, which needs the service role and must succeed or be reported.
 *   - editing or deleting a comment — sweeps orphaned images from storage.
 *   - creating, copying, bulk edits, uploads, list management and deletes —
 *     multi-step or storage work.
 *
 * ⚠️ RICH TEXT IS SANITISED HERE BEFORE IT IS STORED, with the browser twin of
 * the server sanitiser (same allowlist). That was never the security boundary —
 * anyone signed in can write the column through PostgREST with their own token
 * — which is why every renderer sanitises again at render time.
 *
 * Writes that queue a notification email fire `drainEmailOutbox()` and do not
 * wait for it, so the email still goes straight away.
 */

function drain() {
  void drainEmailOutbox().catch((error) => console.error("[email] outbox drain failed:", error));
}

async function currentUserId(): Promise<string | null> {
  const { data } = await browserClient().auth.getSession();
  return data.session?.user.id ?? null;
}

export async function updateTaskField(taskId: string, input: unknown): Promise<ActionResult> {
  const parsed = taskPatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That change is not valid.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const patch = parsed.data;

  const { data, error } = await browserClient()
    .from("vizserve_pms_tasks")
    .update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: sanitizeRichTextInBrowser(patch.description) } : {}),
      ...(patch.resolution !== undefined
        ? { resolution: patch.resolution ? sanitizeRichTextInBrowser(patch.resolution) : null }
        : {}),
      ...(patch.output_link !== undefined ? { output_link: patch.output_link || null } : {}),
      ...(patch.due_date !== undefined ? { due_date: patch.due_date || null } : {}),
      ...(patch.start_date !== undefined ? { start_date: patch.start_date || null } : {}),
      ...(patch.list_id !== undefined ? { list_id: patch.list_id } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.estimate_minutes !== undefined ? { estimate_minutes: patch.estimate_minutes } : {}),
    })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  // A refused UPDATE is success with zero rows.
  if (!data || data.length === 0) return { ok: false, error: "That task is not yours to edit." };
  return { ok: true, data: undefined };
}

/** A lead's forced move. The database function re-checks that the caller leads the department. */
export async function overrideTaskStatus(taskId: string, input: unknown): Promise<ActionResult<{ status: string }>> {
  const parsed = overridePayloadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { data, error } = await browserClient().rpc("vizserve_pms_force_task_status", {
    p_task_id: taskId,
    p_to_status: parsed.data.to_status,
    p_reason: parsed.data.reason,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: { status: (data as { status: string }).status } };
}

/** P7-71 — who a comment may mention. An empty list on failure, as before. */
export async function mentionableForTask(taskId: string): Promise<{ id: string; full_name: string }[]> {
  if (!z.uuid().safeParse(taskId).success) return [];
  const { data, error } = await browserClient().rpc("vizserve_pms_mentionable_for_task", { p_task_id: taskId });
  if (error) return [];
  return data ?? [];
}

export async function addTaskComment(taskId: string, input: unknown): Promise<ActionResult> {
  if (!z.uuid().safeParse(taskId).success) return { ok: false, error: "That task does not exist." };

  const parsed = taskCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the comment.", fieldErrors: flattenIssues(parsed.error) };
  }

  const userId = await currentUserId();
  if (!userId) return { ok: false, error: "Your session has ended. Sign in again." };

  const { error } = await browserClient().from("vizserve_pms_task_comments").insert({
    task_id: taskId,
    author_id: userId,
    body: sanitizeRichTextInBrowser(parsed.data.body),
  });

  if (error) return { ok: false, error: readableError(error) };

  // A mention queues an email (P8-18); send it now rather than at the next sweep.
  drain();
  return { ok: true, data: undefined };
}

export async function setTaskParent(taskId: string, input: unknown): Promise<ActionResult> {
  const parsed = taskParentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a task to nest this under." };

  const { data, error } = await browserClient()
    .from("vizserve_pms_tasks")
    .update({ parent_task_id: parsed.data.parent_task_id })
    .eq("id", taskId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That task is not available." };
  return { ok: true, data: undefined };
}

export async function addTaskAssignee(taskId: string, userId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(userId).success) {
    return { ok: false, error: "That task or person does not exist." };
  }

  const client = browserClient();
  const { error } = await client.rpc("vizserve_pms_add_task_assignee", { p_task_id: taskId, p_user_id: userId });
  if (error) return { ok: false, error: readableError(error) };

  const { data: detail } = await client.from("vizserve_pms_tasks").select("title").eq("id", taskId).maybeSingle();

  await client.rpc("vizserve_pms_notify", {
    p_user_id: userId,
    p_type: "assigned",
    p_title: `You are on: ${detail?.title ?? "a task"}`,
    p_body: "",
    p_entity_type: "task",
    p_entity_id: taskId,
    p_link_path: `/tasks/${taskId}`,
  });

  drain();
  return { ok: true, data: undefined };
}

export async function removeTaskAssignee(taskId: string, userId: string): Promise<ActionResult> {
  const { error } = await browserClient().rpc("vizserve_pms_remove_task_assignee", {
    p_task_id: taskId,
    p_user_id: userId,
  });
  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

export async function reassignTask(taskId: string, input: unknown): Promise<ActionResult> {
  const schema = z.object({
    assignee_id: z.uuid().nullable(),
    qa_assignee_id: z.uuid().nullable(),
  });

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Choose valid people.", fieldErrors: flattenIssues(parsed.error) };
  }

  const client = browserClient();

  const { data: task } = await client
    .from("vizserve_pms_tasks")
    .select("department_id, assignee_id")
    .eq("id", taskId)
    .maybeSingle();

  if (!task) return { ok: false, error: "That task is not available." };

  // The friendly refusal; P11-03's WITH CHECK refuses the same thing in the database.
  if (parsed.data.assignee_id) {
    const { data: candidate } = await client
      .from("vizserve_pms_users")
      .select("id")
      .eq("id", parsed.data.assignee_id)
      .eq("primary_department_id", task.department_id)
      .eq("is_active", true)
      .maybeSingle();

    if (!candidate) {
      return { ok: false, error: "That person is not an active member of this task's department." };
    }
  }

  const { data: updated, error } = await client
    .from("vizserve_pms_tasks")
    .update({ assignee_id: parsed.data.assignee_id, qa_assignee_id: parsed.data.qa_assignee_id })
    .eq("id", taskId)
    .select("id, title");

  if (error) return { ok: false, error: readableError(error) };
  if (!updated || updated.length === 0) return { ok: false, error: "That task is not yours to reassign." };

  if (parsed.data.assignee_id && parsed.data.assignee_id !== task.assignee_id) {
    await client.rpc("vizserve_pms_notify", {
      p_user_id: parsed.data.assignee_id,
      p_type: "assigned",
      p_title: `Assigned to you: ${updated[0]?.title ?? "a task"}`,
      p_body: "",
      p_entity_type: "task",
      p_entity_id: taskId,
      p_link_path: `/tasks/${taskId}`,
    });
    drain();
  }

  return { ok: true, data: undefined };
}

/* P7-68 — the checklist. Each call is policy-checked on the task's seat. */

export async function addChecklistItem(taskId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  if (!z.uuid().safeParse(taskId).success) return { ok: false, error: "That task does not exist." };

  const parsed = checklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the step.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { data, error } = await browserClient().rpc("vizserve_pms_add_checklist_item", {
    p_task_id: taskId,
    p_label: parsed.data.label,
  });

  if (error) return { ok: false, error: readableError(error) };
  if (!data) return { ok: false, error: "That task is not available." };
  return { ok: true, data: { id: data.id } };
}

export async function setChecklistItemDone(taskId: string, input: unknown): Promise<ActionResult> {
  void taskId;
  const parsed = checklistToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That step does not exist." };

  const { data, error } = await browserClient()
    .from("vizserve_pms_task_checklist_items")
    .update({ is_done: parsed.data.is_done })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };
  return { ok: true, data: undefined };
}

export async function renameChecklistItem(taskId: string, itemId: string, input: unknown): Promise<ActionResult> {
  void taskId;
  const parsed = checklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the step.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { data, error } = await browserClient()
    .from("vizserve_pms_task_checklist_items")
    .update({ label: parsed.data.label })
    .eq("id", itemId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };
  return { ok: true, data: undefined };
}

export async function removeChecklistItem(taskId: string, itemId: string): Promise<ActionResult> {
  void taskId;
  const { data, error } = await browserClient()
    .from("vizserve_pms_task_checklist_items")
    .delete()
    .eq("id", itemId)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That step is not available." };
  return { ok: true, data: undefined };
}

/** P7-73 — one custom-field value, validated against the field as it is now. */
export async function setTaskFieldValue(taskId: string, fieldId: string, value: unknown): Promise<ActionResult> {
  const client = browserClient();

  const { data: row } = await client
    .from("vizserve_pms_list_fields")
    .select("id, list_id, name, field_type, options, decimals, sort_order, is_active")
    .eq("id", fieldId)
    .maybeSingle();

  const field = row ? toListField(row) : null;
  if (!field || !field.is_active) return { ok: false, error: "That field no longer exists on this list." };

  const parsed = taskFieldValueSchema(field).safeParse(value ?? null);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That value does not fit this field." };
  }

  const { error } = await client.rpc("vizserve_pms_set_task_field", {
    p_task_id: taskId,
    p_field_id: field.id,
    p_value: parsed.data as Json,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}

/*
 * P15-10 — a task's repeat schedule. Both are database functions that check
 * the caller can change the task (the P11-06 department rule) and refuse a
 * client-request task or a subtask with a sentence of their own.
 */

export async function setTaskRecurrence(input: unknown): Promise<ActionResult> {
  const parsed = setRecurrenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick how often it repeats." };

  const { error } = await browserClient().rpc("vizserve_pms_set_task_recurrence", {
    p_task_id: parsed.data.task_id,
    p_frequency: parsed.data.frequency,
    p_landing_status: parsed.data.landing_status,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

export async function stopTaskRecurrence(taskId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(taskId).success) return { ok: false, error: "That task does not exist." };

  const { error } = await browserClient().rpc("vizserve_pms_stop_task_recurrence", { p_task_id: taskId });
  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}
