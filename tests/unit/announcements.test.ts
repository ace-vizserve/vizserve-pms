import { describe, expect, it } from "vitest";

import { ROLE_ORDER, type Role } from "@/lib/auth/roles";
import { canPostAnnouncements, canTakeDownAnnouncement } from "@/lib/auth/rules";
import { createAnnouncementSchema } from "@/lib/schemas/announcements";

/**
 * P17-04 — who posts and who takes down a home-page announcement.
 *
 * Mirrors the policies in `20261023090000_p17_04_announcements.sql`. These
 * decide whether the buttons render; RLS decides whether the write lands.
 */

const ME = "00000000-0000-4000-8000-000000000001";
const SOMEONE_ELSE = "00000000-0000-4000-8000-000000000002";

const viewer = (role: Role) => ({ role, userId: ME });

describe("canPostAnnouncements", () => {
  it("is Team Leader and above, by the ladder", () => {
    for (const role of ROLE_ORDER) {
      expect(canPostAnnouncements({ role })).toBe(role !== "member");
    }
  });
});

describe("canTakeDownAnnouncement", () => {
  it("lets a lead take down their own, not someone else's", () => {
    expect(canTakeDownAnnouncement(viewer("team_leader"), { created_by: ME })).toBe(true);
    expect(canTakeDownAnnouncement(viewer("team_leader"), { created_by: SOMEONE_ELSE })).toBe(false);
  });

  it("lets a Manager and above take down anyone's", () => {
    for (const role of ["manager", "admin", "business_manager", "owner"] as const) {
      expect(canTakeDownAnnouncement(viewer(role), { created_by: SOMEONE_ELSE })).toBe(true);
    }
  });

  it("never lets a member, even on a row they wrote while they were a lead", () => {
    expect(canTakeDownAnnouncement(viewer("member"), { created_by: ME })).toBe(false);
  });
});

describe("createAnnouncementSchema", () => {
  it("trims and requires a title and body", () => {
    const parsed = createAnnouncementSchema.safeParse({ title: "  ", body: "x", expires_on: null });
    expect(parsed.success).toBe(false);
  });

  it("accepts an optional last day", () => {
    const parsed = createAnnouncementSchema.safeParse({
      title: "Town hall",
      body: "Friday 3pm",
      expires_on: "2026-10-30",
    });
    expect(parsed.success).toBe(true);
  });
});
