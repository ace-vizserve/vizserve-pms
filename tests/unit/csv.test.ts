import { describe, expect, it } from "vitest";

import { csvCell, slugForFilename, toCsv } from "@/lib/csv";

describe("P15-06 lib/csv", () => {
  it("quotes commas, quotes and newlines and joins with CRLF", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe("");
    expect(toCsv([["a", 1], ["b\nc", null]])).toBe('a,1\r\n"b\nc",');
  });

  it("slugs a filename", () => {
    expect(slugForFilename("People", "R&D / Design")).toBe("people-r-d-design");
    expect(slugForFilename("")).toBe("export");
  });
});
