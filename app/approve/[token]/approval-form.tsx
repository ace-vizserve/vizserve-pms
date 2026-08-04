"use client";

import { useState, useTransition } from "react";
import { Check, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { submitClientDecision } from "./actions";

/**
 * P4-04 — the decision half of the client page.
 *
 * Two things are load-bearing here and neither is decoration:
 *
 *   1. THE DEADLINE IS STATED ON THE PAGE, not only in the email. Amier at
 *      54:00, and the first of the three mitigations in docs/08 for the
 *      auto-complete rule. A client who is told plainly has no grounds to be
 *      surprised; one who was told once, in an email they may not have read,
 *      does.
 *   2. "Request changes" is not a rejection and is not styled as one. Amier's
 *      framing throughout is that negotiation is the normal path — a destructive
 *      red button here would make asking for a small fix feel like a complaint.
 */
export function ApprovalForm({
  token,
  requesterName,
  deadline,
}: {
  token: string;
  requesterName: string;
  deadline: string;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"idle" | "revision">("idle");
  const [comment, setComment] = useState("");
  const [name, setName] = useState(requesterName);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"APPROVED" | "REVISION_REQUESTED" | null>(null);

  function submit(decision: "APPROVED" | "REVISION_REQUESTED") {
    setError(null);

    startTransition(async () => {
      const result = await submitClientDecision(token, {
        decision,
        comment: comment.trim() || undefined,
        approver_name: name.trim() || undefined,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDone(decision);
    });
  }

  if (done) {
    return (
      <div className="rounded-xl bg-card ring-1 ring-foreground/10 p-8 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-success-subtle text-success">
          <Check className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">
          {done === "APPROVED" ? "Approved — thank you" : "Thanks, we are on it"}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          {done === "APPROVED"
            ? "The team has been told and this request is now complete. We will email you shortly to ask how it went."
            : "Your comments have gone straight to the person who did the work. They will come back to you with a revision."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10 p-6 sm:p-8">
      {mode === "idle" ? (
        <>
          <h2 className="text-sm font-semibold">Is this what you needed?</h2>

          <div className="mt-2 space-y-2">
            <Label htmlFor="approver_name" className="text-xs text-muted-foreground">
              Your name
            </Label>
            <Input
              id="approver_name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="max-w-xs"
            />
            {/* Q7 option (c). Weak as security, decent as accountability — the
                honest limit is that email forwarding defeats email identity, and
                a typed name at least records who actually clicked. */}
            <p className="text-xs text-muted-foreground">Recorded with your decision.</p>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => submit("APPROVED")} loading={pending}>
              <Check />
              Approve
            </Button>
            <Button variant="outline" onClick={() => setMode("revision")} disabled={pending}>
              <MessageSquare />
              Request changes
            </Button>
          </div>
        </>
      ) : (
        <>
          <h2 className="text-sm font-semibold">What needs changing?</h2>
          <div className="mt-3 space-y-2">
            <Textarea
              id="comment"
              rows={4}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="e.g. The date on the poster says 12 August — it should be 21 August. Everything else is great."
              aria-label="What needs changing"
            />
            <p className="text-xs text-muted-foreground">
              This goes straight to the person who did the work, word for word. Be as specific as
              you can and they can turn it around quickly.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => submit("REVISION_REQUESTED")}
              loading={pending}
              disabled={comment.trim().length < 10}
            >
              Send back for changes
            </Button>
            <Button variant="ghost" onClick={() => setMode("idle")} disabled={pending}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* The deadline, on the page, in plain language. Not a footnote in grey. */}
      <p className="mt-6 rounded-sm bg-warning-subtle px-3 py-2 text-xs text-warning">
        If we do not hear from you by <strong>{deadline}</strong>, this request will be closed as
        completed without a response.
      </p>
    </div>
  );
}
