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
 *
 * THE LEAVE-TYPE COLUMN IS SIZED FOR THE LONGEST LABEL, not for a round number.
 * P7-41 added "Anti-Violence Against Women and Their Children (VAWC) Leave" —
 * 258pt at 9pt Helvetica, against the 160pt this column used to allow. It cut
 * to "…Women and The…", which drops the acronym that identifies it, in a
 * document whose entire job is to be checked line by line against HR's own.
 *
 * The room comes from two places that had it spare: employee names are rarely
 * past 120pt, and the three numeric columns each hold at most "366.5" — 28pt of
 * digits sitting in an 80pt gap. Nothing was made narrower than its content.
 */
const COLUMN = {
  name: MARGIN,
  type: MARGIN + 150,
  allocatedRight: MARGIN + 420,
  usedRight: MARGIN + 472,
  remainingRight: MARGIN + CONTENT_WIDTH,
} as const;

/**
 * How much room a label actually gets before it collides with the figures.
 *
 * Measured to where the NUMBERS start, not to the "Allocated" heading — the
 * heading lives on its own band and never shares a row with a label, so sizing
 * to it would waste 30pt for a collision that cannot happen.
 */
const TYPE_WIDTH = 240;
const NAME_WIDTH = 140;

const ROW_HEIGHT = 15;
const HEADER_HEIGHT = 18;
const BODY_SIZE = 9;
const FIRST_PAGE_TOP = 128;
const LATER_PAGE_TOP = 60;
const BOTTOM_LIMIT = A4_HEIGHT - MARGIN - 24; // room for the page footer

/** P7-53. Leading for one printed filter line under the counting rules. */
const FILTER_LINE_HEIGHT = 10;
/** Where the first filter line sits — just below the two rules lines at 98/108. */
const FILTER_BLOCK_TOP = 122;

/**
 * P7-53 — where the column band starts once the filter lines are in.
 *
 * ⚠️ THE PLANNER HAS TO BE TOLD THIS, it cannot read the constant. `FIRST_PAGE_TOP`
 * used to be a module constant that both the planner and the renderer read, so
 * "print a taller header" was a one-line change. It is not: the planner decides
 * how many rows fit on page one from this number, so a header that grew without
 * telling it would overprint the first rows while the pagination still believed
 * it had 128pt of margin. Hence the parameter on `planLeaveReport`.
 *
 * With no filters this returns exactly 128, which is why every existing
 * pagination test still describes the same pages.
 */
function firstPageTopFor(filters: string[]): number {
  return FIRST_PAGE_TOP + filters.length * FILTER_LINE_HEIGHT;
}

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
  /**
   * P7-53 — the filters that were applied, already written as English.
   *
   * ⚠️ REQUIRED, AND EMPTY IS A VALID ANSWER MEANING "unfiltered". Not optional,
   * because the failure this prevents is silent: a filtered PDF that does not
   * name its filters is indistinguishable from an unfiltered one, and this
   * document exists to be compared against HR's manual count. Two documents
   * that disagree are useless unless each states what it counted (D30). An
   * optional field is one a caller forgets.
   *
   * Formatted by the caller rather than here: turning a list of uuids into
   * "Leave type: Sick leave, Vacation leave" needs the names, and this module
   * deliberately knows nothing but layout.
   */
  filters: string[];
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
function planBlocks<L>(blocks: L[][], firstPageTop: number): { lines: L[] }[] {
  const pages: { lines: L[] }[] = [];
  let lines: L[] = [];
  let y = firstPageTop + HEADER_HEIGHT;

  const startPage = () => {
    pages.push({ lines });
    lines = [];
    y = LATER_PAGE_TOP + HEADER_HEIGHT;
  };

  for (const block of blocks) {
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

export function planLeaveReport(
  people: LeaveReportPerson[],
  /**
   * P7-53. Defaulted so every existing caller and test describes the same
   * pages; the renderer passes `firstPageTopFor(meta.filters)` when the header
   * has grown filter lines. See the note on that function — this cannot be read
   * from a module constant, because the header and the pagination would then
   * disagree about how much room page one has.
   */
  firstPageTop: number = FIRST_PAGE_TOP,
): PlannedPage[] {
  const blocks = people.map((person): PlannedLine[] => [
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
  ]);

  return planBlocks(blocks, firstPageTop);
}

/** Draw the planned pages. Returns the finished PDF bytes. */
export function renderLeaveReport(
  people: LeaveReportPerson[],
  meta: LeaveReportMeta,
): Uint8Array {
  const document = new PdfDocument();
  const firstPageTop = firstPageTopFor(meta.filters);
  const pages = planLeaveReport(people, firstPageTop);

  pages.forEach((page, index) => {
    document.addPage();

    let y = index === 0 ? firstPageTop : LATER_PAGE_TOP;

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

      // P7-53 — the filters, named on the page.
      //
      // Darker and bolder than the rules above them, deliberately: the rules are
      // the same on every copy and get skimmed after the first read, while these
      // change per document and are the line somebody must notice before
      // comparing this page to a count of everybody. A filtered report that
      // looks exactly like an unfiltered one is the failure mode (D30).
      meta.filters.forEach((filter, filterIndex) => {
        document.text(
          MARGIN,
          FILTER_BLOCK_TOP + filterIndex * FILTER_LINE_HEIGHT,
          filter,
          { size: 8, font: "bold", gray: 0.15 },
        );
      });
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

        const name = truncateToWidth(line.person.full_name, NAME_WIDTH, 9, "bold");
        document.text(COLUMN.name + 4, baseline, name, { size: 9, font: "bold" });

        // Department and, where it applies, the fact that this person has left.
        // A leaver still appears because their absences are part of the year
        // being audited; saying so stops them being counted as current staff.
        const detail = [line.person.department_name ?? "No department", line.person.is_active ? "" : "no longer active"]
          .filter(Boolean)
          .join(" · ");

        document.text(COLUMN.type, baseline, truncateToWidth(detail, TYPE_WIDTH, 7.5), {
          size: 7.5,
          gray: 0.45,
        });
      } else if (line.kind === "type") {
        document.text(COLUMN.type, baseline, truncateToWidth(line.label, TYPE_WIDTH, BODY_SIZE), {
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

// ---------------------------------------------------------------------------
// MODE B — leave actually taken in a window (P7-53).
//
// In this file rather than its own, because the two modes are one document
// family and share every piece of geometry above. Splitting them would mean
// exporting the column map, the page constants and the block planner out of a
// module that deliberately keeps its layout private.
//
// ⚠️ THERE IS NO ALLOCATED COLUMN AND NO UNUSED COLUMN. Allocation is annual;
// a "remaining" figure for March–June would be a number on an audit document
// that is not true of any period, which is worse than an absent column. The
// only figures here are days actually taken.
// ---------------------------------------------------------------------------

/** One row of `vizserve_pms_leave_taken`, as the action hands it over. */
export type LeaveTakenRow = {
  user_id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  department_name: string | null;
  leave_type_id: string;
  code: string;
  label: string;
  sort_order: number;
  request_id: string;
  start_date: string;
  end_date: string;
  counted_from: string;
  counted_to: string;
  start_half: string;
  end_half: string;
  is_clipped: boolean;
  days: number;
};

export type LeaveTakenPerson = {
  user_id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  department_name: string | null;
  requests: LeaveTakenRow[];
  totalDays: number;
};

export type LeaveTakenMeta = {
  /** The window, inclusive. Printed on the page — this report has no year. */
  from: string;
  to: string;
  generatedOn: string;
  generatedBy: string;
  scope: string;
  /** See `LeaveReportMeta.filters`. Same contract, same reason. */
  filters: string[];
};

/**
 * Group the flat rows by person, preserving the SQL ordering.
 *
 * Same shape as `groupLeaveReport` and for the same reason: the document is
 * blocked by person, and a person's total has to be next to their rows.
 */
export function groupLeaveTaken(rows: LeaveTakenRow[]): LeaveTakenPerson[] {
  const people: LeaveTakenPerson[] = [];
  const byId = new Map<string, LeaveTakenPerson>();

  for (const row of rows) {
    let person = byId.get(row.user_id);

    if (!person) {
      person = {
        user_id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        is_active: row.is_active,
        department_name: row.department_name,
        requests: [],
        totalDays: 0,
      };
      byId.set(row.user_id, person);
      people.push(person);
    }

    person.requests.push(row);
    person.totalDays += row.days;
  }

  return people;
}

export type PlannedTakenLine =
  | { kind: "person"; person: LeaveTakenPerson }
  | { kind: "request"; row: LeaveTakenRow }
  | { kind: "total"; person: LeaveTakenPerson };

export type PlannedTakenPage = { lines: PlannedTakenLine[] };

export function planLeaveTaken(
  people: LeaveTakenPerson[],
  firstPageTop: number = FIRST_PAGE_TOP,
): PlannedTakenPage[] {
  const blocks = people.map((person): PlannedTakenLine[] => [
    { kind: "person", person },
    ...person.requests.map((row): PlannedTakenLine => ({ kind: "request", row })),
    // Unlike Mode A there is no single-row exception. One leave request and a
    // total saying the same number IS redundant on the page — but this report
    // is read by summing a column, and a person whose total is sometimes
    // present and sometimes not makes that sum a manual special case.
    { kind: "total", person },
  ]);

  return planBlocks(blocks, firstPageTop);
}

/**
 * `2026-03-01` and `2026-03-31` -> `1–31 Mar 2026`, near enough.
 *
 * Formatted from the string parts, NOT through `Date`. Parsing `2026-03-01` as
 * a Date gives midnight UTC, which is the previous day in Manila — the exact
 * trap `lib/dates.ts` exists to avoid, and it would print a range off by a day
 * at both ends on an audit document.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatReportDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const monthName = MONTHS[Number(month) - 1] ?? month;
  return `${Number(day)} ${monthName} ${year}`;
}

const TAKEN_COLUMN = {
  name: MARGIN,
  type: MARGIN + 150,
  dates: MARGIN + 330,
  daysRight: MARGIN + CONTENT_WIDTH,
} as const;

const TAKEN_TYPE_WIDTH = 170;
const TAKEN_DATES_WIDTH = 170;

export function renderLeaveTakenReport(
  people: LeaveTakenPerson[],
  meta: LeaveTakenMeta,
): Uint8Array {
  const document = new PdfDocument();
  const firstPageTop = firstPageTopFor(meta.filters);
  const pages = planLeaveTaken(people, firstPageTop);

  const grandTotal = people.reduce((total, person) => total + person.totalDays, 0);

  pages.forEach((page, index) => {
    document.addPage();

    let y = index === 0 ? firstPageTop : LATER_PAGE_TOP;

    if (index === 0) {
      document.text(MARGIN, 56, "Leave taken", { size: 20, font: "bold" });
      document.text(
        MARGIN,
        74,
        `${formatReportDate(meta.from)} to ${formatReportDate(meta.to)}`,
        { size: 11 },
      );

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

      // The rules, as Mode A prints them — but the second line is different and
      // the difference is the whole point of this mode. It says both that there
      // is no allocation here and what a clipped row means, because a row whose
      // day count deliberately disagrees with its printed dates looks like an
      // arithmetic error to anyone who has not been told.
      document.text(
        MARGIN,
        98,
        "Counts APPROVED leave only, in working days (weekends and holidays excluded), for leave overlapping the period.",
        { size: 7.5, gray: 0.4 },
      );
      document.text(
        MARGIN,
        108,
        "No allocation is shown: allocation is annual, so it cannot be reported against a partial period. * = leave extends beyond the period; only the days inside it are counted.",
        { size: 7.5, gray: 0.4 },
      );

      meta.filters.forEach((filter, filterIndex) => {
        document.text(
          MARGIN,
          FILTER_BLOCK_TOP + filterIndex * FILTER_LINE_HEIGHT,
          filter,
          { size: 8, font: "bold", gray: 0.15 },
        );
      });
    }

    document.rect(MARGIN, y, CONTENT_WIDTH, HEADER_HEIGHT, 0.92);
    const headerBaseline = y + 12.5;
    document.text(TAKEN_COLUMN.name + 4, headerBaseline, "Employee", { size: 8, font: "bold" });
    document.text(TAKEN_COLUMN.type, headerBaseline, "Leave type", { size: 8, font: "bold" });
    document.text(TAKEN_COLUMN.dates, headerBaseline, "Dates", { size: 8, font: "bold" });
    document.text(TAKEN_COLUMN.daysRight, headerBaseline, "Days", {
      size: 8,
      font: "bold",
      align: "right",
    });

    y += HEADER_HEIGHT;

    page.lines.forEach((line, lineIndex) => {
      const baseline = y + 10.5;

      if (line.kind === "person") {
        if (lineIndex !== 0) {
          document.line(MARGIN, y, A4_WIDTH - MARGIN, y, { gray: 0.85, width: 0.4 });
        }

        const name = truncateToWidth(line.person.full_name, NAME_WIDTH, 9, "bold");
        document.text(TAKEN_COLUMN.name + 4, baseline, name, { size: 9, font: "bold" });

        const detail = [
          line.person.department_name ?? "No department",
          line.person.is_active ? "" : "no longer active",
        ]
          .filter(Boolean)
          .join(" · ");

        document.text(TAKEN_COLUMN.type, baseline, truncateToWidth(detail, TAKEN_TYPE_WIDTH, 7.5), {
          size: 7.5,
          gray: 0.45,
        });
      } else if (line.kind === "request") {
        const { row } = line;

        document.text(
          TAKEN_COLUMN.type,
          baseline,
          truncateToWidth(row.label, TAKEN_TYPE_WIDTH, BODY_SIZE),
          { size: BODY_SIZE },
        );

        // The REQUEST'S OWN dates, not the clipped ones, with a marker where
        // they differ. Printing the clipped range instead would be tidier and
        // would hide the fact that the person was away longer than this report
        // covers — which somebody reconciling two adjacent periods needs to see.
        const range =
          row.start_date === row.end_date
            ? formatReportDate(row.start_date)
            : `${formatReportDate(row.start_date)} – ${formatReportDate(row.end_date)}`;

        document.text(
          TAKEN_COLUMN.dates,
          baseline,
          truncateToWidth(row.is_clipped ? `${range} *` : range, TAKEN_DATES_WIDTH, BODY_SIZE),
          { size: BODY_SIZE },
        );

        document.text(TAKEN_COLUMN.daysRight, baseline, formatDayCount(row.days), {
          size: BODY_SIZE,
          align: "right",
        });
      } else {
        document.line(TAKEN_COLUMN.type, y + 1, A4_WIDTH - MARGIN, y + 1, {
          gray: 0.8,
          width: 0.4,
        });
        document.text(TAKEN_COLUMN.type, baseline, "Total", { size: BODY_SIZE, font: "bold" });
        document.text(TAKEN_COLUMN.daysRight, baseline, formatDayCount(line.person.totalDays), {
          size: BODY_SIZE,
          font: "bold",
          align: "right",
        });
      }

      y += ROW_HEIGHT;
    });

    // The grand total, on the last page only. Mode A has no equivalent because
    // summing allocations across people answers no question anybody asks; a
    // total number of leave days taken in a period is the first thing this
    // report gets read for.
    if (index === pages.length - 1) {
      document.text(
        A4_WIDTH - MARGIN,
        A4_HEIGHT - MARGIN - 6,
        `Total days taken: ${formatDayCount(grandTotal)}`,
        { size: 9, font: "bold", align: "right" },
      );
    }

    document.text(
      A4_WIDTH - MARGIN,
      A4_HEIGHT - MARGIN + 8,
      `Page ${index + 1} of ${pages.length}`,
      { size: 7.5, align: "right", gray: 0.45 },
    );
    document.text(MARGIN, A4_HEIGHT - MARGIN + 8, "VizServe PMS — leave taken", {
      size: 7.5,
      gray: 0.45,
    });
  });

  return document.build();
}

/** `vizserve-leave-taken-2026-03-01-to-2026-03-31.pdf`. */
export function leaveTakenFilename(from: string, to: string): string {
  return `vizserve-leave-taken-${from}-to-${to}.pdf`;
}

/**
 * The "nothing to report" case, for both modes.
 *
 * An empty result is a real answer to a filtered question — "nobody in
 * VizMedia took sick leave in March" — and it must still produce a document,
 * because the person asked for one and a silent no-op reads as a broken button.
 * The action refuses to render only when the caller can see nothing at all,
 * which is a different thing and gets a different message.
 */
export function emptyReportNote(mode: "annual" | "taken"): string {
  return mode === "annual"
    ? "No staff match these filters."
    : "No approved leave was taken in this period by anyone matching these filters.";
}
