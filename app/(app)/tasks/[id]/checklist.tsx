"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { Plus, Trash2, X } from "lucide-react";

import { SubtaskProgress } from "../inline";
import { TaskSection } from "./task-section";
import {
  addChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
} from "../actions";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { focusWithoutScroll } from "@/lib/focus";
import { CHECKLIST_LABEL_MAX } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P7-68 — THE PROCEDURE, next to the work.
 *
 * ⚠️ A CHECKLIST IS NOT A SUBTASK LIST, and this component exists because the
 * two should not look alike. A subtask has a status, an assignee and a due date,
 * and it belongs in queues; a checklist item is a step somebody ticks on the way
 * through — "Record number of malware attacks" — and belongs nowhere but here.
 * The 162 imported from ClickUp are monthly procedures, the same 19 steps every
 * time, and as subtasks they would have been 338 rows of noise in the board.
 *
 * ⚠️ THE TICK IS OPTIMISTIC AND DOES NOT REFRESH THE ROUTE. Ticking is the most
 * frequent thing anybody does here and it changes nothing else on the page, so
 * a `router.refresh()` per tick would throw away whatever is half-typed in the
 * box below to redraw a checkbox that already moved. Adding and removing DO
 * refresh — those change the list itself.
 */
export type ChecklistItem = {
  id: string;
  label: string;
  is_done: boolean;
  group_label: string | null;
};

export function Checklist({ taskId, items }: { taskId: string; items: ChecklistItem[] }) {
  /*
   * ⚠️ THE STATE LIVES HERE, NOT IN `AddStep`, because the control and the box
   * it opens are no longer next to each other. The button is in the section
   * HEADER — beside the progress bar, where "Add output" and "Add a subtask"
   * both are — and the input it opens belongs at the FOOT of the list, which is
   * where the next step goes. One of them has to own the flag and neither can
   * be the other's parent, so the section does.
   */
  const [adding, setAdding] = useState(false);
  /*
   * ⚠️ KEYED OFF `items`, so the optimistic state is rebuilt whenever the server
   * sends a new list. Without that, an item added by somebody else — or by the
   * add box below, which does refresh — would be drawn from a stale array.
   */
  const [shown, tick] = useOptimistic(items, (state, next: { id: string; is_done: boolean }) =>
    state.map((item) => (item.id === next.id ? { ...item, is_done: next.is_done } : item)),
  );

  const done = shown.filter((item) => item.is_done).length;

  /*
   * The headings a ClickUp checklist carried. Rendered in the order the items
   * arrive rather than sorted — `position` is the procedure's own order and
   * grouping must not reshuffle it.
   */
  const groups: { label: string | null; items: ChecklistItem[] }[] = [];
  for (const item of shown) {
    const last = groups[groups.length - 1];
    if (last && last.label === item.group_label) last.items.push(item);
    else groups.push({ label: item.group_label, items: [item] });
  }

  return (
    <TaskSection
      id="checklist"
      title="Checklist"
      /* The same bar the subtask list and the task row use, so "12/19" cannot
         come to mean two different things in one product. In the HEADER, so
         collapsing the section still tells you how far through it you are. */
      summary={<SubtaskProgress done={done} total={shown.length} />}
      /* The same treatment as Output and Subtasks: a labelled outline button on
         the heading line. A checklist whose only way in was a ghost link under
         the last item was the same "not obvious" problem one section down. */
      action={
        <Button type="button" variant="outline" size="xs" onClick={() => setAdding(true)}>
          <Plus />
          Add a step
        </Button>
      }>

      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No steps yet. Add the ones this task repeats every time.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {groups.map((group, index) => (
            <li key={group.label ?? `ungrouped-${index}`}>
              {group.label ? (
                <p className="mt-2 mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </p>
              ) : null}

              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <Row key={item.id} taskId={taskId} item={item} onTick={tick} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {adding ? <AddStep taskId={taskId} onClose={() => setAdding(false)} /> : null}
    </TaskSection>
  );
}

function Row({
  taskId,
  item,
  onTick,
}: {
  taskId: string;
  item: ChecklistItem;
  onTick: (next: { id: string; is_done: boolean }) => void;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.label);

  function toggle(next: boolean) {
    start(async () => {
      onTick({ id: item.id, is_done: next });

      const result = await setChecklistItemDone(taskId, { id: item.id, is_done: next });

      // The optimistic value reverts on its own when the transition ends, so a
      // failure needs no undo — only an explanation.
      if (!result.ok) toast.error(result.error);
    });
  }

  function save() {
    const label = draft.trim();
    if (!label || label === item.label) {
      setEditing(false);
      setDraft(item.label);
      return;
    }

    start(async () => {
      const result = await renameChecklistItem(taskId, item.id, { label });
      if (!result.ok) {
        toast.error(result.error);
        setDraft(item.label);
      }
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <li className="flex items-center gap-2">
        <Input
          ref={focusWithoutScroll}
          value={draft}
          maxLength={CHECKLIST_LABEL_MAX}
          aria-label="Step"
          className="h-8 text-sm"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
            if (event.key === "Escape") {
              setDraft(item.label);
              setEditing(false);
            }
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Cancel"
          className="size-7"
          onMouseDown={(event) => {
            // `onMouseDown`, before the input's blur fires and saves.
            event.preventDefault();
            setDraft(item.label);
            setEditing(false);
          }}>
          <X />
        </Button>
      </li>
    );
  }

  return (
    <li className="group/step flex items-start gap-2 rounded-sm py-0.5 hover:bg-accent/40">
      <Checkbox
        checked={item.is_done}
        disabled={pending}
        // The label is the accessible name; a second one would be read twice.
        aria-label={item.label}
        className="mt-0.5"
        onCheckedChange={(next) => toggle(Boolean(next))}
      />

      {/*
        ⚠️ A BUTTON, BECAUSE IT OPENS AN EDITOR. A `<label>` here would toggle
        the box on click and there would be no way to correct a typo without
        ticking the step. The checkbox keeps its own hit area and its own name.
      */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "flex-1 cursor-text text-left text-sm wrap-break-word",
          // Struck AND dimmed: strike-through alone disappears in a screenshot
          // at this size, and the state is already carried by the box itself.
          item.is_done && "text-muted-foreground line-through",
        )}>
        {item.label}
      </button>

      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${item.label}`}
        disabled={pending}
        // Visible on hover, and always on keyboard focus — a control that only
        // appears on hover is a control a keyboard user cannot find.
        className="size-7 opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100"
        onClick={() =>
          start(async () => {
            const result = await removeChecklistItem(taskId, item.id);
            if (!result.ok) toast.error(result.error);
          })
        }>
        <Trash2 />
      </Button>
    </li>
  );
}

/**
 * ⚠️ IT STAYS OPEN AFTER A SAVE. Somebody adding a procedure is adding six
 * steps, not one, and a box that closed itself after each would cost five extra
 * clicks and five trips back to the header. Escape closes it; so does leaving it
 * empty. The button that opened it lives in the section header — see the note
 * on `adding` above.
 */
function AddStep({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit() {
    const trimmed = label.trim();
    if (!trimmed) {
      onClose();
      return;
    }

    start(async () => {
      const result = await addChecklistItem(taskId, { label: trimmed });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setLabel("");
      inputRef.current?.focus({ preventScroll: true });
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        ref={inputRef}
        autoFocus
        value={label}
        disabled={pending}
        maxLength={CHECKLIST_LABEL_MAX}
        placeholder="Record the Secure Score"
        aria-label="New step"
        className="h-8 text-sm"
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            setLabel("");
            onClose();
          }
        }}
      />
      <Button type="button" size="sm" loading={pending} disabled={!label.trim()} onClick={submit}>
        Add
      </Button>
    </div>
  );
}
