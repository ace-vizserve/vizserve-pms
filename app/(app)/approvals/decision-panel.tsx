"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
    <div className="rounded-lg border bg-card p-5 shadow-ring">
      <h2 className="text-sm font-semibold">Your decision</h2>

      <div className="mt-4 space-y-2">
        <Label htmlFor="decision-reason">
          Reason <span className="text-muted-foreground">(required to reject)</span>
        </Label>
        <Textarea
          id="decision-reason"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why you are approving or rejecting."
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "decision-error" : undefined}
        />
        {error ? (
          <p id="decision-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
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
    </div>
  );
}
