import { A4_HEIGHT, A4_WIDTH, PdfDocument, truncateToWidth } from "@/lib/pdf";
import { formatDayCount } from "@/lib/schemas/leave-balances";

/**
 * P7-34 — the leave audit report.
 *
 * Run in December, before January, so unused days can be settled or paid as
 * part of the bonus. That makes it an AUDIT DOCUMENT rather than a screen: it
 * gets printed, checked line by line against what HR has on paper, signed and
 * filed. Three things follow from that, and they are the reasons this file
 * looks the way it does.
 *
 *   1. EVERY PERSON APPEARS, including one who took no leave at all and one who
 *      has no allocation set. An absence from an audit table is ambiguous — it
 *      could mean nothing happened, or it could mean somebody was missed — and
 *      an auditor cannot tell those apart afterwards. A person with nothing gets
 *      a line saying so.
 *   2. EVERY FIGURE IS SHOWN, not just the interesting one. Allocated, used and
 *      unused all appear, even though unused is the only one the bonus depends
 *      on, because a single number nobody can check the arithmetic of is not
 *      evidence.
 *   3. THE HEADER STATES THE RULES. Which year, what counts as used, what is
 *      excluded, and when it was generated. A report that is going to be
 *      compared against a manual count has to say what it counted, or the two
 *      disagree and nobody can tell which is wrong.
 *
 * Kept separate from `lib/pdf.ts` on purpose: that file knows about bytes and
 * fonts and nothing about leave, this one knows about leave and nothing about
 * cross-reference tables. It is also why the layout is testable without parsing
 * a PDF — `planLeaveReport` returns the lines, and `renderLeaveReport` draws
 * them.
 */

/** One row of `vizserve_pms_leave_report`, as the action hands it over. */
export type LeaveReportRow = {
  user_id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  department_name: string | null;
  leave_type_id: string;
  code: string;
  label: string;
  sort_order: number;
  days_allocated: number;
  days_used: number;
  days_remaining: number;
};

export type LeaveReportPerson = {
  user_id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  department_name: string | null;
  /** Only the types worth printing — see `groupLeaveReport`. */
  types: Array<{
    label: string;
    allocated: number;
    used: number;
    remaining: number;
  }>;
  totals: { allocated: number; used: number; remaining: number };
};

/**
 * Rows to people.
 *
 * TYPES WITH NOTHING BEHIND THEM ARE DROPPED — a person who has never touched
 * Solo Parent Leave does not need a line of zeroes for it, and eight such lines
 * each would turn a three-page report into fifteen. The SQL returns all of them
 * deliberately, because it cannot know what the caller is printing; the choice
 * belongs here, where it can be explained.
 *
 * THE TOTALS ARE SUMMED OVER THE PRINTED TYPES, which is the same thing as over
 * all of them, since the dropped rows are zero on all three figures. Stated
 * because the two would silently diverge the day that filter changes.
 */
export function groupLeaveReport(rows: LeaveReportRow[]): LeaveReportPerson[] {
  const people = new Map<string, LeaveReportPerson>();

  for (const row of rows) {
    let person = people.get(row.user_id);

    if (!person) {
      person = {
        user_id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        is_active: row.is_active,
        department_name: row.department_name,
        types: [],
        totals: { allocated: 0, used: 0, remaining: 0 },
      };
      people.set(row.user_id, person);
    }

    if (row.days_allocated === 0 && row.days_used === 0) continue;

    person.types.push({
      label: row.label,
      allocated: row.days_allocated,
      used: row.days_used,
      remaining: row.days_remaining,
    });

    person.totals.allocated += row.days_allocated;
    person.totals.used += row.days_used;
    person.totals.remaining += row.days_remaining;
  }

  return [...people.values()];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const MARGIN = 40;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;

/**
 * Column right edges for the three figures, and left edges for the two labels.
 *
 * Numbers are RIGHT-aligned so the decimal points stack — a column of "12",
 * "7.5" and "0.5" left-aligned is unreadable at a glance, and this is a
 * document somebody scans for the odd one out.
 */
const COLUMN = {
  name: MARGIN,
  type: MARGIN + 210,
  allocatedRight: MARGIN + 380,
  usedRight: MARGIN + 460,
  remainingRight: MARGIN + CONTENT_WIDTH,
} as const;

const ROW_HEIGHT = 15;
const HEADER_HEIGHT = 18;
const BODY_SIZE = 9;
const FIRST_PAGE_TOP = 128;
const LATER_PAGE_TOP = 60;
const BOTTOM_LIMIT = A4_HEIGHT - MARGIN - 24; // room for the page footer

export type LeaveReportMeta = {
  year: number;
  /** ISO date in the app zone. Passed in — nothing here reads the clock. */
  generatedOn: string;
  /** Who ran it. Named on the page because an audit document needs a source. */
  generatedBy: string;
  /**
   * What the caller could see. "All departments" for an admin, otherwise the
   * ones they lead — printed so a partial report is never mistaken for a whole
   * one, which is the single most dangerous way this document can be wrong.
   */
  scope: string;
};

/** A drawable line. Deliberately data, so the layout can be tested directly. */
export type PlannedLine =
  | { kind: "person"; person: LeaveReportPerson }
  | { kind: "type"; label: string; allocated: number; used: number; remaining: number }
  | { kind: "total"; totals: LeaveReportPerson["totals"] }
  | { kind: "empty" };

export type PlannedPage = { lines: PlannedLine[] };

/**
 * Break the people into pages.
 *
 * A PERSON IS NEVER SPLIT ACROSS A PAGE BREAK unless they alone are taller than
 * a page. Somebody's name on one sheet and half their leave on the next is how
 * a total gets read against the wrong person, which for a document that decides
 * a bonus is the failure worth spending a little whitespace to avoid.
 *
 * The exception is real and handled: a person with more leave types than fits a
 * page is split rather than dropped, because dropping them silently is worse
 * than an awkward break.
 */
export function planLeaveReport(people: LeaveReportPerson[]): PlannedPage[] {
  const pages: PlannedPage[] = [];
  let lines: PlannedLine[] = [];
  let y = FIRST_PAGE_TOP + HEADER_HEIGHT;

  const startPage = () => {
    pages.push({ lines });
    lines = [];
    y = LATER_PAGE_TOP + HEADER_HEIGHT;
  };

  for (const person of people) {
    const block: PlannedLine[] = [
      { kind: "person", person },
      ...(person.types.length === 0
        ? [{ kind: "empty" } as PlannedLine]
        : person.types.map(
            (type): PlannedLine => ({
              kind: "type",
              label: type.label,
              allocated: type.allocated,
              used: type.used,
              remaining: type.remaining,
            }),
          )),
      // No total line when there is only one type: "10 / 3 / 7" repeated
      // immediately underneath itself is noise, and an auditor reads the
      // repetition as a second figure to check.
      ...(person.types.length > 1 ? [{ kind: "total", totals: person.totals } as PlannedLine] : []),
    ];

    const blockHeight = block.length * ROW_HEIGHT + 6;
    const fitsOnAPage = LATER_PAGE_TOP + HEADER_HEIGHT + blockHeight <= BOTTOM_LIMIT;

    if (y + blockHeight > BOTTOM_LIMIT && lines.length > 0 && fitsOnAPage) {
      startPage();
    }

    for (const line of block) {
      if (y + ROW_HEIGHT > BOTTOM_LIMIT && lines.length > 0) startPage();
      lines.push(line);
      y += ROW_HEIGHT;
    }

    y += 6; // the gap between people
  }

  pages.push({ lines });
  return pages;
}

/** Draw the planned pages. Returns the finished PDF bytes. */
export function renderLeaveReport(
  people: LeaveReportPerson[],
  meta: LeaveReportMeta,
): Uint8Array {
  const document = new PdfDocument();
  const pages = planLeaveReport(people);

  pages.forEach((page, index) => {
    document.addPage();

    let y = index === 0 ? FIRST_PAGE_TOP : LATER_PAGE_TOP;

    if (index === 0) {
      document.text(MARGIN, 56, "Leave audit", { size: 20, font: "bold" });
      document.text(MARGIN, 74, `Calendar year ${meta.year}`, { size: 11 });

      document.text(A4_WIDTH - MARGIN, 56, `Generated ${meta.generatedOn}`, {
        size: 8,
        align: "right",
        gray: 0.35,
      });
      document.text(A4_WIDTH - MARGIN, 68, `by ${meta.generatedBy}`, {
        size: 8,
        align: "right",
        gray: 0.35,
      });
      document.text(A4_WIDTH - MARGIN, 80, meta.scope, {
        size: 8,
        align: "right",
        gray: 0.35,
      });

      // The rules, on the page. Without these the report and HR's manual count
      // disagree and there is no way to tell which of them is wrong.
      document.text(
        MARGIN,
        98,
        "Counts APPROVED leave only, in working days (weekends and holidays excluded), attributed to the",
        { size: 7.5, gray: 0.4 },
      );
      document.text(
        MARGIN,
        108,
        "year it started in. Unused = allocated less used, and may be negative where leave was allowed past the allocation.",
        { size: 7.5, gray: 0.4 },
      );
    }

    // The column header band, repeated on every page — a table continuing onto
    // a second sheet without its headings is three unlabelled columns of
    // numbers.
    document.rect(MARGIN, y, CONTENT_WIDTH, HEADER_HEIGHT, 0.92);
    const headerBaseline = y + 12.5;
    document.text(COLUMN.name + 4, headerBaseline, "Employee", { size: 8, font: "bold" });
    document.text(COLUMN.type, headerBaseline, "Leave type", { size: 8, font: "bold" });
    document.text(COLUMN.allocatedRight, headerBaseline, "Allocated", {
      size: 8,
      font: "bold",
      align: "right",
    });
    document.text(COLUMN.usedRight, headerBaseline, "Used", {
      size: 8,
      font: "bold",
      align: "right",
    });
    document.text(COLUMN.remainingRight, headerBaseline, "Unused", {
      size: 8,
      font: "bold",
      align: "right",
    });

    y += HEADER_HEIGHT;

    page.lines.forEach((line, lineIndex) => {
      const baseline = y + 10.5;

      if (line.kind === "person") {
        // A rule above each person, except the first on the page, so the blocks
        // read as blocks. Light enough not to compete with the header band.
        if (lineIndex !== 0) {
          document.line(MARGIN, y, A4_WIDTH - MARGIN, y, { gray: 0.85, width: 0.4 });
        }

        const name = truncateToWidth(line.person.full_name, 200, 9, "bold");
        document.text(COLUMN.name + 4, baseline, name, { size: 9, font: "bold" });

        // Department and, where it applies, the fact that this person has left.
        // A leaver still appears because their absences are part of the year
        // being audited; saying so stops them being counted as current staff.
        const detail = [line.person.department_name ?? "No department", line.person.is_active ? "" : "no longer active"]
          .filter(Boolean)
          .join(" · ");

        document.text(COLUMN.type, baseline, truncateToWidth(detail, 160, 7.5), {
          size: 7.5,
          gray: 0.45,
        });
      } else if (line.kind === "type") {
        document.text(COLUMN.type, baseline, truncateToWidth(line.label, 160, BODY_SIZE), {
          size: BODY_SIZE,
        });
        document.text(COLUMN.allocatedRight, baseline, formatDayCount(line.allocated), {
          size: BODY_SIZE,
          align: "right",
        });
        document.text(COLUMN.usedRight, baseline, formatDayCount(line.used), {
          size: BODY_SIZE,
          align: "right",
        });
        document.text(COLUMN.remainingRight, baseline, formatDayCount(line.remaining), {
          size: BODY_SIZE,
          align: "right",
          // An overdraw is greyed no differently — state is never conveyed by
          // colour alone, and on a page that may be photocopied in black and
          // white it could not be anyway. The minus sign carries it.
        });
      } else if (line.kind === "total") {
        document.line(COLUMN.type, y + 1, A4_WIDTH - MARGIN, y + 1, { gray: 0.8, width: 0.4 });
        document.text(COLUMN.type, baseline, "Total", { size: BODY_SIZE, font: "bold" });
        document.text(COLUMN.allocatedRight, baseline, formatDayCount(line.totals.allocated), {
          size: BODY_SIZE,
          font: "bold",
          align: "right",
        });
        document.text(COLUMN.usedRight, baseline, formatDayCount(line.totals.used), {
          size: BODY_SIZE,
          font: "bold",
          align: "right",
        });
        document.text(COLUMN.remainingRight, baseline, formatDayCount(line.totals.remaining), {
          size: BODY_SIZE,
          font: "bold",
          align: "right",
        });
      } else {
        // The "nothing to report" line, which is a finding rather than a gap.
        document.text(COLUMN.type, baseline, "No leave allocated or taken this year", {
          size: BODY_SIZE,
          gray: 0.45,
        });
      }

      y += ROW_HEIGHT;
    });

    document.text(
      A4_WIDTH - MARGIN,
      A4_HEIGHT - MARGIN + 8,
      `Page ${index + 1} of ${pages.length}`,
      { size: 7.5, align: "right", gray: 0.45 },
    );
    document.text(MARGIN, A4_HEIGHT - MARGIN + 8, "VizServe PMS — leave audit", {
      size: 7.5,
      gray: 0.45,
    });
  });

  return document.build();
}

/**
 * `vizserve-leave-audit-2026.pdf`.
 *
 * The year is in the filename because these get saved next to each other year
 * after year, and "leave-audit.pdf (3)" is how the wrong one ends up attached
 * to a payroll email.
 */
export function leaveReportFilename(year: number): string {
  return `vizserve-leave-audit-${year}.pdf`;
}
