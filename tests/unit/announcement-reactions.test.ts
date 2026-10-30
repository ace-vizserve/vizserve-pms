import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REACTION_OPTIONS } from "@/components/reaction-options";
import { ANNOUNCEMENT_REACTIONS, announcementReactionSchema } from "@/lib/schemas/announcements";
import { COMMENT_REACTIONS } from "@/lib/schemas/tasks";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20261030090000_p17_06_announcement_reactions.sql"),
  "utf8",
);

describe("P17-06 announcement reactions", () => {
  it("offers the same six reactions as a comment, in the same order", () => {
    expect([...ANNOUNCEMENT_REACTIONS]).toEqual([...COMMENT_REACTIONS]);
    expect(REACTION_OPTIONS.map((option) => option.id)).toEqual([...ANNOUNCEMENT_REACTIONS]);
  });

  it("mirrors the check constraint in the migration", () => {
    const check = /check \(reaction in \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? "";
    const ids = [...check.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(ids).toEqual([...ANNOUNCEMENT_REACTIONS]);
  });

  it("accepts a known reaction and refuses anything else", () => {
    const id = "6f1c2f8e-3b1a-4c7e-9f0a-1d2e3f4a5b6c";
    expect(announcementReactionSchema.safeParse({ announcement_id: id, reaction: "seen", reacted: true }).success).toBe(true);
    expect(announcementReactionSchema.safeParse({ announcement_id: id, reaction: "angry", reacted: true }).success).toBe(false);
    expect(announcementReactionSchema.safeParse({ announcement_id: "nope", reaction: "seen", reacted: true }).success).toBe(false);
  });

  it("never lets the client write the name — the trigger stamps it", () => {
    expect(MIGRATION).toMatch(/grant insert \(announcement_id, user_id, reaction\)/);
    expect(MIGRATION).not.toMatch(/grant insert on vizserve_pms_announcement_reactions/);
  });
});
