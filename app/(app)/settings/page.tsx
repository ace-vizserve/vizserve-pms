import type { Metadata } from "next";

import { requireAuthContext } from "@/lib/auth/authorization";
import { loadPunchState } from "@/lib/dtr-server";
import { loadUserPreferences, signSoundUrl } from "@/lib/preferences-server";
import { PageShell } from "@/components/page-shell";

import { PasswordForm } from "./password-form";
import { RemindersForm } from "./reminders-form";

export const metadata: Metadata = { title: "Settings" };

/**
 * P8-11 / P8-12 — the first screen in this product that belongs to the person
 * looking at it.
 *
 * ⚠️ NOT `/admin/settings`, WHICH IS A DIFFERENT SCREEN WITH THE SAME WORD ON
 * IT. That one is `requireRole("owner")` and changes company policy for
 * everybody; this one is `requireAuthContext()` with no role floor at all,
 * because everybody has a password and everybody has a shift. They are reached
 * from different places for the same reason — the company one from the Admin
 * group in the rail, this one from under your own name in the sidebar footer.
 *
 * Two things live here so far, and the pairing is not arbitrary: both are facts
 * about YOU that nobody else can usefully set. The password because an admin who
 * could type it could sign in as you; the reminders because only you know
 * whether a chime at 08:45 is a help or an intrusion.
 */
export default async function SettingsPage() {
  const context = await requireAuthContext();

  const [preferences, punch] = await Promise.all([
    loadUserPreferences(context.userId),
    // `cache()`d and already read by the app shell for this same request, so the
    // schedule shown below costs nothing extra. It is here at all because the
    // reminder controls are meaningless without work hours, and saying so is
    // better than rendering switches that can never fire.
    loadPunchState(context.userId),
  ]);

  const soundUrl = await signSoundUrl(preferences);

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Settings". */}
      <p className="text-xs text-muted-foreground">
        Yours alone. Nothing here changes anything for anybody else, and nobody else can see it.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">Password</h2>
            <p className="text-xs text-muted-foreground">
              Changed here and nowhere else. There is no reset email — if you are ever locked out,
              an admin can issue you a temporary password.
            </p>
          </div>

          <PasswordForm />
        </section>

        <section className="space-y-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">Clock reminders</h2>
            <p className="text-xs text-muted-foreground">
              A nudge before your shift starts and before it ends. Nothing is emailed and nothing
              lands in your inbox — this is a sound and a message in the app, and it is silent on
              weekends, holidays and days you have approved leave.
            </p>
          </div>

          <RemindersForm
            clockInReminder={preferences.clockInReminder}
            clockOutReminder={preferences.clockOutReminder}
            leadMinutes={preferences.leadMinutes}
            soundKey={preferences.soundKey}
            soundVolume={preferences.soundVolume}
            soundUrl={soundUrl}
            workStart={punch.schedule.workStart}
            workEnd={punch.schedule.workEnd}
          />
        </section>
      </div>
    </PageShell>
  );
}
