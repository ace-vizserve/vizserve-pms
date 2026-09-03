"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { decideInternalRequest } from "./actions";

/**
 * P5-08 — approve or reject.
 *
 * No "return". P5-08 specifies two outcomes, and the engine's third is simply
 * not offered here.
 *
 * The reason box is always visible rather than appearing after Reject is
 * pressed: a required field that materialises on click reads as an error, and
 * an approver who wants to note *why* they approved should not have to reject
 * to get a box.
 */
export function DecisionPanel({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(decision: "approved" | "rejected") {
    setError(null);

    startTransition(async () => {
      const result = await decideInternalRequest(requestId, {
        decision,
        reason: reason.trim() || undefined,
      });

      if (!result.ok) {
        setError(result.fieldErrors?.reason?.[0] ?? result.error);
        toast.error(result.error);
        return;
      }

      // Said explicitly, because the whole value of a No Time-In request is
      // that approving it CHANGED something — and the DTR is a different screen.
      toast.success(
        result.data.dtrEntryId
          ? "Approved. The DTR record has been corrected."
          : `Request ${result.data.status.toLowerCase()}.`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your decision</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          {/* No `htmlFor`: the editor's input is a contenteditable `div`, which
              is not a labelable element, so `htmlFor` would resolve to nothing.
              The editor carries the same words as its `aria-label` instead. */}
          <Label>
            Reason <span className="text-muted-foreground">(required to reject)</span>
          </Label>
          <RichTextEditor
            value={reason}
            onChange={setReason}
            ariaLabel="Reason"
            invalid={Boolean(error)}
            placeholder="Why you are approving or rejecting."
            minHeight="min-h-20"
          />
          {error ? (
            <p id="decision-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" loading={pending} onClick={() => decide("approved")}>
            Approve
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            loading={pending}
            onClick={() => decide("rejected")}
          >
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
