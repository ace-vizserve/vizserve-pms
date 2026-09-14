import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { summariseAttendance, type AttendanceDay, type AttendancePerson } from "@/lib/attendance-summary";
import { todayInAppZone } from "@/lib/dates";
import { expandLeaveDays, leaveKey } from "@/lib/leave";
import { loadApprovedLeaveSpans } from "@/lib/leave-server";
import { loadDepartmentNames } from "@/lib/departments-server";
import { loadApprovedOvertime } from "@/lib/overtime-server";
import { loadAppSettings } from "@/lib/settings-server";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { AttendanceTable } from "./attendance-table";

export const metadata: Metadata = { title: "Attendance" };

/** `2026-03` → `2026-03-01` and `2026-03-31`, from the parts. Never via `Date`. */
function monthBounds(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  // Day 0 of the NEXT month is the last day of this one, and `Date.UTC` handles
  // December rolling into January without a special case.
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** Every date in the month, inclusive, as `YYYY-MM-DD`. */
function datesIn(month: string): string[] {
  const { to } = monthBounds(month);
  const lastDay = Number(to.slice(8));
  return Array.from({ length: lastDay }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}

/** `2026-03` and nothing else. A mangled param falls back to this month. */
function narrowMonth(value: string | undefined, fallback: string): string {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return fallback;
  const year = Number(value.slice(0, 4));
  return year >= 2020 && year <= 2100 ? value : fallback;
}

/**
 * P7-52 — the attendance roll-up.
 *
 * ⚠️ READ `lib/attendance-summary.ts` BEFORE CHANGING ANYTHING HERE. "Absent"
 * had no definition in this codebase until that file, so the number this screen
 * reports is a decision rather than a derivation — and it is stated on the page
 * for the same reason the audit PDF prints its rules.
 *
 * ONE MONTH AT A TIME, from the URL. The DTR is per person and per fortnight;
 * this is per person and per month, because the question it answers ("who is
 * repeatedly late") is not visible in two weeks and is drowned in a year.
 *
 * ⚠️ THE AGGREGATION IS IN A PURE FUNCTION, NOT HERE. The only comparable
 * roll-up in the app is inline in `app/(app)/dtr/page.tsx:408-422` and cannot
 * be reused or tested. Putting this one in `lib/` is what let the definition of
 * "absent" be pinned by `tests/unit/attendance-summary.test.ts` rather than
 * left to whoever reads the page next.
 *
 * Read through the ORDINARY RLS client. HR sees everybody because the policies
 * say so, not because this page asks for everybody — no query below carries a
 * department filter, exactly as every other list in this app.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  await requireHr();
  const supabase = await createClient();

  const params = await searchParams;
  const requested = Array.isArray(params.month) ? params.month[0] : params.month;

  const today = todayInAppZone();
  const thisMonth = today.slice(0, 7);
  const month = narrowMonth(requested, thisMonth);
  const { from, to } = monthBounds(month);

  const [
    { data: people, error: peopleError },
    { data: entries, error: entriesError },
    leave,
    { data: holidays },
    overtime,
    departmentName,
    settings,
  ] = await Promise.all([
    supabase
      .from("vizserve_pms_users")
      .select("id, full_name, work_start, work_end, is_active, primary_department_id")
      // ACTIVE ONLY, unlike the leave audit. A leaver's absences in a closed
      // year are part of what that audit counts; a leaver in this month is not
      // "absent", they have left, and counting them would put a 20-day absence
      // at the top of the list every month forever.
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("vizserve_pms_dtr_entries")
      .select("user_id, work_date, time_in, time_out")
      .gte("work_date", from)
      .lte("work_date", to),
    /*
     * ⚠️ THIS READ USED TO OMIT `start_half` AND `end_half`, AND THAT WAS THE
     * BUG. Without them a half day was indistinguishable from a whole one, so
     * the roll-up counted it as a full day of leave AND exempted the half the
     * person actually worked from the lateness and undertime checks. /dtr had
     * the halves all along, so the same day read two different ways on two
     * screens. The shared loader is what stops a third caller selecting a
     * different set of columns.
     */
    loadApprovedLeaveSpans(from, to),
    supabase
      .from("vizserve_pms_holidays")
      .select("holiday_date")
      .gte("holiday_date", from)
      .lte("holiday_date", to),
    loadApprovedOvertime(from, to),
    loadDepartmentNames(),
    // Was awaited on its own line above this batch, holding all six reads
    // behind it. It takes no argument and is `cache()`d, so it depends on
    // nothing here — it is simply the seventh thing to go out at once.
    loadAppSettings(),
  ]);

  const error = peopleError ?? entriesError;
  const dates = datesIn(month);
  const holidayDates = new Set((holidays ?? []).map((row) => row.holiday_date));

  // Indexed once, keyed `userId:date`. A linear scan per person per day would
  // be O(people x days x rows) on the one screen that renders the whole company
  // for a whole month.
  const entryByKey = new Map<string, { time_in: string | null; time_out: string | null }>();
  for (const entry of entries ?? []) {
    entryByKey.set(`${entry.user_id}:${entry.work_date}`, {
      time_in: entry.time_in,
      time_out: entry.time_out,
    });
  }

  const overtimeByKey = new Map<string, number>();
  for (const row of overtime) {
    const key = `${row.requester_id}:${row.work_date}`;
    overtimeByKey.set(key, (overtimeByKey.get(key) ?? 0) + row.overtime_minutes);
  }

  /*
   * Expanded from ranges to days, HALVES AND ALL.
   *
   * `expandLeaveDays` is the same arithmetic /dtr and the payroll export use,
   * and it is unit-tested (`tests/unit/leave-days.test.ts`). The hand-rolled
   * string walk this replaces had no notion of a portion at all.
   */
  const leaveDays = expandLeaveDays(leave.spans, from, to);

  const attendance: AttendancePerson[] = (people ?? []).map((person) => ({
    userId: person.id,
    fullName: person.full_name,
    departmentName: person.primary_department_id
      ? (departmentName.get(person.primary_department_id) ?? null)
      : null,
    workStart: person.work_start,
    workEnd: person.work_end,
    days: dates.map((date): AttendanceDay => {
      const key = `${person.id}:${date}`;
      const entry = entryByKey.get(key);

      return {
        date,
        timeIn: entry?.time_in ?? null,
        timeOut: entry?.time_out ?? null,
        hasEntry: entry !== undefined,
        // The PORTION, not a boolean. A morning half day is half a day of
        // leave and half a day the person was expected at their desk.
        leavePortion: leaveDays.get(leaveKey(person.id, date))?.portion ?? null,
        isHoliday: holidayDates.has(date),
        overtimeMinutes: overtimeByKey.get(key) ?? 0,
      };
    }),
  }));

  const summaries = summariseAttendance(attendance, settings.graceMinutes);

  return (
    <PageShell>
      <p className="text-xs text-muted-foreground">
        Lateness and unexplained absence, by month. A day counts only if it is a weekday and not a
        holiday. <strong>Absent means a working day with no time-in and no approved leave</strong> —
        leave is counted separately and is never absence. Late is a time-in more than{" "}
        {settings.graceMinutes} minute{settings.graceMinutes === 1 ? "" : "s"} past the scheduled
        start; undertime is a clock-out that early before the end, allowing for approved overtime.
        Anyone with no fixed hours recorded is shown but not counted — there is no start time to
        judge them against.
      </p>

      {error ? (
        <QueryError what="attendance" message={error.message} />
      ) : (
        <AttendanceTable month={month} thisMonth={thisMonth} summaries={summaries} />
      )}
    </PageShell>
  );
}
