import { z } from "zod";

/**
 * P17-04 CONTRACT — home-page announcements.
 *
 * The lengths mirror the CHECK constraints in
 * `20261023090000_p17_04_announcements.sql`; change both or neither.
 */

export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 2000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date.")
  .nullable();

export const createAnnouncementSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Give it a title.")
    .max(ANNOUNCEMENT_TITLE_MAX, `Keep the title under ${ANNOUNCEMENT_TITLE_MAX} characters.`),
  body: z
    .string()
    .trim()
    .min(1, "Say what the announcement is.")
    .max(ANNOUNCEMENT_BODY_MAX, `Keep it under ${ANNOUNCEMENT_BODY_MAX} characters.`),
  /** Last day it shows, inclusive. Null keeps it up until somebody takes it down. */
  expires_on: isoDate,
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const archiveAnnouncementSchema = z.object({ id: z.uuid() });

export type Announcement = {
  id: string;
  title: string;
  body: string;
  expires_on: string | null;
  created_by: string;
  author_name: string;
  created_at: string;
};

/**
 * P17-06 — the reactions an announcement can carry, in picker order.
 *
 * ⚠️ MIRRORS THE CHECK CONSTRAINT on `vizserve_pms_announcement_reactions`
 * (`20261030090000_p17_06_announcement_reactions.sql`), which is the same six
 * as a task comment. Change both or neither.
 */
export const ANNOUNCEMENT_REACTIONS = ["like", "love", "celebrate", "laugh", "seen", "done"] as const;
export type AnnouncementReaction = (typeof ANNOUNCEMENT_REACTIONS)[number];

export const announcementReactionSchema = z.object({
  announcement_id: z.uuid(),
  reaction: z.enum(ANNOUNCEMENT_REACTIONS),
  reacted: z.boolean(),
});

/** One person's one reaction. `user_name` is stamped by the database. */
export type AnnouncementReactionRow = {
  announcement_id: string;
  user_id: string;
  user_name: string;
  reaction: string;
  created_at: string;
};
