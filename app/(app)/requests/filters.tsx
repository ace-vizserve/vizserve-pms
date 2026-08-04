"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REQUEST_STATUS_OPTIONS } from "@/components/status-badge";

const ALL = "__all__";

/**
 * Filters live in the URL rather than component state, so a Team Leader can
 * bookmark "my overdue VizMedia queue" and send it to someone else. It also
 * means the server does the filtering — this list only grows.
 */
export function RequestFilters({ forms }: { forms: { id: string; name: string }[] }) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI's Select emits `string | null` on clear, where Radix emitted "".
  // The falsy branch below already handles both.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    router.push(`/requests?${next.toString()}`);
  }

  const hasFilters = ["status", "form", "from", "to"].some((k) => params.get(k));

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="space-y-1.5">
        <Label htmlFor="status" className="text-xs text-muted-foreground">
          Status
        </Label>
        <Select value={params.get("status") ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="status" className="h-8 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {REQUEST_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="form" className="text-xs text-muted-foreground">
          Form
        </Label>
        <Select value={params.get("form") ?? ALL} onValueChange={(v) => setParam("form", v)}>
          <SelectTrigger id="form" className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All forms</SelectItem>
            {forms.map((form) => (
              <SelectItem key={form.id} value={form.id}>
                {form.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="from" className="text-xs text-muted-foreground">
          Submitted from
        </Label>
        <Input
          id="from"
          type="date"
          className="h-8 w-40"
          defaultValue={params.get("from") ?? ""}
          onChange={(e) => setParam("from", e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="to" className="text-xs text-muted-foreground">
          to
        </Label>
        <Input
          id="to"
          type="date"
          className="h-8 w-40"
          defaultValue={params.get("to") ?? ""}
          onChange={(e) => setParam("to", e.target.value)}
        />
      </div>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={() => router.push("/requests")}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
