"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

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
import { addDays, addMonths, startOfMonth, startOfWeek } from "@/lib/dates";
import { TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";

const ALL = "__all__";

const KIND_ITEMS: Record<string, string> = {
  [ALL]: "All work",
  client: "Client work",
  internal: "Internal work",
  personal: "Personal tasks",
};

type Preset = { label: string; from: string; to: string };

function presetsFor(today: string): Preset[] {
  const week = startOfWeek(today) ?? today;
  const month = startOfMonth(today) ?? today;
  const lastMonth = addMonths(month, -1) ?? month;
  const endOf = (start: string, months: number) => addDays(addMonths(start, months) ?? start, -1) ?? start;

  return [
    { label: "This week", from: week, to: addDays(week, 6) ?? week },
    { label: "Last week", from: addDays(week, -7) ?? week, to: addDays(week, -1) ?? week },
    { label: "This month", from: month, to: endOf(month, 1) },
    { label: "Last month", from: lastMonth, to: endOf(lastMonth, 1) },
    { label: "Last 3 months", from: addMonths(month, -2) ?? month, to: endOf(month, 1) },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` },
  ];
}

/**
 * P15-02 — THE ANALYTICS FILTER BAR, shared by every tab and the person page.
 *
 * In the URL, so a view is a link ("VizBytes, client work, last month"), and it
 * survives moving between tabs — the tab links carry the query. Which controls
 * appear is the page's choice: Client results has no use for "kind", which is
 * client by definition.
 */
export function PerformanceFilters({
  basePath,
  from,
  to,
  today,
  departments,
  allLabel,
  showKind = true,
  showPriority = true,
  showPeriod = true,
  previousLabel,
}: {
  basePath: string;
  from: string;
  to: string;
  today: string;
  departments: { id: string; name: string }[];
  allLabel: string;
  showKind?: boolean;
  showPriority?: boolean;
  showPeriod?: boolean;
  /** "Compared with 2 Aug – 31 Aug". Said once, under the bar. */
  previousLabel?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function push(next: URLSearchParams) {
    const query = next.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  }

  function set(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    push(next);
  }

  function applyPreset(preset: Preset) {
    const next = new URLSearchParams(params.toString());
    next.set("from", preset.from);
    next.set("to", preset.to);
    push(next);
  }

  const departmentItems: Record<string, string> = {
    [ALL]: allLabel,
    ...Object.fromEntries(departments.map((department) => [department.id, department.name])),
  };
  const priorityItems: Record<string, string> = { [ALL]: "Any priority", ...TASK_PRIORITY_LABELS };
  const custom = params.get("from") || params.get("to");

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      {showPeriod ? (
        <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
          {presetsFor(today).map((preset) => {
            const active = preset.from === from && preset.to === to;
            return (
              <Button
                key={preset.label}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                aria-pressed={active}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        {departments.length > 1 ? (
          <Field id="perf-department" label="Department">
            <Select items={departmentItems} value={params.get("department") ?? ALL} onValueChange={(value) => set("department", value)}>
              <SelectTrigger id="perf-department" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(departmentItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {showKind ? (
          <Field id="perf-kind" label="Kind of work">
            <Select items={KIND_ITEMS} value={params.get("kind") ?? ALL} onValueChange={(value) => set("kind", value)}>
              <SelectTrigger id="perf-kind" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KIND_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {showPriority ? (
          <Field id="perf-priority" label="Priority">
            <Select items={priorityItems} value={params.get("priority") ?? ALL} onValueChange={(value) => set("priority", value)}>
              <SelectTrigger id="perf-priority" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(priorityItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {showPeriod ? (
          <>
            <Field id="perf-from" label="From">
              <DatePicker id="perf-from" value={from} className="w-40" onChange={(value) => set("from", value ?? "")} />
            </Field>
            <Field id="perf-to" label="To">
              <DatePicker
                id="perf-to"
                value={to}
                className="w-40"
                min={from || undefined}
                onChange={(value) => set("to", value ?? "")}
              />
            </Field>
            {custom ? (
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
                This month
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {previousLabel ? <p className="text-2xs text-muted-foreground">{previousLabel}</p> : null}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
