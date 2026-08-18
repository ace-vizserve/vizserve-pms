"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";

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

export async function signInWithMicrosoft(formData: FormData) {
  const supabase = await createClient();
  const origin = (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL!;
  const next = safeNextPath(formData.get("next"));

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      // `email` is required for identity linking to work: Supabase links an
      // Entra identity to an existing email/password user only when the
      // provider returns a verified email (P0-03, "one human, one profile").
      scopes: "email openid profile",
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent("Microsoft sign-in is unavailable right now.")}`);
  }

  redirect(data.url);
}

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
