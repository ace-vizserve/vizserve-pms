"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TASK_STATUS_OPTIONS } from "@/components/status-badge";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";

const ALL = "__all__";

/**
 * Filters in the URL, not in component state — the same reasoning as the
 * requests list: a bookmarkable, sendable view, and the server does the work.
 *
 * THE SCOPE TABS ARE NO LONGER HERE. All / Mine / Waiting on my QA moved to
 * `toolbar.tsx`, which renders on the board as well — the board has always read
 * `?view=`, and while the tabs lived inside this panel it had no way to set it.
 * What is left here is the pair of filters that genuinely only narrow a LIST:
 * status is a grouping on the board, and a list filter is a column it does not
 * draw.
 */
export function TaskFilters({ lists }: { lists: { id: string; name: string }[] }) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI's Select emits `string | null` on clear, where Radix emitted "".
  // The falsy branch below already handles both.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    router.push(`/tasks?${next.toString()}`);
  }

  const hasFilters = ["status", "view", "list", "priority", "sort"].some((key) =>
    params.get(key),
  );

  /*
   * J — the priority filter, and the sort that stops the column being decoration.
   *
   * Highest first, unlike `TASK_PRIORITIES` itself: that constant is declared
   * low→high because Postgres compares enums by declaration order and every sort
   * in the app depends on it, while a person reading a picker scans from the most
   * severe down.
   *
   * "No priority" is a real option rather than an omission — it is what most
   * tasks are, and "show me the unranked backlog" is a question worth asking.
   * It is `none`, not an empty string, because an empty string is how this Select
   * says "cleared".
   */
  const priorityItems: Record<string, string> = {
    [ALL]: "Any priority",
    ...Object.fromEntries(
      [...TASK_PRIORITIES].reverse().map((value) => [value, TASK_PRIORITY_LABELS[value]]),
    ),
  };

  const sortItems: Record<string, string> = {
    due: "Due date",
    priority: "Priority",
  };

  // Base UI renders the RAW VALUE in <SelectValue> unless the root is handed an
  // items map. Without these the Status filter showed the literal "__all__"
  // sentinel on screen, and every other option showed its enum rather than its
  // label. inbox-filters.tsx and dtr-toolbar.tsx already did this; these two
  // were simply missed.
  const statusItems: Record<string, string> = {
    [ALL]: "All statuses",
    ...Object.fromEntries(TASK_STATUS_OPTIONS.map((option) => [option.value, option.label])),
  };
  const listItems: Record<string, string> = {
    [ALL]: "All lists",
    ...Object.fromEntries(lists.map((list) => [list.id, list.name])),
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <div className="space-y-1.5">
        <Label htmlFor="status" className="text-xs text-muted-foreground">
          Status
        </Label>
        <Select
          items={statusItems}
          value={params.get("status") ?? ALL}
          onValueChange={(value) => setParam("status", value)}
        >
          <SelectTrigger id="status" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {TASK_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {lists.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="list" className="text-xs text-muted-foreground">
            List
          </Label>
          <Select
            items={listItems}
            value={params.get("list") ?? ALL}
            onValueChange={(value) => setParam("list", value)}
          >
            <SelectTrigger id="list" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All lists</SelectItem>
              {lists.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="priority" className="text-xs text-muted-foreground">
          Priority
        </Label>
        <Select
          items={priorityItems}
          value={params.get("priority") ?? ALL}
          onValueChange={(value) => setParam("priority", value)}
        >
          <SelectTrigger id="priority" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any priority</SelectItem>
            {[...TASK_PRIORITIES].reverse().map((value) => (
              <SelectItem key={value} value={value}>
                {TASK_PRIORITY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sort" className="text-xs text-muted-foreground">
          Sort by
        </Label>
        <Select
          items={sortItems}
          value={params.get("sort") ?? "due"}
          // `due` is the default, so choosing it REMOVES the parameter rather
          // than pinning it — a URL that says `?sort=due` claims a choice
          // somebody did not make, and it survives every later filter change.
          onValueChange={(value) => setParam("sort", value === "due" ? null : value)}
        >
          <SelectTrigger id="sort" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="due">Due date</SelectItem>
            <SelectItem value="priority">Priority</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={() => router.push("/tasks")}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
