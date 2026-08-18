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

  // Base UI's Select.Value renders the RAW VALUE unless the Root is given an
  // items map — which is why this trigger read literally "all" instead of
  // "Everyone in scope". Same gap that was already documented in the inbox
  // filters; this is the DTR's copy of it.
  const personItems: Record<string, string> = {
    all: "Everyone in scope",
    ...Object.fromEntries(people.map((person) => [person.id, person.full_name])),
  };

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
    /*
      Stacks rather than spreading across the page. This lives in the DTR page's
      left rail beside the table now, not in a full-width bar above it, so every
      control takes the rail's width — a native date input is close to its own
      minimum at 140px, and two of them side by side in a 19rem column is how
      you get a clipped picker on Windows.
    */
    <div className="flex flex-col gap-2 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <div className="space-y-1">
        <Label htmlFor="dtr-from" className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id="dtr-from"
          type="date"
          value={range.from}
          onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))}
          onBlur={(event) => apply({ from: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="dtr-to" className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id="dtr-to"
          type="date"
          value={range.to}
          onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))}
          onBlur={(event) => apply({ to: event.target.value })}
        />
      </div>

      {people.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="dtr-person" className="text-xs text-muted-foreground">
            Person
          </Label>
          <Select
            items={personItems}
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

      {canExport ? (
        <Button variant="outline" className="w-full" loading={exporting} onClick={download}>
          <Download className="size-4" />
          Export CSV
        </Button>
      ) : null}
    </div>
  );
}
