import type { VizservePmsUserRole } from "@/lib/database.types";

/**
 * The role hierarchy, with NO server-only import.
 *
 * Split out of `authorization.ts` because that module is `server-only` — it
 * resolves a session and reaches the database, and pulling it into a client
 * bundle is a build error by design. But the role ORDER is not a secret and not
 * a decision; it is a fact about the enum, and a role selector, a zod schema and
 * a nav filter all legitimately need it on the client.
 *
 * Duplicating the list instead would be the actual danger: two copies that drift
 * make `roleAtLeast` and the Postgres `>=` disagree, and that disagreement shows
 * up as a security bug rather than a type error.
 *
 * The decisions still live in `authorization.ts`. This is only the ordering.
 */

/** Ascending authority. Mirrors the Postgres enum declaration order exactly. */
export const ROLE_ORDER = ["member", "team_leader", "manager", "admin"] as const;

export type Role = VizservePmsUserRole;

/**
 * Roles are INCLUSIVE: admin ⊇ manager ⊇ team_leader ⊇ member (D15).
 * Always `>=`, never `===`. Amier is an admin who is also a TL; an equality
 * check would lock him out of his own approval queue.
 */
export function roleAtLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}
