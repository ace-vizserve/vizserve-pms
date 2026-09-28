"use server";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";

/**
 * P12 Phase B — send whatever the email outbox is holding, now.
 *
 * Writes that queue a notification email (a comment with a mention, being put
 * on a task) moved to the browser, but draining the outbox needs the server's
 * mail credentials. The browser fires this after such a write and does not wait
 * for it; without it the email would still go, on the next 15-minute cron sweep
 * rather than straight away.
 *
 * It takes no input and only sends what the database already queued, so any
 * signed-in caller may trigger it — the worst it can do is send due mail early.
 */
export async function drainEmailOutbox(): Promise<void> {
  await requireAuthContextOrThrow();
  dispatchPendingEmailsInBackground();
}
