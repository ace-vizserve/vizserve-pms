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

/**
 * Ascending authority. Mirrors the Postgres enum declaration order exactly.
 *
 * ⚠️ "admin" IS A DEAD RUNG AND MUST STAY IN THIS ARRAY. P8-01 moved what
 * `admin` meant — "oversees everything" — up to the new top value `owner`, and
 * promoted every existing row. No account holds "admin" any more and the role
 * picker no longer offers it (see ROLE_LABELS), but the value is still declared
 * in the Postgres enum: dropping an enum value means rebuilding the type on a
 * live database, which buys nothing. Delete it from here and every `indexOf`
 * below shifts by one against a `>=` in SQL that did not — which is the exact
 * disagreement the comment above warns produces a security bug rather than a
 * type error.
 */
export const ROLE_ORDER = ["member", "team_leader", "manager", "admin", "owner"] as const;

export type Role = VizservePmsUserRole;

/**
 * Roles are INCLUSIVE: owner ⊇ manager ⊇ team_leader ⊇ member (D15).
 * Always `>=`, never `===`. Amier is an owner who is also a TL; an equality
 * check would lock him out of his own approval queue.
 *
 * ⚠️ P8-01 made the `===` rule enforceable rather than merely advised. Every
 * `role === "admin"` in the app was true for the top rung until the top rung was
 * renamed, and would now be true for NOBODY — a whole class of silent
 * permission loss that `roleAtLeast` is immune to.
 */
export function roleAtLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}
