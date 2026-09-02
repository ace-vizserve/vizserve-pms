"use client";

import { ChevronDown, ChevronUp, Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FIELD_TYPE_LABELS } from "@/lib/form-builder/canvas";
import type { CanvasField } from "@/lib/form-builder/canvas";
import { FieldDragHandle, SortableFieldRow } from "@/lib/form-builder/dnd";

/**
 * P7-66 — THE NUMBERED LIST OF QUESTIONS.
 *
 * ⚠️ THE ROW IS A SUMMARY AND THAT IS NOW CORRECT, WHERE IT WAS THE BUG BEFORE.
 * Two rejected layouts put a summary card ("Long text · Required") in the MIDDLE
 * of the screen, which is where the form itself belongs — the complaint each
 * time was that the middle showed a description of the form rather than the
 * form. The form is now in the right-hand pane, drawn with the components a
 * respondent's browser draws. So the list can be a list: it is the thing you
 * sort and select with, and it never claims to be a preview.
 *
 * ⚠️ THE UP/DOWN BUTTONS ARE NOT GOING ANYWHERE. Drag is a POINTER-ONLY
 * enhancement over a working keyboard path (WCAG 2.2 AA 2.1.1, and 2.5.7 on
 * dragging movements). Both routes end in `planEntityReorder`; `arrayMove` is
 * never called. They are revealed on hover and focus rather than always drawn,
 * because eight rows with four buttons each is a wall of chrome — but
 * `focus-visible` keeps them reachable by Tab, which is the whole point.
 *
 * ⚠️ ARCHIVED QUESTIONS ARE A SEPARATE LIST, BELOW, NOT GREYED ROWS AMONG THE
 * LIVE ONES. An archived question is not on the form: it renders nowhere, it
 * cannot be answered, and it does not take a number. Leaving it in the sequence
 * would make the numbering on this screen disagree with the numbering the
 * respondent sees, which is the one thing the numbers are for.
 */

export function QuestionList({
  active,
  archived,
  selectedId,
  answeredIds,
  busy,
  onSelect,
  onMove,
  onRestore,
}: {
  active: CanvasField[];
  archived: CanvasField[];
  selectedId: string | null;
  /**
   * Questions with answers behind them.
   *
   * ⚠️ THE FORM'S SUBMISSION COUNT, NARROWED TO FIELDS THAT ARE ACTUALLY ROWS.
   * `vizserve_pms_form_field_protect` refuses a key rename or a delete once the
   * FORM has submissions — it does not count per field — so a question added
   * five minutes ago to a form with a thousand answers is equally locked. Saying
   * so on the row is what stops somebody discovering it from a refusal.
   */
  answeredIds: ReadonlySet<string>;
  /** True while a save is running: reordering mid-write would race it. */
  busy: boolean;
  onSelect: (entityId: string) => void;
  onMove: (entityId: string, direction: "up" | "down") => void;
  onRestore: (entityId: string) => void;
}) {
  return (
    <>
      <ul className="flex flex-col gap-2">
        {active.map((field, index) => (
          <SortableFieldRow key={field.id} id={field.id} disabled={busy}>
            <QuestionRow
              field={field}
              index={index}
              selected={selectedId === field.id}
              answered={answeredIds.has(field.id)}
              busy={busy}
              first={index === 0}
              last={index === active.length - 1}
              onSelect={() => onSelect(field.id)}
              onMove={(direction) => onMove(field.id, direction)}
            />
          </SortableFieldRow>
        ))}
      </ul>

      {archived.length > 0 ? (
        <section className="space-y-2 pt-5" aria-labelledby="archived-questions">
          <h3
            id="archived-questions"
            className="text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Archived · {archived.length}
          </h3>
          {/* Said once, above the list, rather than on every row: their answers
              are why these cannot simply be deleted (R5). */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Off the form, and kept. Answers already given to these are still
            stored and still have a column on the Responses tab.
          </p>

          <ul className="flex flex-col gap-1.5">
            {archived.map((field) => (
              <li
                key={field.id}
                className="flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {field.entity.attributes.label || "Untitled question"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRestore(field.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function QuestionRow({
  field,
  index,
  selected,
  answered,
  busy,
  first,
  last,
  onSelect,
  onMove,
}: {
  field: CanvasField;
  index: number;
  selected: boolean;
  answered: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onSelect: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const { attributes } = field.entity;

  return (
    /*
     * ⚠️ A `<div>` WITH AN ONCLICK, NOT A `<button>` WRAPPING EVERYTHING. The
     * row contains three real buttons (the grip, up, down); nesting those inside
     * a button is invalid HTML and browsers resolve it by unnesting the markup,
     * which breaks the layout before it breaks the semantics. The row's own
     * affordance is the label, which IS a button — so the keyboard path is a
     * real one and the large click target is a convenience over it.
     */
    <div
      onClick={onSelect}
      className={cn(
        "group relative flex cursor-pointer items-center gap-2.5 rounded-lg border bg-card py-3 pr-3 pl-2 grade-raised shadow-raised",
        "hover:border-accent-border",
        selected && "border-primary bg-accent",
      )}
    >
      {selected ? (
        // A 3px spine on the open row. Colour is not the only signal — the row
        // is also the one with the editor under it — but it is what makes the
        // pairing readable at a glance on a form with twenty questions.
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-primary"
        />
      ) : null}

      <span className="w-5.5 shrink-0 text-center text-xs font-semibold text-muted-foreground tabular-nums">
        {index + 1}.
      </span>

      <span className="min-w-0 flex-1">
        <button
          type="button"
          onClick={(event) => {
            // The row's handler would fire again on the way up and re-select the
            // same question — harmless, but it makes every click two.
            event.stopPropagation();
            onSelect();
          }}
          className="block max-w-full truncate text-left text-sm font-medium after:absolute after:inset-0 after:content-['']"
        >
          {attributes.label || (
            <span className="text-muted-foreground">Untitled question</span>
          )}
          {attributes.required ? (
            <>
              {" "}
              <span aria-hidden className="text-destructive">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          ) : null}
        </button>

        <span className="mt-px flex items-center gap-1.5 text-xs text-muted-foreground">
          {FIELD_TYPE_LABELS[field.entity.type]}
          {answered ? (
            <>
              <span aria-hidden>·</span>
              <Lock aria-hidden className="size-2.5" />
              {/* The word as well as the padlock: state is never conveyed by an
                  icon or a colour alone (CLAUDE.md). */}
              answered
            </>
          ) : null}
        </span>
      </span>

      {/*
        ⚠️ `z-10` AND `relative` — the label's `after:inset-0` overlay above is
        what makes the whole row clickable, and without this it would sit ON TOP
        of these three buttons and swallow every press.
      */}
      <span className="relative z-10 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy || first}
          aria-label={`Move ${attributes.label || "this question"} up`}
          onClick={(event) => {
            event.stopPropagation();
            onMove("up");
          }}
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy || last}
          aria-label={`Move ${attributes.label || "this question"} down`}
          onClick={(event) => {
            event.stopPropagation();
            onMove("down");
          }}
        >
          <ChevronDown />
        </Button>
        <FieldDragHandle
          label={`Drag to reorder ${attributes.label || "this question"}`}
        />
      </span>
    </div>
  );
}
