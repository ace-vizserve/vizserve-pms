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

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-xl bg-card p-1 ring-1 ring-foreground/10">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setParam("view", tab.value === "all" ? "" : tab.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === tab.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
            aria-pressed={view === tab.value}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
        <div className="space-y-1.5">
          <Label htmlFor="status" className="text-xs text-muted-foreground">
            Status
          </Label>
          <Select
            value={params.get("status") ?? ALL}
            onValueChange={(value) => setParam("status", value)}
          >
            <SelectTrigger id="status" className="h-8 w-52">
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
              value={params.get("list") ?? ALL}
              onValueChange={(value) => setParam("list", value)}
            >
              <SelectTrigger id="list" className="h-8 w-48">
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
