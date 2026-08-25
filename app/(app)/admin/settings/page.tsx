import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { loadAppSettings } from "@/lib/settings-server";
import { PageShell } from "@/components/page-shell";

import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

/**
 * P7-37 — the company-wide settings an admin can change without a deploy.
 *
 * One setting today. The screen exists as its own route rather than as a card on
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
  await requireRole("admin");

  const settings = await loadAppSettings();

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Settings". */}
      <p className="text-xs text-muted-foreground">
        Company-wide rules. These take effect immediately, for everybody, and are read on every
        punch rather than copied onto records — so changing one changes how existing days are
        described, not what was recorded.
      </p>

      <SettingsForm graceMinutes={settings.graceMinutes} />
    </PageShell>
  );
}
