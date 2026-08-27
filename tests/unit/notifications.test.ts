import { describe, expect, it } from "vitest";

import {
  isNotificationType,
  isReadFilter,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
} from "@/lib/notifications";
import { formatNavBadge } from "@/lib/navigation";

/**
 * The type guard is the interesting one. `?type=` goes straight into
 * `.eq("type", …)`, and Postgres answers an unknown enum value with
 * "invalid input value for enum" — a 500-shaped failure from a hand-edited URL,
 * where the right behaviour is an ignored filter.
 */

describe("isNotificationType", () => {
  it.each(NOTIFICATION_TYPES)("accepts the real type %s", (type) => {
    expect(isNotificationType(type)).toBe(true);
  });

  it.each([
    "invalid",
    "PENDING_APPROVAL",
    "pending_approval; drop table",
    "",
    null,
    undefined,
    42,
    {},
  ])("rejects %s", (value) => {
    expect(isNotificationType(value)).toBe(false);
  });
});

describe("isReadFilter", () => {
  it.each(["all", "unread", "read"])("accepts %s", (value) => {
    expect(isReadFilter(value)).toBe(true);
  });

  it.each(["unRead", "true", "", null, undefined, 1])("rejects %s", (value) => {
    expect(isReadFilter(value)).toBe(false);
  });
});

describe("NOTIFICATION_TYPE_LABELS", () => {
  it("labels every type, so the filter can never show a raw enum value", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPE_LABELS[type]).toBeTruthy();
      expect(NOTIFICATION_TYPE_LABELS[type]).not.toContain("_");
    }
  });
});

// P7-50 renamed this to `formatNavBadge` and moved it to lib/navigation.ts —
// it was never about notifications, and Requests now uses the same rule.
describe("formatNavBadge", () => {
  it("returns null at zero, so no empty badge renders", () => {
    expect(formatNavBadge(0)).toBeNull();
    expect(formatNavBadge(-1)).toBeNull();
  });

  it("shows the exact count up to 99", () => {
    expect(formatNavBadge(1)).toBe("1");
    expect(formatNavBadge(99)).toBe("99");
  });

  it("caps beyond 99", () => {
    // Not hypothetical — a real inbox here is already past 1,600, and four
    // digits push the label off its own row.
    expect(formatNavBadge(100)).toBe("99+");
    expect(formatNavBadge(1609)).toBe("99+");
  });
});
