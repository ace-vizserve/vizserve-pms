"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * E2's period, in the URL rather than in state.
 *
 * The same reasoning as the task and request filters: a bookmarkable, sendable
 * view, and the server does the work. A lead who wants to send somebody "last
 * month across the department" sends a link.
 *
 * ONE ROW, ABOVE THE CHARTS, which is where the dataviz method puts filters —
 * controls interleaved with the figures they change make it unclear which chart
 * is filtered and which is not.
 *
 * The dates are not validated here. `/reports` narrows them server-side with the
 * same regex the schemas use and falls back to the current month, so a
 * hand-edited `?from=banana` renders the default period rather than erroring —
 * the posture `/timesheet` takes with `?week=banana`.
 */
export function RangePicker({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const params = useSearchParams();

  function set(key: "from" | "to", value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/reports?${next.toString()}`);
  }

  const custom = params.get("from") || params.get("to");

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <div className="space-y-1.5">
        <Label htmlFor="from" className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id="from"
          type="date"
          value={from}
          className="w-40"
          onChange={(event) => set("from", event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="to" className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id="to"
          type="date"
          value={to}
          className="w-40"
          onChange={(event) => set("to", event.target.value)}
        />
      </div>

      {/* Only when there is something to clear — a permanently visible reset on
          the default period is a control that does nothing. */}
      {custom ? (
        <Button variant="ghost" size="sm" onClick={() => router.push("/reports")}>
          <X />
          This month
        </Button>
      ) : null}
    </div>
  );
}
