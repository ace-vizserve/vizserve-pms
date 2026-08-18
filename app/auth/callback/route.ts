import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/utils/supabase/server";

/**
 * OAuth callback — exchanges the Entra authorization code for a session.
 *
 * Identity linking (P0-03) is Supabase-side: when the provider returns a
 * verified email that already belongs to a user, the identity is attached to
 * that user rather than creating a second one. That behaviour is a PROJECT
 * SETTING. If it is off, signing in with Entra on Monday and email/password on
 * Tuesday produces two auth.users rows, two profiles, and a person whose work
 * is split across both. Verify it before calling P0-03 done.
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
