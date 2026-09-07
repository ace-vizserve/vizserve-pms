"use client";

import { Undo2 } from "lucide-react";
import { startTransition, useActionState, useOptimistic, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

import { withdrawInternalRequest } from "./actions";

/**
 * P9-03 — the author takes their own request back.
 *
 * ⚠️ CONFIRMED, unlike every other button on this page. Withdrawing is the only
 * action here a person takes on their OWN work with no second signature, and it
 * cannot be undone — the request goes to WITHDRAWN and the way back is to file
 * a new one. Approve and reject are both somebody else's decision about
 * somebody else's request, and both already require a reason for the negative
 * path; this one asks for nothing, so the dialog is the whole safeguard.
 *
 * The rule that decides whether it is legal lives in
 * `vizserve_pms_withdraw_internal_request` and is mirrored on the server page
 * to decide whether this renders at all. Nothing is re-checked here — a check
 * in a client component is a suggestion.
 */
export function WithdrawButton({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  /*
   * P11-05 — the button answers on the click.
   *
   * ⚠️ IT REPLACES ITSELF RATHER THAN PREDICTING THE PAGE. The status pill,
   * the stage rail and the whole "waiting on" paragraph are rendered by the
   * server component around this one, and there is no honest way to reach up
   * and repaint them from here. What is certain is that the request is being
   * withdrawn and this control is finished — so it says so, and the page catches
   * up with the action's revalidation.
   *
   * The dialog closes with it. Leaving a modal up over a decision already taken
   * reads as the button not having worked.
   */
  const [withdrawing, setWithdrawing] = useOptimistic(false);

  const [, dispatch, pending] = useActionState(async () => {
      const result = await withdrawInternalRequest(requestId);

      if (!result.ok) {
        toast.error(result.error);
        // Left open. The commonest failure is somebody answering it seconds
        // ago, and closing the dialog on that message would hide the reason
        // the button is about to disappear.
        return;
      }

      toast.success("Request withdrawn.");
      setOpen(false);
    }, undefined);

  return (
    <>
      {withdrawing ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          Withdrawing…
        </p>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Undo2 className="size-3.5" aria-hidden />
          Withdraw
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw this request?</DialogTitle>
            <DialogDescription>
              It stops here and nobody is asked to decide it. Withdrawing is not the same as being
              rejected — the record will say you took it back — but you cannot undo it. File a new
              request if you change your mind.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
            {/* A form action rather than an onClick: React gives it its own
                transition, and the confirm still works with JS loading. */}
            <form
              action={() =>
                startTransition(() => {
                  setWithdrawing(true);
                  setOpen(false);
                  dispatch();
                })
              }
            >
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Withdrawing…" : "Withdraw"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
