import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/utils/supabase/server";

/**
 * Auth code callback — exchanges a one-time code for a session.
 *
 * ⚠️ IT HAS NO CALLER, AND THAT IS ITS CURRENT STATE RATHER THAN A BUG.
 *
 * Written for Entra; the Microsoft sign-in was then removed from the login page
 * and this became the password-reset callback, because `resetPasswordForEmail`
 * pointed its `redirectTo` here. P8-11 withdrew the reset email as well —
 * passwords are changed at `/settings` and reissued by an owner — so nothing in
 * the product sends anybody here any more.
 *
 * It is kept because restoring Entra needs it back unchanged, and because a
 * route that 404s is not free: a stale link in somebody's inbox reaching a 404
 * says "this application is broken" rather than "that link has expired". With
 * no `code` it redirects to the login page, which is the honest answer to a
 * link that no longer means anything.
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
