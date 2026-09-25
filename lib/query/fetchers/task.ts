import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { parse, parseAll } from "@/lib/query/parse";
import { read, ReadError } from "@/lib/query/read";
import { toListField, type ListField } from "@/lib/schemas/list-fields";
import {
  checklistItemSchema,
  clientDecisionSchema,
  collaboratorSchema,
  subtaskRowSchema,
  taskAttachmentRowSchema,
  taskCommentRowSchema,
  taskCoverageSchema,
  taskHistoryEntrySchema,
  taskRequestRowSchema,
  taskRowSchema,
  taskTimeTrackedSchema,
  type ClientDecision,
  type SubtaskRow,
  type TaskAttachmentRow,
  type TaskCommentRow,
  type TaskCoverage,
  type TaskHistoryEntry,
  type TaskRequestRow,
  type TaskRow,
} from "@/lib/schemas/task-detail";
import {
  directoryPersonSchema,
  visibleListSchema,
  type DirectoryPerson,
  type VisibleList,
} from "@/lib/schemas/task-list";
import { parseTaskRequestBrief, type TaskRequestBrief } from "@/lib/schemas/tasks";

/**
 * P12-06 — the reads behind `/tasks/[id]`, browser → PostgREST.
 *
 * Ported from staging and brought up to main: custom fields (P7-73), the
 * checklist (P7-68), comment images staying out of Files (P7-67) and the
 * collaboration space's people (P13-01).
 *
 * ⚠️ EVERY READ THROWS ON FAILURE (`read()`), except the request brief — see
 * `fetchTaskDetail`. No `?? []`: a failed read and an empty one must look
 * different on screen.
 *
 * ⚠️ NO SCOPE FILTER ANYWHERE. Every read is policy-scoped, exactly as the RSC
 * it replaces was.
 */

/**
 * The narrowest client a task-area fetcher needs. The real browser and server
 * clients both satisfy it; a unit test can hand it an object literal.
 */
export type TaskReadClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

export type TaskDetail = {
  task: TaskRow;
  /** Null for internal work, and for a caller with no seat. */
  brief: TaskRequestBrief | null;
  coverage: TaskCoverage[];
};

/** `qk.task(id)` — the task row, its brief and who is covering it. */
export async function fetchTaskDetail(client: TaskReadClient, taskId: string): Promise<TaskDetail> {
  const [row, briefPayload, coverageRows] = await Promise.all([
    read<unknown>(
      client
        .from("vizserve_pms_tasks")
        .select(
          "id, title, description, status, resolution, output_link, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, is_personal, priority, estimate_minutes, field_values, custom_fields, created_by, created_at",
        )
        .eq("id", taskId)
        .maybeSingle(),
    ),

    /*
     * ⚠️ THE ONE READ THAT DEGRADES INSTEAD OF THROWING. The brief is a panel,
     * not the task: failing it hides "From the request" and leaves the task
     * workable, which is what the RSC did. Logged so it is not silent.
     */
    client.rpc("vizserve_pms_task_request_brief", { p_task_id: taskId }).then(({ data, error }) => {
      if (error) {
        console.error(
          `[task] request brief unavailable for ${taskId} — ${error.message} ` +
            `(code ${error.code ?? "none"}). The panel is hidden; the task still renders.`,
        );
        return null;
      }
      return data;
    }),

    read<unknown[]>(
      client
        .from("vizserve_pms_active_task_coverage")
        .select("reliever_id, absent_user_id, end_date")
        .eq("task_id", taskId),
    ),
  ]);

  if (row === null) {
    throw new ReadError(
      "That task is no longer there — it may have been deleted, or moved somewhere you cannot see.",
    );
  }

  return {
    task: parse(taskRowSchema, row, "task"),
    brief: parseTaskRequestBrief(briefPayload),
    coverage: parseAll(taskCoverageSchema, coverageRows, "task coverage"),
  };
}

export type TaskHistory = {
  history: TaskHistoryEntry[];
  /** Empty on internal work — there is no client to have decided anything. */
  decisions: ClientDecision[];
};

/** `qk.taskPart(id, "history")` — the audit trail and, on client work, the decisions. */
export async function fetchTaskHistory(
  client: TaskReadClient,
  taskId: string,
  options: { hasRequest: boolean },
): Promise<TaskHistory> {
  const [historyRows, decisionRows] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_task_status_history")
        .select("id, from_status, to_status, actor_id, comment, is_override, created_at")
        .eq("task_id", taskId)
        .order("created_at", { ascending: false }),
    ),

    options.hasRequest
      ? read<unknown[]>(
          client
            .from("vizserve_pms_client_decisions")
            .select("id, decision, comment, approver_name, created_at")
            .eq("task_id", taskId)
            .order("created_at", { ascending: false }),
        )
      : Promise.resolve([]),
  ]);

  return {
    history: parseAll(taskHistoryEntrySchema, historyRows, "task history"),
    decisions: parseAll(clientDecisionSchema, decisionRows, "client decisions"),
  };
}

/** `qk.taskPart(id, "comments")` — oldest first; the view decides the display order. */
export async function fetchTaskComments(client: TaskReadClient, taskId: string): Promise<TaskCommentRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_comments")
      .select("id, body, author_id, created_at, updated_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
  );

  return parseAll(taskCommentRowSchema, rows, "comments");
}

/** `qk.taskPart(id, "subtasks")` — P7-28, one level deep. */
export async function fetchSubtasks(client: TaskReadClient, taskId: string): Promise<SubtaskRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date, assignee_id, priority")
      .eq("parent_task_id", taskId)
      .order("created_at"),
  );

  return parseAll(subtaskRowSchema, rows, "subtasks");
}

/**
 * `qk.taskPart(id, "attachments")` — the team's output files, oldest first.
 *
 * ⚠️ NOT `kind = 'comment'` (P7-67). A screenshot pasted into a comment is a row
 * on this table and is drawn inline in the thread; without this it would also
 * appear in Files, one picture presented twice.
 */
export async function fetchTaskAttachments(
  client: TaskReadClient,
  taskId: string,
): Promise<TaskAttachmentRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_attachments")
      .select("id, filename, mime_type, size_bytes, uploaded_by")
      .eq("task_id", taskId)
      .neq("kind", "comment")
      .order("created_at"),
  );

  return parseAll(taskAttachmentRowSchema, rows, "output files");
}

/** `qk.taskPart(id, "checklist")` — P7-68, in `position` order, which IS the procedure. */
export async function fetchTaskChecklist(client: TaskReadClient, taskId: string) {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_checklist_items")
      .select("id, label, is_done, group_label")
      .eq("task_id", taskId)
      .order("position"),
  );

  return parseAll(checklistItemSchema, rows, "checklist");
}

/** `qk.taskPart(id, "time")` — minutes logged against this task, everybody's. */
export async function fetchTaskTimeTracked(client: TaskReadClient, taskId: string): Promise<number> {
  const rows = await read<unknown[]>(
    client.rpc("vizserve_pms_task_time_tracked", { p_task_ids: [taskId] }),
  );

  const parsed = parseAll(taskTimeTrackedSchema, rows, "time tracked");
  return parsed.find((entry) => entry.task_id === taskId)?.minutes ?? 0;
}

/** `qk.listsVisible()` — every active list the reader may see, across departments. */
export async function fetchVisibleLists(client: TaskReadClient): Promise<VisibleList[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_lists")
      .select("id, name, group_id, owner_id, department_id")
      .eq("is_active", true)
      .order("name"),
  );

  return parseAll(visibleListSchema, rows, "lists");
}

/**
 * `qk.listFields(listId)` — P7-73, a list's active custom fields.
 *
 * The same read as `loadListFields` in `lib/list-fields-server.ts`, shaped by the
 * same `toListField`, so the detail page and the list agree on a field.
 */
export async function fetchListFields(client: TaskReadClient, listId: string): Promise<ListField[]> {
  const rows = await read(
    client
      .from("vizserve_pms_list_fields")
      .select("id, list_id, name, field_type, options, decimals, sort_order, is_active")
      .eq("list_id", listId)
      .eq("is_active", true)
      .order("sort_order")
      .order("created_at"),
  );

  return (rows ?? []).map(toListField);
}

/** `qk.ref("collaborators")` — P13-01, who may be handed work in the shared space. */
export async function fetchCollaborators(client: TaskReadClient) {
  const rows = await read<unknown[]>(client.rpc("vizserve_pms_collaborators"));
  return parseAll(collaboratorSchema, rows, "collaborators");
}

/**
 * `qk.ref("users")` — THE WHOLE DIRECTORY, ACTIVE AND NOT. Reference data, so it
 * inherits `REF_STALE_TIME` by key prefix. See `directoryPersonSchema` for why
 * the inactive are included.
 */
export async function fetchDirectory(client: TaskReadClient): Promise<DirectoryPerson[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id, is_active")
      .order("full_name"),
  );

  return parseAll(directoryPersonSchema, rows, "people");
}

/**
 * `qk.request(id)` — P7-59, the request row. RLS returns it to department leads
 * only, so `null` is the ORDINARY answer for everybody else, not a failure.
 */
export async function fetchTaskRequest(
  client: TaskReadClient,
  requestId: string,
): Promise<TaskRequestRow | null> {
  const row = await read<unknown>(
    client
      .from("vizserve_pms_requests")
      .select(
        "id, reference_no, requester_name, requester_email, requester_org, description, target_date, submitted_at, reviewed_by, reviewed_at, form_id",
      )
      .eq("id", requestId)
      .maybeSingle(),
  );

  return row === null ? null : parse(taskRequestRowSchema, row, "request");
}
