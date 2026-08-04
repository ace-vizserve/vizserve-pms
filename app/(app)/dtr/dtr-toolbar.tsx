"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

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
import { exportDtrCsv } from "./actions";

export type DtrPerson = { id: string; full_name: string };

/**
 * P5-04 filters + P5-11 export.
 *
 * Filters go in the URL, like every other list in the app — a month someone is
 * looking at should survive a refresh and be pasteable into a message.
 */
export function DtrToolbar({
  people,
  from,
  to,
  userId,
  canExport,
}: {
  /** Empty for a plain member: there is nobody else they may look at. */
  people: DtrPerson[];
  from: string;
  to: string;
  userId: string | null;
  canExport: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [exporting, startExport] = useTransition();
  const [range, setRange] = useState({ from, to });

  function apply(next: Partial<{ from: string; to: string; user: string }>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === "all") query.delete(key);
      else query.set(key, value);
    }
    router.push(`/dtr?${query.toString()}`);
  }

  function download() {
    startExport(async () => {
      const result = await exportDtrCsv({ from: range.from, to: range.to, user_id: userId });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // Built and revoked in the same tick — a blob URL left dangling pins the
      // whole file in memory for the life of the document.
      const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.data.filename;
      anchor.click();
      URL.revokeObjectURL(url);

      toast.success("Export downloaded.");
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-ring sm:flex-row sm:items-end">
      <div className="grid flex-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="dtr-from">From</Label>
          <Input
            id="dtr-from"
            type="date"
            value={range.from}
            onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))}
            onBlur={(event) => apply({ from: event.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dtr-to">To</Label>
          <Input
            id="dtr-to"
            type="date"
            value={range.to}
            onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))}
            onBlur={(event) => apply({ to: event.target.value })}
          />
        </div>

        {people.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="dtr-person">Person</Label>
            <Select
              value={userId ?? "all"}
              onValueChange={(value) => apply({ user: value ?? undefined })}
            >
              <SelectTrigger id="dtr-person" className="w-full">
                <SelectValue placeholder="Everyone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone in scope</SelectItem>
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {canExport ? (
        <Button variant="outline" loading={exporting} onClick={download}>
          <Download className="size-4" />
          Export CSV
        </Button>
      ) : null}
    </div>
  );
}
