"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { updateRequestApprover } from "./actions";

export type ApproverStep = {
  /** Null for step 1, the requester — not a row, and not editable here. */
  id: string | null;
  step: number;
  name: string;
  email: string;
  state: "approved" | "waiting" | "next" | "not_sent";
};

const STATE: Record<ApproverStep["state"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  approved: { label: "Approved", tone: "success" },
  waiting: { label: "Waiting", tone: "warning" },
  next: { label: "Next", tone: "neutral" },
  not_sent: { label: "Not sent yet", tone: "neutral" },
};

/**
 * P16-06 — the Gate 3 chain: who signs the work off, in order, and where it is.
 * A later approver can be corrected until their step comes up.
 */
export function ClientApprovers({
  requestId,
  steps,
  canEdit,
}: {
  requestId: string;
  steps: ApproverStep[];
  canEdit: boolean;
}) {
  return (
    <ol className="divide-y text-sm">
      {steps.map((step) => (
        <ApproverRow
          key={step.step}
          requestId={requestId}
          step={step}
          editable={canEdit && step.id !== null && (step.state === "next" || step.state === "not_sent")}
        />
      ))}
    </ol>
  );
}

function ApproverRow({ requestId, step, editable }: { requestId: string; step: ApproverStep; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(step.name);
  const [email, setEmail] = useState(step.email);
  const [pending, startTransition] = useTransition();
  const state = STATE[step.state];

  function save() {
    if (!step.id) return;
    startTransition(async () => {
      const result = await updateRequestApprover(requestId, step.id!, { name, email });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
      toast.success("Approver updated.");
    });
  }

  if (editing) {
    return (
      <li className="space-y-2 py-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={name} aria-label="Approver name" disabled={pending} onChange={(e) => setName(e.target.value)} />
          <Input
            value={email}
            type="email"
            aria-label="Approver email"
            disabled={pending}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} loading={pending}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 py-2">
      <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{step.step}.</span>
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {step.name}
          {step.step === 1 ? <span className="text-muted-foreground"> · requester</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">{step.email}</p>
      </div>
      <Chip tone={state.tone} label={state.label} />
      {editable ? (
        <Button size="icon-xs" variant="ghost" aria-label={`Edit approver ${step.step}`} onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
      ) : null}
    </li>
  );
}
