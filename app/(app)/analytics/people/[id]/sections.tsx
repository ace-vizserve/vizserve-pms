import Link from "next/link";

import {
  InternalStatusBadge,
  InternalTypeBadge,
  RequestStatusBadge,
  TaskCategoryBadge,
  TaskStatusBadge,
  TimesheetWeekBadge,
} from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auditActionLabel, auditEntityLabel } from "@/lib/audit";
import type {
  VizservePmsInternalRequestStatus,
  VizservePmsInternalRequestType,
  VizservePmsRequestStatus,
  VizservePmsTaskStatus,
  VizservePmsTimesheetWeekStatus,
} from "@/lib/database.types";
import { addDays, formatDate, formatDateTime, formatDuration, todayInAppZone } from "@/lib/dates";
import { isTaskOverdue, TERMINAL_STATUSES, taskCategory } from "@/lib/schemas/tasks";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

import { LinkTabs } from "@/components/link-tabs";
import { Pagination } from "@/components/pagination";

import { SimpleTable } from "../../figures";

/**
 * P15-03 — THE PERSON PAGE'S RECORD SECTIONS: everything one person is on or
 * has filed. Each reads through the viewer's own client, so RLS still decides
 * row by row; the page has already checked the person is in the viewer's scope.
 * Activity is the exception — see `ActivitySection`.
 */

const empty = (what: string) => <p className="text-xs text-muted-foreground">{what}</p>;

/**
 * Paging for every list on the person page. Every list pages — the activity
 * tab used to print 130 rows in one scroll. `href` rebuilds the page's own URL
 * with the given params changed (`undefined` removes one).
 */
export type Paging = {
  page: number;
  pageSize: number;
  basePath: string;
  href: (next: Record<string, string | undefined>) => string;
};

function Pager({ paging, total }: { paging: Paging; total: number }) {
  return (
    <Pagination
      page={paging.page}
      pageSize={paging.pageSize}
      total={total}
      hrefFor={(target) => paging.href({ page: target > 1 ? String(target) : undefined })}
      basePath={paging.basePath}
    />
  );
}

const rangeOf = (paging: Paging) => {
  const from = (paging.page - 1) * paging.pageSize;
  return [from, from + paging.pageSize - 1] as const;
};

// ---------------------------------------------------------------------------

export async function TasksSection({
  userId,
  show,
  paging,
}: {
  userId: string;
  show: "open" | "all";
  paging: Paging;
}) {
  const supabase = await createClient();
  const today = todayInAppZone();
  let query = supabase
    .rpc("vizserve_pms_tasks_for_person", { p_user: userId, p_role: "any" }, { count: "exact" })
    .select("id, title, status, due_date, assignee_id, qa_assignee_id, request_id, is_personal, updated_at")
    .order("updated_at", { ascending: false });
  if (show === "open") query = query.not("status", "in", `(${TERMINAL_STATUSES.join(",")})`);
  const { data, error, count } = await query.range(...rangeOf(paging));

  const tasks = ((data ?? []) as {
    id: string;
    title: string;
    status: VizservePmsTaskStatus;
    due_date: string | null;
    assignee_id: string | null;
    qa_assignee_id: string | null;
    request_id: string | null;
    is_personal: boolean;
    updated_at: string;
  }[]);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{show === "open" ? "Open tasks" : "Every task"}</CardTitle>
        <CardDescription className="text-xs">
          Tasks they are doing or reviewing, most recently touched first.{" "}
          <Link href={paging.href({ show: show === "open" ? "all" : undefined, page: undefined })} className="text-primary hover:underline">
            {show === "open" ? "Include finished ones" : "Open only"}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? empty(`Could not load tasks: ${error.message}`) : tasks.length === 0 ? (
          empty("Nothing here.")
        ) : (
          <SimpleTable
            head={["Task", "Kind", "Their part", "Status", "Due", "Last touched"]}
            rows={tasks.map((task) => [
              <Link key="t" href={`/tasks/${task.id}`} className="hover:underline">
                {task.title}
              </Link>,
              <TaskCategoryBadge key="k" category={taskCategory(task)} />,
              task.assignee_id === userId ? "Doing it" : task.qa_assignee_id === userId ? "QA" : "On it",
              <TaskStatusBadge key="s" status={task.status} />,
              task.due_date ? (
                <span key="d" className={isTaskOverdue(task, today) ? "font-medium text-destructive" : undefined}>
                  {formatDate(task.due_date)}
                  {isTaskOverdue(task, today) ? " · overdue" : ""}
                </span>
              ) : (
                "—"
              ),
              formatDate(task.updated_at.slice(0, 10)),
            ])}
          />
        )}
        <Pager paging={paging} total={count ?? 0} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export async function TimesheetsSection({ userId, paging }: { userId: string; paging: Paging }) {
  const supabase = await createClient();
  const since = addDays(todayInAppZone(), -7 * 26) ?? todayInAppZone();
  const [{ data: weeks, error }, { data: entries }] = await Promise.all([
    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("week_start, status, submitted_minutes, submitted_at, decision_reason")
      .eq("user_id", userId)
      .gte("week_start", since)
      .order("week_start", { ascending: false }),
    supabase.from("vizserve_pms_timesheet_entries").select("work_date, minutes").eq("user_id", userId).gte("work_date", since),
  ]);

  // Logged per week, for weeks never submitted too.
  const logged = new Map<string, number>();
  for (const entry of entries ?? []) {
    const date = new Date(`${entry.work_date}T12:00:00Z`);
    const back = (date.getUTCDay() + 6) % 7;
    const monday = addDays(entry.work_date, -back)!;
    logged.set(monday, (logged.get(monday) ?? 0) + entry.minutes);
  }
  const byWeek = new Map(
    ((weeks ?? []) as {
      week_start: string;
      status: VizservePmsTimesheetWeekStatus;
      submitted_minutes: number | null;
      submitted_at: string | null;
      decision_reason: string | null;
    }[]).map((week) => [week.week_start, week]),
  );
  const allWeeks = [...new Set([...byWeek.keys(), ...logged.keys()])].sort().reverse();
  const [from, to] = rangeOf(paging);
  const shownWeeks = allWeeks.slice(from, to + 1);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Timesheets</CardTitle>
        <CardDescription className="text-xs">The last 26 weeks. Open a week to see it on the team week.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? empty(`Could not load timesheets: ${error.message}`) : allWeeks.length === 0 ? (
          empty("Nothing logged in the last 26 weeks.")
        ) : (
          <SimpleTable
            head={["Week of", "Status", "Logged", "Submitted", "Note"]}
            rows={shownWeeks.map((monday) => {
              const week = byWeek.get(monday);
              return [
                <Link key="w" href={`/timesheet/team?week=${monday}`} className="hover:underline">
                  {formatDate(monday)}
                </Link>,
                week ? <TimesheetWeekBadge key="s" status={week.status} /> : <span key="s" className="text-muted-foreground">Not submitted</span>,
                formatDuration(logged.get(monday) ?? 0),
                week?.submitted_at ? formatDateTime(week.submitted_at) : "—",
                week?.decision_reason ? <span key="n" className="text-xs text-muted-foreground">Sent back with a note</span> : "",
              ];
            })}
          />
        )}
        <Pager paging={paging} total={allWeeks.length} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Two lists — what they filed, and the client requests they decided at Gate 1
 * — so two tabs. One table per screen, each paged.
 */
export async function RequestsSection({
  userId,
  sub,
  paging,
}: {
  userId: string;
  sub: "filed" | "gate1";
  paging: Paging;
}) {
  const supabase = await createClient();
  const range = rangeOf(paging);

  const filedQuery = supabase
    .from("vizserve_pms_internal_requests")
    .select("id, request_type, status, start_date, end_date, work_date, overtime_minutes, created_at", { count: "exact" })
    .eq("requester_id", userId)
    .order("created_at", { ascending: false });
  const decidedQuery = supabase
    .from("vizserve_pms_approvals")
    .select("entity_id, decision, created_at", { count: "exact" })
    .eq("approver_id", userId)
    .eq("entity_type", "request")
    .order("created_at", { ascending: false });

  // The open tab is read a page at a time; the other is only counted.
  const [filed, decided] = await Promise.all([
    sub === "filed" ? filedQuery.range(...range) : filedQuery.limit(0),
    sub === "gate1" ? decidedQuery.range(...range) : decidedQuery.limit(0),
  ]);

  const tabs = (
    <LinkTabs
      label="Requests"
      active={sub}
      tabs={[
        { key: "filed", label: "Filed", href: paging.href({ sub: undefined, page: undefined }), count: filed.count ?? undefined },
        {
          key: "gate1",
          label: "Decided at Gate 1",
          href: paging.href({ sub: "gate1", page: undefined }),
          count: decided.count ?? undefined,
        },
      ]}
    />
  );

  if (sub === "gate1") {
    const reviewed = decided.data ?? [];
    const reviewedIds = reviewed.map((row) => row.entity_id);
    const { data: clientRequests } = reviewedIds.length
      ? await supabase.from("vizserve_pms_requests").select("id, reference_no, title, status").in("id", reviewedIds)
      : { data: [] };
    const requestOf = new Map((clientRequests ?? []).map((row) => [row.id, row]));

    return (
      <div className="grid gap-3">
        {tabs}
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Client requests they decided at Gate 1</CardTitle>
          </CardHeader>
          <CardContent>
            {decided.error ? empty(`Could not load decisions: ${decided.error.message}`) : reviewed.length === 0 ? (
              empty("None.")
            ) : (
              <SimpleTable
                head={["Request", "Decided", "Their decision", "Status now"]}
                rows={reviewed.map((row) => {
                  const request = requestOf.get(row.entity_id);
                  return [
                    request ? (
                      <Link key="r" href={`/requests/${request.id}`} className="hover:underline">
                        {request.reference_no} · {request.title}
                      </Link>
                    ) : (
                      "A request you cannot open"
                    ),
                    formatDate(row.created_at.slice(0, 10)),
                    row.decision,
                    request ? <RequestStatusBadge key="s" status={request.status as VizservePmsRequestStatus} /> : "—",
                  ];
                })}
              />
            )}
            <Pager paging={paging} total={decided.count ?? 0} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = (filed.data ?? []) as {
    id: string;
    request_type: VizservePmsInternalRequestType;
    status: VizservePmsInternalRequestStatus;
    start_date: string | null;
    end_date: string | null;
    work_date: string | null;
    overtime_minutes: number | null;
    created_at: string;
  }[];

  return (
    <div className="grid gap-3">
      {tabs}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Requests they filed</CardTitle>
          <CardDescription className="text-xs">Leave, overtime, time corrections and reimbursements, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {filed.error ? empty(`Could not load requests: ${filed.error.message}`) : rows.length === 0 ? (
            empty("None you can see.")
          ) : (
            <SimpleTable
              head={["Filed", "Type", "For", "Status"]}
              rows={rows.map((row) => [
                <Link key="f" href={`/approvals/${row.id}`} className="hover:underline">
                  {formatDate(row.created_at.slice(0, 10))}
                </Link>,
                <InternalTypeBadge key="t" type={row.request_type} />,
                row.start_date
                  ? `${formatDate(row.start_date)}${row.end_date && row.end_date !== row.start_date ? ` – ${formatDate(row.end_date)}` : ""}`
                  : row.work_date
                    ? `${formatDate(row.work_date)}${row.overtime_minutes ? ` · ${formatDuration(row.overtime_minutes)}` : ""}`
                    : "—",
                <InternalStatusBadge key="s" status={row.status} />,
              ])}
            />
          )}
          <Pager paging={paging} total={filed.count ?? 0} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * What they did, and what was done to their account — Manager and above only.
 * Two lists, so two tabs, each paged. It used to print 130 rows in one scroll.
 *
 * ⚠️ THROUGH THE SERVICE ROLE. The audit log is readable by Admin and up under
 * RLS; the Manager reaches it here, after the page's own Manager-and-up check,
 * for this one person and nothing else.
 */
export async function ActivitySection({
  userId,
  sub,
  paging,
}: {
  userId: string;
  sub: "did" | "account";
  paging: Paging;
}) {
  const admin = createAdminClient();
  const range = rangeOf(paging);

  const didQuery = admin
    .from("vizserve_pms_audit_logs")
    .select("id, entity_type, entity_id, action, created_at", { count: "exact" })
    .eq("actor_id", userId)
    .order("created_at", { ascending: false });
  const accountQuery = admin
    .from("vizserve_pms_audit_logs")
    .select("id, entity_type, entity_id, action, actor_id, created_at", { count: "exact" })
    .eq("entity_type", "user")
    .eq("entity_id", userId)
    .order("created_at", { ascending: false });

  const [did, account] = await Promise.all([
    sub === "did" ? didQuery.range(...range) : didQuery.limit(0),
    sub === "account" ? accountQuery.range(...range) : accountQuery.limit(0),
  ]);

  const tabs = (
    <LinkTabs
      label="Activity"
      active={sub}
      tabs={[
        { key: "did", label: "What they did", href: paging.href({ sub: undefined, page: undefined }), count: did.count ?? undefined },
        {
          key: "account",
          label: "Changes to their account",
          href: paging.href({ sub: "account", page: undefined }),
          count: account.count ?? undefined,
        },
      ]}
    />
  );

  if (sub === "account") {
    const rows = account.data ?? [];
    const actorIds = [...new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))];
    const { data: actors } = actorIds.length
      ? await admin.from("vizserve_pms_users").select("id, full_name").in("id", actorIds)
      : { data: [] };
    const nameOf = new Map((actors ?? []).map((row) => [row.id, row.full_name]));

    return (
      <div className="grid gap-3">
        {tabs}
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Changes to their account</CardTitle>
            <CardDescription className="text-xs">Role, department, access and schedule changes, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {account.error ? empty(`Could not load changes: ${account.error.message}`) : rows.length === 0 ? (
              empty("Nothing recorded.")
            ) : (
              <SimpleTable
                head={["When", "Change", "By"]}
                rows={rows.map((row) => [
                  formatDateTime(row.created_at),
                  auditActionLabel(row.action),
                  row.actor_id ? (nameOf.get(row.actor_id) ?? "Someone") : "System",
                ])}
              />
            )}
            <Pager paging={paging} total={account.count ?? 0} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = did.data ?? [];
  return (
    <div className="grid gap-3">
      {tabs}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">What they did</CardTitle>
          <CardDescription className="text-xs">Every recorded action, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {did.error ? empty(`Could not load activity: ${did.error.message}`) : rows.length === 0 ? (
            empty("Nothing recorded.")
          ) : (
            <SimpleTable
              head={["When", "Action", "On"]}
              rows={rows.map((row) => [
                formatDateTime(row.created_at),
                auditActionLabel(row.action),
                auditEntityLabel(row.entity_type),
              ])}
            />
          )}
          <Pager paging={paging} total={did.count ?? 0} />
        </CardContent>
      </Card>
    </div>
  );
}
