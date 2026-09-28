"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FIELD_KEY_PREFIX, type ListField } from "@/lib/schemas/list-fields";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";
import { EXTRA_FILTER_KEYS } from "@/lib/task-extra-filters";

import { TaskExtraFilters } from "../extra-filters";
import { FieldFilters } from "../field-filters";

const ANY = "__any__";

/**
 * P12 — the board's filters, the ones that make sense on a board: search,
 * person, due date (shared with the list), priority, and the open list's custom
 * fields. Status is what the columns ARE, so it is not offered here; folder,
 * list and sort are list-view concerns.
 *
 * All in the URL, so switching to the list keeps what both views understand.
 */
export function BoardFilters({ customFields }: { customFields: ListField[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ANY) next.delete(key);
    else next.set(key, value);
    router.push(`${pathname}?${next.toString()}`);
  }

  const priorityItems: Record<string, string> = {
    [ANY]: "Any priority",
    ...Object.fromEntries([...TASK_PRIORITIES].reverse().map((value) => [value, TASK_PRIORITY_LABELS[value]])),
  };

  const hasFilters =
    ["priority", ...EXTRA_FILTER_KEYS].some((key) => params.get(key)) ||
    [...params.keys()].some((key) => key.startsWith(FIELD_KEY_PREFIX));

  function clear() {
    // Keeps the place (list, scope, kind); drops only what this bar sets.
    const next = new URLSearchParams(params.toString());
    for (const key of ["priority", ...EXTRA_FILTER_KEYS]) next.delete(key);
    for (const key of [...next.keys()]) if (key.startsWith(FIELD_KEY_PREFIX)) next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex shrink-0 flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <TaskExtraFilters />

      <div className="space-y-1.5">
        <Label htmlFor="board-priority" className="text-xs text-muted-foreground">
          Priority
        </Label>
        <Select items={priorityItems} value={params.get("priority") ?? ANY} onValueChange={(value) => setParam("priority", value)}>
          <SelectTrigger id="board-priority" className="w-40">
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
      </div>

      <FieldFilters fields={customFields} params={params as unknown as URLSearchParams} setParam={setParam} />

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clear}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
