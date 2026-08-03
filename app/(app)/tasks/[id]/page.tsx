import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { TASK_STATUS_LABELS, isTerminal } from "@/lib/schemas/tasks";
import { TaskStatusBadge } from "@/components/status-badge";
import { createClient } from "@/utils/supabase/server";

import { TaskOutputs } from "./task-outputs";
import { TaskWorkflow } from "./task-workflow";

export const metadata: Metadata = { title: "Task" };

/**
 * P3-05 — task detail.
 *
 * The QA screen (P3-08) is this page seen by the QA reviewer, not a separate
 * one. The reviewer needs exactly what the PIC had — the original request's
 * fields, the resolution, the output — and building a second screen to show the
 * same things is how the two drift until QA is reviewing against a stale copy.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();
  const supabase = await createClient();

  // Out of scope returns no row under RLS, so this 404s rather than confirming
  // the task exists to someone who cannot see it.
  const { data: task } = await supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, description, status, resolution, output_link, due_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, field_values, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!task) notFound();

  const [
    { data: history },
    { data: people },
    { data: lists },
    { data: request },
    { data: outputs },
  ] = await Promise.all([
      supabase
        .from("vizserve_pms_task_status_history")
        .select("id, from_status, to_status, actor_id, comment, is_override, created_at")
        .eq("task_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("vizserve_pms_users")
        .select("id, full_name, primary_department_id")
        .eq("is_active", true)
        .order("full_name"),
      supabase
        .from("vizserve_pms_lists")
        .select("id, name")
        .eq("department_id", task.department_id)
        .eq("is_active", true)
        .order("name"),
      task.request_id
        ? supabase
            .from("vizserve_pms_requests")
            .select("id, reference_no, requester_name, requester_email, target_date, form_id")
            .eq("id", task.request_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("vizserve_pms_task_attachments")
        .select("id, filename, mime_type, size_bytes, uploaded_by")
        .eq("task_id", id)
        .order("created_at"),
    ]);

  // The originating form's fields, including archived ones — a historical answer
  // must keep rendering with its label after the field is retired (D20/R5).
  const { data: fields } = request
    ? await supabase
        .from("vizserve_pms_form_fields")
        .select("field_key, label, is_active")
        .eq("form_id", request.form_id)
        .order("sort_order")
    : { data: null };

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const values = (task.field_values ?? {}) as Record<string, unknown>;

  const viewer = {
    isPic: task.assignee_id === context.userId,
    isQa: task.qa_assignee_id === context.userId,
    leadsDepartment:
      context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
    isAdmin: roleAtLeast(context.role, "admin"),
  };

  const late = isOverdue(task.due_date) && !isTerminal(task.status);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link
        href="/tasks"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All tasks
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{task.title}</h1>
            <TaskStatusBadge status={task.status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {request ? (
              <>
                <Link href={`/requests/${request.id}`} className="hover:underline">
                  {request.reference_no}
                </Link>
                {" · "}
                {request.requester_name}
              </>
            ) : (
              "Added by hand — no client request behind it"
            )}
          </p>
        </div>

        <div className="text-right text-xs">
          <div className={late ? "font-medium text-destructive" : "text-muted-foreground"}>
            Due {formatDate(task.due_date)}
            {late ? " · overdue" : null}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            PIC {task.assignee_id ? nameOf.get(task.assignee_id) : "unassigned"}
            {task.qa_assignee_id ? ` · QA ${nameOf.get(task.qa_assignee_id)}` : null}
          </div>
        </div>
      </div>

      {task.description ? (
        <section className="rounded-lg border bg-card p-5 shadow-ring">
          <h2 className="mb-2 text-sm font-semibold">Brief</h2>
          <p className="whitespace-pre-wrap text-sm">{task.description}</p>
        </section>
      ) : null}

      {/* What the client actually asked for. The QA reviewer checks the output
          against this, so it sits above the resolution rather than behind a tab. */}
      {fields && fields.length > 0 ? (
        <section className="rounded-lg border bg-card p-5 shadow-ring">
          <h2 className="mb-3 text-sm font-semibold">From the request</h2>
          <dl className="text-sm">
            {fields.map((field) => {
              const raw = values[field.field_key];
              const rendered =
                raw === null || raw === undefined || raw === ""
                  ? "—"
                  : Array.isArray(raw)
                    ? raw.join(", ")
                    : String(raw);

              return (
                <div
                  key={field.field_key}
                  className="grid grid-cols-[10rem_1fr] gap-3 border-b py-2 last:border-0"
                >
                  <dt className="text-xs text-muted-foreground">
                    {field.label}
                    {!field.is_active ? (
                      <span className="ml-1 text-2xs">(archived)</span>
                    ) : null}
                  </dt>
                  <dd className="min-w-0 break-words">{rendered}</dd>
                </div>
              );
            })}
            {request?.target_date ? (
              <div className="grid grid-cols-[10rem_1fr] gap-3 border-t py-2">
                <dt className="text-xs text-muted-foreground">Client asked for</dt>
                <dd>{formatDate(request.target_date)}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <TaskWorkflow
        taskId={task.id}
        status={task.status}
        title={task.title}
        description={task.description}
        resolution={task.resolution ?? ""}
        outputLink={task.output_link ?? ""}
        dueDate={task.due_date ?? ""}
        listId={task.list_id}
        assigneeId={task.assignee_id}
        qaAssigneeId={task.qa_assignee_id}
        lists={lists ?? []}
        candidates={(people ?? []).filter(
          (person) => person.primary_department_id === task.department_id,
        )}
        viewer={viewer}
      />

      <TaskOutputs
        taskId={task.id}
        attachments={outputs ?? []}
        // Uploading is doing the work. A department lead can too, because they
        // are frequently the QA and sometimes the person picking up the pieces.
        canUpload={
          (viewer.isPic || viewer.isQa || viewer.leadsDepartment) && !isTerminal(task.status)
        }
        uploaderNames={nameOf}
      />

      <section className="rounded-lg border bg-card p-5 shadow-ring">
        <h2 className="mb-3 text-sm font-semibold">History</h2>
        {!history || history.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-3">
            {history.map((entry) => (
              <li key={entry.id} className="border-l-2 pl-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">
                    {entry.from_status
                      ? `${TASK_STATUS_LABELS[entry.from_status]} → ${TASK_STATUS_LABELS[entry.to_status]}`
                      : `Created as ${TASK_STATUS_LABELS[entry.to_status]}`}
                  </span>
                  {/* An override that reads like an ordinary step is an override
                      that destroys the trail it appears in. */}
                  {entry.is_override ? (
                    <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-2xs font-medium text-warning">
                      Forced
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {entry.actor_id ? nameOf.get(entry.actor_id) ?? "Someone" : "System"}
                    {" · "}
                    {formatDateTime(entry.created_at)}
                  </span>
                </div>
                {entry.comment ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {entry.comment}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
