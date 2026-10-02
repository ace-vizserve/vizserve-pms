"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toCsv } from "@/lib/csv";
import { todayInAppZone } from "@/lib/dates";
import { downloadCsv } from "@/lib/download-file";

/**
 * P15-06 — "Export CSV" for a report table.
 *
 * Built in the browser from the rows the table already holds, so the file is
 * exactly what this reader can see: the page read them through RLS, and a
 * second server round-trip could only drift from it. Numbers go out raw — no
 * dashes, no "h" suffix — so a spreadsheet can sum them.
 */
export function ExportCsvButton({
  filename,
  rows,
  disabled,
}: {
  /** Without the date or extension, e.g. `vizserve-workload-design`. */
  filename: string;
  /** Header row first. Built lazily, on click. */
  rows: () => ReadonlyArray<ReadonlyArray<string | number | null | undefined>>;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => downloadCsv(toCsv(rows()), `${filename}-${todayInAppZone()}.csv`)}
    >
      <Download />
      Export CSV
    </Button>
  );
}
