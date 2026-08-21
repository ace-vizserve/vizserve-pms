import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/utils/supabase/server";

/**
 * Auth code callback — exchanges a one-time code for a session.
 *
 * THIS IS THE PASSWORD-RESET CALLBACK NOW. It was written for Entra, and the
 * Microsoft sign-in was removed from the login page, but the route is still
 * load-bearing: `resetPasswordForEmail` sends a link whose `redirectTo` lands
 * here, from `app/forgot-password/actions.ts` and from the admin's "send a
 * reset link" in `app/(app)/admin/users/actions.ts`. Delete it as OAuth
 * leftovers and every password reset in the product silently 404s.
 *
 * `exchangeCodeForSession` is the same call either way — a PKCE code is a PKCE
 * code, whether an identity provider or a reset email produced it.
 *
 * If Entra is ever restored: identity linking (P0-03) is a Supabase PROJECT
 * SETTING, not something this route controls. With it off, signing in with
 * Entra on Monday and email/password on Tuesday produces two auth.users rows,
 * two profiles, and a person whose work is split across both.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent("Sign-in failed.")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("We could not complete that sign-in.")}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
