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
