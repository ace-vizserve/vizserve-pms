import { describe, expect, it } from "vitest";

import { PdfDocument, measureText, truncateToWidth } from "@/lib/pdf";
import {
  groupLeaveReport,
  leaveReportFilename,
  planLeaveReport,
  renderLeaveReport,
  type LeaveReportRow,
} from "@/lib/reports/leave-report";

/**
 * P7-34 — the leave audit PDF.
 *
 * This project writes its own PDF rather than adding a library (see the header
 * of `lib/pdf.ts`), and the price of that decision is paid here. A malformed
 * PDF does not throw and does not warn: it opens BLANK, or the reader refuses
 * it with a message about a damaged file, and neither tells anybody which byte
 * was wrong. So the structural tests below actually walk the cross-reference
 * table and check that every offset lands on the object it claims to — which is
 * precisely what a reader does, and the only failure mode worth automating.
 *
 * The layout tests are separate and cheap, because `planLeaveReport` returns
 * data rather than drawing: pagination can be checked without parsing anything.
 */

const TYPE_VACATION = "11111111-1111-4111-8111-111111111111";
const TYPE_SICK = "22222222-2222-4222-8222-222222222222";
const TYPE_SOLO = "33333333-3333-4333-8333-333333333333";

function row(overrides: Partial<LeaveReportRow> = {}): LeaveReportRow {
  return {
    user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    full_name: "Amier Ordonez",
    email: "amier.ordonez@vizserve.hfse.edu.sg",
    is_active: true,
    department_name: "VizBytes",
    leave_type_id: TYPE_VACATION,
    code: "VACATION",
    label: "Vacation Leave",
    sort_order: 10,
    days_allocated: 10,
    days_used: 3,
    days_remaining: 7,
    ...overrides,
  };
}

const META = {
  year: 2026,
  generatedOn: "2026-12-15",
  generatedBy: "Test Admin",
  scope: "All departments",
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe("groupLeaveReport", () => {
  it("collapses rows into one entry per person, summing the totals", () => {
    const people = groupLeaveReport([
      row(),
      row({ leave_type_id: TYPE_SICK, label: "Sick Leave", days_allocated: 5, days_used: 1.5, days_remaining: 3.5 }),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].types.map((type) => type.label)).toEqual(["Vacation Leave", "Sick Leave"]);
    expect(people[0].totals).toEqual({ allocated: 15, used: 4.5, remaining: 10.5 });
  });

  it("drops a type with no allocation and no usage", () => {
    // The SQL returns all eight types for everybody on purpose — it cannot know
    // what is being printed. Eight lines of zeroes per person would turn a
    // three-page audit into fifteen.
    const people = groupLeaveReport([
      row(),
      row({ leave_type_id: TYPE_SOLO, label: "Solo Parent Leave", days_allocated: 0, days_used: 0, days_remaining: 0 }),
    ]);

    expect(people[0].types.map((type) => type.label)).toEqual(["Vacation Leave"]);
  });

  it("keeps a type that was used without ever being allocated", () => {
    // The overdraw case, and the one that must never be filtered out: leave was
    // taken against an allowance nobody set, so the unused figure is negative
    // and that is the whole finding.
    const people = groupLeaveReport([
      row({ days_allocated: 0, days_used: 2, days_remaining: -2 }),
    ]);

    expect(people[0].types).toHaveLength(1);
    expect(people[0].totals.remaining).toBe(-2);
  });

  it("keeps a person who has nothing at all, with no type rows", () => {
    // Every person appears. An absence from an audit table cannot be told apart
    // from somebody being missed.
    const people = groupLeaveReport([
      row({ days_allocated: 0, days_used: 0, days_remaining: 0 }),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].types).toEqual([]);
    expect(people[0].totals).toEqual({ allocated: 0, used: 0, remaining: 0 });
  });

  it("preserves the leaver flag", () => {
    const people = groupLeaveReport([row({ is_active: false })]);
    expect(people[0].is_active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("planLeaveReport", () => {
  function person(index: number, typeCount: number) {
    const types = Array.from({ length: typeCount }, (_, typeIndex) => ({
      label: `Type ${typeIndex}`,
      allocated: 5,
      used: 1,
      remaining: 4,
    }));

    return {
      user_id: `user-${index}`,
      full_name: `Person ${index}`,
      email: `person${index}@example.com`,
      is_active: true,
      department_name: "VizBytes",
      types,
      totals: { allocated: types.length * 5, used: types.length, remaining: types.length * 4 },
    };
  }

  it("emits a person line, a line per type and a total", () => {
    const [page] = planLeaveReport([person(1, 3)]);
    expect(page.lines.map((line) => line.kind)).toEqual(["person", "type", "type", "type", "total"]);
  });

  it("omits the total when there is only one type", () => {
    // A total identical to the single line above it is a second figure an
    // auditor has to check for no reason.
    const [page] = planLeaveReport([person(1, 1)]);
    expect(page.lines.map((line) => line.kind)).toEqual(["person", "type"]);
  });

  it("emits an explicit empty line for somebody with no leave", () => {
    const [page] = planLeaveReport([person(1, 0)]);
    expect(page.lines.map((line) => line.kind)).toEqual(["person", "empty"]);
  });

  it("never splits a person across a page break", () => {
    // 40 people at 5 lines each is well past one page. Every page must start on
    // a person line, because a name on one sheet and a total on the next is how
    // a bonus gets calculated against the wrong employee.
    const pages = planLeaveReport(Array.from({ length: 40 }, (_, index) => person(index, 3)));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.lines[0]?.kind).toBe("person");
    }
  });

  it("loses nobody across the break", () => {
    const people = Array.from({ length: 40 }, (_, index) => person(index, 3));
    const pages = planLeaveReport(people);

    const names = pages
      .flatMap((page) => page.lines)
      .filter((line) => line.kind === "person")
      .map((line) => (line.kind === "person" ? line.person.full_name : ""));

    expect(names).toEqual(people.map((entry) => entry.full_name));
  });

  it("returns one page for nobody at all", () => {
    // The action refuses to build an empty report, but the layout must not
    // produce zero pages either — `PdfDocument.build` throws on those.
    expect(planLeaveReport([])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

describe("measureText", () => {
  it("measures digits at 556/1000, identically in both fonts", () => {
    // This is what makes a right-aligned column of figures land on one edge
    // whether or not the total row is bold. If it ever stops being true, the
    // totals drift out of line and nothing else will say so.
    expect(measureText("12345", 10)).toBeCloseTo(27.8, 5);
    expect(measureText("12345", 10, "bold")).toBeCloseTo(27.8, 5);
  });

  it("makes bold wider than regular for letters", () => {
    expect(measureText("Employee", 9, "bold")).toBeGreaterThan(measureText("Employee", 9));
  });

  it("scales with size", () => {
    expect(measureText("Vacation Leave", 18)).toBeCloseTo(measureText("Vacation Leave", 9) * 2, 5);
  });

  it("measures an empty string as nothing", () => {
    expect(measureText("", 9)).toBe(0);
  });
});

describe("truncateToWidth", () => {
  it("leaves a string that fits alone", () => {
    expect(truncateToWidth("Sick Leave", 200, 9)).toBe("Sick Leave");
  });

  it("cuts and ellipsises one that does not, staying inside the width", () => {
    const cut = truncateToWidth("Special Leave for Women Under Republic Act", 60, 9);

    expect(cut.endsWith("…")).toBe(true);
    expect(measureText(cut, 9)).toBeLessThanOrEqual(60);
  });

  it("returns nothing when there is no room even for the ellipsis", () => {
    expect(truncateToWidth("Vacation Leave", 1, 9)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The bytes
// ---------------------------------------------------------------------------

/** Latin-1 back to a string, so offsets in the test are byte offsets too. */
function asLatin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

describe("PdfDocument.build", () => {
  it("refuses a document with no pages", () => {
    expect(() => new PdfDocument().build()).toThrow(/at least one page/);
  });

  it("refuses to draw before a page exists", () => {
    expect(() => new PdfDocument().text(0, 0, "x")).toThrow(/addPage/);
  });

  it("writes a header, a trailer and a startxref", () => {
    const document = new PdfDocument();
    document.addPage();
    document.text(40, 40, "Hello");

    const text = asLatin1(document.build());

    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("/BaseFont /Helvetica-Bold");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("points every cross-reference entry at the object it claims", () => {
    // THE TEST THAT MATTERS. A reader seeks by these offsets rather than
    // scanning, so one wrong number opens a blank document with no diagnosis.
    const document = new PdfDocument();
    document.addPage();
    document.text(40, 40, "Page one");
    document.addPage();
    document.text(40, 40, "Page two");

    const text = asLatin1(document.build());

    const startxref = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(startxref).not.toBeNull();

    const xrefOffset = Number(startxref![1]);
    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

    const size = /\/Size (\d+)/.exec(text);
    expect(size).not.toBeNull();

    // Entry 0 is the free-list head; the rest are objects 1..n-1.
    const entries = [...text.slice(xrefOffset).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) =>
      Number(match[1]),
    );

    expect(entries).toHaveLength(Number(size![1]) - 1);

    entries.forEach((offset, index) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it("declares a stream length in bytes, not characters", () => {
    // The trap: a name with an accent is one character and two UTF-8 bytes. If
    // `/Length` ever counted characters, every object after the first accented
    // name would be at the wrong offset.
    const document = new PdfDocument();
    document.addPage();
    document.text(40, 40, "Nuñez");

    const text = asLatin1(document.build());
    const declared = /\/Length (\d+) >>\nstream\n/.exec(text);
    expect(declared).not.toBeNull();

    const start = text.indexOf("stream\n") + "stream\n".length;
    const end = text.indexOf("\nendstream");
    expect(end - start).toBe(Number(declared![1]));
  });

  it("escapes brackets and backslashes in text", () => {
    // "Test Manager (All)" is already in the seeded staff list. An unescaped
    // bracket ends the PDF string early and corrupts every later offset.
    const document = new PdfDocument();
    document.addPage();
    document.text(40, 40, "Test Manager (All) \\ done");

    const text = asLatin1(document.build());
    expect(text).toContain("(Test Manager \\(All\\) \\\\ done) Tj");
  });

  it("counts its pages in the page tree", () => {
    const document = new PdfDocument();
    document.addPage();
    document.addPage();
    document.addPage();

    const text = asLatin1(document.build());
    expect(text).toContain("/Count 3");
    expect([...text.matchAll(/\/Type \/Page[^s]/g)]).toHaveLength(3);
  });
});

describe("renderLeaveReport", () => {
  const rows = [
    row(),
    row({ leave_type_id: TYPE_SICK, label: "Sick Leave", days_allocated: 5, days_used: 6, days_remaining: -1 }),
    row({
      user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      full_name: "Joel Castro",
      email: "joel.castro@vizserve.hfse.edu.sg",
      department_name: "VizAssists",
      days_allocated: 0,
      days_used: 0,
      days_remaining: 0,
    }),
  ];

  it("produces a valid single-page PDF", () => {
    const text = asLatin1(renderLeaveReport(groupLeaveReport(rows), META));

    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("(Leave audit) Tj");
    expect(text).toContain("(Calendar year 2026) Tj");
  });

  it("names the year, the date, the author and the scope on the page", () => {
    // All four exist because this document gets compared against a manual
    // count. Without them, when the two disagree nobody can tell which is wrong.
    const text = asLatin1(renderLeaveReport(groupLeaveReport(rows), META));

    expect(text).toContain("(Generated 2026-12-15) Tj");
    expect(text).toContain("(by Test Admin) Tj");
    expect(text).toContain("(All departments) Tj");
  });

  it("prints the negative unused figure rather than clamping it", () => {
    // Sick Leave above is 5 allocated against 6 used. An audit that hid the
    // overdraw would be hiding the only line worth reading.
    const text = asLatin1(renderLeaveReport(groupLeaveReport(rows), META));
    expect(text).toContain("(-1) Tj");
  });

  it("says so for a person with nothing, rather than omitting them", () => {
    const text = asLatin1(renderLeaveReport(groupLeaveReport(rows), META));

    expect(text).toContain("(Joel Castro) Tj");
    expect(text).toContain("(No leave allocated or taken this year) Tj");
  });

  it("marks a leaver", () => {
    const text = asLatin1(
      renderLeaveReport(groupLeaveReport([row({ is_active: false })]), META),
    );
    expect(text).toContain("no longer active");
  });

  it("numbers every page", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      row({
        user_id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
        full_name: `Person ${index}`,
      }),
    );

    const text = asLatin1(renderLeaveReport(groupLeaveReport(many), META));
    expect(text).toContain("(Page 1 of ");
    expect(text).toContain("(Page 2 of ");
  });
});

describe("leaveReportFilename", () => {
  it("carries the year, so last year's file is never the one attached", () => {
    expect(leaveReportFilename(2026)).toBe("vizserve-leave-audit-2026.pdf");
  });
});
