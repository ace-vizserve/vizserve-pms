"use client";

import { createContext, useContext } from "react";

import type { VizservePmsTaskStatus } from "@/lib/database.types";

/**
 * How a status control tells the list it has moved, before the server agrees.
 *
 * ⚠️ ITS OWN MODULE, IMPORTING NOTHING BUT REACT, AND THAT IS THE WHOLE POINT.
 * This lived in `task-status-groups.tsx` for about an hour and did not work,
 * because that file imports the table, which imports the status control, which
 * imports the transition hook, which imported this back — a cycle. Under a
 * bundler a cycle can hand two halves of the graph two different evaluations of
 * the same module, so `createContext` ran twice: the provider published to one
 * context and `useContext` read the other, which is null. The row never moved
 * and nothing errored, which is the worst shape a bug can take.
 *
 * A leaf module cannot be in a cycle. Keep it that way — do not import the
 * table, the control or anything that reaches them from here.
 */
/**
 * The two things that change which rows a status group holds: a task moving
 * between them, and a task being created into one.
 *
 * A discriminated union rather than two contexts, because they are the same
 * question — "what does this group contain right now" — and two providers
 * around the same list is two things to keep in step.
 */
export type OptimisticMove =
  | { kind: "move"; id: string; status: VizservePmsTaskStatus }
  | { kind: "add"; title: string; status: VizservePmsTaskStatus }
  | { kind: "remove"; id: string }
  /**
   * Any other column on the row — priority, the two dates, the estimate, the
   * list.
   *
   * ⚠️ IT HAS TO LIVE ON THE ROW, NOT IN THE CONTROL, and that is what a local
   * `useOptimistic` could never do. `InlinePriority` is rendered TWICE in a
   * single task row — once beside the title and once as the priority column —
   * and `TaskRowActions` reads the same field a third time. Three component
   * instances, three separate pieces of local state: changing one left the other
   * two showing the old value until the server answered.
   *
   * One patch on the row feeds all three, because all three render from it.
   */
  | { kind: "patch"; id: string; fields: Record<string, unknown> };

/*
 * THE PLACEHOLDER ID — AND WHY IT IS NOT A UUID.
 *
 * An optimistic row stands for a task the server has not created yet, so it has
 * no id to carry. React still needs a key, and the key has to be one nothing
 * can mistake for a real id.
 *
 * ⚠️ THE MISTAKE IT GUARDS AGAINST IS REAL AND WAS SHIPPED: the placeholder
 * row rendered the ordinary task row, link and all, and `<HoverPrefetchLink
 * href={`/tasks/optimistic-0`}>` fetched that page on hover — which reached
 * Postgres and came back `invalid input syntax for type uuid: "optimistic-0"`.
 * Every control on that row had the same hole: a priority, a date or a delete
 * pressed before the server answered would have sent this string to an action
 * typed `uuid`.
 *
 * So the rule is: a placeholder row is INERT. It shows what was typed and says
 * it is still going in. `isPlaceholder` is how every renderer asks.
 */
const PLACEHOLDER_PREFIX = "optimistic-";

/** The key for the nth pending row. Never reaches the database. */
export function placeholderId(index: number) {
  return `${PLACEHOLDER_PREFIX}${index}`;
}

/** True for a row that exists only in this browser. Nothing may be sent about it. */
export function isPlaceholder(id: string) {
  return id.startsWith(PLACEHOLDER_PREFIX);
}

/** Null wherever the control renders with no groups around it — the task detail page and the board. */
export const OptimisticMoveContext = createContext<((move: OptimisticMove) => void) | null>(null);

export function useOptimisticMove() {
  return useContext(OptimisticMoveContext);
}
