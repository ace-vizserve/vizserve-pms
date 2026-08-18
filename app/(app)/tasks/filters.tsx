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

const ALL = "__all__";

/**
 * Filters in the URL, not in component state — the same reasoning as the
 * requests list: a bookmarkable, sendable view, and the server does the work.
 *
 * The view tabs are first because they are what people actually use. "Waiting on
 * my QA" is P3-08's screen expressed as a filter of this list rather than a
 * separate page — a second screen with a second set of rules is a second place
 * for them to drift.
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

  const view = params.get("view") ?? "all";
  const hasFilters = ["status", "view", "list"].some((key) => params.get(key));

  const tabs = [
    { value: "all", label: "All" },
    { value: "mine", label: "Mine" },
    { value: "qa", label: "Waiting on my QA" },
  ];

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
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg border bg-muted p-1">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setParam("view", tab.value === "all" ? "" : tab.value)}
            className={`rounded-sm px-3 py-1 text-xs font-[550] transition-all ${
              view === tab.value
                ? "border border-border bg-card grade-raised text-foreground shadow-raised"
                : "border border-transparent text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={view === tab.value}
          >
            {tab.label}
          </button>
        ))}
      </div>

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

        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={() => router.push("/tasks")}>
            <X />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
