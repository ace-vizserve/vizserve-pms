import { describe, expect, it } from "vitest";

import {
  formSettingsSchema,
  nextCandidate,
  prefixFromName,
  slugFromName,
} from "@/lib/schemas/forms";

/**
 * P7-29 — the two identifiers a form has besides its name.
 *
 * The property that matters most is the last describe block: whatever these
 * derive must PASS the schema that will validate it a moment later. A
 * derivation that produces a value the form then refuses is worse than no
 * derivation, because it fails on a field the person deliberately left blank.
 */

/** The regexes live in `formSettingsSchema`; parse through it rather than copying them. */
function accepts(field: "slug" | "reference_prefix", value: string): boolean {
  const parsed = formSettingsSchema.safeParse({
    name: "A form",
    slug: field === "slug" ? value : "a-form",
    reference_prefix: field === "reference_prefix" ? value : "AAA",
    department_id: null,
    sla_days: 5,
  });
  return parsed.success;
}

describe("slugFromName", () => {
  it("lower-cases and hyphenates", () => {
    expect(slugFromName("Collateral Request")).toBe("collateral-request");
    expect(slugFromName("Test Client Request")).toBe("test-client-request");
  });

  it("collapses punctuation rather than carrying it into a URL", () => {
    expect(slugFromName("Design & Brand  —  Intake!")).toBe("design-brand-intake");
    expect(slugFromName("  Leading and trailing  ")).toBe("leading-and-trailing");
  });

  it("keeps digits, which are legal in a slug", () => {
    expect(slugFromName("2026 Planning")).toBe("2026-planning");
  });

  it("never ends on a separator, however it was truncated", () => {
    // The 60-character cut can land mid-word and leave a hyphen behind, which
    // the schema's regex refuses.
    const long = slugFromName(`${"a".repeat(58)} tail`);
    expect(long.endsWith("-")).toBe(false);
    expect(accepts("slug", long)).toBe(true);
  });

  it("still produces a usable form when the name has no URL characters at all", () => {
    // A validation error on a field somebody deliberately left blank is the app
    // refusing to do the work it offered to do.
    expect(slugFromName("字体設計")).toBe("form");
    expect(slugFromName("!!!")).toBe("form");
  });
});

describe("prefixFromName", () => {
  it("abbreviates the first word where it is long enough to stand alone", () => {
    // "COL" reads as collateral; "CR" reads as nothing.
    expect(prefixFromName("Collateral Request")).toBe("COL");
    expect(prefixFromName("Design Request")).toBe("DES");
  });

  it("falls back to initials where the first word is too short", () => {
    expect(prefixFromName("IT Support")).toBe("IS");
    expect(prefixFromName("HR Leave Request")).toBe("HLR");
  });

  it("skips a word that starts on a digit rather than stripping it", () => {
    // `PREFIX-YYYY-NNNN` is parsed by segment, so a leading digit makes the
    // first one ambiguous — but stripping "2026" down to "" would throw away
    // the perfectly good word standing right behind it.
    expect(prefixFromName("2026 Planning")).toBe("PLA");
    expect(prefixFromName("3D Modelling")).toBe("MOD");
  });

  it("falls back rather than deriving something the schema would refuse", () => {
    expect(prefixFromName("")).toBe("REQ");
    expect(prefixFromName("字体")).toBe("REQ");
    // One usable letter is below the two-character floor.
    expect(prefixFromName("A")).toBe("REQ");
  });
});

describe("nextCandidate", () => {
  it("numbers a slug with a separator and a prefix without one", () => {
    expect(nextCandidate("collateral-request", 2)).toBe("collateral-request-2");
    expect(nextCandidate("COL", 2, "")).toBe("COL2");
  });

  it("eats into the stem rather than pushing a prefix past its ceiling", () => {
    // The prefix regex allows eight characters and no more, so the suffix
    // cannot simply be appended.
    const bumped = nextCandidate("ABCDEFGH", 9, "");
    expect(bumped).toBe("ABCDEFG9");
    expect(accepts("reference_prefix", bumped)).toBe(true);
  });
});

describe("every derived value passes the schema that validates it next", () => {
  const names = [
    "Collateral Request",
    "Test Client Request",
    "IT Support",
    "3D Modelling",
    "Design & Brand — Intake!",
    "2026 Planning",
    "字体設計",
    "A",
    "",
    " ",
    "x".repeat(200),
  ];

  it.each(names)("%j", (name) => {
    expect(accepts("slug", slugFromName(name))).toBe(true);
    expect(accepts("reference_prefix", prefixFromName(name))).toBe(true);
  });

  it("holds through de-duplication too", () => {
    for (const name of names) {
      for (let attempt = 2; attempt <= 12; attempt += 1) {
        expect(accepts("slug", nextCandidate(slugFromName(name), attempt))).toBe(true);
        expect(accepts("reference_prefix", nextCandidate(prefixFromName(name), attempt, ""))).toBe(
          true,
        );
      }
    }
  });
});
