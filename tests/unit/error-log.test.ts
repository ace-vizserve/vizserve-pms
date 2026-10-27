import { describe, expect, it } from "vitest";

import {
  currentEnvironment,
  dailyCounts,
  describeThrown,
  hourlyCounts,
  isExpectedError,
  LIMITS,
  shouldRecord,
  stripQuery,
  toErrorRow,
  topErrors,
} from "@/lib/error-log";
import { visibleNavItems } from "@/lib/navigation";
import { ROLE_ORDER } from "@/lib/auth/roles";

/**
 * P17-05 — the error log's rules. What is recorded, what is skipped, and how a
 * report is fitted to the table's constraints before it reaches them.
 */

describe("which deployment", () => {
  it("reads Vercel's own variable, and calls anything else local", () => {
    expect(currentEnvironment({ VERCEL_ENV: "production" })).toBe("production");
    expect(currentEnvironment({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(currentEnvironment({})).toBe("development");
  });

  it("records local dev only when asked to", () => {
    expect(shouldRecord({})).toBe(false);
    expect(shouldRecord({ ERROR_LOG_DEV: "1" })).toBe(true);
    expect(shouldRecord({ VERCEL_ENV: "production" })).toBe(true);
    expect(shouldRecord({ VERCEL_ENV: "preview" })).toBe(true);
  });
});

describe("isExpectedError", () => {
  it("skips control flow and deliberate refusals", () => {
    expect(isExpectedError(Object.assign(new Error("x"), { digest: "NEXT_REDIRECT;replace;/login;307;" }))).toBe(true);
    expect(isExpectedError(Object.assign(new Error("x"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }))).toBe(true);
    const forbidden = new Error("This area is for the Admin (IT) role.");
    forbidden.name = "ForbiddenError";
    expect(isExpectedError(forbidden)).toBe(true);
  });

  it("keeps real failures", () => {
    expect(isExpectedError(new Error("permission denied for table vizserve_pms_tasks"))).toBe(false);
    expect(isExpectedError(Object.assign(new Error("boom"), { digest: "2817364512" }))).toBe(false);
    expect(isExpectedError("a string")).toBe(false);
    expect(isExpectedError(null)).toBe(false);
  });
});

describe("toErrorRow", () => {
  it("drops the query, which can carry a token", () => {
    expect(stripQuery("/approve/abc?token=secret#x")).toBe("/approve/abc");
    expect(toErrorRow({ source: "server", kind: "render", environment: "production", message: "x", path: "/a?b=c" }).path).toBe(
      "/a",
    );
  });

  it("cuts what is too long instead of letting the table refuse it", () => {
    const row = toErrorRow({
      source: "client",
      kind: "client",
      environment: "preview",
      message: "m".repeat(LIMITS.message + 50),
      stack: "s".repeat(LIMITS.stack + 50),
    });
    expect(row.message.length).toBe(LIMITS.message);
    expect(row.stack?.length).toBe(LIMITS.stack);
  });

  it("never sends an empty message, which the table refuses", () => {
    expect(toErrorRow({ source: "server", kind: "route", environment: "production", message: "   " }).message).toBe(
      "Unknown error",
    );
  });
});

describe("describeThrown", () => {
  it("reads an Error, its digest, and anything else thrown", () => {
    const error = Object.assign(new Error("boom"), { digest: "123" });
    expect(describeThrown(error)).toMatchObject({ message: "boom", digest: "123" });
    expect(describeThrown("plain").message).toBe("plain");
    expect(describeThrown({ code: 1 }).message).toBe('{"code":1}');
  });
});

describe("the chart's buckets", () => {
  it("counts per Manila day and keeps the empty days", () => {
    // 23:30 UTC on the 25th is 07:30 on the 26th in Manila.
    const counts = dailyCounts(["2026-10-25T23:30:00Z", "2026-10-27T01:00:00Z", "2026-10-27T02:00:00Z"], 3, "2026-10-27");
    expect(counts).toEqual([
      { day: "2026-10-25", count: 0 },
      { day: "2026-10-26", count: 1 },
      { day: "2026-10-27", count: 2 },
    ]);
  });

  it("counts the last 24 hours per hour, oldest first", () => {
    const now = Date.parse("2026-10-27T10:30:00Z");
    const buckets = hourlyCounts(["2026-10-27T10:10:00Z", "2026-10-27T09:59:00Z", "2026-10-25T00:00:00Z"], now);
    expect(buckets).toHaveLength(24);
    expect(buckets[23].count).toBe(1);
    expect(buckets[22].count).toBe(1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
  });
});

describe("topErrors", () => {
  it("counts one bug once, whichever record it happened on", () => {
    const groups = topErrors([
      { message: "Could not load\nat x", route: "/tasks/[id]", path: "/tasks/1", occurred_at: "2026-10-27T01:00:00Z" },
      { message: "Could not load\nat y", route: "/tasks/[id]", path: "/tasks/2", occurred_at: "2026-10-27T02:00:00Z" },
      { message: "Other", route: "/dtr", path: "/dtr", occurred_at: "2026-10-27T03:00:00Z" },
    ]);
    expect(groups[0]).toMatchObject({ message: "Could not load", where: "/tasks/[id]", count: 2 });
    expect(groups[1]).toMatchObject({ message: "Other", count: 1 });
  });
});

describe("the sidebar row", () => {
  it("is for the Admin (IT) role and nobody else, Business Manager and CEO included", () => {
    for (const role of ROLE_ORDER) {
      const shown = visibleNavItems(role, { isHr: true }).some((item) => item.href === "/admin/errors");
      expect(shown, role).toBe(role === "admin");
    }
  });
});
