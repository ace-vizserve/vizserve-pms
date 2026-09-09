"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { CharacterCount } from "@/components/ui/character-count";
import { INTERNAL_REASON_MAX } from "@/lib/schemas/internal-requests";
import { fieldErrorsOf, fromAction } from "@/lib/query/mutate";
import { qk } from "@/lib/query/keys";
import { decideInternalRequest } from "./actions";

/** The Server Action, as a promise TanStack can drive `onError` off. */
const sendDecision = fromAction(decideInternalRequest);

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
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  /*
   * ------------------------------------------------------------------------
   * P11-05 / P12-19 — THE PANEL ANSWERS ON THE CLICK.
   *
   * ⚠️ IT DOES NOT PREDICT THE REQUEST'S NEW STATUS, and that distinction is
   * the point. A leave request at stage 2 that a lead approves does NOT become
   * Approved — it moves to stage 3 and waits for a manager (P9-04). Painting
   * "Approved" here would be a lie on the commonest path through this screen.
   *
   * What is certain is that THIS person has now decided, so that is what shows:
   * the two buttons are replaced by what they chose, and the real status arrives
   * with the invalidation.
   *
   * ⚠️ SO THIS WRITE PATCHES NO CACHE ENTRY, and the absence is the design.
   * There is nothing honest to put in `qk.approval(id)`: which branch of
   * `vizserve_pms_decide_internal_request` ran decides the new status, and a
   * correction rewrites a DTR row this panel cannot see. `useMutation`'s own
   * state carries the whole prediction — which also means `onError` has nothing
   * to roll back, and the form simply comes back carrying the reason, exactly as
   * ending the old transition did.
   *
   * ⚠️ `isSuccess` IS IN `decided` AND IS NOT OPTIONAL. `isPending` goes false
   * the instant the write returns, but this panel is unmounted by its PARENT,
   * which stops rendering it when `qk.approval(id)` comes back no longer
   * `PENDING_REVIEW` — a refetch `onSettled` has only just fired. The gap
   * between those two moments is what the old `useOptimistic` was held open
   * across `router.refresh()` to cover.
   * ------------------------------------------------------------------------
   */
  const submit = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      sendDecision(requestId, { decision, reason: reason.trim() || undefined }),

    onError: (mutationError) => {
      /* The field message where there is one — the reason has a server-side
         floor and this is the box it belongs beside. `fieldErrorsOf` is what
         `ActionResult.fieldErrors` exists for. */
      setError(fieldErrorsOf(mutationError)?.reason?.[0] ?? mutationError.message);
      toast.error(mutationError.message);
    },

    onSuccess: (data) => {
      // Said explicitly, because the whole value of a No Time-In request is
      // that approving it CHANGED something — and the DTR is a different screen.
      toast.success(
        data.dtrEntryId
          ? "Approved. The DTR record has been corrected."
          : `Request ${data.status.toLowerCase()}.`,
      );
    },

    /*
     * ⚠️ FIRED, NEVER AWAITED, AND FIVE ROOTS BECAUSE A DECISION REACHES FIVE
     * PLACES. `["approval"]` is this request and every part of it — the chain
     * gains a signature row, which is a different key from the request itself.
     * `["approvals"]` is the queue that sent somebody here. `qk.snapshot()` is
     * the rail's awaiting count. `qk.unread()` and `["inbox"]` because
     * `vizserve_pms_decide_internal_request` notifies the requester, and the
     * badge is on every page.
     *
     * These mirror the `revalidatePath` list the action still carries, which is
     * how the two are kept honest against each other.
     */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["approval"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
      void queryClient.invalidateQueries({ queryKey: qk.unread() });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const pending = submit.isPending;
  const decided =
    submit.isPending || submit.isSuccess ? (submit.variables ?? null) : null;

  function decide(decision: "approved" | "rejected") {
    setError(null);
    submit.mutate(decision);
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
        {decided ? (
          <p
            aria-live="polite"
            className="rounded-sm border bg-muted px-3 py-2 text-xs text-foreground-muted"
          >
            {decided === "approved" ? "Approving…" : "Rejecting…"} — waiting for the server to
            confirm what happens next.
          </p>
        ) : (
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
        )}
      </CardContent>
    </Card>
  );
}
