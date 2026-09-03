"use client";

import { EyeOff, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";

import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CALENDAR_VISIBILITY_LABELS } from "@/lib/schemas/leave-types";
import { GENDER_LABELS, type Gender } from "@/lib/schemas/users";

import { createLeaveType, updateLeaveType } from "./actions";

export type CalendarVisibility = "FULL" | "LABEL_HIDDEN" | "HIDDEN";

export type LeaveTypeRow = {
  id: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  applies_to_gender: Gender | null;
  calendar_visibility: CalendarVisibility;
};

/** Shorter than the full sentence in the schema — the row has one line. */
const VISIBILITY_SHORT: Record<CalendarVisibility, string> = {
  FULL: "Full",
  LABEL_HIDDEN: "Label hidden",
  HIDDEN: "Hidden",
};

/**
 * The sentinel for "everyone" in the two selects.
 *
 * `<Select>` cannot carry an empty string or null as a selectable value — Base
 * UI uses null for "nothing selected", so an item with that value renders as a
 * permanently blank trigger. A named sentinel, mapped back to null at submit,
 * is one line in each direction and keeps "everyone" a real, pickable option
 * rather than the absence of one.
 */
const ANY_GENDER = "__ANY__";

/**
 * ⚠️ AND THE SENTINEL IS WHAT THE TRIGGER SHOWED. Base UI renders the raw value
 * in <SelectValue> unless the root is handed an `items` map, so this select read
 * "__ANY__" closed and "Everyone" open, and the one beside it read "LABEL_HIDDEN"
 * closed and "Label hidden" open — a database enum on screen, which §6 rules out
 * outright.
 */
const GENDER_ITEMS: Record<string, string> = {
  [ANY_GENDER]: "Everyone",
  FEMALE: GENDER_LABELS.FEMALE,
  MALE: GENDER_LABELS.MALE,
};

type Draft = {
  id: string | null;
  code: string;
  label: string;
  // A STRING, deliberately. `<input type="number">` reports a cleared field as
  // "", and `Number("")` is 0 — so a half-typed sort order would silently
  // become "first" rather than staying blank. Coerced once, at submit.
  sort_order: string;
  is_active: boolean;
  applies_to_gender: string;
  calendar_visibility: CalendarVisibility;
};

function draftFrom(type: LeaveTypeRow | null): Draft {
  return {
    id: type?.id ?? null,
    code: type?.code ?? "",
    label: type?.label ?? "",
    sort_order: String(type?.sort_order ?? 0),
    is_active: type?.is_active ?? true,
    applies_to_gender: type?.applies_to_gender ?? ANY_GENDER,
    calendar_visibility: type?.calendar_visibility ?? "FULL",
  };
}

export function LeaveTypesTable({ types }: { types: LeaveTypeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const isNew = draft?.id === null;

  function open(type: LeaveTypeRow | null) {
    setFieldErrors({});
    setDraft(draftFrom(type));
  }

  function submit() {
    if (!draft) return;
    setFieldErrors({});

    const payload = {
      label: draft.label,
      sort_order: draft.sort_order,
      is_active: draft.is_active,
      applies_to_gender: draft.applies_to_gender === ANY_GENDER ? null : draft.applies_to_gender,
      calendar_visibility: draft.calendar_visibility,
    };

    startTransition(async () => {
      const result = draft.id
        ? await updateLeaveType({ ...payload, id: draft.id })
        : await createLeaveType({ ...payload, code: draft.code });

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success(draft.id ? "Leave type updated." : "Leave type added.");
      setDraft(null);
      router.refresh();
    });
  }

  const columns: Column<LeaveTypeRow>[] = [
    {
      key: "label",
      header: "Leave type",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.label}</span>
          {/* The code, quietly. It is the stable identifier every rule is
              written against, so somebody reading a migration or an audit row
              needs to be able to find the type it names. */}
          <span className="text-[11px] text-muted-foreground">{row.code}</span>
        </div>
      ),
    },
    {
      key: "applies",
      header: "Applies to",
      cell: (row) =>
        row.applies_to_gender ? (
          GENDER_LABELS[row.applies_to_gender]
        ) : (
          <span className="text-muted-foreground">Everyone</span>
        ),
    },
    {
      key: "visibility",
      header: "On the shared calendar",
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          {row.calendar_visibility !== "FULL" ? (
            <EyeOff className="size-3.5 text-muted-foreground" aria-hidden />
          ) : null}
          {VISIBILITY_SHORT[row.calendar_visibility]}
        </span>
      ),
    },
    { key: "sort", header: "Order", align: "end", cell: (row) => row.sort_order },
    {
      key: "status",
      header: "Status",
      cell: (row) =>
        // The label is carried, never the colour alone — a retired row has to
        // read as retired in black and white.
        row.is_active ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Badge variant="outline">Retired</Badge>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <Button variant="ghost" size="sm" onClick={() => open(row)}>
          <Pencil className="size-3.5" aria-hidden />
          <span className="sr-only">Edit {row.label}</span>
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => open(null)}>
          <Plus className="size-4" aria-hidden />
          Add a leave type
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={types}
        getRowKey={(row) => row.id}
        rowClassName={(row) => (row.is_active ? undefined : "opacity-60")}
        empty="No leave types yet."
      />

      <Dialog open={draft !== null} onOpenChange={(next) => (next ? null : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isNew ? "Add a leave type" : "Edit leave type"}</DialogTitle>
            <DialogDescription>
              {isNew
                ? "The code is permanent once saved — rules and reports are written against it."
                : "The code cannot be changed. Rename with the label instead; nothing joins on it."}
            </DialogDescription>
          </DialogHeader>

          {draft ? (
            <div className="flex flex-col gap-4">
              {isNew ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={draft.code}
                    placeholder="STUDY"
                    onChange={(event) =>
                      setDraft({ ...draft, code: event.target.value.toUpperCase() })
                    }
                  />
                  {fieldErrors.code ? (
                    <p className="text-xs text-destructive">{fieldErrors.code[0]}</p>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
                {fieldErrors.label ? (
                  <p className="text-xs text-destructive">{fieldErrors.label[0]}</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applies_to_gender">Applies to</Label>
                <Select
                  items={GENDER_ITEMS}
                  value={draft.applies_to_gender}
                  // Base UI hands back `string | null`; null means cleared,
                  // which this select offers no way to reach. Falling back to
                  // the sentinel rather than to "" keeps the trigger labelled.
                  onValueChange={(value) =>
                    setDraft({ ...draft, applies_to_gender: value ?? ANY_GENDER })
                  }>
                  <SelectTrigger id="applies_to_gender">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(GENDER_ITEMS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Restricting a type hides it from everyone else&apos;s picker, and the database
                  refuses a request filed against it.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="calendar_visibility">On the shared calendar</Label>
                <Select
                  items={CALENDAR_VISIBILITY_LABELS}
                  value={draft.calendar_visibility}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      calendar_visibility: (value ?? "FULL") as CalendarVisibility,
                    })
                  }>
                  <SelectTrigger id="calendar_visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CALENDAR_VISIBILITY_LABELS) as CalendarVisibility[]).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {CALENDAR_VISIBILITY_LABELS[value]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The requester always sees their own leave in full. This decides what colleagues
                  see.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sort_order">Order in the picker</Label>
                <Input
                  id="sort_order"
                  type="number"
                  min={0}
                  max={999}
                  value={draft.sort_order}
                  onChange={(event) => setDraft({ ...draft, sort_order: event.target.value })}
                />
                {fieldErrors.sort_order ? (
                  <p className="text-xs text-destructive">{fieldErrors.sort_order[0]}</p>
                ) : null}
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                <div>
                  <Label htmlFor="is_active">Active</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {draft.is_active
                      ? "Offered when somebody files leave."
                      : "Retired. Not offered any more, and every request already filed under it is kept and still reported."}
                  </p>
                </div>
                <Switch
                  id="is_active"
                  checked={draft.is_active}
                  onCheckedChange={(checked) => setDraft({ ...draft, is_active: checked })}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
