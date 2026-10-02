import type { DailyAttendanceReport, SheetLevel } from "@/lib/daily-attendance-report";
import { A4_HEIGHT, A4_WIDTH, measureText, PdfDocument, truncateToWidth } from "@/lib/pdf";

/**
 * P15-08 — the 6 AM report as a PDF, attached to the email so the CEO and
 * Business Managers can read, forward or print it without logging in.
 *
 * Same page grammar as the leave audit (`leave-report.ts`): title top-left,
 * generated-on top-right, a shaded header band, hairlines between rows, a page
 * footer. Helvetica through `lib/pdf.ts`, so text is WinAnsi — the email's
 * "·" separators are fine there but its em dashes are not (they encode as "?"), which is why every
 * string drawn here is assembled locally rather than lifted from the email body.
 */

const MARGIN = 40;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;

const COLUMN = {
  name: { x: MARGIN + 6, width: 110 },
  department: { x: MARGIN + 122, width: 84 },
  schedule: { x: MARGIN + 210, width: 64 },
  timeIn: { x: MARGIN + 280, width: 34 },
  timeOut: { x: MARGIN + 320, width: 40 },
  status: { x: MARGIN + 366, width: CONTENT_WIDTH - 366 - 6 },
} as const;

/**
 * The row colours. A pale fill across the row and a solid bar at its left
 * edge, with the status drawn in the darker ink. The STATUS WORD is always
 * there too, so a greyscale print loses the colour and none of the meaning.
 */
const TONE: Record<SheetLevel, { fill: string; ink: string } | null> = {
  absent: { fill: "#FBE3E1", ink: "#B3352C" },
  attention: { fill: "#FDEBD5", ink: "#C2570C" },
  leave: { fill: "#E4EEF8", ink: "#2F5C9A" },
  fine: { fill: "#E6F4EC", ink: "#1C7A52" },
  unknown: null,
};

const LEGEND: { level: SheetLevel; label: string }[] = [
  { level: "absent", label: "Absent" },
  { level: "attention", label: "Late / no time-out / out early" },
  { level: "leave", label: "On leave" },
  { level: "fine", label: "On time" },
];

const ROW_HEIGHT = 16;
const HEADER_HEIGHT = 18;
const BODY_SIZE = 9;
const FIRST_PAGE_TOP = 150;
const LATER_PAGE_TOP = 60;
const BOTTOM_LIMIT = A4_HEIGHT - MARGIN - 24;

export function renderDailyAttendancePdf(
  report: DailyAttendanceReport,
  { generatedOn }: { generatedOn: string },
): Uint8Array {
  const document = new PdfDocument();
  const fit = (text: string, width: number, bold = false) =>
    truncateToWidth(text, width, BODY_SIZE, bold ? "bold" : "regular");

  let y = 0;
  let pageNumber = 0;

  function header() {
    document.rect(MARGIN, y, CONTENT_WIDTH, HEADER_HEIGHT, 0.92);
    const baseline = y + 12.5;
    document.text(COLUMN.name.x, baseline, "Employee", { size: 8, font: "bold" });
    document.text(COLUMN.department.x, baseline, "Department", { size: 8, font: "bold" });
    document.text(COLUMN.schedule.x, baseline, "Schedule", { size: 8, font: "bold" });
    document.text(COLUMN.timeIn.x, baseline, "Time in", { size: 8, font: "bold" });
    document.text(COLUMN.timeOut.x, baseline, "Time out", { size: 8, font: "bold" });
    document.text(COLUMN.status.x, baseline, "Status", { size: 8, font: "bold" });
    y += HEADER_HEIGHT;
  }

  // Drawn as each page closes. "Page n" without "of m": the drawing API
  // writes to the current page only, and one page is the common case.
  function footer() {
    document.text(MARGIN, A4_HEIGHT - MARGIN + 8, "VizServe Team Portal - daily attendance", { size: 7, gray: 0.5 });
    document.text(A4_WIDTH - MARGIN, A4_HEIGHT - MARGIN + 8, `Page ${pageNumber}`, { size: 7, align: "right", gray: 0.5 });
  }

  function newPage() {
    if (pageNumber > 0) footer();
    document.addPage();
    pageNumber += 1;

    if (pageNumber === 1) {
      document.text(MARGIN, 56, "Daily attendance", { size: 20, font: "bold" });
      document.text(MARGIN, 74, report.day, { size: 11 });
      document.text(A4_WIDTH - MARGIN, 56, `Generated ${generatedOn}`, { size: 8, align: "right", gray: 0.4 });
      document.text(A4_WIDTH - MARGIN, 68, "All active employees", { size: 8, align: "right", gray: 0.4 });

      document.text(
        MARGIN,
        100,
        `Absent ${report.absent}   ·   Late ${report.late}   ·   No time-out ${report.noTimeOut}`,
        { size: 11, font: "bold" },
      );
      document.text(
        MARGIN,
        116,
        `${report.present} timed in, ${report.onLeave} on leave. Late and absent apply to the ` +
          `${report.scheduled} people with fixed hours; leave on the calendar, approved or pending, is never absent.`,
        { size: 8, gray: 0.35 },
      );
      // The key to the row colours, so the sheet explains itself.
      let x = MARGIN;
      for (const item of LEGEND) {
        const tone = TONE[item.level]!;
        document.rect(x, 126, 9, 9, tone.fill);
        document.rect(x, 126, 2.5, 9, tone.ink);
        document.text(x + 13, 133, item.label, { size: 8, gray: 0.3 });
        x += 13 + measureText(item.label, 8) + 16;
      }
      y = FIRST_PAGE_TOP - 4;
    } else {
      y = LATER_PAGE_TOP;
    }

    header();
  }

  newPage();

  if (report.sheet.length === 0) {
    document.text(MARGIN + 6, y + 18, "No active employees.", { size: 10, gray: 0.3 });
  }

  // EVERYBODY, worst first: absent, then late and missing time-outs, then
  // leave, then on time — department and name within each. The status column
  // says it in words; colour and weight only repeat it.
  for (const row of report.sheet) {
    if (y + ROW_HEIGHT > BOTTOM_LIMIT) newPage();

    const baseline = y + 11;
    const status = row.status.join(", ");
    const tone = TONE[row.level];
    const needsAttention = row.level === "absent" || row.level === "attention";

    if (tone) {
      document.rect(MARGIN, y, CONTENT_WIDTH, ROW_HEIGHT, tone.fill);
      document.rect(MARGIN, y, 3, ROW_HEIGHT, tone.ink);
    }
    const dash = (value: string) => value || "-";

    document.text(COLUMN.name.x, baseline, fit(row.name, COLUMN.name.width), { size: BODY_SIZE });
    document.text(COLUMN.department.x, baseline, fit(row.department ?? "No department", COLUMN.department.width), {
      size: BODY_SIZE,
      gray: row.department ? 0 : 0.45,
    });
    document.text(COLUMN.schedule.x, baseline, fit(row.schedule, COLUMN.schedule.width), {
      size: BODY_SIZE,
      gray: 0.35,
    });
    document.text(COLUMN.timeIn.x, baseline, dash(row.timeIn), { size: BODY_SIZE, gray: row.timeIn ? 0 : 0.5 });
    document.text(COLUMN.timeOut.x, baseline, dash(row.timeOut), { size: BODY_SIZE, gray: row.timeOut ? 0 : 0.5 });
    // A long status (a half day of leave with its type, plus the absent half)
    // steps down to 7pt before it is ever cut: the end of it is the part that
    // matters. Truncated only if it still does not fit.
    const statusFont = needsAttention ? "bold" : "regular";
    const statusSize =
      [BODY_SIZE, 8, 7.5, 7].find((size) => measureText(status, size, statusFont) <= COLUMN.status.width) ?? 7;
    document.text(COLUMN.status.x, baseline, truncateToWidth(status, COLUMN.status.width, statusSize, statusFont), {
      size: statusSize,
      font: statusFont,
      color: tone?.ink,
    });

    y += ROW_HEIGHT;
    // A white gap between tinted rows; a hairline under an untinted one.
    document.line(MARGIN, y, A4_WIDTH - MARGIN, y, tone ? { gray: 1, width: 1.2 } : { gray: 0.85, width: 0.4 });
  }

  footer();

  return document.build();
}

/** `vizserve-attendance-2026-10-01.pdf`. */
export function dailyAttendancePdfFilename(date: string): string {
  return `vizserve-attendance-${date}.pdf`;
}
