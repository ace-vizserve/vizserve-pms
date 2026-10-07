"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { toast } from "@/components/ui/toast";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";

import { setRequestUrgency } from "./actions";

type Urgency = "URGENT" | "NON_URGENT";

/**
 * P16-05 — change the urgency of approved work. The SLA date is recomputed
 * from the day it was approved, and the task's due date follows.
 */
export function UrgencyControl({
  requestId,
  urgency,
  urgentDays,
  normalDays,
}: {
  requestId: string;
  urgency: Urgency | null;
  urgentDays: number;
  normalDays: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(urgency);

  function change(next: Urgency) {
    if (next === shown) return;
    startTransition(async () => {
      setShown(next);
      const result = await setRequestUrgency(requestId, { urgency: next });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
      toast.success("Urgency changed — the due date moved with it.");
    });
  }

  return (
    <Segmented<Urgency> value={shown ?? undefined} onValueChange={change} disabled={pending} aria-label="Urgency">
      <SegmentedItem className="px-2.5 py-0.5" value="URGENT">
        Urgent · {urgentDays}d
      </SegmentedItem>
      <SegmentedItem className="px-2.5 py-0.5" value="NON_URGENT">
        Non-urgent · {normalDays}d
      </SegmentedItem>
    </Segmented>
  );
}
