import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { requireAdmin } from "@/lib/auth/authorization";
import { loadAppSettings } from "@/lib/settings-server";
import { createClient } from "@/utils/supabase/server";

import { NotificationRulesForm } from "./notification-rules-form";
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
  await requireAdmin();

  const supabase = await createClient();

  // P14-09. The catalogue, its rules, and the people a rule can name — read
  // through the Admin's own policies (the rules tables are Admin-only).
  const [settings, events, rules, people] = await Promise.all([
    loadAppSettings(),
    supabase
      .from("vizserve_pms_notification_events")
      .select("key, flow, flow_label, flow_sort, stage_label, sort, ends_flow, description"),
    supabase
      .from("vizserve_pms_notification_rules")
      .select("id, event_key, audience_kind, audience, user_id, in_app, email, locked"),
    supabase.from("vizserve_pms_users").select("id, full_name").eq("is_active", true).order("full_name"),
  ]);

  const rulesFailed = events.error || rules.error || !events.data || events.data.length === 0;

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Settings". */}
      <p className="text-xs text-muted-foreground">
        Company-wide rules. These take effect immediately, for everybody. The timekeeping ones are read on every punch
        rather than copied onto records — so changing one changes how existing days are described, not what was
        recorded.
      </p>

      <SettingsForm graceMinutes={settings.graceMinutes} breakMinutes={settings.breakMinutes} />

      {/* ⚠️ A FAILED READ, NOT AN EMPTY STATE — drawn as a message rather than
          as switches at a guess. Before P14-09 is applied the tables do not
          exist, and this is what shows. */}
      {rulesFailed ? (
        <p className="rounded-lg border bg-card grade-surface p-4 text-xs text-muted-foreground shadow-raised-lg">
          Could not read the notification settings. If this persists, the P14-09 database change has not been
          applied yet.
        </p>
      ) : (
        <NotificationRulesForm events={events.data} rules={rules.data ?? []} people={people.data ?? []} />
      )}
    </PageShell>
  );
}
