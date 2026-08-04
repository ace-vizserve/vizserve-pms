"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { createClient } from "@/utils/supabase/server";

/**
 * Self-service password reset.
 *
 * Public and unauthenticated, so two things matter more than usual:
 *
 *   1. IT NEVER SAYS WHETHER THE ACCOUNT EXISTS. Supabase's own endpoint is
 *      already discreet about this, and the wrapper stays discreet too — a
 *      "no such user" here would be an account-enumeration oracle for the whole
 *      staff list. The caller gets `ok: true` for a real address and an unknown
 *      one alike.
 *   2. The redirect target is built from the request ORIGIN, not from user
 *      input, so this cannot be turned into an open redirect that mails
 *      somebody a link to another site.
 */

const emailSchema = z.email();

export async function requestPasswordReset(
  email: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = emailSchema.safeParse(email);

  // The one thing worth rejecting: a value that is not an address at all. That
  // is a typo, not a probe, and telling someone their input was malformed
  // reveals nothing about who has an account.
  if (!parsed.success) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const origin = (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const supabase = await createClient();

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${origin}/auth/callback?next=/dashboard`,
  });

  if (error) {
    // Logged, not surfaced. A rate limit or a mail failure is our problem, and
    // the difference between "we could not send" and "there is nobody to send
    // to" is exactly what this must not leak.
    console.error(`[auth] password reset for ${parsed.data}: ${error.message}`);
  }

  return { ok: true };
}
