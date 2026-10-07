"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/authorization";
import { flattenIssues, readableError, type ActionResult } from "@/lib/action-result";
import { createClient } from "@/utils/supabase/server";

/**
 * P16-03 — cancel, reopen, archive, restore and delete a CLIENT task.
 *
 * Each is one database function, and the function decides who may: the Team
 * Leader of the department or the Manager for the first four, the Manager or
 * Admin for delete. These only shape the input and refresh the pages.
 */

const reasonSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason.").max(2000, "Keep it under 2000 characters."),
});

function refresh(taskId: string) {
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/requests");
  revalidatePath("/dashboard");
}

async function withReason(
  taskId: string,
  input: unknown,
  fn: "vizserve_pms_cancel_task" | "vizserve_pms_archive_task" | "vizserve_pms_delete_client_task",
): Promise<ActionResult> {
  await requireRole("team_leader");
  const parsed = reasonSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Give a reason.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, { p_task_id: taskId, p_reason: parsed.data.reason });
  if (error) return { ok: false, error: readableError(error) };

  refresh(taskId);
  return { ok: true, data: undefined };
}

async function plain(taskId: string, fn: "vizserve_pms_reopen_task" | "vizserve_pms_restore_task"): Promise<ActionResult> {
  await requireRole("team_leader");
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, { p_task_id: taskId });
  if (error) return { ok: false, error: readableError(error) };

  refresh(taskId);
  return { ok: true, data: undefined };
}

export async function cancelClientTask(taskId: string, input: unknown) {
  return withReason(taskId, input, "vizserve_pms_cancel_task");
}

export async function archiveClientTask(taskId: string, input: unknown) {
  return withReason(taskId, input, "vizserve_pms_archive_task");
}

export async function deleteClientTask(taskId: string, input: unknown) {
  return withReason(taskId, input, "vizserve_pms_delete_client_task");
}

export async function reopenClientTask(taskId: string) {
  return plain(taskId, "vizserve_pms_reopen_task");
}

export async function restoreClientTask(taskId: string) {
  return plain(taskId, "vizserve_pms_restore_task");
}

export type ClientTaskDeleteImpact =
  | { ok: true; title: string; subtasks: number; tracked_minutes: number; comments: number; attachments: number }
  | { ok: false; reason: string };

export async function clientTaskDeleteImpact(taskId: string): Promise<ActionResult<ClientTaskDeleteImpact>> {
  await requireRole("team_leader");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_client_task_delete_impact", { p_task_id: taskId });
  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: data as ClientTaskDeleteImpact };
}
