import type { Metadata } from "next";
import { BrandLockup } from "@/components/brand-lockup";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next =
    params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "/";

  return (
    /*
      Split sign-in: brand wash on the left, form on the right.

      The left panel is decoration and is dropped below `lg` rather than stacked
      — on a phone it would push the form under a screen of marketing before
      anyone could type. The lockup lives on the *form* side precisely so the
      product is still identified when that panel is gone.
    */
    <main className="grid min-h-svh lg:grid-cols-2">
      {/* ------------------------------------------------------- brand panel */}
      <div
        // items-center is doing real work here: flex-col makes justify-center
        // the *vertical* axis, and without a cross-axis rule the max-w-lg block
        // below collapses to the left edge. text-center then only centres the
        // text within that left-hugging column, which reads as misaligned.
        className="relative hidden flex-col items-center justify-center overflow-hidden px-12 lg:flex xl:px-20"
        // Token rather than an arbitrary class so the stops stay in globals.css
        // with the contrast note that justifies them.
        style={{ backgroundImage: "var(--brand-gradient)" }}
      >
        <div className="relative max-w-lg text-center">
          <h1 className="font-display text-4xl leading-[1.1] font-extrabold tracking-tight text-balance text-white xl:text-5xl">
            One Platform to Streamline
          </h1>
          {/* brand-tint on brand blue measures 3.13:1 — below the 4.5:1 body
              floor, above the 3:1 large-text floor. It is only ever used here,
              at 36px+ bold. docs/12 sanctions exactly this use. */}
          <p className="font-display mt-3 text-2xl font-extrabold tracking-tight text-balance text-brand-tint xl:text-3xl">
            Every VizServe Request
          </p>
          <p className="mx-auto mt-6 max-w-md text-sm leading-6 text-pretty text-white/80">
            Client intake, team-leader review, internal QA, and client sign-off — tracked end to
            end, behind one login. Replacing ClickUp and Microsoft Teams Approvals.
          </p>
        </div>
      </div>

      {/*
        ------------------------------------------------------- form panel

        `--background`, not the `bg-muted/50` this used to carry. Muted is a
        RAISED-and-inset fill in the system (§1.1), not a ground — using it for a
        full-height panel is what forced every field on the form to override
        itself to `bg-background` so it would not dissolve into its own
        container. The form is a proper card on the page ground instead, so the
        primitives can be left alone and the panel gets the lift the system
        gives every other panel in the product.
      */}
      <div className="flex flex-col justify-center bg-background px-4 py-12 sm:px-8">
        <div className="mx-auto w-full max-w-sm">
          {/* The shared lockup (§3), not a fourth hand-built copy of it. The
              asset is white-only, so the component sits it on `--brand-surface`
              — a token that deliberately does NOT flip with the theme, because
              `--brand` lightens in dark and would drop white on it to ~2.2:1. */}
          <BrandLockup subtitle="Project Management System" className="justify-center" />

          <div className="mt-7 text-center">
            {/* Names the product outright. Port 3000 on this machine also
                serves an SIS login, and "Welcome back" on both is how a smoke
                test passes against the wrong app. */}
            <h1 className="text-xl font-semibold tracking-[-0.022em]">Welcome to VizServe PMS</h1>
            <p className="mt-1.5 text-sm text-foreground-muted">Sign in to access your account</p>
          </div>

          <div className="mt-6 rounded-lg border bg-card grade-surface p-6 shadow-raised-lg">
            <LoginForm next={next} initialError={params.error} />
          </div>

          <p className="mt-5 text-center text-xs text-muted-foreground">
            Accounts are created by an administrator. Ask your team leader if you need access.
          </p>

          {/* The "About this platform" link that used to sit here pointed at the
              marketing page, which is gone — and for a signed-out reader it now
              bounces straight back to this screen. There is nothing to link to:
              everyone who belongs here already knows what this is. */}
          <div className="mt-5 border-t pt-4 text-center text-xs text-muted-foreground">
            Internal platform · <span className="font-semibold text-foreground">VizServe</span>
          </div>
        </div>
      </div>
    </main>
  );
}
