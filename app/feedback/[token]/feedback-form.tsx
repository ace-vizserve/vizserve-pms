"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RATING_LABELS } from "@/lib/schemas/client-approval";

import { submitFeedback } from "../../approve/[token]/actions";

/**
 * P4-10 — one rating, one optional comment.
 *
 * Radio buttons rather than stars, and each one labelled. A five-star widget
 * looks nicer and answers a different question for every person who uses it —
 * "3 out of what?" — and this data feeds Phase 6 reporting, where a number that
 * means different things to different clients is worse than no number.
 */
export function FeedbackForm({ token }: { token: string }) {
  const [pending, startTransition] = useTransition();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit() {
    if (rating === null) return;
    setError(null);

    startTransition(async () => {
      const result = await submitFeedback(token, { rating, comment: comment.trim() || undefined });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-success-subtle text-success">
          <Check className="size-5" />
        </div>
        <h2 className="text-base font-semibold">Thank you</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          That goes straight to the team who did the work.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium">How was it?</legend>
        <div className="mt-2 space-y-1.5">
          {[5, 4, 3, 2, 1].map((value) => (
            <label
              key={value}
              className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                rating === value ? "border-primary bg-primary/5" : "hover:bg-muted/50"
              }`}
            >
              <input
                type="radio"
                name="rating"
                value={value}
                checked={rating === value}
                onChange={() => setRating(value)}
                className="size-4 accent-primary"
              />
              <span className="font-medium tabular-nums">{value}</span>
              <span className="text-muted-foreground">{RATING_LABELS[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="feedback_comment">Anything else? (optional)</Label>
        <Textarea
          id="feedback_comment"
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="What went well, or what would have made it better."
        />
      </div>

      <Button onClick={submit} loading={pending} disabled={rating === null}>
        Send feedback
      </Button>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
