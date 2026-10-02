import { formatAppTime, formatDate, formatWeekday } from "@/lib/dates";
import { deviation, describeDeviation, scheduleFor, DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";
import type { EmailBody } from "@/lib/email/layout";
import { describeLeaveDay, expandLeaveDays, leaveKey, type LeaveSpan } from "@/lib/leave";

/**
 * P15-08 — THE 6 AM EMAIL: YESTERDAY'S LATE, ABSENT AND NO TIME-OUT.
 *
 * Pure, and the rules are `lib/attendance-summary.ts`'s for ONE day, so this
 * email and the HR attendance screen cannot disagree about the same person:
 *
 *   ABSENT — scheduled, no DTR entry, and NOTHING ON THE LEAVE CALENDAR for the
 *   day: not approved leave, not pending leave, not a half day of either.
 *
 *   LATE — a time-in past the scheduled start by more than the grace.
 *
 *   NO TIME-OUT — timed in, never timed out. Reported for EVERYBODY, scheduled
 *   or not: unlike lateness it is not a judgement against a schedule, it is an
 *   incomplete record that payroll will trip over.
 *
 * Somebody with no fixed hours is never late and never absent — see the
 * header of `lib/attendance-summary.ts`.
 *
 *   ON LEAVE — approved OR PENDING leave covering the day (what the leave
 *   calendar shows; never rejected or withdrawn), marked on the sheet and listed
 *   in the email after the exceptions, with its type where the type may be
 *   shown. It is never an exception: a person on leave is accounted for.
 *
 * ⚠️ LEAVE OF EVERY VISIBILITY ARRIVES HERE, HIDDEN TYPES INCLUDED, because it
 * has to excuse the absence. The CALLER blanks `type_name` for HIDDEN and
 * LABEL_HIDDEN types, so a confidential type reads as plain "On leave" and is
 * never named.
 */

export type ReportPerson = {
  id: string;
  fullName: string;
  departmentName: string | null;
  workStart: string | null;
  workEnd: string | null;
};

export type ReportEntry = { user_id: string; time_in: string | null; time_out: string | null };

export type ReportRow = {
  issue: (typeof KIND_LABEL)[number];
  name: string;
  department: string | null;
  detail: string;
};

/** One person's day on the full sheet the PDF prints — everybody, not only exceptions. */
export type SheetRow = {
  name: string;
  department: string | null;
  /** `09:00-18:00`, or "No fixed hours". */
  schedule: string;
  /** `HH:MM` Manila, or "" when not punched. */
  timeIn: string;
  timeOut: string;
  /** "On time", "Late 12m", "Out early · 20m", "No time-out", "Absent", "On leave", "Leave (AM)"… */
  status: string[];
  /** How bad the day was — the sheet sorts on it, and the PDF colours the row by it. */
  level: SheetLevel;
};

/**
 * Worst first. The PDF draws absent red, attention orange, leave blue and fine
 * green; "unknown" is somebody with no fixed hours and no record — nothing to
 * judge, so no colour either.
 */
export type SheetLevel = "absent" | "attention" | "leave" | "fine" | "unknown";

const LEVEL_ORDER: Record<SheetLevel, number> = { absent: 0, attention: 1, leave: 2, fine: 3, unknown: 4 };

function levelOf(status: readonly string[]): SheetLevel {
  if (status.some((part) => part.startsWith("Absent"))) return "absent";
  if (status.some((part) => /^(Late|Out early|No time-out|No time-in)/.test(part))) return "attention";
  if (status.some((part) => part.startsWith("On leave") || part.startsWith("Leave (pending)"))) return "leave";
  if (status.some((part) => part === "On time" || part === "Present")) return "fine";
  return "unknown";
}

export type DailyAttendanceReport = {
  subject: string;
  body: EmailBody;
  /** "Thu 1 Oct 2026" — the day reported. */
  day: string;
  /** The exceptions, in the order the email lists them. */
  rows: ReportRow[];
  /** Every active employee, worst first, then by department and name. For the PDF. */
  sheet: SheetRow[];
  present: number;
  onLeave: number;
  scheduled: number;
  absent: number;
  late: number;
  noTimeOut: number;
};

/** 0-2 are exceptions; 3 is leave, listed after them and never counted as one. */
type Finding = { kind: 0 | 1 | 2 | 3; person: ReportPerson; detail: string };

const KIND_LABEL = ["Absent", "Late", "No time-out", "On leave"] as const;

/** Department order with "no department" LAST. Not `?? "~"`: locale collation sorts punctuation first. */
const byDepartment = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function buildDailyAttendanceReport({
  date,
  people,
  entries,
  leave,
  pendingLeave = [],
  graceMinutes = DEFAULT_GRACE_MINUTES,
}: {
  /** The day being reported, `YYYY-MM-DD`. */
  date: string;
  people: readonly ReportPerson[];
  /** DTR rows for `date`. */
  entries: readonly ReportEntry[];
  /** Approved leave overlapping `date`. */
  leave: readonly LeaveSpan[];
  /**
   * Leave requested and not yet decided, overlapping `date`. The leave
   * calendar shows it, so the sheet does too: somebody whose leave is on the
   * calendar is marked as on leave, never as absent.
   */
  pendingLeave?: readonly LeaveSpan[];
  graceMinutes?: number;
}): DailyAttendanceReport {
  const entryOf = new Map(entries.map((entry) => [entry.user_id, entry]));
  const leaveDays = expandLeaveDays(leave, date, date);
  const pendingDays = expandLeaveDays(pendingLeave, date, date);
  const findings: Finding[] = [];
  let present = 0;
  let onLeave = 0;
  let scheduled = 0;

  const sheet: SheetRow[] = [];

  for (const person of people) {
    const schedule = scheduleFor({ work_start: person.workStart, work_end: person.workEnd });
    const isScheduled = Boolean(schedule.workStart && schedule.workEnd);
    const approvedDay = leaveDays.get(leaveKey(person.id, date)) ?? null;
    /** Pending counts only where nothing approved covers the day already. */
    const pendingDay = approvedDay ? null : (pendingDays.get(leaveKey(person.id, date)) ?? null);
    const leaveDay = approvedDay ?? pendingDay;
    const portion = leaveDay?.portion ?? null;
    /** ": Annual Leave", or "" when the type is unknown or may not be shown. */
    const leaveType = leaveDay?.typeNames.length ? `: ${leaveDay.typeNames.join(", ")}` : "";
    const half = portion === "morning" ? " (AM)" : portion === "afternoon" ? " (PM)" : "";
    const entry = entryOf.get(person.id);

    /** This person's line on the full sheet; filled in as the checks run. */
    const line: SheetRow = {
      name: person.fullName,
      department: person.departmentName,
      schedule: isScheduled ? `${schedule.workStart}-${schedule.workEnd}` : "No fixed hours",
      timeIn: entry?.time_in ? formatAppTime(entry.time_in) : "",
      timeOut: entry?.time_out ? formatAppTime(entry.time_out) : "",
      status: [],
      level: "unknown",
    };
    sheet.push(line);

    if (isScheduled) scheduled += 1;

    /*
     * LEAVE ON THE CALENDAR IS NEVER ABSENCE. Approved or still pending, full
     * day or half: the person is marked as on leave and, if they did not punch,
     * that is the whole of their line. Only a day with nothing on the calendar
     * can be absent.
     */
    if (leaveDay) {
      onLeave += 1;
      findings.push({
        kind: 3,
        person,
        detail: approvedDay ? describeLeaveDay(leaveDay) : `Awaiting approval · ${describeLeaveDay(leaveDay)}`,
      });
      line.status.push(approvedDay ? `On leave${half}${leaveType}` : `Leave (pending)${half}${leaveType}`);
      if (portion === "full" || !entry?.time_in) continue;
    }

    if (!entry?.time_in) {
      if (isScheduled && !entry) {
        findings.push({ kind: 0, person, detail: "No time record" });
        line.status.push("Absent");
      } else if (entry) {
        // A row with a time-out and no time-in: a record somebody started
        // fixing and did not finish. Said plainly rather than left blank.
        line.status.push("No time-in");
      } else {
        line.status.push("No time record");
      }
      continue;
    }

    present += 1;

    if (isScheduled) {
      // A morning off moves the start, so arriving after lunch is not late; an
      // afternoon off moves the end, so leaving at midday is not early.
      const late = portion === "morning" ? null : deviation("in", entry.time_in, schedule.workStart, graceMinutes);
      if (late) {
        const amount = describeDeviation(late).replace("Late in · ", "");
        findings.push({
          kind: 1,
          person,
          detail: `${amount} late, in at ${formatAppTime(entry.time_in)} (start ${late.scheduled})`,
        });
        line.status.push(`Late ${amount}`);
      }

      // Sheet only, not an exception in the email. Against the ordinary end:
      // approved overtime is not read here, and it only ever moves the end
      // LATER, so this can under-report an early departure but never invent one.
      const out = portion === "afternoon" ? null : deviation("out", entry.time_out, schedule.workEnd, graceMinutes);
      if (out && out.minutes < 0) line.status.push(describeDeviation(out));
    }

    if (!entry.time_out) {
      findings.push({ kind: 2, person, detail: `In at ${formatAppTime(entry.time_in)}, never timed out` });
      line.status.push("No time-out");
    }

    if (line.status.length === 0) line.status.push(isScheduled ? "On time" : "Present");
  }

  for (const line of sheet) line.level = levelOf(line.status);

  // Worst first — absent, then late and missing time-outs — so what needs
  // attention is at the top of page one; department and name within each.
  sheet.sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      byDepartment(a.department, b.department) ||
      a.name.localeCompare(b.name),
  );

  findings.sort(
    (a, b) =>
      a.kind - b.kind ||
      byDepartment(a.person.departmentName, b.person.departmentName) ||
      a.person.fullName.localeCompare(b.person.fullName),
  );

  const count = (kind: Finding["kind"]) => findings.filter((finding) => finding.kind === kind).length;
  const absent = count(0);
  const late = count(1);
  const noTimeOut = count(2);
  const day = `${formatWeekday(date)} ${formatDate(date)}`;
  const onLeaveListed = count(3);
  const clean = absent + late + noTimeOut === 0;
  const leaveNote = onLeaveListed > 0 ? `, ${onLeaveListed} on leave` : "";

  return {
    day,
    sheet,
    rows: findings.map((finding) => ({
      issue: KIND_LABEL[finding.kind],
      name: finding.person.fullName,
      department: finding.person.departmentName,
      detail: finding.detail,
    })),
    present,
    onLeave,
    scheduled,
    absent,
    late,
    noTimeOut,
    subject: clean
      ? `Attendance ${day}: no exceptions${leaveNote}`
      : `Attendance ${day}: ${absent} absent, ${late} late, ${noTimeOut} no time-out${leaveNote}`,
    body: {
      preheader: `Yesterday's attendance, ${day}`,
      heading: clean ? "A clean day" : `Attendance exceptions for ${day}`,
      status: {
        label: `${absent} absent · ${late} late · ${noTimeOut} no time-out · ${onLeaveListed} on leave`,
        tone: absent > 0 ? "warning" : clean ? "success" : "info",
      },
      paragraphs: [
        [
          `${plural(present, "person", "people")} timed in on ${day}, and ${plural(onLeave, "was", "were")} on leave.`,
          clean ? "Nobody was absent, late or missing a time-out." : "Everyone who was absent, late or never timed out is listed below.",
          onLeaveListed > 0 ? (clean ? "Who was on leave is listed below." : "Who was on leave is listed after them.") : "",
        ]
          .filter(Boolean)
          .join(" "),
        `Late and absent apply only to the ${plural(scheduled, "person", "people")} with fixed hours; anyone with leave on the calendar, approved or pending, is never absent.`,
      ],
      facts: findings.map((finding) => ({
        label: finding.person.fullName,
        value: `${KIND_LABEL[finding.kind]} · ${finding.detail}${
          finding.person.departmentName ? ` · ${finding.person.departmentName}` : ""
        }`,
      })),
      factsTitle: onLeaveListed > 0 ? "Absent, late, no time-out and on leave" : "Absent, late and no time-out",
      factsNote: day,
      // No button: the list above and the attached PDF are the whole report,
      // so reading it never needs a login.
      footnote:
        "Everyone's time in and time out is in the attached PDF. Sent every working-day morning at 6:00 AM to the CEO and Business Managers, covering the previous working day.",
    },
  };
}
