"use client";

import { AlignLeft, Archive, Calendar, CircleDot, Hash, Image, Mail, SeparatorHorizontal, SquareCheckBig, Type, Upload, Youtube } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CanvasField } from "@/lib/form-builder/canvas";
import { FIELD_TYPE_HINTS, FIELD_TYPE_LABELS } from "@/lib/form-builder/canvas";
import type { FieldType } from "@/lib/schemas/forms";
import { cn } from "@/lib/utils";

/**
 * P7-66 — THE LEFT PANE: CLICK A TYPE, GET A QUESTION.
 *
 * ⚠️ THIS REPLACED A DIALOG, AND THE DIALOG WAS THE THIRD ATTEMPT. Adding a
 * question used to be: press "Add question", read a modal listing eight types
 * with a hint under each, choose one, watch the modal close, then find where the
 * question landed. Three interactions and a context switch for the single most
 * common thing anybody does on this screen.
 *
 * A permanent rail costs one click and never covers the form. The eight types
 * are always visible, so choosing between them is reading rather than
 * remembering — which is what the dialog's hints were for, and they come along.
 *
 * ⚠️ IT IS NOT A DRAG SOURCE. dnd-kit is wired for REORDERING the list
 * (`lib/form-builder/dnd.tsx`), and dragging from a palette is a second, harder
 * gesture with its own drop targets and its own keyboard story — for an action
 * a click already performs. Every ordering path in this builder goes through
 * `planEntityReorder` (CLAUDE.md/`canvas.ts`); a palette drag would need a
 * second one.
 *
 * ⚠️ THE HIGHLIGHT IS "THE OPEN QUESTION IS THIS TYPE", NOT "CLICKING THIS DOES
 * SOMETHING DIFFERENT". Every button does the same thing whatever is
 * highlighted. It is there because the answer type also appears in the editor,
 * and two controls showing the same fact that disagree is worse than one.
 */

const TYPE_ICONS: Record<FieldType, React.ComponentType<{ className?: string }>> = {
  text: Type,
  textarea: AlignLeft,
  select: CircleDot,
  multiselect: SquareCheckBig,
  date: Calendar,
  file: Upload,
  email: Mail,
  number: Hash,
  section: SeparatorHorizontal,
  image: Image,
  youtube: Youtube,
};

export function QuestionTypes({
  types,
  currentType,
  disabled,
  archived,
  onAdd,
  onRestore,
}: {
  /**
   * The types this form may ask for, in the order they are offered.
   *
   * ⚠️ NOT THE WHOLE ENUM. An internal form is not offered File upload, because
   * `/respond` can accept no upload — the attachment machinery is request-shaped
   * end to end. See `offerableFieldTypes`.
   */
  types: ReadonlyArray<FieldType>;
  /** The open question's type, or null when nothing is open. */
  currentType: FieldType | null;
  /**
   * True while a save is on the wire.
   *
   * Not "while somebody is typing" — that was the old dirty-lock, and autosave
   * deleted it. A new question can be added on top of a half-typed one; the
   * document simply waits for both.
   */
  disabled: boolean;
  /**
   * The questions that are off the form but kept (`is_active = false`, R5).
   *
   * ⚠️ THEY LIVE IN THE RAIL, NOT UNDER THE LIST. This used to be a third
   * section at the foot of the middle column, below the questions and below the
   * open editor — so on a form with a few archived questions the canvas ended in
   * a block of things that are NOT on the form, in the column whose whole job is
   * showing what is. Worse, it grew without bound: nothing is ever deleted here,
   * so the pile only gets longer, and it pushed the editor further off screen
   * every time somebody archived something.
   *
   * A count in the rail says the same thing in one line and costs nothing when
   * the answer is "none" — the button is not rendered at all then.
   */
  archived: CanvasField[];
  onAdd: (type: FieldType) => void;
  onRestore: (entityId: string) => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <aside aria-label="Add question" className="min-h-0 overflow-y-auto border-r bg-card px-3 pt-4 pb-10">
      <h2 className="px-2 pb-2.5 text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Add question
      </h2>

      <ul className="flex flex-col gap-1">
        {types.map((type) => {
          const Icon = TYPE_ICONS[type];

          return (
            <li key={type}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAdd(type)}
                // The one-line "what would I use this for", kept off the rail
                // and reachable on hover. See the note under the list.
                title={FIELD_TYPE_HINTS[type]}
                className={cn(
                  "flex h-11 w-full items-center gap-2.5 rounded-lg border bg-card px-2.5 text-left text-sm font-medium grade-raised shadow-raised",
                  "hover:border-accent-border hover:bg-accent hover:text-accent-foreground",
                  "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
                  currentType === type && "border-primary bg-accent text-accent-foreground",
                )}>
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    currentType === type ? "text-accent-foreground" : "text-muted-foreground",
                  )}
                />
                <span className="truncate">{FIELD_TYPE_LABELS[type]}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        ⚠️ THE HINTS MOVED FROM UNDER EACH BUTTON TO UNDER THE LIST. Eight
        two-line cards is a 400px rail of explanatory text competing with the
        form for attention every second of every session — and the hints are
        read once, when somebody is new. One sentence about how the rail works
        earns its place; eight about what "Short text" means does not.

        The per-type hints still exist and are still shown, on hover, as the
        button's own title. `FIELD_TYPE_HINTS` is where they live.
      */}
      <p className="px-2 pt-3 text-xs leading-relaxed text-pretty text-muted-foreground">
        {/* The rule this states is `addField`'s: a question lands directly under
            the one you have open, so a form is written by working down it. */}
        Click a type to add it under the question you have open.{" "}
        {types.includes("file")
          ? "The type is fixed once the question has answers."
          : "File upload is not offered on an internal form — there is nowhere to put the file."}
      </p>

      {/*
        ⚠️ NOTHING AT ALL WHEN NOTHING IS ARCHIVED. A row reading "Archived · 0"
        is a permanent invitation to open an empty drawer; most forms never
        archive a question and should never learn the word.
      */}
      {archived.length === 0 ? null : (
        <>
          <Button className="mt-4 w-full" variant={"warning"} onClick={() => setArchiveOpen(true)}>
            <Archive aria-hidden className="size-4 shrink-0" />
            <span className="truncate">Archived</span>
            <span className="ml-auto tabular-nums">{archived.length}</span>
          </Button>

          <ArchivedDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            archived={archived}
            busy={disabled}
            onRestore={onRestore}
          />
        </>
      )}
    </aside>
  );
}

/**
 * The archived questions, on demand.
 *
 * ⚠️ IT CLOSES ITSELF WHEN THE LAST ONE IS RESTORED. The button that opened it
 * is not rendered at all at zero, so a dialog left standing over an empty list
 * would be a panel with no way back to it and nothing in it. `archived` is
 * derived from the builder store, so this re-renders on every restore and the
 * check is just a render-time one — no effect, no second source of truth.
 *
 * ⚠️ RESTORE, NOT DELETE. There is no delete here and there must not be: a
 * question is archived precisely because answers are filed under its
 * `field_key`, and `vizserve_pms_form_field_protect` refuses the delete anyway
 * (D20/R5). The sentence says so rather than leaving somebody hunting for the
 * button.
 */
function ArchivedDialog({
  open,
  onOpenChange,
  archived,
  busy,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archived: CanvasField[];
  busy: boolean;
  onRestore: (entityId: string) => void;
}) {
  const empty = archived.length === 0;

  return (
    <Dialog open={open && !empty} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archived · {archived.length}</DialogTitle>
          {/* Said once, above the list, rather than on every row: their answers
              are why these cannot simply be deleted (R5). */}
          <DialogDescription>
            Off the form, and kept. Answers already given to these are still stored and still have a column on the
            Responses tab.
          </DialogDescription>
        </DialogHeader>

        {/* Capped and scrolling: nothing here is ever deleted, so the list only
            grows, and a dialog taller than the window has no scrollbar of its
            own. */}
        <ul className="flex max-h-[60svh] flex-col gap-1.5 overflow-y-auto">
          {archived.map((field) => (
            <li key={field.id} className="flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {field.entity.attributes.label || "Untitled question"}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onRestore(field.id)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
