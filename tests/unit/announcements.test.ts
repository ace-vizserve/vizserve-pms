import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROLE_ORDER, type Role } from "@/lib/auth/roles";
import { canEditAnnouncement, canPostAnnouncements, canTakeDownAnnouncement } from "@/lib/auth/rules";
import { createAnnouncementSchema, editAnnouncementSchema } from "@/lib/schemas/announcements";

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

describe("canEditAnnouncement", () => {
  it("lets a lead and above edit their own", () => {
    for (const role of ROLE_ORDER.filter((role) => role !== "member")) {
      expect(canEditAnnouncement(viewer(role), { created_by: ME })).toBe(true);
    }
  });

  it("lets the Manager edit anyone's", () => {
    expect(canEditAnnouncement(viewer("manager"), { created_by: SOMEONE_ELSE })).toBe(true);
  });

  it("does not let anybody else edit someone else's, the roles above the Manager included", () => {
    for (const role of ROLE_ORDER.filter((role) => role !== "manager")) {
      expect(canEditAnnouncement(viewer(role), { created_by: SOMEONE_ELSE })).toBe(false);
    }
  });

  it("never lets a member, even on a row they wrote while they were a lead", () => {
    expect(canEditAnnouncement(viewer("member"), { created_by: ME })).toBe(false);
  });
});

describe("editAnnouncementSchema", () => {
  const fields = { title: "Town hall", body: "Friday 3pm", expires_on: null };

  it("needs the id of the notice", () => {
    expect(editAnnouncementSchema.safeParse(fields).success).toBe(false);
    expect(editAnnouncementSchema.safeParse({ ...fields, id: ME }).success).toBe(true);
  });

  it("holds the text to the same rules as posting", () => {
    expect(editAnnouncementSchema.safeParse({ ...fields, id: ME, title: "  " }).success).toBe(false);
  });
});

// P17-09 — the policy and trigger are the enforcement. Pin their shape.
describe("the P17-09 migration", () => {
  const SQL = readFileSync(
    join(process.cwd(), "supabase/migrations/20261102100000_p17_09_announcement_edit.sql"),
    "utf8",
  );

  it("grants the three editable columns and not the markers", () => {
    expect(SQL).toMatch(/grant update \(title, body, expires_on\) on vizserve_pms_announcements to authenticated;/);
    expect(SQL).not.toMatch(/grant update[^;]*edited_/);
  });

  it("keeps the edit policy to the author or the Manager, on a live notice, on both sides", () => {
    const policy = SQL.slice(SQL.indexOf('create policy "announcements edited by author or manager"'));
    expect(policy.match(/created_by = auth\.uid\(\)/g)).toHaveLength(2);
    expect(policy.match(/archived_at is null/g)).toHaveLength(2);
    expect(policy.match(/vizserve_pms_current_role\(\)\) = 'manager'/g)).toHaveLength(2);
    expect(policy).not.toMatch(/has_role\('manager'\)/);
  });

  it("drops the narrower author-only policy if the first version was pasted", () => {
    expect(SQL).toMatch(/drop policy if exists "announcements edited by author" on/);
  });

  it("stamps who made the change from the session, not from the client", () => {
    expect(SQL).toMatch(/new\.edited_by := auth\.uid\(\);/);
  });

  it("refuses a text change on a row being archived", () => {
    expect(SQL).toMatch(/if new\.archived_at is not null then\s+raise exception/);
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
