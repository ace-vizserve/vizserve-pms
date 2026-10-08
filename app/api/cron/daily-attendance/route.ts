import { NextResponse } from "next/server";

import { buildDailyAttendanceReport } from "@/lib/daily-attendance-report";
import { addDays, formatDate, isDateOnly, todayInAppZone } from "@/lib/dates";
import { DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";
import type { LeaveSpan } from "@/lib/leave";
import { cronFailure, isCronAuthorized, loadRoster, previewResponse, sendToOversight } from "@/lib/oversight-digest-server";
import { dailyAttendancePdfFilename, renderDailyAttendancePdf } from "@/lib/reports/daily-attendance-pdf";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P15-08 — 6:00 AM Manila (22:00 UTC in `vercel.json`): the previous working
 * day's late, absent and no time-out, to the CEO and Business Managers. The
 * day is closed, and the list is waiting before work starts.
 *
 * THE PREVIOUS WORKING DAY, NOT YESTERDAY. It runs only on working days, and
 * reports the last working day before today — so Monday's email covers
 * Friday, and the day after a holiday covers the day before it. A Monday
 * email about Sunday would say nothing, and a Saturday one would arrive when
 * nobody is reading.
 *
 * THE PDF IS ATTACHED, so the report is read in the inbox and nobody has to
 * log in to see it. `?preview=pdf` returns it instead of sending.
 *
 * TESTING: `?date=YYYY-MM-DD` reports that day, working-day checks skipped,
 * and `&to=<email>` sends only to that address, which must be an active
 * user's.
 */

export const maxDuration = 60;

const TAG = "daily-attendance";

/**
 * Left out of the report entirely — the email and the PDF. They still RECEIVE
 * it if they are oversight. By id, not email: an email can change (Nina's did).
 */
const EXEMPT = new Set([
  "37c09844-65f8-48d6-9dc9-396eb11e0930", // Amier Ordonez
  "b21b4e11-b148-47f1-a7d8-d4b4c6d1b526", // Joel Castro
]);

const isWeekend = (date: string) => {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};

type LeaveRow = {
  requester_id: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  start_half: "MORNING" | "AFTERNOON" | null;
  end_half: "MORNING" | "AFTERNOON" | null;
  vizserve_pms_leave_types: { label: string; calendar_visibility: string | null } | null;
};

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const requested = params.get("date");
  const testTo = params.get("to")?.trim().toLowerCase() || null;

  const admin = createAdminClient();
  let date: string;

  if (isDateOnly(requested)) {
    date = requested;
  } else {
    const today = todayInAppZone();
    const { data: holidays, error } = await admin
      .from("vizserve_pms_holidays")
      .select("holiday_date")
      .gte("holiday_date", addDays(today, -21)!)
      .lte("holiday_date", today);
    if (error) return cronFailure(TAG, "holidays", error.message);

    const holiday = new Set((holidays ?? []).map((row) => row.holiday_date));
    const isWorkingDay = (value: string) => !isWeekend(value) && !holiday.has(value);

    if (!isWorkingDay(today)) return NextResponse.json({ ok: true, skipped: "not a working day", today });

    let previous = addDays(today, -1)!;
    // Bounded: three weeks of consecutive holidays means the table is wrong.
    for (let step = 0; step < 21 && !isWorkingDay(previous); step += 1) previous = addDays(previous, -1)!;
    date = previous;
  }

  const [roster, entries, leave, settings] = await Promise.all([
    loadRoster(admin),
    admin.from("vizserve_pms_dtr_entries").select("user_id, time_in, time_out").eq("work_date", date),
    admin
      .from("vizserve_pms_internal_requests")
      .select("requester_id, status, start_date, end_date, start_half, end_half, vizserve_pms_leave_types(label, calendar_visibility)")
      .eq("request_type", "LEAVE")
      // What the leave calendar shows: approved and still pending. Rejected and
      // withdrawn requests were never an absence and stay off, as they do there.
      .in("status", ["APPROVED", "PENDING_REVIEW"])
      .lte("start_date", date)
      .gte("end_date", date),
    admin.from("vizserve_pms_app_settings").select("grace_minutes").maybeSingle(),
  ]);

  // A failed read must not arrive looking like "everybody was absent".
  if (roster.error) return cronFailure(TAG, "roster", roster.error);
  if (entries.error) return cronFailure(TAG, "dtr", entries.error.message);
  if (leave.error) return cronFailure(TAG, "leave", leave.error.message);

  const rows = (leave.data ?? []) as LeaveRow[];
  const toSpans = (status: string): LeaveSpan[] =>
    rows
      .filter((row) => row.status === status && row.start_date && row.end_date)
      .map((row) => ({
        user_id: row.requester_id,
        start_date: row.start_date!,
        end_date: row.end_date!,
        start_half: row.start_half,
        end_half: row.end_half,
        // The type is named only where the leave calendar would name it. A HIDDEN
        // type (P7-42: RA 9262 §44, RA 9710) and a LABEL_HIDDEN one still excuse
        // the absence and still read "On leave" — just never which kind.
        type_name:
          row.vizserve_pms_leave_types && row.vizserve_pms_leave_types.calendar_visibility === "FULL"
            ? row.vizserve_pms_leave_types.label
            : null,
      }));
  const spans = toSpans("APPROVED");
  const pendingSpans = toSpans("PENDING_REVIEW");

  const report = buildDailyAttendanceReport({
    date,
    people: roster.people.filter((person) => !EXEMPT.has(person.id)),
    entries: entries.data ?? [],
    leave: spans,
    pendingLeave: pendingSpans,
    graceMinutes: settings.data?.grace_minutes ?? DEFAULT_GRACE_MINUTES,
  });

  const pdf = renderDailyAttendancePdf(report, { generatedOn: formatDate(todayInAppZone()) });
  const filename = dailyAttendancePdfFilename(date);

  const preview = params.get("preview");
  if (preview === "1") return previewResponse(report.subject, report.body);
  if (preview === "pdf") {
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  const recipients = testTo
    ? roster.people
        .filter((person) => person.email.toLowerCase() === testTo)
        .map((person) => ({ ...person, isOversight: true }))
    : roster.people;
  if (testTo && recipients.length === 0) {
    return NextResponse.json({ ok: false, error: "`to` must be an active user's email" }, { status: 400 });
  }

  const subject = testTo ? `[Test] ${report.subject}` : report.subject;
  const sent = await sendToOversight(TAG, recipients, subject, report.body, [{ filename, content: pdf }]);

  return NextResponse.json({
    ok: true,
    date,
    absent: report.absent,
    late: report.late,
    noTimeOut: report.noTimeOut,
    ...sent,
  });
}
