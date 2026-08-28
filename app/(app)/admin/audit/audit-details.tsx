"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import type { AuditField } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * What the dialog draws.
 *
 * `created` and `deleted` are not diffs and must not be rendered as one — a
 * create has nothing on the left, and a column of em-dashes under a heading
 * saying "Changed" asks the reader to compare against nothing. 12,293 of the
 * 13,186 rows in the trail have a null `before`, so this is the common case,
 * not an edge one.
 */
export type AuditShape = "created" | "deleted" | "diff" | "empty";

export type AuditEntry = {
  id: string;
  entity_type: string;
  entity_id: string;
  /** The raw action, kept only so the list can pick the chip's tone. */
  action: string;
  /** Already humanised on the server — "Leave allocation set". */
  action_label: string;
  entity_label: string;
  actor_name: string | null;
  when: string;
  shape: AuditShape;
  /** Formatted on the server, ids already resolved to names. */
  fields: AuditField[];
};

/**
 * The recorded values for one audit row.
 *
 * A DIALOG rather than an expanding row. The payloads are wide — the leave
 * allocation entry carries nine leave types — and a row that grows to eleven
 * lines when clicked pushes every row below it down the page, which is the
 * opposite of what someone comparing two entries needs.
 *
 * Purely presentational: every value arrives as a string with its ids already
 * resolved, because that work needs the database and the browser has none.
 */
export function AuditDetails({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);

  const changed = entry.fields.filter((field) => field.changed);
  const unchanged = entry.fields.filter((field) => !field.changed);

  return (
    <>
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        Details
        {/* The row already names the action and the record; this button needs
            to say which row it belongs to for anyone tabbing through forty of
            them with no visible column context. */}
        <span className="sr-only">
          {" "}
          for {entry.action_label.toLowerCase()} on {entry.entity_label.toLowerCase()}, {entry.when}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {entry.action_label} — {entry.entity_label}
            </DialogTitle>
            <DialogDescription>
              {entry.actor_name ?? "System"} · {entry.when}
            </DialogDescription>
          </DialogHeader>

          {entry.shape === "empty" ? (
            // A real and common case, not an error: several call sites record
            // that something happened without a payload — a punch, a submit.
            // Saying so is better than an empty panel that reads as a failure.
            <p className="text-sm text-muted-foreground">
              No field values were recorded with this entry. The action itself is the record.
            </p>
          ) : entry.shape === "created" || entry.shape === "deleted" ? (
            // One column, because there is only one side. The heading says
            // which side it is, so "5" is never mistaken for a new value on a
            // delete or an old one on a create.
            <SingleTable
              caption={entry.shape === "created" ? "Values recorded" : "Values before deletion"}
              valueHeader={entry.shape === "created" ? "Set to" : "Was"}
              fields={entry.fields}
              side={entry.shape === "created" ? "after" : "before"}
            />
          ) : (
            <div className="space-y-5">
              {changed.length > 0 ? (
                <DiffTable caption="Changed" fields={changed} highlight />
              ) : null}

              {unchanged.length > 0 ? (
                <DiffTable caption="Unchanged at the time" fields={unchanged} />
              ) : null}
            </div>
          )}

          {/* The id, last and quiet. It is the only way to correlate this row
              with the same record elsewhere — pasting it into the search box
              returns that record's whole history — but it is a database value
              on an operator's screen, so it does not get to be a column. */}
          <p className="text-2xs text-muted-foreground">
            Record id <span className="font-mono select-all">{entry.entity_id}</span> — paste it
            into search to see everything that happened to this record.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The field name, with its parent path above it when it has one.
 *
 * The group is a second line rather than a "Allocations · Vacation Leave"
 * concatenation: nine rows all beginning with the same word push the part that
 * differs off to the right, which is exactly the scanning problem the flattened
 * rows exist to solve.
 */
function FieldName({ field }: { field: AuditField }) {
  return (
    <>
      {field.group ? (
        <span className="block text-2xs font-normal text-muted-foreground">{field.group}</span>
      ) : null}
      {field.label}
    </>
  );
}

/** A create or a delete: one side, so one value column. */
function SingleTable({
  caption,
  valueHeader,
  fields,
  side,
}: {
  caption: string;
  valueHeader: string;
  fields: AuditField[];
  side: "before" | "after";
}) {
  return (
    <TableFrame caption={caption}>
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th scope="col" className="px-3 py-2 text-left font-medium">
            Field
          </th>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            {valueHeader}
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.path} className="border-b last:border-b-0">
            <th scope="row" className="px-3 py-2 text-left align-top font-medium">
              <FieldName field={field} />
            </th>
            <td className="px-3 py-2 align-top wrap-break-word">{field[side]}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/** An edit: both sides, with the changed ones marked by more than weight. */
function DiffTable({
  caption,
  fields,
  highlight = false,
}: {
  caption: string;
  fields: AuditField[];
  highlight?: boolean;
}) {
  return (
    <TableFrame caption={caption}>
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th scope="col" className="px-3 py-2 text-left font-medium">
            Field
          </th>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            Before
          </th>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            After
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.path} className="border-b last:border-b-0">
            <th scope="row" className="px-3 py-2 text-left align-top font-medium">
              <FieldName field={field} />
            </th>
            <td className="px-3 py-2 align-top wrap-break-word text-muted-foreground">
              {field.before}
            </td>
            <td
              className={
                highlight
                  ? "px-3 py-2 align-top wrap-break-word font-medium text-foreground"
                  : "px-3 py-2 align-top wrap-break-word text-muted-foreground"
              }
            >
              {highlight ? (
                // The arrow is the second carrier — a changed side told apart
                // from an unchanged one by weight alone vanishes in greyscale
                // and in a printed copy.
                <span className="flex items-start gap-1.5">
                  <ArrowRight
                    aria-hidden
                    className="mt-1 size-3.5 shrink-0 text-foreground-faint"
                  />
                  <span>{field.after}</span>
                </span>
              ) : (
                field.after
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/**
 * A real `<table>` because it is tabular data with a header, and because the
 * shape has to survive 390px — where it scrolls inside its own container rather
 * than pushing the dialog sideways.
 */
function TableFrame({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">{caption}</p>
      <div className="overflow-x-auto rounded-lg border bg-card grade-surface">
        <table className="w-full text-sm">{children}</table>
      </div>
    </div>
  );
}
