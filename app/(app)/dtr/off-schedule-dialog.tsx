"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { correctionTypeFor, describeDeviationLong, type Deviation } from "@/lib/dtr-schedule";

/**
 * P7-40 — the prompt that fires when a punch lands off schedule.
 *
 * A DIALOG RATHER THAN A TOAST, which was Amier's call and is the right one. A
 * toast is dismissed by ignoring it, and the whole point of this prompt is that
 * the record now says something the person may want to dispute — a claim they
 * have a few seconds to notice and days to regret not noticing. A dialog is
 * seen. It is also the only interruption in the punch flow, and it only appears
 * when there is genuinely something to decide.
 *
 * IT NEVER FILES ANYTHING. Two ways out: open the request form with the day and
 * the scheduled time already chosen, or dismiss. The dialog cannot submit a
 * correction itself, because a correction is an attestation about when somebody
 * actually started work, and a one-click "yes fix it" would turn that into a
 * reflex — the approver would then be signing off a time the system invented and
 * nobody read.
 *
 * DISMISSAL IS NOT RECORDED, on purpose. There is no "don't show again", no
 * acknowledged flag, no row. If the deviation still stands tomorrow the DTR row
 * still offers the link, quietly, in the Request column. Persisting a dismissal
 * would mean the app knows the punch is wrong and has agreed to stop mentioning
 * it, which is a worse state than either fixing it or leaving it alone.
 */
export function OffScheduleDialog({
  deviation,
  workDate,
  punchedAt,
  onDismiss,
}: {
  deviation: Deviation | null;
  workDate: string;
  punchedAt: string;
  onDismiss: () => void;
}) {
  if (!deviation) return null;

  const type = correctionTypeFor(deviation.side);
  const href = `/approvals?type=${type}&date=${workDate}&time=${encodeURIComponent(deviation.scheduled)}`;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deviation.side === "in" ? "That time-in is late" : "That time-out is off schedule"}
          </DialogTitle>
          <DialogDescription>{describeDeviationLong(deviation, punchedAt)}</DialogDescription>
        </DialogHeader>

        {/* The recorded time STANDS unless somebody approves otherwise, and
            saying so here is the difference between an offer and an accusation.
            P5-02 makes a punch unoverwritable precisely so that the record
            cannot be quietly edited by the person it describes. */}
        <p className="text-xs text-muted-foreground">
          The time above is what the DTR now shows. If it is wrong — you started work earlier and
          clocked in late, say — request a correction and your team leader can approve it. If it is
          right, there is nothing to do.
        </p>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Not now</DialogClose>
          {/* A LINK, not a button — it navigates (§2.1). The two query
              parameters are narrowed again on arrival by narrowRequestPrefill,
              so this and a hand-typed URL are treated identically. */}
          <Button render={<Link href={href} />}>Request a correction</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
