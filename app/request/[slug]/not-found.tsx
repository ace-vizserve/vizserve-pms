import type { Metadata } from "next";
import { FileQuestion } from "lucide-react";

import { BrandLockup } from "@/components/brand-lockup";

export const metadata: Metadata = { title: "Form unavailable" };

/**
 * A DEAD FORM LINK, which is the 404 in this app that reaches a stranger.
 *
 * `page.tsx` calls `notFound()` whenever `vizserve_pms_get_public_form` returns
 * nothing, and that covers a retired form, one that was never published, and a
 * mistyped slug. These links go out by email and sit in client inboxes for
 * months, so this page is reached long after anybody here has forgotten the
 * form existed.
 *
 * The root `not-found.tsx` would already do a decent job. This one exists
 * because it knows one thing the root cannot: the reader was trying to fill in
 * a FORM. That turns "this page does not exist" — which reads as though they
 * mistyped something, and invites them to try again — into "the form is
 * closed", which tells them the truth and points them at the person who sent
 * the link.
 *
 * ⚠️ NO ACTION BUTTON, deliberately, and this is the one place in the app where
 * that is right. Every other dead end offers a way back; there is nowhere to
 * send this reader. `/` is the staff sign-in, which they have no account for —
 * a button marked "Go to VizServe Team Portal" would take a client who wanted to submit
 * a job and hand them a login screen. The next step genuinely belongs to the
 * person who sent them the link, so the page says so instead of manufacturing a
 * click.
 *
 * §4.6: no session, no nav, no jargon. It never says "slug", "form id",
 * "unpublished" or "404" — those are our words for our problem.
 */
export default function FormNotFound() {
  return (
    <main className="client-surface flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 px-4 py-10">
      <BrandLockup align="stacked" />

      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border bg-card grade-surface px-6 py-10 text-center shadow-raised-lg">
        <span
          className="flex size-12 items-center justify-center rounded-lg border bg-card grade-raised text-muted-foreground shadow-raised"
          aria-hidden
        >
          <FileQuestion className="size-6" />
        </span>

        <h1 className="text-lg font-semibold tracking-[-0.014em]">
          This form is no longer available
        </h1>

        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          It may have been closed, or the link may be out of date. Anything you submitted before now
          is unaffected and is still with the team.
        </p>

        {/* The reassurance is not padding. Somebody who filled this form last
            month and comes back to a dead link has one immediate question, and
            it is whether their request went missing. */}
        <p className="max-w-sm text-2xs leading-relaxed text-muted-foreground">
          Please ask the person who sent you the link for a current one.
        </p>
      </div>
    </main>
  );
}
