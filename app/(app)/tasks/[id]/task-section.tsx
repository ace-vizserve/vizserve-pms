"use client";

import { useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * P7-68 — ONE SECTION TREATMENT FOR THE WORK AREA.
 *
 * THE PROBLEM THIS SOLVES. The brief, the resolution, the output, the checklist
 * and the subtasks were five `<section className="space-y-2">` in a row, each
 * headed by a 12px semibold line and separated from the next by nothing at all.
 * Reported as "the whole area is tight, I can't tell that this bit is the
 * subtasks" — which is not a complaint about density but about BOUNDARIES: at a
 * glance there was no edge between one thing and the next, so the page read as
 * one long column of small text.
 *
 * ⚠️ A HAIRLINE, NOT A CARD, AND THAT IS THE EXISTING DECISION. `subtask-list`
 * says it in capitals — P7-56 pulled these OUT of cards deliberately, because
 * five bordered panels stacked inside one card is a box in a box in a box. The
 * fix for "no boundary" is a boundary, not a container: a rule above each
 * section and room around it. Depth stays outward-only (§1.5) and nothing here
 * carries a shadow.
 *
 * ⚠️ THE HEADER IS A BUTTON AND THE HEADING STAYS A HEADING. `<h3>` wrapping a
 * `<button>`, not a button labelled like a heading — a screen reader's
 * document outline is how somebody navigates a page this long, and a section
 * whose title is only a control disappears from it.
 *
 * ⚠️ THE STATE IS REMEMBERED PER SECTION, PER BROWSER, and every access is
 * wrapped: `localStorage` does not merely come back empty in a private window,
 * it THROWS in a few contexts, and an unguarded read would take the task page
 * down over a collapsed panel. `components/data-table-columns.tsx` carries the
 * same note for the same reason.
 */

const KEY = (id: string) => `vizserve-pms:task-section:${id}`;

function readStored(id: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(KEY(id));
    if (raw === "open") return true;
    if (raw === "closed") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function write(id: string, open: boolean) {
  try {
    window.localStorage.setItem(KEY(id), open ? "open" : "closed");
  } catch {
    // A preference that cannot be saved is not worth a toast. The section is
    // still correct for this visit.
  }
}

export function TaskSection({
  id,
  title,
  summary,
  action,
  defaultOpen = true,
  children,
}: {
  /** Stable across renders and versions — it is the storage key. */
  id: string;
  title: string;
  /**
   * The one thing worth knowing while it is CLOSED — a progress bar, a count.
   * Rendered in the header, so collapsing a section never hides whether it has
   * anything in it.
   */
  summary?: React.ReactNode;
  /**
   * A control that belongs to the section rather than to one row in it — "Add
   * output", say.
   *
   * ⚠️ OUTSIDE THE TOGGLE, NOT INSIDE IT. A button nested in a button is
   * invalid HTML and behaves like it: the click bubbles and the section
   * collapses under the thing you just pressed.
   */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  /*
   * ⚠️ THE INITIALISER RUNS ONCE, IN THE BROWSER, and that is the point. Reading
   * storage during render would differ between the server pass and the first
   * client pass and hydrate mismatched; `useState(() => …)` in a client
   * component runs after hydration has already decided the markup.
   */
  const [open, setOpen] = useState(() =>
    typeof window === "undefined" ? defaultOpen : readStored(id, defaultOpen),
  );

  const toggle = useCallback(() => {
    setOpen((was) => {
      write(id, !was);
      return !was;
    });
  }, [id]);

  return (
    <section
      data-slot="task-section"
      /*
       * The rule above, and the room around it. `first:` clears it for whichever
       * section leads the stack, so the group does not open with a line hanging
       * under the card's own header.
       */
      className="border-t border-border pt-4 first:border-t-0 first:pt-0"
      aria-labelledby={`task-section-${id}`}>
      <div className="flex items-center gap-2">
      <h3 id={`task-section-${id}`} className="min-w-0 flex-1 text-xs font-semibold text-foreground">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`task-section-body-${id}`}
          /*
           * Full width so the whole header line is the target — §5.8 wants 24px
           * minimum and this is the difference between a 12px chevron and a
           * comfortable row. `-mx-1 px-1` keeps the hover tint off the column
           * edge without moving the text.
           */
          className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              // `motion-reduce` because a rotating glyph is motion, small or not
              // (§5.7). The state survives it — `aria-expanded` is the fact.
              "motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {title}
          {summary}
        </button>
      </h3>

      {/* Hidden while collapsed: a section you have folded away should not keep
          offering to add things to it. */}
      {open ? action : null}
      </div>

      {/*
        ⚠️ UNMOUNTED WHEN CLOSED, not hidden. These sections hold live controls —
        a comment box, a checklist somebody is typing into — and a `hidden`
        subtree keeps every one of them in the tab order and in the accessibility
        tree, which is how a collapsed panel silently swallows a Tab press.
      */}
      {open ? (
        <div id={`task-section-body-${id}`} className="mt-2 space-y-2">
          {children}
        </div>
      ) : null}
    </section>
  );
}
