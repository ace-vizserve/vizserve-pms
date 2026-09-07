"use client";

import { startTransition, useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { CharacterCount } from "@/components/ui/character-count";
import { INTERNAL_REASON_MAX } from "@/lib/schemas/internal-requests";
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
  /*
   * P11-05 — `useActionState`, driven by a form action below.
   *
   * The queueing matters less here than on a task list — nobody approves the
   * same request twice — but the pending flag and the action are now one thing
   * rather than a transition wrapped around a bare call, and the two buttons
   * submit a real form.
   */
  const [, dispatch, pending] = useActionState(
    async (_previous: void, decision: "approved" | "rejected") => {
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
    },
    undefined,
  );

  function decide(decision: "approved" | "rejected") {
    setError(null);
    startTransition(() => dispatch(decision));
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
          {/* ⚠️ THE CAP ONLY, NO FLOOR. The label already says "(required to
              reject)", and this same box is OPTIONAL when approving — a
              permanent "at least 5 characters" under it would be a demand the
              approve path never makes. The floor is enforced server-side and
              surfaces as the error below. */}
          <CharacterCount value={reason} max={INTERNAL_REASON_MAX} rich />
          {error ? (
            <p id="decision-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        {/* ⚠️ ONE FORM, TWO SUBMIT BUTTONS, each with its own `formAction`.
            React runs a form action in its own transition, which is what the
            pending state hangs off — and the panel keeps working before the
            JavaScript for this route has finished loading. */}
        <form className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="submit"
            className="flex-1"
            loading={pending}
            formAction={() => decide("approved")}>
            Approve
          </Button>
          <Button
            type="submit"
            variant="outline"
            className="flex-1"
            loading={pending}
            formAction={() => decide("rejected")}>
            Reject
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
