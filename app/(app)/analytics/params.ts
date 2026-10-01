import { addDays, addMonths, startOfMonth } from "@/lib/dates";
import type { WorkKind } from "@/lib/performance";
import type { PerformanceFilters } from "@/lib/performance-server";

export type AnalyticsSearch = {
  department?: string;
  kind?: string;
  priority?: string;
  from?: string;
  to?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: WorkKind[] = ["client", "internal", "personal"];
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

/**
 * P15-02 — the URL, narrowed. Unknown values fall back rather than erroring:
 * a hand-edited `?kind=banana` shows all work, and an unparseable date the
 * current month — the posture every filtered page here takes.
 */
export function readAnalyticsFilters(search: AnalyticsSearch, today: string): PerformanceFilters {
  const monthStart = startOfMonth(today) ?? today;
  return {
    departmentId: search.department ?? null,
    kind: KINDS.includes(search.kind as WorkKind) ? (search.kind as WorkKind) : null,
    priority: PRIORITIES.includes(search.priority ?? "") ? search.priority! : null,
    from: DATE.test(search.from ?? "") ? search.from! : monthStart,
    to: DATE.test(search.to ?? "") ? search.to! : (addDays(addMonths(monthStart, 1) ?? monthStart, -1) ?? today),
  };
}
