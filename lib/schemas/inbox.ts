import { z } from "zod";

import { NOTIFICATION_TYPES } from "@/lib/notifications";

/**
 * P12-17 CONTRACT — what `/inbox` reads, once the reads are the browser's.
 *
 * The D3a handoff artefact for the inbox, and a sibling of
 * `lib/schemas/task-list.ts`. Read that file's header for the general argument;
 * the short version is that moving a read into the browser does NOT move the
 * generated `Database` types with it, so a column renamed or dropped from a
 * `.select()` string arrives as `undefined` with no type error anywhere.
 *
 * ⚠️ ON THIS SCREEN THE UNDEFINED THAT MATTERS IS `read_at`. Every unread signal
 * — the dot, the bold title, the `sr-only` "(unread)", the clickable title, the
 * "Mark all read" button and the count in the header strip — is derived from
 * that one nullable column. A shape fault that turned it into `undefined` would
 * render an entirely-read inbox as entirely unread, and the badge in the rail
 * would disagree with the page it links to.
 */

/**
 * The type enum, mirrored from the one place that already lists it.
 *
 * ⚠️ NOT A HAND-WRITTEN UNION. `lib/notifications.ts` holds `NOTIFICATION_TYPES`
 * because the labels, the filter dropdown and the URL guard all read it, and a
 * second copy here would be a second thing to update when a migration adds a
 * type — with the failure arriving as "notifications came back in a shape this
 * build does not recognise" on somebody's whole inbox.
 */
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/**
 * One row of the inbox.
 *
 * `body` is rich text and is FLATTENED at render (`richTextToPlainText`) rather
 * than sanitised and shown as markup — `vizserve_pms_notify` is called from SQL
 * with a transition comment or an internal request's reason as the body, and
 * both of those columns became rich text at P7-56. A `<ul>` laid out inside a
 * table row would blow the row height open.
 *
 * `link_path` is nullable and its absence is a real state, not a gap: a
 * notification with nowhere to send anybody is still something you look at, and
 * `MarkReadTitle` is the control that exists for exactly that row.
 */
export const notificationRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string().nullable(),
  link_path: z.string().nullable(),
  type: notificationTypeSchema,
  /** Null is UNREAD. Every unread signal on the page derives from this. */
  read_at: z.string().nullable(),
  /** Null is "never emailed", which is a policy decision (docs/12), not a failure. */
  emailed_at: z.string().nullable(),
  created_at: z.string(),
});

export type NotificationRow = z.infer<typeof notificationRowSchema>;
