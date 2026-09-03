"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { cn } from "@/lib/utils";

import { updateTaskField } from "../actions";

/**
 * The task's name, on the one screen that could not change it.
 *
 * ⚠️ THIS PAGE RENDERED THE TITLE AS A PLAIN `<h1>`. The list could rename a
 * task from its row, the board could rename one from its card, and the detail
 * page — the screen you open to work on it — could not. `TaskWorkflow` even
 * takes `title` as a prop and sends it back on every Save, so the field was
 * being written on this page all along without ever being editable on it.
 *
 * A HEADING THAT BECOMES AN INPUT, not a pencil opening a popover. The row and
 * the card use a popover because there is no room for an editor in a table cell
 * and the title there is one of eight things competing for the space. Here the
 * title is the largest thing on the page and has a line to itself, so editing
 * in place is both possible and the obvious gesture — and a popover containing
 * one input, floating over a heading you can already see, would be ceremony.
 *
 * It writes through `updateTaskField`, the same action the row's rename calls.
 * A second path to the same column is a second set of rules to keep in step.
 */
export function EditableTitle({
  taskId,
  title,
  canEdit,
}: {
  taskId: string;
  title: string;
  /** The same test as the rest of the card: on the task, or leading it. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft is seeded when the editor OPENS, not synced by an effect. Same
  // shape as the row's rename, and it is also what keeps a title that changed
  // elsewhere — another tab, a revalidate — from being overwritten by a stale
  // draft sitting in this component. (Syncing it in an effect is a setState in
  // an effect, which the compiler rejects for cascading renders.)
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function commit() {
    const next = draft.trim();

    // Unchanged is not a save. An UPDATE writing the same title still bumps
    // `updated_at` and still says "Renamed", which is a lie about what happened.
    if (!next || next === title) {
      setDraft(title);
      setEditing(false);
      return;
    }

    startTransition(async () => {
      const result = await updateTaskField(taskId, { title: next });

      if (!result.ok) {
        // The heading on screen already shows the new value. Putting the old one
        // back is the whole contract here.
        setDraft(title);
        setEditing(false);
        toast.error(result.error);
        return;
      }

      toast.success("Renamed");
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <h1 className="group/title flex min-w-0 items-center gap-1.5 text-xl font-semibold tracking-tight">
        <span className="min-w-0 wrap-break-word">{title}</span>

        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
            aria-label={`Rename ${title}`}
            title="Rename"
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
              "hover:bg-accent hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              // Quiet until wanted, but never keyboard-only-invisible: it comes
              // back on focus as well as on hover, so tabbing to it still shows
              // where you are.
              "opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100",
            )}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </h1>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      disabled={pending}
      aria-label="Task name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(title);
          setEditing(false);
        }
      }}
      /*
       * A BARE `<input>`, and the one place in this app that is right.
       *
       * `Input` is a boxed control — its own fill, border and 40px height — and
       * this has to be the heading it replaces, at the heading's size and on the
       * heading's baseline. Dropping a field-shaped box into the top of the page
       * makes the title jump every time somebody clicks it. The states the
       * primitive carries are all present below; what is deliberately absent is
       * the box.
       */
      className={cn(
        "w-full max-w-2xl min-w-0 rounded-sm bg-transparent text-xl font-semibold tracking-tight",
        "-mx-1 px-1 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    />
  );
}
