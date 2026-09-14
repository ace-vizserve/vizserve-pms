"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Info, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "__all__";

/**
 * P11-14 — the /analytics filter bar: which department, and over what period.
 *
 * IN THE URL, like every other filter here, so a lead can bookmark one team or
 * send somebody "Creative, last month" as a link. The server checks the
 * department against what this viewer may read — a pasted id from somebody
 * else's department falls back to "all of mine" — and narrows the dates with
 * the same regex the schemas use, so a hand-edited `?from=banana` renders the
 * default rather than erroring.
 *
 * ⚠️ THE PERIOD DEFAULTS TO EMPTY, AND THAT IS THE POINT. /reports defaults to
 * the current month because it asks about intake; this page asks who is
 * carrying what, and a period silently applied would hide a six-week-old task
 * still sitting on somebody's plate. So all-time is the default and the range
 * is opt-in — `RangePicker` on /reports is the same control with the opposite
 * default, which is why this is a second component rather than that one reused.
 *
 * ⚠️ IT RANGES ON THE DUE DATE, where /reports ranges on `created_at`. That is
 * the other reason the two are not one component: /reports asks when work came
 * IN, and a lead here means "what is due this month". It also has to be said
 * out loud that undated work drops out — about a third of the tasks in this
 * database have no due date, and a third of the page vanishing with no
 * explanation is worse than having no filter at all.
 *
 * ONE ROW, ABOVE THE CHARTS, which is where the dataviz method puts filters:
 * controls interleaved with the figures they change leave it unclear which
 * chart is filtered and which is not.
 */
export function AnalyticsFilters({
  departments,
  allLabel,
  from,
  to,
}: {
  departments: { id: string; name: string }[];
  allLabel: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI renders the raw value in <SelectValue> unless handed an items map.
  const items: Record<string, string> = {
    [ALL]: allLabel,
    ...Object.fromEntries(departments.map((department) => [department.id, department.name])),
  };

  function push(next: URLSearchParams) {
    const query = next.toString();
    router.push(query ? `/analytics?${query}` : "/analytics");
  }

  function choose(value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete("department");
    else next.set("department", value);
    push(next);
  }

  function setDate(key: "from" | "to", value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    push(next);
  }

  // Only the period clears here. The department is a persistent choice a lead
  // makes once, and sweeping it away with the dates would be a control doing
  // more than its label says.
  const ranged = Boolean(params.get("from") || params.get("to"));

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      {departments.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="department" className="text-xs text-muted-foreground">
            Department
          </Label>
          <Select items={items} value={params.get("department") ?? ALL} onValueChange={choose}>
            <SelectTrigger id="department" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{allLabel}</SelectItem>
              {departments.map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="from" className="text-xs text-muted-foreground">
          Due from
        </Label>
        <DatePicker
          id="from"
          value={from}
          className="w-40"
          onChange={(value) => setDate("from", value ?? "")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="to" className="text-xs text-muted-foreground">
          Due to
        </Label>
        <DatePicker
          id="to"
          value={to}
          className="w-40"
          min={from || undefined}
          onChange={(value) => setDate("to", value ?? "")}
        />
      </div>

      {/* Only when there is something to clear — a permanently visible reset on
          the default period is a control that does nothing. */}
      {ranged ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.delete("from");
            next.delete("to");
            push(next);
          }}
        >
          <X />
          All time
        </Button>
      ) : null}

      {/* Said once the period is on, not permanently: a warning about a filter
          nobody has set is noise, and this one is only true while it is. */}
      {ranged ? (
        <p className="flex w-full items-center gap-1.5 text-2xs text-muted-foreground">
          <Info className="size-3 shrink-0" aria-hidden />
          Only tasks with a due date in this window are counted — work with no due date is left out.
        </p>
      ) : null}
    </div>
  );
}
