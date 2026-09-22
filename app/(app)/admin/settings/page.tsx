import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { requireRole } from "@/lib/auth/authorization";
import { NOTIFICATION_TYPES } from "@/lib/notifications";
import { loadAppSettings, loadNotificationEmailSettings } from "@/lib/settings-server";

import { NotificationEmailForm } from "./notification-email-form";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

/**
 * P7-37 — the company-wide settings an admin can change without a deploy.
 *
 * Two settings since P8-05: the grace period, which decides what the DTR SAYS
 * about a punch, and the unpaid break, which decides what a scheduled day is
 * WORTH and so what a timesheet week has to reach before it can be handed in.
 * The second is the first thing on this screen that refuses something rather
 * than advising about it, and the field says so.
 *
 * The screen exists as its own route rather than as a card on
 * `/admin/users` because the next one will not be about users either, and a
 * settings field hidden inside the staff editor is a settings field nobody
 * finds.
 *
 * Read through `loadAppSettings`, the same `cache()`d reader every other screen
 * uses, rather than a query written here — so the number this form shows is by
 * construction the number the DTR is judging punches against. A second query
 * with its own fallback is how a settings screen ends up disagreeing with the
 * feature it configures.
 */
export default async function SettingsPage() {
  await requireRole("owner");

  const [settings, notificationEmails] = await Promise.all([loadAppSettings(), loadNotificationEmailSettings()]);

  /*
   * P8-19 — ORDERED HERE, IN THE UI, RATHER THAN BY THE QUERY. The useful order
   * is the one `NOTIFICATION_TYPES` already declares — roughly the lifecycle,
   * gates first — and it is the same order the inbox filter lists. Postgres has
   * no opinion that matches it: ordering by the enum would give declaration
   * order, which is the order the types were BUILT in across five phases, and
   * alphabetical would put "assigned" above "client decision" for no reason.
   *
   * Anything the database has and the mirror does not goes on the end rather
   * than being dropped. The form renders it with its raw name and says why.
   */
  const orderedNotificationEmails = notificationEmails
    ? [...notificationEmails].sort((a, b) => {
        const left = (NOTIFICATION_TYPES as readonly string[]).indexOf(a.type);
        const right = (NOTIFICATION_TYPES as readonly string[]).indexOf(b.type);
        return (left === -1 ? Number.MAX_SAFE_INTEGER : left) - (right === -1 ? Number.MAX_SAFE_INTEGER : right);
      })
    : null;

  return (
    <PageShell className="lg:flex-row flex-wrap">
      {/* No <h1> — the breadcrumb says "Admin / Settings". */}
      <p className="text-xs text-muted-foreground">
        Company-wide rules. These take effect immediately, for everybody. The timekeeping ones are read on every punch
        rather than copied onto records — so changing one changes how existing days are described, not what was
        recorded.
      </p>

      <SettingsForm graceMinutes={settings.graceMinutes} breakMinutes={settings.breakMinutes} />

      {/* ⚠️ NOT AN EMPTY STATE — a failed read. `loadNotificationEmailSettings`
          returns null rather than falling back precisely so this branch exists:
          eight switches drawn in the OFF position from a default would let an
          owner "save" company-wide email off for every gate in the app. */}
      <div className="w-full">
        {orderedNotificationEmails ? (
          <NotificationEmailForm rows={orderedNotificationEmails} />
        ) : (
          <p className="max-w-2xl rounded-lg border bg-card grade-surface p-4 text-xs text-muted-foreground shadow-raised-lg">
            Could not read the email notification settings. The switches are hidden rather than shown at a guess,
            because saving a guess would turn email off for everything. Reload, and if it persists the notification
            types are missing from this database.
          </p>
        )}
      </div>
    </PageShell>
  );
}
