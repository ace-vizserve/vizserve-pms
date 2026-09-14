import type { StageKey } from "@/lib/department-analytics";

/**
 * P11-14 — THE THREE STAGE BANDS, IN THE ORDER THEY ARE DRAWN, and the single
 * place /analytics maps one to a colour.
 *
 * Its own module because the rings and the per-person bars both need it, and a
 * second copy of a map like this one is the anti-pattern that has already bitten
 * this repo five times — `ROLE_LABELS`, `ROLE_ORDER` and the tone pairs each got
 * duplicated, and every copy drifted.
 *
 * EIGHT STATUSES FOLD TO THREE, which is the same reduction `charts.tsx` makes
 * and for the same reason: eight categorical hues is well past the point where
 * anybody holds a legend in their head. The per-status detail lives in the table
 * at the bottom of the page, where a number is a number.
 *
 * ⚠️ THE FINISHED BAND WEARS `--chart-done`, NOT `--chart-3`. Stage is state,
 * and the house rule is that identity colours cannot carry state — so the green
 * that means finished is its own token, measured as a series against both the
 * light and the dark surface. Overdue's red is `--chart-overdue` and is
 * deliberately NOT in this list: it is never a band or a slice, only a figure
 * carried with the word "overdue". See the comment on the tokens for the
 * measurements that forbid it.
 */
export const STAGES = [
  { key: "notStarted", label: "Not started", fill: "bg-chart-1" },
  { key: "active", label: "In progress", fill: "bg-chart-2" },
  { key: "completed", label: "Completed", fill: "bg-chart-done" },
] as const satisfies readonly { key: StageKey; label: string; fill: string }[];

/** The ring draws its arcs rather than filling them, so it needs the stroke. */
export const STAGE_STROKE: Record<StageKey, string> = {
  notStarted: "stroke-chart-1",
  active: "stroke-chart-2",
  completed: "stroke-chart-done",
};
