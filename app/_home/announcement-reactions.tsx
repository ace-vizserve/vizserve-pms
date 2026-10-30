"use client";

import { useState } from "react";

import { REACTION_OPTIONS } from "@/components/reaction-options";
import { Reactions } from "@/components/ui/reactions";
import { toast } from "@/components/ui/toast";
import { summariseReactions } from "@/lib/comment-reactions";
import type { AnnouncementReactionRow } from "@/lib/schemas/announcements";

import { setAnnouncementReaction } from "./announcement-actions";

/**
 * P17-06 — the reaction bar under an announcement, so a reader can say "seen"
 * without a reply and the poster can hover a pill to see who.
 *
 * Optimistic: the pill moves at once, the write follows, and a refusal puts the
 * rows back and says why. The names come from `user_name` on each row, stamped
 * by the database — a member cannot read the directory outside their own
 * department, and a company-wide notice is read by all of them.
 */
export function AnnouncementReactions({
  announcementId,
  title,
  viewerId,
  initial,
}: {
  announcementId: string;
  title: string;
  viewerId: string;
  initial: AnnouncementReactionRow[];
}) {
  const [rows, setRows] = useState(initial);

  const names = new Map(rows.map((row) => [row.user_id, row.user_name || "Someone"]));
  // The comment fold, keyed by announcement instead of comment.
  const value =
    summariseReactions(
      rows.map((row) => ({ ...row, comment_id: row.announcement_id })),
      viewerId,
      (userId) => names.get(userId) ?? "Someone",
    )[announcementId] ?? [];

  async function onChange(change: { id: string; reacted: boolean }) {
    const before = rows;
    setRows(
      change.reacted
        ? [
            ...rows,
            {
              announcement_id: announcementId,
              user_id: viewerId,
              user_name: "You",
              reaction: change.id,
              created_at: new Date().toISOString(),
            },
          ]
        : rows.filter((row) => !(row.user_id === viewerId && row.reaction === change.id)),
    );

    const result = await setAnnouncementReaction({
      announcement_id: announcementId,
      reaction: change.id,
      reacted: change.reacted,
    });
    if (!result.ok) {
      setRows(before);
      toast.error(result.error);
    }
  }

  return (
    <Reactions
      className="mt-2"
      size="lg"
      options={REACTION_OPTIONS}
      value={value}
      onValueChange={(_next, change) => void onChange(change)}
      label={`Reactions to "${title}"`}
    />
  );
}
