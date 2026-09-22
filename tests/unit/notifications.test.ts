import { describe, expect, it } from "vitest";

import {
  isNotificationType,
  isReadFilter,
  NOTIFICATION_EMAIL_SENDER,
  NOTIFICATION_TYPE_HINTS,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
} from "@/lib/notifications";
import { notificationEmailSettingsSchema } from "@/lib/schemas/settings";
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

/**
 * P8-19 — the settings screen reads three maps keyed by notification type, and
 * a gap in any of them is a row that renders with `undefined` where its name,
 * its explanation or its mailbox should be. TypeScript catches a missing key
 * only while the generated union is complete, and that union has been four days
 * stale before now (`mentioned`, P8-18) — which is the failure these cover.
 */
describe("the notification type maps", () => {
  it.each(NOTIFICATION_TYPES)("labels, explains and routes %s", (type) => {
    expect(NOTIFICATION_TYPE_LABELS[type]).toBeTruthy();
    expect(NOTIFICATION_TYPE_HINTS[type]).toBeTruthy();
    expect(NOTIFICATION_EMAIL_SENDER[type]).toBeTruthy();
  });

  it("has no key the enum mirror does not", () => {
    for (const map of [
      NOTIFICATION_TYPE_LABELS,
      NOTIFICATION_TYPE_HINTS,
      NOTIFICATION_EMAIL_SENDER,
    ]) {
      expect(Object.keys(map).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    }
  });

  /**
   * The rule from P8-15, asserted rather than left in a comment: anything
   * sitting on one of the three gates comes from `approvals@`, so muting the
   * comment traffic cannot mute the queue somebody is the bottleneck on.
   */
  it.each(["pending_approval", "qa_requested", "client_decision", "internal_decision"] as const)(
    "sends %s from approvals@",
    (type) => {
      expect(NOTIFICATION_EMAIL_SENDER[type]).toBe("approvals");
    },
  );

  it.each(["assigned", "status_changed", "mentioned", "commented"] as const)(
    "sends %s from notifications@",
    (type) => {
      expect(NOTIFICATION_EMAIL_SENDER[type]).toBe("notifications");
    },
  );
});

/**
 * P8-19 — the settings form posts the whole set back every time. The schema is
 * deliberately loose about WHICH types (the action checks those against the
 * table, which cannot drift) and strict about the shape.
 */
describe("notificationEmailSettingsSchema", () => {
  it("accepts the full set", () => {
    const input = { types: NOTIFICATION_TYPES.map((type) => ({ type, send_email: false })) };
    expect(notificationEmailSettingsSchema.safeParse(input).success).toBe(true);
  });

  it("accepts a type it has never heard of, for the action to filter", () => {
    const input = { types: [{ type: "invented_later", send_email: true }] };
    expect(notificationEmailSettingsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { types: [] },
    { types: [{ type: "assigned" }] },
    { types: [{ type: "assigned", send_email: "yes" }] },
    { types: [{ type: "", send_email: true }] },
    { types: "assigned" },
    {},
  ])("rejects %j", (input) => {
    expect(notificationEmailSettingsSchema.safeParse(input).success).toBe(false);
  });
});
