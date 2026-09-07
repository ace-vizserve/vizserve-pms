import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";

import { BrandLockup } from "@/components/brand-lockup";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/**
 * THE ROOT 404. Until now there was none, so every unmatched URL in this app
 * rendered Next's built-in page: black Helvetica on white, "This page could not
 * be found", no theme, no brand, no way back.
 *
 * ⚠️ IT HAS TWO AUDIENCES AND CANNOT TELL THEM APART, which is what shapes
 * every word below.
 *
 *   A CLIENT with a dead form link. `app/request/[slug]/page.tsx` calls
 *   `notFound()` when `vizserve_pms_get_public_form` returns nothing — a
 *   retired form, an unpublished one, a mistyped slug. Those links live in
 *   client inboxes for months. This is the whole of what they see, they have no
 *   account, no nav and no idea what "VizServe Team Portal" is, and today they see a
 *   browser-default error page from a company that asked them to fill in a
 *   form. That is the case this page exists for.
 *
 *   A SIGNED-IN OPERATOR who mistyped a URL or followed a stale bookmark.
 *   Everything under `(app)` is behind the auth gate, so `proxy.ts` sends a
 *   signed-out stranger to `/login` before they ever reach here — meaning an
 *   unmatched URL that DOES reach this page belongs to somebody who is already
 *   signed in, or to one of the public prefixes above.
 *
 * There is no way to know which, and no way to find out cheaply: `not-found.tsx`
 * is the last thing standing when a route has failed, and giving it a database
 * read to decide its own copy would make the error page able to error. So it
 * says only what is true for both, and its one action — `/` — resolves itself:
 * signed in, that is the dashboard; signed out, `proxy.ts` turns it into the
 * sign-in page.
 *
 * §4.6 governs it, because the client is the reader who can least afford
 * jargon: `BrandLockup` for identity, one clear action, no enum, no route name,
 * no mention of a slug or a session.
 */
export default function NotFound() {
  return (
    /*
     * `client-surface` and the same `bg-muted/40` ground as /request, /approve
     * and /feedback. A client arriving here from a form link should land on the
     * surface they were expecting rather than on the app's own chrome — and
     * this page has no sidebar to sit beside, which is why it builds its own
     * frame instead of using PageShell.
     */
    <main className="client-surface flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 px-4 py-10">
      <BrandLockup align="stacked" />

      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border bg-card grade-surface px-6 py-10 text-center shadow-raised-lg">
        <span
          className="flex size-12 items-center justify-center rounded-lg border bg-card grade-raised text-muted-foreground shadow-raised"
          aria-hidden
        >
          <Compass className="size-6" />
        </span>

        {/* The <h1> the built-in page never had. This is the only heading on
            the screen, and a 404 with no landmark is a page a screen reader
            enters with nothing to announce. */}
        <h1 className="text-lg font-semibold tracking-[-0.014em]">This page does not exist</h1>

        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          The address may be mistyped, or the link may be out of date. If somebody sent you here to
          fill in a form, it has most likely been closed since — ask them for a current link.
        </p>

        {/*
          A LINK, not `<Button render={<Link/>}>` — Base UI's Button is a native
          <button> and warns that the semantics it promised are gone. This
          navigates, so it is an anchor wearing the button's clothes.

          `/` and nothing more specific: it is the one destination that is right
          for both readers without this page having to work out which it has.
        */}
        <Link href="/" className={buttonVariants({ size: "sm", className: "mt-2" })}>
          Go to VizServe Team Portal
        </Link>
      </div>
    </main>
  );
}
