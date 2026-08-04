import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next =
    params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "/dashboard";

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

      {/* -------------------------------------------------------- form panel */}
      <div className="flex flex-col justify-center bg-muted/50 px-4 py-12 sm:px-8">
        <div className="mx-auto w-full max-w-sm">
          {/* Identity lockup — the logo is white-only, so it sits on a brand
              tile here rather than directly on the pale panel. */}
          <div className="flex items-center justify-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-sm bg-brand-surface p-1.5">
              <Image
                src="/assets/VizServeWhite.png"
                alt="VizServe"
                width={960}
                height={882}
                sizes="44px"
                priority
                className="h-full w-auto"
              />
            </span>
            <span className="text-left">
              <span className="block border-y py-0.5 text-sm font-semibold tracking-tight">
                VizServe
              </span>
              <span className="block pt-0.5 text-xs text-muted-foreground">
                Project Management System
              </span>
            </span>
          </div>

          <div className="mt-8 text-center">
            {/* Names the product outright. Port 3000 on this machine also
                serves an SIS login, and "Welcome back" on both is how a smoke
                test passes against the wrong app. */}
            <h2 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
              Welcome to VizServe PMS
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">Sign in to access your account</p>
          </div>

          <div className="mt-8">
            <LoginForm next={next} initialError={params.error} />
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Accounts are created by an administrator. Ask your team leader if you need access.
          </p>

          <div className="mt-6 flex items-center justify-between gap-4 border-t pt-5 text-xs">
            <span className="text-muted-foreground">
              Internal platform · <span className="font-semibold text-foreground">VizServe</span>
            </span>
            <Link href="/" className="font-medium text-brand underline-offset-4 hover:underline">
              About this platform →
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
