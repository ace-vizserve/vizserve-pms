"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { loginSchema } from "@/lib/schemas/auth";

export type LoginState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

/** Only ever redirect to a path on this origin — never to an attacker's URL. */
function safeNextPath(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export async function signInWithPassword(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: z_flatten(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Deliberately not distinguishing "no such account" from "wrong password" —
    // the difference is an account-enumeration oracle on a public login page.
    return { error: "That email and password combination did not work." };
  }

  redirect(safeNextPath(formData.get("next")));
}

/*
 * `signInWithMicrosoft` WAS HERE and was removed on request. Email and password
 * is the only way in.
 *
 * Removing the button alone would have left a reachable server action — a
 * `"use server"` export is a POST endpoint whether or not anything renders a
 * form for it, so the flow would still have started for anyone who posted to
 * it. The action had to go with the button.
 *
 * Two things it touched are deliberately still here:
 *
 *   * `app/auth/callback/route.ts`, which now serves password resets alone.
 *     `forgot-password/actions.ts` and the admin's reset link both point their
 *     `redirectTo` at it. Deleting it as OAuth leftovers breaks both.
 *   * The app-access gate (`20260804120000_app_access_gate.sql`), which exists
 *     because the auth pool is shared with other HFSE systems. That is a fact
 *     about the pool, not about Entra, and it outlives this button.
 *
 * Restoring it is `supabase.auth.signInWithOAuth({ provider: "azure" })` with
 * `scopes: "email openid profile"` — the email scope is what lets Supabase link
 * the identity to an existing user instead of creating a second one (P0-03).
 */

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** zod v4 flattens differently across minor versions; keep it in one place. */
function z_flatten(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}
