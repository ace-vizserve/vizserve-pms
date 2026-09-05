"use client";

import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function withdraw() {
    startTransition(async () => {
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
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="size-3.5" aria-hidden />
        Withdraw
      </Button>

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
            <Button variant="destructive" onClick={withdraw} disabled={pending}>
              {pending ? "Withdrawing…" : "Withdraw"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
