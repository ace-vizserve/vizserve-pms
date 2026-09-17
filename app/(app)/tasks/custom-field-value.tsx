"use client";

import { Check, X } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { toDateString } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { formatDate, parseDateOnly } from "@/lib/dates";
import {
  TEXT_MAX,
  TEXTAREA_MAX,
  formatFieldNumber,
  optionsFor,
  type FieldValue,
  type ListField,
} from "@/lib/schemas/list-fields";
import { cn } from "@/lib/utils";

import { setTaskFieldValue } from "./field-actions";

/**
 * P7-73 — a custom field's value: drawn, and edited.
 *
 * `CustomFieldDisplay` is the read-only face, shared by the task list's cells
 * and the task page when the viewer cannot edit. `CustomFieldEditor` is the task
 * page's inline control, in the shape of `InlineDate` / `InlineList` in
 * `inline.tsx`: the value IS the button, and the popover is the editor.
 *
 * ⚠️ AN OPTION IS NEVER COLOUR ALONE. Every option chip carries its label.
 */

const EMPTY = <span className="text-foreground-faint">—</span>;

export function CustomFieldDisplay({
  field,
  value,
  compact = false,
}: {
  field: ListField;
  value: FieldValue | null;
  /** The table cell: one line, labels clipped, long text truncated. */
  compact?: boolean;
}) {
  switch (field.field_type) {
    case "CHECKBOX":
      return value === true ? (
        <span className="inline-flex items-center gap-1 text-success">
          <Check className="size-4" aria-hidden />
          <span className={compact ? "sr-only" : "text-xs"}>Yes</span>
        </span>
      ) : compact ? (
        <span className="sr-only">No</span>
      ) : (
        <span className="text-xs text-muted-foreground">No</span>
      );

    case "DROPDOWN":
    case "LABELS": {
      const options = optionsFor(field, value);
      if (options.length === 0) return EMPTY;
      return (
        <span className={cn("flex min-w-0 gap-1", compact ? "flex-nowrap overflow-hidden" : "flex-wrap")}>
          {options.map((option) => (
            <Chip key={option.id} tone={option.color} label={option.label} />
          ))}
        </span>
      );
    }

    case "NUMBER":
      return typeof value === "number" ? <span className="tabular-nums">{formatFieldNumber(field, value)}</span> : EMPTY;

    case "DATE":
      return typeof value === "string" ? <span className="tabular-nums">{formatDate(value)}</span> : EMPTY;

    case "TEXT":
    case "TEXTAREA":
      return typeof value === "string" ? (
        <span className={cn(compact ? "block max-w-56 truncate" : "whitespace-pre-wrap wrap-break-word")} title={compact ? value : undefined}>
          {value}
        </span>
      ) : (
        EMPTY
      );
  }
}

// A floor on the size, because an EMPTY field used to be a single faint dash —
// a few pixels wide, and read as "cannot click this".
const TRIGGER = cn(
  "-mx-1 inline-flex min-h-6 min-w-12 max-w-full items-center rounded-sm px-1 py-0.5 text-left",
  "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
);

const MENU_ROW = cn(
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
  "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
);

export function CustomFieldEditor({
  taskId,
  field,
  value,
  compact = false,
}: {
  taskId: string;
  field: ListField;
  value: FieldValue | null;
  /** The task list's cell: the value drawn on one line. The editor is the same. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  /*
   * `useOptimistic` inside a transition — see the note on `InlinePriority`. The
   * value moves on the click; if the server refuses, the transition ends and it
   * goes back to what the server still says.
   */
  const [shown, setShown] = useOptimistic(value);
  const [draft, setDraft] = useState("");

  function commit(next: FieldValue | null, { close = true }: { close?: boolean } = {}) {
    if (close) setOpen(false);
    startTransition(async () => {
      setShown(next);
      const result = await setTaskFieldValue(taskId, field.id, next);
      if (!result.ok) toast.error(result.error);
    });
  }

  function openWith(next: boolean) {
    // The draft starts from what is stored every time the editor opens, so a
    // cancelled edit never leaks into the next one.
    if (next) setDraft(shown === null ? "" : String(shown));
    setOpen(next);
  }

  const label = field.name;

  if (field.field_type === "CHECKBOX") {
    return (
      <Checkbox
        aria-label={label}
        checked={shown === true}
        onCheckedChange={(checked) => commit(checked === true ? true : null, { close: false })}
      />
    );
  }

  // Empty says what clicking does, rather than a dash that looks inert.
  const display =
    shown === null ? (
      <span className="text-xs text-foreground-faint">Add</span>
    ) : (
      <CustomFieldDisplay field={field} value={shown} compact={compact} />
    );

  if (field.field_type === "DROPDOWN" || field.field_type === "LABELS") {
    const multiple = field.field_type === "LABELS";
    const picked = new Set(shown === null ? [] : Array.isArray(shown) ? shown : [String(shown)]);
    // Archived options stay visible ONLY while a task still holds one, so it can
    // be taken off; nobody can pick one anew.
    const options = field.options.filter((option) => option.is_active || picked.has(option.id));

    function toggle(id: string) {
      if (!multiple) {
        commit(picked.has(id) ? null : id);
        return;
      }
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // In the field's option order, not the order clicked.
      const ordered = field.options.map((option) => option.id).filter((optionId) => next.has(optionId));
      commit(ordered.length === 0 ? null : ordered, { close: false });
    }

    return (
      <Popover open={open} onOpenChange={openWith}>
        <PopoverTrigger aria-label={`${label}. Change it.`} className={TRIGGER}>
          {display}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={picked.has(option.id)}
              onClick={() => toggle(option.id)}
              className={MENU_ROW}>
              <Chip tone={option.color} label={option.label} />
              {!option.is_active ? <span className="text-2xs text-muted-foreground">archived</span> : null}
              {picked.has(option.id) ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
            </button>
          ))}
          {picked.size > 0 ? (
            <button type="button" onClick={() => commit(null)} className={cn(MENU_ROW, "text-muted-foreground")}>
              Clear
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    );
  }

  if (field.field_type === "DATE") {
    const date = typeof shown === "string" ? (parseDateOnly(shown) ?? undefined) : undefined;
    return (
      <Popover open={open} onOpenChange={openWith}>
        <PopoverTrigger aria-label={`${label}. Change it.`} className={TRIGGER}>
          {display}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2">
          <div className="flex items-center gap-1.5">
            <Calendar
              mode="single"
              autoFocus
              aria-label={label}
              selected={date}
              defaultMonth={date}
              onSelect={(picked) => picked && commit(toDateString(picked))}
            />
            {shown !== null ? (
              <Button size="icon" variant="ghost" aria-label={`Clear ${label}`} onClick={() => commit(null)}>
                <X />
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Text, Text area, Number — typed, and saved on Save or Enter.
  function save() {
    const text = draft.trim();
    if (field.field_type === "NUMBER") {
      if (text === "") return commit(null);
      const number = Number(text);
      if (!Number.isFinite(number)) {
        toast.error(`${label} takes a number.`);
        return;
      }
      return commit(number);
    }
    commit(text === "" ? null : field.field_type === "TEXTAREA" ? draft : text);
  }

  return (
    <Popover open={open} onOpenChange={openWith}>
      <PopoverTrigger aria-label={`${label}. Change it.`} className={TRIGGER}>
        {display}
      </PopoverTrigger>
      <PopoverContent align="start" className={field.field_type === "TEXTAREA" ? "w-96 p-2" : "w-64 p-2"}>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}>
          {field.field_type === "TEXTAREA" ? (
            <Textarea
              aria-label={label}
              autoFocus
              rows={5}
              maxLength={TEXTAREA_MAX}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <Input
              aria-label={label}
              autoFocus
              inputMode={field.field_type === "NUMBER" ? "decimal" : undefined}
              maxLength={field.field_type === "TEXT" ? TEXT_MAX : undefined}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
