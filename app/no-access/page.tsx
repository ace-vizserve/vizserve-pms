import type { Metadata } from "next";

import { signOut } from "@/app/login/actions";
import { BrandLockup } from "@/components/brand-lockup";
import { Button } from "@/components/ui/button";
import type { AuthDenial } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "No access" };

/**
 * Where a signed-in person lands when they are not a user of this application.
 *
 * A separate page rather than a redirect to /login, because they ARE
 * authenticated — sending them to a login screen either loops or signs them
 * straight back in and bounces them here again. The only useful thing to do is
 * say what happened and name who can fix it.
 *
 * Deliberately vague about the ORG CHART and specific about the REMEDY. It does
 * not say which departments exist or who the admins are — this page is reachable
 * by anyone in the Entra tenant, including people who will never be users here.
 */

const MESSAGES: Record<AuthDenial, { heading: string; body: string }> = {
  no_session: {
    heading: "You are not signed in",
    body: "Sign in to continue.",
  },
  not_provisioned: {
    heading: "You do not have access to VizServe PMS",
    body: "Your sign-in worked, but this account has not been set up in this application. If you think it should be, ask an administrator to add you.",
  },
  deactivated: {
    heading: "This account has been deactivated",
    body: "Your access to VizServe PMS has been switched off. Your work and history are kept. An administrator can restore it.",
  },
  no_app_access: {
    heading: "You do not have access to VizServe PMS",
    body: "This account exists but is not enabled for this application. It may be set up for a different HFSE system. An administrator can grant access.",
  },
};

function isDenial(value: string | undefined): value is AuthDenial {
  return value !== undefined && value in MESSAGES;
}

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  // The reason arrives in the query string, so it is whatever someone typed.
  // An unknown value falls back to the least specific message rather than
  // rendering "undefined".
  const message = MESSAGES[isDenial(reason) ? reason : "not_provisioned"];

  return (
    <main className="flex min-h-svh flex-col justify-center bg-muted/40 px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <BrandLockup subtitle="Project Management System" />
        </div>

        <div className="rounded-xl bg-card ring-1 ring-foreground/10 p-6 text-center sm:p-8">
          <h1 className="text-lg font-semibold tracking-tight">{message.heading}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{message.body}</p>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {/* Signing out is the useful action: they are almost certainly in
                the wrong account, or need to come back as someone else. */}
            <form action={signOut}>
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
            <Button variant="ghost" render={<a href="mailto:amier.vizbytes@vizserve.hfse.edu.sg?subject=VizServe%20PMS%20access" />}>
                Request access
              </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
