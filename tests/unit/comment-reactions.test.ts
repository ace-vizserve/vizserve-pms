import { describe, expect, it } from "vitest";

import { applyReactionToggle, summariseReactions, type CommentReactionRow } from "@/lib/comment-reactions";
import { COMMENT_REACTIONS, commentReactionSchema } from "@/lib/schemas/tasks";

const ME = "00000000-0000-4000-8000-000000000001";
const ANA = "00000000-0000-4000-8000-000000000002";
const BEN = "00000000-0000-4000-8000-000000000003";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const TASK = "00000000-0000-4000-8000-0000000000a1";

const names: Record<string, string> = { [ANA]: "Ana Reyes", [BEN]: "Ben Cruz" };
const nameOf = (id: string) => names[id] ?? "Someone";

function row(comment: string, user: string, reaction: string, minute: number): CommentReactionRow {
  return {
    comment_id: comment,
    user_id: user,
    reaction,
    created_at: `2026-10-22T09:${String(minute).padStart(2, "0")}:00Z`,
  };
}

describe("summariseReactions", () => {
  it("counts per reaction and marks the viewer's own", () => {
    const out = summariseReactions(
      [row(C1, ANA, "like", 1), row(C1, ME, "like", 2), row(C1, BEN, "love", 3)],
      ME,
      nameOf,
    );

    expect(out[C1]).toEqual([
      { id: "like", count: 2, reacted: true, names: ["Ana Reyes", "You"] },
      { id: "love", count: 1, reacted: false, names: ["Ben Cruz"] },
    ]);
  });

  it("keeps comments apart", () => {
    const out = summariseReactions([row(C1, ANA, "like", 1), row(C2, ANA, "seen", 2)], ME, nameOf);
    expect(out[C1]?.map((r) => r.id)).toEqual(["like"]);
    expect(out[C2]?.map((r) => r.id)).toEqual(["seen"]);
  });

  it("orders pills by first reaction, not picker order, whatever order the rows arrive in", () => {
    const out = summariseReactions([row(C1, BEN, "like", 5), row(C1, ANA, "done", 1)], ME, nameOf);
    expect(out[C1]?.map((r) => r.id)).toEqual(["done", "like"]);
  });

  it("drops a reaction the picker no longer offers", () => {
    const out = summariseReactions([row(C1, ANA, "thumbs-down", 1)], ME, nameOf);
    expect(out[C1]).toBeUndefined();
  });
});

describe("applyReactionToggle", () => {
  const base = [row(C1, ANA, "like", 1)];

  it("adds the viewer's reaction", () => {
    const next = applyReactionToggle(base, {
      commentId: C1,
      reaction: "like",
      reacted: true,
      viewerId: ME,
      at: "2026-10-22T10:00:00Z",
    });
    expect(summariseReactions(next, ME, nameOf)[C1]).toEqual([
      { id: "like", count: 2, reacted: true, names: ["Ana Reyes", "You"] },
    ]);
  });

  it("removes only the viewer's own row", () => {
    const withMine = [...base, row(C1, ME, "like", 2)];
    const next = applyReactionToggle(withMine, {
      commentId: C1,
      reaction: "like",
      reacted: false,
      viewerId: ME,
      at: "2026-10-22T10:00:00Z",
    });
    expect(next).toEqual(base);
  });

  it("never duplicates a reaction added twice", () => {
    const change = { commentId: C1, reaction: "love", reacted: true, viewerId: ME, at: "2026-10-22T10:00:00Z" };
    const next = applyReactionToggle(applyReactionToggle(base, change), change);
    expect(next.filter((r) => r.user_id === ME)).toHaveLength(1);
  });
});

describe("commentReactionSchema", () => {
  it("accepts every listed reaction and nothing else", () => {
    for (const reaction of COMMENT_REACTIONS) {
      expect(
        commentReactionSchema.safeParse({ comment_id: C1, task_id: TASK, reaction, reacted: true }).success,
      ).toBe(true);
    }
    expect(
      commentReactionSchema.safeParse({ comment_id: C1, task_id: TASK, reaction: "👍", reacted: true }).success,
    ).toBe(false);
  });

  it("matches the database's check constraint", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261022090000_p17_03_comment_reactions.sql", "utf8");
    const listed = /check \(reaction in \(([^)]*)\)\)/.exec(sql)?.[1];
    expect(listed?.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...COMMENT_REACTIONS]);
  });
});
