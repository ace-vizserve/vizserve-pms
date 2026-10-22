/**
 * P17-03 — REACTIONS ON A TASK COMMENT: rows in, pills out.
 *
 * The table holds one row per (comment, person, reaction). The bar wants, per
 * comment, one entry per reaction with a count, whether the viewer is among
 * them, and who they were. This is that fold, kept pure so it is tested
 * without a database (`tests/unit/comment-reactions.test.ts`).
 *
 * ⚠️ ORDER IS FIRST-REACTED, NOT PICKER ORDER. A pill that jumped position
 * because somebody else added a reaction earlier in the list would move under
 * the cursor of whoever was about to press it.
 */

import { COMMENT_REACTIONS, type CommentReaction } from "@/lib/schemas/tasks";

export type CommentReactionRow = {
  comment_id: string;
  user_id: string;
  reaction: string;
  created_at: string;
};

export type ReactionSummary = {
  id: CommentReaction;
  count: number;
  reacted: boolean;
  names: string[];
};

const KNOWN = new Set<string>(COMMENT_REACTIONS);

export function summariseReactions(
  rows: readonly CommentReactionRow[],
  viewerId: string,
  nameOf: (userId: string) => string,
): Record<string, ReactionSummary[]> {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byComment: Record<string, ReactionSummary[]> = {};

  for (const row of sorted) {
    // A reaction retired from the list may still have rows; drawing it would
    // be a pill the picker cannot offer and the viewer cannot add to.
    if (!KNOWN.has(row.reaction)) continue;

    const list = (byComment[row.comment_id] ??= []);
    let entry = list.find((item) => item.id === row.reaction);
    if (!entry) {
      entry = { id: row.reaction as CommentReaction, count: 0, reacted: false, names: [] };
      list.push(entry);
    }
    entry.count += 1;
    if (row.user_id === viewerId) entry.reacted = true;
    entry.names.push(row.user_id === viewerId ? "You" : nameOf(row.user_id));
  }

  return byComment;
}

/**
 * The cache after the viewer toggles one reaction, before the server answers.
 * Removing the last one drops the row entirely, which drops the pill.
 */
export function applyReactionToggle(
  rows: readonly CommentReactionRow[],
  change: { commentId: string; reaction: string; reacted: boolean; viewerId: string; at: string },
): CommentReactionRow[] {
  const without = rows.filter(
    (row) =>
      !(row.comment_id === change.commentId && row.user_id === change.viewerId && row.reaction === change.reaction),
  );
  if (!change.reacted) return without;
  return [
    ...without,
    { comment_id: change.commentId, user_id: change.viewerId, reaction: change.reaction, created_at: change.at },
  ];
}
