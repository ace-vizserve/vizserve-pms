import { ROLE_ORDER, roleAtLeast, type Role } from "@/lib/auth/roles";

/**
 * P8-01 — THE RANK LADDER, extracted from `user-editor.tsx`.
 *
 * Plain TypeScript with no React and no `server-only`, for two reasons: the
 * editor is a client component and cannot pull in anything server-side, and the
 * rules below are the half of that dialog that is worth asserting directly. A
 * lock rule that renders a checkbox enabled when it should be disabled is not
 * something a screenshot catches — see `tests/unit/rank-ladder.test.ts`.
 */

/**
 * The ranks the form OFFERS, most senior first, with the dead rung removed.
 *
 * ⚠️ `admin` IS FILTERED OUT AND MUST STAY FILTERED OUT. It is still a member of
 * `ROLE_ORDER` because the Postgres enum still declares it and the two arrays
 * must agree exactly (see the comment in `lib/auth/roles.ts`) — but P8-01 moved
 * what it meant up to `owner` and promoted every row, so offering it here would
 * let an owner set somebody to a rank that grants nothing: every predicate in
 * the database now reads `>= owner`.
 *
 * Rendered most senior first so that ticking a rank visibly locks everything
 * BELOW it in the list, which is what the inclusive ladder actually means.
 */
export const RANK_LADDER: readonly Role[] = [...ROLE_ORDER]
  .reverse()
  .filter((role) => role !== "admin");

/**
 * The bottom of the ladder. Read off the array rather than written as "member",
 * so that adding a rank below member — which nothing plans to do, and which is
 * exactly why it would be missed — cannot leave the lock rule pointing at the
 * wrong row.
 */
export const LOWEST_RANK: Role = RANK_LADDER[RANK_LADDER.length - 1];

/**
 * The highest OFFERED rank a stored role satisfies.
 *
 * ⚠️ THIS IS WHAT MAKES A LEGACY `admin` ROW DEMOTABLE, and it is the whole
 * point of the function. For every rank the form offers, this is the rank
 * itself. For the dead `admin` rung it is `manager` — which is already what the
 * ticks SHOWED (`roleAtLeast("admin", "manager")` is true), while the form went
 * on holding, and saving, `admin`.
 *
 * The consequences of not normalising were both silent:
 *
 *   1. every offered rank was strictly below the stored one, so every one of
 *      them locked and the row could be promoted to Owner and never demoted;
 *   2. the dialog displayed "Manager" and wrote `admin` straight back, so an
 *      owner who opened a legacy record, changed a phone number and saved had
 *      re-confirmed a rank that grants nothing.
 *
 * Normalising at the seed makes the displayed rank and the saved rank the same
 * value, which is the only version of this form anybody can reason about.
 */
export function offeredRank(role: Role): Role {
  return RANK_LADDER.find((rank) => roleAtLeast(role, rank)) ?? LOWEST_RANK;
}

/**
 * Is this rank ticked for a stored role? A rank is ticked when the role is at
 * least that rank — inclusion, shown.
 */
export function rankTicked(role: Role, rank: Role): boolean {
  return roleAtLeast(role, rank);
}

/**
 * Is this rank ticked BY IMPLICATION — because a rank above it is held?
 *
 * Strictly below the held rank, so it is what the "Included in Manager." hint
 * beside a checkbox is asserting. The rank a person actually holds is ticked but
 * NOT implied, which is why this is separate from `rankLocked` below.
 *
 * ⚠️ COMPARED AGAINST `offeredRank(role)`, NOT `role`. A stored `admin` sits
 * ABOVE manager in `ROLE_ORDER`, so comparing against it directly marked every
 * rank the form offers below owner as implied — which locked them, and left the
 * row impossible to demote.
 */
export function rankImplied(role: Role, rank: Role): boolean {
  return ROLE_ORDER.indexOf(rank) < ROLE_ORDER.indexOf(offeredRank(role));
}

/**
 * Is this rank LOCKED — not a decision the person filling the form can make?
 *
 * Two reasons, and they are different: a rank below the held one is already
 * implied, and the bottom of the ladder is implied by existing at all.
 *
 * ⚠️ THE LOWEST RANK IS ALWAYS LOCKED, AND THE EXPLICIT BRANCH IS WHY. Written
 * as the `<` comparison alone, `member` compared against itself — `0 < 0` — and
 * came out FALSE, so the Member checkbox rendered ENABLED for every member in
 * the company. Unticking it called `toggleRank("member", false)`, which found no
 * offered rank below member and set the role straight back to `member`: a
 * control that moves, does nothing, and snaps back. Everyone is at least a
 * member; the invariant is "always ticked and always locked", and this is the
 * line that holds it.
 */
export function rankLocked(role: Role, rank: Role): boolean {
  return rank === LOWEST_RANK || rankImplied(role, rank);
}

/**
 * What unticking `rank` demotes to: the highest OFFERED rank strictly below it,
 * and never below the bottom of the ladder.
 *
 * Clearing to nothing would leave the form in a state the enum cannot represent
 * — there is no such thing as a person with no rank.
 *
 * ⚠️ STEPPED THROUGH `RANK_LADDER`, NOT `ROLE_ORDER`, AND THAT IS NOT COSMETIC.
 * `ROLE_ORDER` still carries the dead `admin` rung between manager and owner, so
 * `indexOf - 1` off it would demote an owner INTO the retired value — a rank
 * that grants nothing, is not offered anywhere on this form, and would render as
 * "Admin (retired)" on a record somebody had just meant to make a manager.
 *
 * Written as "the highest offered rank strictly below this one" rather than
 * `index + 1`, so an unexpected input falls to the bottom rather than to index
 * 0, which is `owner`. An off-by-one that PROMOTES is not a bug worth risking.
 */
export function rankBelow(rank: Role): Role {
  const below = RANK_LADDER.filter(
    (candidate) => ROLE_ORDER.indexOf(candidate) < ROLE_ORDER.indexOf(rank),
  );
  return below[0] ?? LOWEST_RANK;
}
