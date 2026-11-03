import { describe, expect, it } from "vitest";

import { isFormClosed } from "@/lib/form-builder/deadline";
import { formSettingsSchema } from "@/lib/schemas/forms";
import { sidebarSnapshotSchema } from "@/lib/schemas/sidebar";

describe("isFormClosed", () => {
  it("stays open through the whole of its last day", () => {
    expect(isFormClosed("2026-11-05", "2026-11-05")).toBe(false);
    expect(isFormClosed("2026-11-05", "2026-11-06")).toBe(true);
  });

  it("never closes a form with no deadline", () => {
    expect(isFormClosed(null, "2026-11-06")).toBe(false);
    expect(isFormClosed(undefined, "2026-11-06")).toBe(false);
  });
});

describe("the snapshot before the migration is pasted", () => {
  it("still parses, with nothing to answer", () => {
    const parsed = sidebarSnapshotSchema.parse({ unread: 0, awaiting_review: 0, spaces: [], personal: [] });

    expect(parsed.forms_to_answer).toEqual([]);
  });
});

describe("closes_on on the settings schema", () => {
  const shape = formSettingsSchema.shape.closes_on;

  it("treats absent as leave it alone, and null as no deadline", () => {
    expect(shape.parse(undefined)).toBeUndefined();
    expect(shape.parse(null)).toBeNull();
  });

  it("refuses anything but a bare date", () => {
    expect(shape.parse("2026-11-05")).toBe("2026-11-05");
    expect(shape.safeParse("5 Nov 2026").success).toBe(false);
  });
});
