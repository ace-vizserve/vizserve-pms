import type { Metadata } from "next";
import Link from "next/link";

import { BrandLockup } from "@/components/brand-lockup";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

/**
 * Self-service password reset.
 *
 * The login page has linked here since the first commit and the route did not
 * exist — the same shape of gap `/admin/users` had, on the one screen every
 * single user reaches. P0-04 already built the admin-triggered version of this
 * (`sendPasswordReset`), so the server side was done; only the self-service door
 * was missing.
 *
 * Note that this is only meaningful for the email/password path. Someone who
 * signs in through Entra has no password here to reset, and the copy says so
 * rather than sending them round a loop that cannot help them.
 */
export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-svh flex-col justify-center bg-muted/40 px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup subtitle="Project Management System" />
        </div>

        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-6 sm:p-8">
          <h1 className="text-lg font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            We will email you a link to set a new one.
          </p>

          <div className="mt-5">
            <ForgotPasswordForm />
          </div>

          <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
            Sign in with Microsoft instead? There is no password to reset — use the Microsoft
            button on the{" "}
            <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
              sign-in page
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
