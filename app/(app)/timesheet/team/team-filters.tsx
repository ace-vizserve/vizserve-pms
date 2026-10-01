"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TIMESHEET_WEEK_LABELS, type TimesheetWeekStatus } from "@/lib/schemas/timesheet";

import type { TeamRow } from "./team-week-grid";

const ALL = "__all__";
const NOT_SUBMITTED = "NOT_SUBMITTED";

export type TeamStatusFilter = TimesheetWeekStatus | typeof NOT_SUBMITTED;

const STATUS_ITEMS: Record<string, string> = {
  [ALL]: "Every status",
  SUBMITTED: "Awaiting a decision",
  [NOT_SUBMITTED]: "Not submitted",
  RETURNED: TIMESHEET_WEEK_LABELS.RETURNED,
  APPROVED: TIMESHEET_WEEK_LABELS.APPROVED,
};

/** The filters as the URL states them, narrowed: an unknown value is "all". */
export function readTeamFilters(params: URLSearchParams): {
  department: string | null;
  status: TeamStatusFilter | null;
} {
  const status = params.get("status");
  return {
    department: params.get("department"),
    status: status && status in STATUS_ITEMS && status !== ALL ? (status as TeamStatusFilter) : null,
  };
}

export function applyTeamFilters(
  rows: TeamRow[],
  filters: { department: string | null; status: TeamStatusFilter | null },
): TeamRow[] {
  return rows.filter((row) => {
    if (filters.department && row.departmentId !== filters.department) return false;
    if (filters.status === NOT_SUBMITTED) return row.status === null;
    if (filters.status) return row.status === filters.status;
    return true;
  });
}

/**
 * P15-01 — the team week's filter bar: which department, which week status.
 *
 * IN THE URL, like every other filter here, so "VizBytes, awaiting a decision"
 * is a link. The department list is the departments actually on this week's
 * grid — which is exactly the viewer's scope, because the fetcher narrowed the
 * rows to it — so the picker can never offer a department with nobody in it.
 */
export function TeamFilters({ rows }: { rows: TeamRow[] }) {
  const router = useRouter();
  const params = useSearchParams();

  const departments = [
    ...new Map(
      rows
        .filter((row) => row.departmentId !== null)
        .map((row) => [row.departmentId!, row.departmentName ?? "Unnamed department"]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));

  function set(key: "department" | "status", value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.push(query ? `/timesheet/team?${query}` : "/timesheet/team");
  }

  const departmentItems: Record<string, string> = {
    [ALL]: "Every department",
    ...Object.fromEntries(departments),
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      {departments.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="team-department" className="text-xs text-muted-foreground">
            Department
          </Label>
          <Select
            items={departmentItems}
            value={params.get("department") ?? ALL}
            onValueChange={(value) => set("department", value)}
          >
            <SelectTrigger id="team-department" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every department</SelectItem>
              {departments.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="team-status" className="text-xs text-muted-foreground">
          Week status
        </Label>
        <Select
          items={STATUS_ITEMS}
          value={readTeamFilters(params).status ?? ALL}
          onValueChange={(value) => set("status", value)}
        >
          <SelectTrigger id="team-status" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
