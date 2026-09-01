"use client";

import { useTransition } from "react";
import { FileDown } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { downloadPdf } from "@/lib/download-file";

import { exportLeaveReport } from "@/app/(app)/hr/reports/actions";

/**
 * P7-53 — "Download my leave record".
 *
 * ⚠️ THIS IS THE VISIBLE HALF OF AN AMENDMENT TO D30. That decision said a
 * member running the leave report "gets an empty set rather than an error,
 * because you lead nobody is a true answer to this question". True of the
 * question the report used to ask — "what do the people you LEAD have left" —
 * and not of the one somebody actually has: what do *I* have left. P7-53 adds
 * an `u.id = auth.uid()` branch to both functions, and this is the button that
 * uses it.
 *
 * It calls the SAME action `/hr/reports` and `/admin/users` call. Nothing about
 * the scope is passed from here — the action derives it from the caller's own
 * context, so this button cannot produce a document that overstates what it
 * covers. For a plain member the PDF's header will read "Your own record".
 *
 * The year is not offered. This is a one-click convenience beside the balances
 * somebody is already looking at; anyone who needs a different year or a filter
 * wants the builder, and every person who has one is one click away from it.
 */
export function MyLeaveRecordButton({ year }: { year: number }) {
  const [pending, startExport] = useTransition();

  function download() {
    startExport(async () => {
      const result = await exportLeaveReport({ mode: "annual", year });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      downloadPdf(result.data.base64, result.data.filename);
      toast.success("Your leave record was downloaded.");
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={download} disabled={pending}>
      <FileDown className="size-4" aria-hidden />
      {pending ? "Building…" : "Download my leave record"}
    </Button>
  );
}
