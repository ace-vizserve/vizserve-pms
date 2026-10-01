import "server-only";

import { cache } from "react";

import { summariseAttendance, type AttendanceDay, type AttendancePerson } from "@/lib/attendance-summary";
import { departmentScopeFilter, type AuthContext } from "@/lib/auth/authorization";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";
import { expandLeaveDays, leaveKey, type LeaveSpan } from "@/lib/leave";
import {
  compliance,
  delivery,
  mean,
  previousPeriod,
  reviewers,
  tasksDoneBy,
  timeFigures,
  workload,
  type Compliance,
  type Delivery,
  type PerfEntry,
  type PerfMove,
  type PerfPunch,
  type PerfTask,
  type PerfWeek,
  type Period,
  type PersonFigures,
  type ReviewerRow,
  type TimeFigures,
  type WorkKind,
  type Workload,
} from "@/lib/performance";
import { chunked, readAll } from "@/lib/read-all";
import { loadAppSettings } from "@/lib/settings-server";
import { createClient } from "@/utils/supabase/server";

export type PerformanceFilters = {
  departmentId: string | null;
  kind: WorkKind | null;
  priority: string | null;
  from: string;
  to: string;
};

export type TeamFigures = {
  workload: Workload;
  delivery: Delivery;
  reviewers: ReviewerRow[];
  time: TimeFigures;
  compliance: Compliance;
  attendance: {
    workingDays: number;
    present: number;
    onLeave: number;
    absent: number;
    late: number;
    lateMinutes: number;
    undertime: number;
    scheduledPeople: number;
  };
  missingPunches: number;
  corrections: number;
  overtimeMinutes: number;
  rating: { average: number | null; count: number };
  clientRevisions: number;
};

export type DepartmentRow = { id: string; name: string; people: number; figures: TeamFigures };

export type PerformanceData = {
  departments: { id: string; name: string }[];
  selected: { id: string; name: string } | null;
  scopeIsAll: boolean;
  period: Period;
  previous: Period;
  today: string;
  graceMinutes: number;
  team: TeamFigures;
  teamBefore: TeamFigures;
  byDepartment: DepartmentRow[];
  people: PersonFigures[];
  peopleBefore: Map<string, PersonFigures>;
  listHours: { id: string; name: string; minutes: number }[];
  nameOf: Map<string, string>;
  errors: string[];
};

type UserRow = {
  id: string;
  full_name: string;
  role: string;
  primary_department_id: string | null;
  is_active: boolean;
  work_start: string | null;
  work_end: string | null;
  break_minutes: number | null;
};

type TaskRow = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  department_id: string;
  list_id: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  assignee_id: string | null;
  qa_assignee_id: string | null;
  request_id: string | null;
  is_personal: boolean;
  priority: string | null;
  estimate_minutes: number | null;
  vizserve_pms_task_assignees: { user_id: string }[] | null;
};

type HistoryRow = {
  task_id: string;
  from_status: VizservePmsTaskStatus | null;
  to_status: VizservePmsTaskStatus;
  actor_id: string | null;
  created_at: string;
};

const TASK_COLUMNS =
  "id, title, status, department_id, list_id, due_date, created_at, updated_at, assignee_id, qa_assignee_id, request_id, is_personal, priority, estimate_minutes, vizserve_pms_task_assignees(user_id)";

const KIND_OF = (row: { request_id: string | null; is_personal: boolean }): WorkKind =>
  row.request_id !== null ? "client" : row.is_personal ? "personal" : "internal";

/**
 * P15-02 — the departments this viewer may pick, by the ACTIVE role. Cheap and
 * cached per request: every Analytics page renders its filter bar from it
 * BEFORE the heavy read, so the bar is on screen while the figures load.
 */
export const loadDepartmentOptions = cache(
  async (context: AuthContext): Promise<{ departments: { id: string; name: string }[]; error: { message: string } | null }> => {
    const supabase = await createClient();
    const scope = departmentScopeFilter(context);
    if (scope && scope.length === 0) return { departments: [], error: null };
    let query = supabase.from("vizserve_pms_departments").select("id, name").eq("is_active", true).order("name");
    if (scope) query = query.in("id", scope);
    const { data, error } = await query;
    return { departments: data ?? [], error };
  },
);

/**
 * P15-02 — everything the Analytics tabs and the person page read, for one
 * filter set, for this period AND the one before it, scoped by the ACTIVE role.
 *
 * SCOPE. `departmentScopeFilter` decides the departments: a Team Leader's own,
 * or everything for Manager and up. Tasks are scoped by the task's department;
 * people — hours, attendance, timesheets — by the person's home department.
 * That second one is NOT left to RLS: the HR tick widens the DTR, users and
 * leave reads to the whole company, and a Team Leader's analytics must still
 * be their team.
 *
 * WHAT THE PERIOD MEANS, per measure, because it is not one thing:
 *   - completions, QA moves, ratings, client answers: when they HAPPENED
 *   - hours, punches, attendance, timesheet weeks: the WORK DATE
 *   - workload (open, overdue, stale): TODAY, whatever the period
 */
export async function loadPerformance(
  context: AuthContext,
  filters: PerformanceFilters,
): Promise<PerformanceData> {
  const supabase = await createClient();
  const today = todayInAppZone();
  const period: Period = { from: filters.from, to: filters.to };
  const previous = previousPeriod(period);
  const windowFrom = previous.from;
  const errors: string[] = [];
  const note = (what: string, error: { message: string } | null | undefined) => {
    if (error) errors.push(`${what}: ${error.message}`);
  };

  // ---- scope --------------------------------------------------------------
  const scope = departmentScopeFilter(context);
  const { departments, error: departmentsError } = await loadDepartmentOptions(context);
  note("departments", departmentsError);
  const selected = departments.find((department) => department.id === filters.departmentId) ?? null;
  const departmentIds = selected ? [selected.id] : departments.map((department) => department.id);
  const inScope = (departmentId: string | null | undefined) => Boolean(departmentId && departmentIds.includes(departmentId));
  const NONE = ["00000000-0000-0000-0000-000000000000"];

  // ---- reads --------------------------------------------------------------
  /*
   * ⚠️ NARROW READS, AND WHY. The tasks table holds every task ever imported
   * (4,000+, most finished) and the ClickUp import wrote a history row for each
   * one dated the day of the import. Reading all of either, through the tasks
   * policy, timed out ("canceling statement due to statement timeout") and
   * returned short figures. So this reads:
   *   - the OPEN tasks (workload is about now);
   *   - the COMPLETIONS in the window, and only real ones — a move FROM a
   *     status. The import created finished tasks as finished, with no
   *     previous status, and counting those would put three thousand
   *     "completions" in one September afternoon;
   *   - the QA moves in the window;
   *   - then, by id, the tasks those touch and their full trail.
   */
  const end = addDays(filters.to, 1) ?? filters.to;
  const deptFilter = departmentIds.length > 0 ? departmentIds : NONE;

  const [usersResult, openResult, completionsResult, qaResult, entriesResult, weeksResult, punchesResult, leaveResult, holidaysResult, requestsResult, feedbackResult, decisionsResult, listsResult, settings] =
    await Promise.all([
      supabase
        .from("vizserve_pms_users")
        .select("id, full_name, role, primary_department_id, is_active, work_start, work_end, break_minutes"),
      // One statement per department, fired together: the tasks policy costs a
      // definer call per row, and one statement over every department is the
      // shape that timed out on /analytics (see the note there).
      Promise.all(
        deptFilter.map((departmentId) =>
          readAll<TaskRow>(
            (from, to) =>
              supabase
                .from("vizserve_pms_tasks")
                .select(TASK_COLUMNS, { count: "exact" })
                .eq("department_id", departmentId)
                .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
                .order("id")
                .range(from, to) as unknown as PromiseLike<{
                data: TaskRow[] | null;
                error: { message: string } | null;
                count?: number | null;
              }>,
          ),
        ),
      ).then((pages) => ({
        data: pages.flatMap((page) => page.data),
        error: pages.find((page) => page.error)?.error ?? null,
      })),
      readAll<HistoryRow>((from, to) =>
        supabase
          .from("vizserve_pms_task_status_history")
          .select("task_id, from_status, to_status, actor_id, created_at", { count: "exact" })
          .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
          .not("from_status", "is", null)
          .gte("created_at", windowFrom)
          .lt("created_at", end)
          .order("id")
          .range(from, to),
      ),
      supabase
        .from("vizserve_pms_task_status_history")
        .select("task_id, from_status, to_status, actor_id, created_at")
        .or("from_status.in.(FOR_QA,QA_IN_PROGRESS),to_status.in.(FOR_QA,QA_IN_PROGRESS)")
        .gte("created_at", windowFrom)
        .lt("created_at", end),
      readAll<{ id: string; user_id: string; task_id: string; minutes: number; work_date: string }>((from, to) =>
        supabase
          .from("vizserve_pms_timesheet_entries")
          .select("id, user_id, task_id, minutes, work_date", { count: "exact" })
          .gte("work_date", windowFrom)
          .lte("work_date", filters.to)
          .order("id")
          .range(from, to),
      ),
      supabase
        .from("vizserve_pms_timesheet_weeks")
        .select("user_id, week_start, status, submitted_at")
        .gte("week_start", startOfWeek(windowFrom) ?? windowFrom)
        .lte("week_start", filters.to),
      readAll<{ id: string; user_id: string; work_date: string; time_in: string | null; time_out: string | null }>((from, to) =>
        supabase
          .from("vizserve_pms_dtr_entries")
          .select("id, user_id, work_date, time_in, time_out", { count: "exact" })
          .gte("work_date", windowFrom)
          .lte("work_date", filters.to)
          .order("id")
          .range(from, to),
      ),
      supabase
        .from("vizserve_pms_internal_requests")
        .select("requester_id, start_date, end_date, start_half, end_half")
        .eq("request_type", "LEAVE")
        .eq("status", "APPROVED")
        .lte("start_date", filters.to)
        .gte("end_date", windowFrom),
      supabase.from("vizserve_pms_holidays").select("holiday_date").gte("holiday_date", windowFrom).lte("holiday_date", filters.to),
      supabase
        .from("vizserve_pms_internal_requests")
        .select("requester_id, request_type, status, work_date, overtime_minutes, created_at")
        .in("request_type", ["OVERTIME", "TIME_IN_CORRECTION", "TIME_OUT_CORRECTION", "NO_TIME_IN", "NO_TIME_OUT"])
        .gte("work_date", windowFrom)
        .lte("work_date", filters.to),
      supabase.from("vizserve_pms_feedback").select("task_id, rating, created_at").gte("created_at", windowFrom),
      supabase.from("vizserve_pms_client_decisions").select("task_id, decision, created_at").gte("created_at", windowFrom),
      supabase.from("vizserve_pms_lists").select("id, name"),
      loadAppSettings(),
    ]);

  note("people", usersResult.error);
  note("open tasks", openResult.error);
  note("completions", completionsResult.error);
  note("QA moves", qaResult.error);
  note("timesheet entries", entriesResult.error);
  note("timesheet weeks", weeksResult.error);
  note("time records", punchesResult.error);
  note("leave", leaveResult.error);
  note("requests", requestsResult.error);

  const users = (usersResult.data ?? []) as UserRow[];
  const nameOf = new Map(users.map((user) => [user.id, user.full_name]));
  const departmentOfUser = new Map(users.map((user) => [user.id, user.primary_department_id]));
  const people = users.filter((user) => user.is_active && inScope(user.primary_department_id));
  const personIds = new Set(people.map((person) => person.id));
  const personInScope = (userId: string) => personIds.has(userId);

  // ---- second wave: the tasks those touch, by id ---------------------------
  const completedIds = [...new Set(completionsResult.data.map((row) => row.task_id))];
  const qaRows = (qaResult.data ?? []) as HistoryRow[];
  const taskRows = new Map(openResult.data.map((row) => [row.id, row]));
  const wanted = [
    ...new Set([
      ...completedIds,
      ...qaRows.map((row) => row.task_id),
      ...entriesResult.data.filter((row) => personInScope(row.user_id)).map((row) => row.task_id),
    ]),
  ].filter((id) => !taskRows.has(id));

  const [taskPages, trailPages, loggedPages] = await Promise.all([
    Promise.all(
      chunked(wanted).map(
        (ids) =>
          supabase.from("vizserve_pms_tasks").select(TASK_COLUMNS).in("id", ids) as unknown as PromiseLike<{
            data: TaskRow[] | null;
            error: { message: string } | null;
          }>,
      ),
    ),
    // The whole trail of every task finished in the window, for time-in-stage
    // and first-pass QA.
    Promise.all(
      // 40 tasks a request: a request returns at most 1,000 rows, and a task
      // that went round QA a few times carries a dozen moves.
      chunked(completedIds, 40).map((ids) =>
        supabase
          .from("vizserve_pms_task_status_history")
          .select("task_id, from_status, to_status, actor_id, created_at")
          .in("task_id", ids)
          .lt("created_at", end),
      ),
    ),
    // All-time hours on those tasks, for hours against the estimate.
    Promise.all(
      chunked(completedIds, 20).map((ids) => supabase.from("vizserve_pms_timesheet_entries").select("task_id, minutes").in("task_id", ids)),
    ),
  ]);

  for (const page of taskPages) {
    note("tasks", page.error);
    for (const row of page.data ?? []) taskRows.set(row.id, row);
  }

  const matches = (row: TaskRow) =>
    inScope(row.department_id) &&
    (!filters.kind || KIND_OF(row) === filters.kind) &&
    (!filters.priority || row.priority === filters.priority);

  const tasks: PerfTask[] = [...taskRows.values()].filter(matches).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    departmentId: row.department_id,
    listId: row.list_id,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doers: [
      ...new Set(
        [row.assignee_id, ...(row.vizserve_pms_task_assignees ?? []).map((assignee) => assignee.user_id)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ],
    qaId: row.qa_assignee_id,
    kind: KIND_OF(row),
    priority: row.priority,
    estimateMinutes: row.estimate_minutes,
  }));
  const taskIds = new Set(tasks.map((task) => task.id));

  const seen = new Set<string>();
  const moves: PerfMove[] = [];
  for (const row of [...trailPages.flatMap((page) => (page.data ?? []) as HistoryRow[]), ...qaRows]) {
    if (!taskIds.has(row.task_id)) continue;
    const key = `${row.task_id}|${row.created_at}|${row.to_status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push({ taskId: row.task_id, from: row.from_status, to: row.to_status, actorId: row.actor_id, at: row.created_at });
  }
  for (const page of trailPages) note("task history", page.error);
  moves.sort((a, b) => a.at.localeCompare(b.at));

  const loggedByTask = new Map<string, number>();
  for (const page of loggedPages) {
    for (const row of page.data ?? []) loggedByTask.set(row.task_id, (loggedByTask.get(row.task_id) ?? 0) + row.minutes);
  }

  // ---- time ---------------------------------------------------------------
  const factsOf = taskRows;

  const entries: PerfEntry[] = [];
  const kindOf = new Map<string, WorkKind>();
  const listOf = new Map<string, string | null>();
  for (const row of entriesResult.data) {
    if (!personInScope(row.user_id)) continue;
    const embed = factsOf.get(row.task_id) ?? null;
    const kind = embed ? KIND_OF(embed) : "internal";
    if (filters.kind && kind !== filters.kind) continue;
    if (filters.priority && embed?.priority !== filters.priority) continue;
    kindOf.set(row.task_id, kind);
    listOf.set(row.task_id, embed?.list_id ?? null);
    entries.push({ userId: row.user_id, taskId: row.task_id, minutes: row.minutes, workDate: row.work_date });
  }

  const punches: PerfPunch[] = punchesResult.data
    .filter((row) => personInScope(row.user_id))
    .map((row) => ({ userId: row.user_id, workDate: row.work_date, timeIn: row.time_in, timeOut: row.time_out }));

  const breakOf = new Map(people.map((person) => [person.id, person.break_minutes ?? settings.breakMinutes]));

  const weeks: PerfWeek[] = ((weeksResult.data ?? []) as { user_id: string; week_start: string; status: PerfWeek["status"]; submitted_at: string | null }[])
    .filter((row) => personInScope(row.user_id))
    .map((row) => ({ userId: row.user_id, weekStart: row.week_start, status: row.status, submittedAt: row.submitted_at }));

  // ---- attendance ---------------------------------------------------------
  const spans: LeaveSpan[] = ((leaveResult.data ?? []) as {
    requester_id: string;
    start_date: string | null;
    end_date: string | null;
    start_half: LeaveSpan["start_half"];
    end_half: LeaveSpan["end_half"];
  }[])
    .filter((row) => row.start_date && row.end_date && personInScope(row.requester_id))
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: null,
    }));
  const leaveDays = expandLeaveDays(spans, windowFrom, filters.to);
  const holidays = new Set((holidaysResult.data ?? []).map((row) => row.holiday_date));
  const punchByKey = new Map(punches.map((punch) => [`${punch.userId}:${punch.workDate}`, punch]));

  const requests = ((requestsResult.data ?? []) as {
    requester_id: string;
    request_type: string;
    status: string;
    work_date: string | null;
    overtime_minutes: number | null;
  }[]).filter((row) => personInScope(row.requester_id));
  const overtimeByKey = new Map<string, number>();
  for (const row of requests) {
    if (row.request_type === "OVERTIME" && row.status === "APPROVED" && row.work_date) {
      const key = `${row.requester_id}:${row.work_date}`;
      overtimeByKey.set(key, (overtimeByKey.get(key) ?? 0) + (row.overtime_minutes ?? 0));
    }
  }

  const isWeekend = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
    return weekday === 0 || weekday === 6;
  };

  /** Days counted for attendance: up to yesterday, plus today only once punched. */
  function attendanceDays(userId: string, window: Period): AttendanceDay[] {
    const days: AttendanceDay[] = [];
    for (let date: string | null = window.from; date && date <= window.to; date = addDays(date, 1)) {
      const key = `${userId}:${date}`;
      const punch = punchByKey.get(key);
      if (date > today || (date === today && !punch)) break;
      days.push({
        date,
        timeIn: punch?.timeIn ?? null,
        timeOut: punch?.timeOut ?? null,
        hasEntry: Boolean(punch),
        leavePortion: leaveDays.get(leaveKey(userId, date))?.portion ?? null,
        isHoliday: holidays.has(date),
        overtimeMinutes: overtimeByKey.get(key) ?? 0,
      });
    }
    return days;
  }

  function workingDays(userId: string, weekStart: string): number {
    let count = 0;
    for (let offset = 0; offset < 5; offset += 1) {
      const date = addDays(weekStart, offset)!;
      if (holidays.has(date) || isWeekend(date)) continue;
      if (leaveDays.get(leaveKey(userId, date))?.portion === "full") continue;
      count += 1;
    }
    return count;
  }

  // ---- client outcomes ----------------------------------------------------
  const feedback = (feedbackResult.data ?? []) as { task_id: string; rating: number; created_at: string }[];
  const decisions = (decisionsResult.data ?? []) as { task_id: string; decision: string; created_at: string }[];
  const inWindow = (at: string, window: Period) => at.slice(0, 10) >= window.from && at.slice(0, 10) <= window.to;

  // ---- figures ------------------------------------------------------------
  function figuresFor(
    window: Period,
    scopeTasks: PerfTask[],
    who: (userId: string) => boolean,
    withWorkload: boolean,
  ): TeamFigures {
    const scopeTaskIds = new Set(scopeTasks.map((task) => task.id));
    const myEntries = entries.filter((entry) => who(entry.userId));
    const myPunches = punches.filter((punch) => who(punch.userId));
    const memberIds = people.filter((person) => who(person.id));

    const summaries = summariseAttendance(
      memberIds.map(
        (person): AttendancePerson => ({
          userId: person.id,
          fullName: person.full_name,
          departmentName: null,
          workStart: person.work_start,
          workEnd: person.work_end,
          days: attendanceDays(person.id, window),
        }),
      ),
      settings.graceMinutes,
    );

    const complianceRows = memberIds.map((person) => compliance(person.id, weeks, window, today, workingDays));
    const ratings = feedback.filter((row) => scopeTaskIds.has(row.task_id) && inWindow(row.created_at, window)).map((row) => row.rating);

    return {
      workload: withWorkload ? workload(scopeTasks, today) : workload([], today),
      delivery: delivery(scopeTasks, moves, window, loggedByTask),
      reviewers: reviewers(
        moves.filter((move) => scopeTaskIds.has(move.taskId)),
        window,
      ),
      time: timeFigures(myEntries, myPunches, kindOf, breakOf, window),
      compliance: complianceRows.reduce(
        (sum, row) => ({
          expected: sum.expected + row.expected,
          submitted: sum.submitted + row.submitted,
          onTime: sum.onTime + row.onTime,
          returned: sum.returned + row.returned,
          missing: sum.missing + row.missing,
        }),
        { expected: 0, submitted: 0, onTime: 0, returned: 0, missing: 0 },
      ),
      attendance: summaries.reduce(
        (sum, row) =>
          row.unscheduled
            ? sum
            : {
                workingDays: sum.workingDays + row.workingDays,
                present: sum.present + row.present,
                onLeave: sum.onLeave + row.onLeave,
                absent: sum.absent + row.absent,
                late: sum.late + row.late,
                lateMinutes: sum.lateMinutes + row.lateMinutes,
                undertime: sum.undertime + row.undertime,
                scheduledPeople: sum.scheduledPeople + 1,
              },
        { workingDays: 0, present: 0, onLeave: 0, absent: 0, late: 0, lateMinutes: 0, undertime: 0, scheduledPeople: 0 },
      ),
      missingPunches: myPunches.filter(
        (punch) => punch.timeIn && !punch.timeOut && punch.workDate < today && punch.workDate >= window.from && punch.workDate <= window.to,
      ).length,
      corrections: requests.filter(
        (row) => who(row.requester_id) && row.request_type !== "OVERTIME" && row.work_date && row.work_date >= window.from && row.work_date <= window.to,
      ).length,
      overtimeMinutes: requests
        .filter(
          (row) =>
            who(row.requester_id) &&
            row.request_type === "OVERTIME" &&
            row.status === "APPROVED" &&
            row.work_date &&
            row.work_date >= window.from &&
            row.work_date <= window.to,
        )
        .reduce((total, row) => total + (row.overtime_minutes ?? 0), 0),
      rating: { average: mean(ratings), count: ratings.length },
      clientRevisions: decisions.filter(
        (row) => scopeTaskIds.has(row.task_id) && row.decision === "REVISION_REQUESTED" && inWindow(row.created_at, window),
      ).length,
    };
  }

  const team = figuresFor(period, tasks, personInScope, true);
  const teamBefore = figuresFor(previous, tasks, personInScope, false);

  const byDepartment: DepartmentRow[] =
    departmentIds.length > 1
      ? departments.map((department) => {
          const inDepartment = (userId: string) => departmentOfUser.get(userId) === department.id && personInScope(userId);
          return {
            id: department.id,
            name: department.name,
            people: people.filter((person) => person.primary_department_id === department.id).length,
            figures: figuresFor(
              period,
              tasks.filter((task) => task.departmentId === department.id),
              inDepartment,
              true,
            ),
          };
        })
      : [];

  function personFigures(person: UserRow, window: Period, withWorkload: boolean): PersonFigures {
    const theirs = tasksDoneBy(tasks, person.id);
    const figures = figuresFor(window, theirs, (userId) => userId === person.id, withWorkload);
    const attendance = summariseAttendance(
      [
        {
          userId: person.id,
          fullName: person.full_name,
          departmentName: null,
          workStart: person.work_start,
          workEnd: person.work_end,
          days: attendanceDays(person.id, window),
        },
      ],
      settings.graceMinutes,
    )[0]!;

    return {
      userId: person.id,
      name: person.full_name,
      departmentId: person.primary_department_id,
      workload: figures.workload,
      delivery: figures.delivery,
      time: figures.time,
      compliance: figures.compliance,
      attendance,
      missingPunches: figures.missingPunches,
      corrections: figures.corrections,
      overtimeMinutes: figures.overtimeMinutes,
      reviews: reviewers(moves, window).find((row) => row.userId === person.id)?.reviews ?? 0,
      rating: figures.rating,
      clientRevisions: figures.clientRevisions,
    };
  }

  const peopleFigures = people
    .map((person) => personFigures(person, period, true))
    .sort((a, b) => a.name.localeCompare(b.name));
  const peopleBefore = new Map(people.map((person) => [person.id, personFigures(person, previous, false)]));

  // ---- hours by list ------------------------------------------------------
  const listNames = new Map(((listsResult.data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  const listMinutes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.workDate < period.from || entry.workDate > period.to) continue;
    const listId = listOf.get(entry.taskId) ?? "none";
    listMinutes.set(listId, (listMinutes.get(listId) ?? 0) + entry.minutes);
  }
  const listHours = [...listMinutes.entries()]
    .map(([id, minutes]) => ({ id, name: id === "none" ? "No list" : (listNames.get(id) ?? "A list you cannot open"), minutes }))
    .sort((a, b) => b.minutes - a.minutes);

  return {
    departments,
    selected,
    scopeIsAll: scope === null,
    period,
    previous,
    today,
    graceMinutes: settings.graceMinutes,
    team,
    teamBefore,
    byDepartment,
    people: peopleFigures,
    peopleBefore,
    listHours,
    nameOf,
    errors,
  };
}

