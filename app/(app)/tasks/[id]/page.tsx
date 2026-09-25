import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  canAdminDepartment,
  isCollaborationSpace,
  realtimeDepartmentFilter,
  requireAuthContext,
} from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { requestToday } from "@/lib/dates-server";
import { fetchJoinedTaskIdSet } from "@/lib/tasks-server";
import { createClient } from "@/utils/supabase/server";

import { TaskDetail, type TaskSeat } from "./task-detail";

export const metadata: Metadata = { title: "Task" };

/**
 * P12-06 — THE SERVER DECIDES WHO YOU ARE ON THIS TASK, AND NOTHING ELSE.
 *
 * This page used to read everything the task shows in one server batch — a
 * task row, then fifteen reads in one wave — before a single pixel moved. That
 * batch lives in the browser now (`task-detail.tsx`, from the query cache), so
 * a task you have opened before paints at once and the server's part of a
 * navigation is two small reads.
 *
 * ⚠️ WHAT STAYS HERE IS AUTHORIZATION OUTPUT. `AuthContext` never reaches the
 * browser, so the seat — do you lead this department, are you an admin on it,
 * is it the collaboration space — is decided here and handed over as plain
 * booleans. Every rule is the one the old page applied, unchanged.
 *
 * ⚠️ `notFound()` STAYS A SERVER DECISION. The task read below is policy-scoped,
 * so a task you cannot see is a 404 before any client code runs, exactly as it
 * was.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();
  const supabase = await createClient();

  const [{ data: task }, joinedTaskIdSet, today] = await Promise.all([
    supabase.from("vizserve_pms_tasks").select("id, department_id").eq("id", id).maybeSingle(),
    fetchJoinedTaskIdSet(context.userId),
    requestToday(),
  ]);

  if (!task) notFound();

  const collaboration = isCollaborationSpace(context, task.department_id);

  const seat: TaskSeat = {
    userId: context.userId,
    joined: joinedTaskIdSet.has(task.id),
    leadsDepartment: roleAtLeast(context.role, "owner") || context.managedDepartmentIds.includes(task.department_id),
    isAdmin: roleAtLeast(context.role, "owner"),
    inDepartment: context.primaryDepartmentId === task.department_id || collaboration,
    administersDepartment: canAdminDepartment(context, task.department_id),
    collaboration,
  };

  return (
    <TaskDetail taskId={task.id} seat={seat} realtimeFilter={realtimeDepartmentFilter(context)} today={today} />
  );
}
