"use client";

import { createContext, useContext } from "react";

import type { AuthContext } from "@/lib/auth/rules";

/**
 * P12 Phase A — who the viewer is, in the browser.
 *
 * `app/(app)/layout.tsx` resolves the `AuthContext` on the server exactly as it
 * always has — the temporary-password wall, the app-access gate and the
 * deactivation check all run there before anything paints — and hands the
 * result down through this provider. Pages then need no server work of their
 * own per click, which is what lets a navigation switch at once instead of
 * waiting on a server render.
 *
 * ⚠️ IT DECIDES NOTHING THE DATABASE DOES NOT ALSO DECIDE. These are the
 * viewer's own attributes, used to draw controls with the rules in
 * `lib/auth/rules.ts`. Every read is scoped by RLS and every write is checked by
 * policy or by the database function behind it, exactly as for a direct
 * PostgREST call — which any signed-in user can already make with their token.
 *
 * ⚠️ FRESH ON EVERY SERVER RENDER OF THE LAYOUT: a full load, a refresh, and the
 * `router.refresh()` every write ends in. A role change therefore reaches the
 * browser on the next of those, and the database enforces it from the first
 * request regardless.
 */
const Context = createContext<AuthContext | null>(null);

export function AuthProvider({ value, children }: { value: AuthContext; children: React.ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAuth(): AuthContext {
  const value = useContext(Context);
  if (!value) throw new Error("useAuth() needs <AuthProvider>, which app/(app)/layout.tsx renders.");
  return value;
}
