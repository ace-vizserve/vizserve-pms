"use client";

import { useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { exportFormResponses } from "@/app/(app)/forms/actions";

/**
 * P7-66 — the Export CSV button on the Responses tab.
 *
 * ⚠️ THE FILE IS BUILT ON THE SERVER, NOT FROM WHAT IS ON SCREEN. The screen
 * caps its read at a thousand responses because it renders every one of them; an
 * export built from that array would silently be the same thousand, and a
 * truncated spreadsheet is a thing people draw conclusions from. The action
 * reads them all, as the caller, with RLS deciding which rows exist.
 *
 * It also means the file's columns come from the schema RECONCILED AGAINST THE
 * ROWS rather than from whatever the browser happens to be holding — so an
 * archived question's answers are in the file even if the tab was opened before
 * it was archived.
 *
 * A plain `<Button>` and a Blob rather than an `<a download>`: the CSV does not
 * exist until somebody asks for it, so there is no URL to point a link at.
 * Same shape as the DTR payroll export.
 */
export function ExportAnswers({ formId, disabled }: { formId: string; disabled: boolean }) {
  const [pending, startTransition] = useTransition();

  function onExport() {
    startTransition(async () => {
      const result = await exportFormResponses(formId);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      /*
       * The blob URL is built and revoked in the same tick, as the DTR export
       * does: one left dangling pins the whole file in memory for the life of
       * the page.
       */
      const url = URL.createObjectURL(
        new Blob([result.data.csv], { type: "text/csv;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.data.filename;
      anchor.click();
      URL.revokeObjectURL(url);

      toast.success("Answers downloaded.");
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // Nothing to export is not an error worth a round trip and a toast.
      disabled={disabled || pending}
      loading={pending}
      onClick={onExport}
    >
      <Download />
      Export CSV
    </Button>
  );
}
