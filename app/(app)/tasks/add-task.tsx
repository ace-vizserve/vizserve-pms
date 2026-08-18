"use client";

import { useState } from "react";

import { TableCell, TableRow } from "@/components/ui/table";
import type { TaskStatus } from "@/lib/schemas/tasks";

import {
  ComposerCard,
  ComposerRow,
  ComposerTrigger,
  type Assignable,
} from "./task-composer";

/**
 * The open/closed half of inline creation.
 *
 * The composer needs client state; the list and the board are server components.
 * These two are the seam — small, and holding nothing but a boolean, so nothing
 * about a task crosses into the browser bundle to make a form appear.
 *
 * THE LIST ONE RENDERS `<tr>`s ON PURPOSE, both open and closed. It is handed to
 * `DataTable` as `appendRow`, which puts it inside the same `<tbody>` as the rows
 * above — the only way the composer's cells line up under the columns, because a
 * form in a div underneath has no way to know the widths the browser just
 * computed. A server component may pass a client component as a prop, which is
 * what makes this legal.
 */
export function GroupComposer({
  status,
  assignable,
  columnCount,
}: {
  status: TaskStatus;
  assignable: Assignable[];
  columnCount: number;
}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <ComposerRow status={status} assignable={assignable} onCancel={() => setOpen(false)} />
    );
  }

  return (
    <TableRow className="hover:bg-transparent">
      {/* One cell spanning the table, so the trigger sits under the first column
          where the name will be rather than in a column of its own. */}
      <TableCell colSpan={columnCount} className="p-0 whitespace-normal">
        <ComposerTrigger onOpen={() => setOpen(true)} />
      </TableCell>
    </TableRow>
  );
}

/** The board's half: a trigger that becomes a card in the column it belongs to. */
export function BoardComposer({
  status,
  assignable,
}: {
  status: TaskStatus;
  assignable: Assignable[];
}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div className="shrink-0 px-2 pb-2">
        <ComposerCard status={status} assignable={assignable} onCancel={() => setOpen(false)} />
      </div>
    );
  }

  return (
    <div className="shrink-0 px-2 pb-2">
      <ComposerTrigger onOpen={() => setOpen(true)} shape="column" />
    </div>
  );
}
