"use client";

import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ApproverDraft = { name: string; email: string };

export const MAX_APPROVERS = 5;

/** Each row must be complete; an untouched blank row is simply dropped. */
export function approverProblem(rows: ApproverDraft[]): string | null {
  for (const row of rows) {
    const name = row.name.trim();
    const email = row.email.trim();
    if (!name && !email) continue;
    if (!name) return "Give each approver a name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "Give each approver a valid email.";
  }
  return null;
}

export function filledApprovers(rows: ApproverDraft[]): ApproverDraft[] {
  return rows
    .map((row) => ({ name: row.name.trim(), email: row.email.trim() }))
    .filter((row) => row.name || row.email);
}

/**
 * P16-06 — who signs the finished work off after the requester, in order.
 * The requester is step 1; each row here is the next step.
 */
export function ApproversField({
  rows,
  onChange,
  error,
}: {
  rows: ApproverDraft[];
  onChange: (rows: ApproverDraft[]) => void;
  error: string | null;
}) {
  function update(index: number, patch: Partial<ApproverDraft>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 w-full border-b pb-2 text-sm font-semibold">Who approves the finished work</legend>
      <p className="text-xs text-muted-foreground">
        You approve first. Add anyone else who must sign it off — each gets their own email, in this order, after
        the one before approves.
      </p>

      <ol className="space-y-2">
        <li className="flex items-center gap-2 text-sm">
          <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">1.</span>
          <span className="text-muted-foreground">You</span>
        </li>
        {rows.map((row, index) => (
          <li key={index} className="flex items-start gap-2">
            <span className="w-6 shrink-0 pt-2 text-xs text-muted-foreground tabular-nums">{index + 2}.</span>
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`approver-name-${index}`} className="sr-only">
                  Approver {index + 2} name
                </Label>
                <Input
                  id={`approver-name-${index}`}
                  placeholder="Name"
                  value={row.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`approver-email-${index}`} className="sr-only">
                  Approver {index + 2} email
                </Label>
                <Input
                  id={`approver-email-${index}`}
                  type="email"
                  placeholder="Email"
                  value={row.email}
                  onChange={(event) => update(index, { email: event.target.value })}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove approver ${index + 2}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <X />
            </Button>
          </li>
        ))}
      </ol>

      {rows.length < MAX_APPROVERS ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { name: "", email: "" }])}>
          <Plus />
          Add approver
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
