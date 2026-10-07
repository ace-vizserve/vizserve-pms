"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CANCEL_REASON_PRESETS } from "@/lib/schemas/approvals";

import { cancelRequest } from "./actions";

/**
 * P16-02 — cancel a client request: wrong form, duplicate, withdrawn.
 *
 * Not Reject. A refusal is a judgement on the work; this says the request
 * should not be here at all, and reports keep the two apart. The reason is
 * emailed to the client as typed.
 */
export function CancelRequestButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await cancelRequest(requestId, { reason });
      if (!result.ok) {
        setError(result.fieldErrors?.reason?.[0] ?? result.error);
        return;
      }
      toast.success("Cancelled. The client has been emailed the reason.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
        Cancel request
      </Button>

      <Dialog open={open} onOpenChange={(next) => (pending ? null : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this request?</DialogTitle>
            <DialogDescription>
              It closes without a task and does not count as a rejection. The client is emailed the reason
              word for word.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {CANCEL_REASON_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={reason === preset ? "default" : "outline"}
                  onClick={() => setReason(preset)}
                  disabled={pending}>
                  {preset.replace(/\.$/, "")}
                </Button>
              ))}
            </div>
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              disabled={pending}
              aria-invalid={Boolean(error)}
              placeholder="e.g. Submitted through the wrong form — please use the User Support form."
              onChange={(event) => setReason(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={submit} loading={pending} disabled={reason.trim().length < 3}>
              Cancel request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
