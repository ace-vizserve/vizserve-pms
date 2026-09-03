import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadMustChangePassword, resolveAuth } from "@/lib/auth/authorization";
import { BrandLockup } from "@/components/brand-lockup";

import { PasswordForm } from "@/app/(app)/settings/password-form";

export const metadata: Metadata = { title: "Choose a password" };

/**
 * P8-11 — the wall between a temporary password and the rest of the app.
 *
 * ⚠️ DELIBERATELY OUTSIDE `(app)`, and that is the whole design. The gate lives
 * in `requireAuthContext()`, which every authenticated page calls — so a screen
 * inside `(app)` would be redirected to itself, forever. Out here it renders on
 * its own, with no sidebar and nothing to click away to, which is also the
 * honest presentation: there is exactly one thing to do.
 *
 * ⚠️ AND IT CALLS `resolveAuth()`, NEVER `requireAuthContext()`. The second one
 * is what performs the redirect; calling it here is the loop.
 *
 * The reverse case matters too: somebody who lands here with no flag set is
 * sent home rather than shown a form asking them to fix a problem they do not
 * have.
 */
export default async function ChangePasswordPage() {
  const { context } = await resolveAuth();

  // No session, or no profile. Not this screen's problem — /login and
  // /no-access are, and the layout gate is what normally routes there.
  if (!context) redirect("/login");

  const forced = await loadMustChangePassword(context.userId);
  if (!forced) redirect("/settings");

  return (
    <main className="flex min-h-svh flex-col justify-center bg-muted/40 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup subtitle="Project Management System" />
        </div>

        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-6 sm:p-8">
          <h1 className="text-lg font-semibold tracking-tight">Choose your own password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You are signed in with a temporary password an admin issued. Pick one only you know
            before carrying on — the rest of the app is closed until you do.
          </p>

          <div className="mt-5">
            {/*
              No current-password field. They are signed in WITH the temporary
              password, so the session is already the proof, and retyping
              something an admin read out to them proves nothing. The server
              still refuses a "new" password that turns out to be the temporary
              one — see `changeOwnPassword`.
            */}
            <PasswordForm requireCurrent={false} onChanged="home" />
          </div>

          <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
            Signed in as {context.email}.
          </p>
        </div>
      </div>
    </main>
  );
}
