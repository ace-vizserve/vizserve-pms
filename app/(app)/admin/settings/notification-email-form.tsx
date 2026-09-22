"use client";

import { Mail, MailX } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  NOTIFICATION_EMAIL_SENDER,
  NOTIFICATION_TYPE_HINTS,
  NOTIFICATION_TYPE_LABELS,
  isNotificationType,
} from "@/lib/notifications";

import { updateNotificationEmailSettings } from "./actions";

/**
 * P8-19 — which notification types also send an email.
 *
 * The table behind this has existed since P0-10 with a comment promising it was
 * "editable without a deploy", and for seven weeks the only editor was a SQL
 * console. P8-18 is what made the gap visible: `mentioned` was flipped on in a
 * migration, and the only way to answer "is it actually on in production?" was
 * to go and look at the database.
 *
 * ⚠️ THE MOST IMPORTANT THING ON THIS SCREEN IS A SENTENCE, NOT A SWITCH — the
 * one saying the in-app inbox is unaffected. Somebody reading a column of
 * things labelled "Mentions" and "Client decision" with toggles beside them
 * will reasonably conclude that turning one off stops the notification. It does
 * not. Every type always writes an inbox row; this decides only whether an
 * email chases it. Getting that wrong in an owner's head is how the approval
 * queue quietly stops reaching anybody.
 *
 * ONE SAVE FOR THE WHOLE SET, matching `SettingsForm` beside it. Per-switch
 * autosave was the obvious alternative and is worse here: these settle as a
 * policy — "email the gates, not the chatter" — so they are read together and
 * changed together, and a row of controls that each fire their own request
 * gives an owner eight chances to half-apply a decision.
 */

export type NotificationEmailRow = {
  type: string;
  sendEmail: boolean;
};

/**
 * A type the database has and `lib/notifications.ts` does not.
 *
 * ⚠️ RENDERED, NOT HIDDEN, and this is a deliberate exception to "never expose
 * an enum value to a user" (design system §6). That rule protects people who
 * did not choose to be looking at a database; the owner on this screen is
 * holding the switch for one, and the alternative is a live email setting that
 * exists and cannot be seen. `mentioned` spent four days in exactly this state.
 * Tidied to sentence case so it reads as a name rather than a column.
 */
function fallbackLabel(type: string): string {
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function NotificationEmailForm({ rows }: { rows: NotificationEmailRow[] }) {
  const [saved, setSaved] = useState(rows);
  const [values, setValues] = useState(() => Object.fromEntries(rows.map((row) => [row.type, row.sendEmail])));
  const [pending, startTransition] = useTransition();

  // Compared against what the server last confirmed rather than against the
  // props, so the button settles after a save without the page having to
  // remount the form.
  const dirty = saved.some((row) => values[row.type] !== row.sendEmail);

  function submit() {
    startTransition(async () => {
      const next = saved.map((row) => ({
        type: row.type,
        send_email: values[row.type] ?? row.sendEmail,
      }));

      const result = await updateNotificationEmailSettings({ types: next });

      if (!result.ok) {
        toast.error(result.error);
        // Deliberately NOT rolling the switches back. The action applies types
        // one at a time and reports the first refusal, so some of these may have
        // landed — `revalidatePath` on the server is what redraws the truth, and
        // guessing at it here would fight that.
        return;
      }

      setSaved(next.map((row) => ({ type: row.type, sendEmail: row.send_email })));
      toast.success("Saved. This applies to notifications written from now on.");
    });
  }

  return (
    <form className="w-full space-y-4 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg" action={submit}>
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Email notifications</h2>
        <p className="text-xs text-muted-foreground">
          Every event below always lands in the recipient&rsquo;s portal inbox. These switches decide only whether an
          email chases it, and they take effect on notifications written from now on — turning one on does not email
          anything already sitting in an inbox.
        </p>
      </div>

      <ul className="divide-y rounded-md border">
        {saved.map((row) => {
          /*
           * Narrowed into a variable rather than tested into a boolean. The
           * rows arrive as plain strings on purpose — the database is the
           * authority on what types exist, not the hand-maintained mirror — so
           * this is the one place the two are reconciled, and a `boolean` from
           * the guard would not narrow the three lookups below.
           */
          const known = isNotificationType(row.type) ? row.type : null;
          const label = known ? NOTIFICATION_TYPE_LABELS[known] : fallbackLabel(row.type);
          const hint = known
            ? NOTIFICATION_TYPE_HINTS[known]
            : "Added to the database more recently than this screen. It still emails if this is on.";
          const sender = known ? NOTIFICATION_EMAIL_SENDER[known] : null;
          const on = values[row.type] ?? row.sendEmail;
          const id = `notification_email_${row.type}`;

          return (
            <li key={row.type} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={id}>{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>

                {/* The state in words as well as in the switch — greyscale and
                    screenshot safe, and it is the line that answers the question
                    an owner actually arrives with, which is "where does this
                    come from and is it on". */}
                <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                  {on ? (
                    <Mail aria-hidden className="size-3.5 shrink-0 text-foreground-faint" />
                  ) : (
                    <MailX aria-hidden className="size-3.5 shrink-0 text-foreground-faint" />
                  )}
                  {on && sender ? (
                    <span>
                      Emails, from <span className="font-medium">{sender}@vizserve.com</span>
                    </span>
                  ) : on ? (
                    <span>Emails</span>
                  ) : (
                    <span>Inbox only</span>
                  )}
                </p>
              </div>

              <Switch
                id={id}
                checked={on}
                onCheckedChange={(checked) => setValues((previous) => ({ ...previous, [row.type]: checked }))}
              />
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending} disabled={!dirty}>
          Save
        </Button>
        {/* `disabled` is never the only explanation (design system §4.2). */}
        <p className="text-xs text-muted-foreground">
          {dirty ? "Unsaved changes." : "Nothing to save — these match what is stored."}
        </p>
      </div>
    </form>
  );
}
