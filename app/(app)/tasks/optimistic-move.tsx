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
export type OptimisticMove = { id: string; status: VizservePmsTaskStatus };

/** Null wherever the control renders with no groups around it — the task detail page and the board. */
export const OptimisticMoveContext = createContext<((move: OptimisticMove) => void) | null>(null);

export function useOptimisticMove() {
  return useContext(OptimisticMoveContext);
}
