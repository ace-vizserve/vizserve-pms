"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * P13-02 — A PEOPLE PICKER YOU CAN TYPE INTO.
 *
 * Amier, 21 Sep, looking at sixteen names in the Company-wide list: "in the
 * company wide please include search so that if the person are not there i can
 * just search it".
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN A SEARCH BOX INSIDE `<SelectContent>`. The
 * dialogs used Base UI's `Select`, whose popup is a real listbox: it owns
 * keyboard focus and runs its own typeahead, so an `<input>` placed inside it
 * competes for every keystroke with the component that is trying to jump to a
 * row beginning with those letters. That is fixable with enough
 * `stopPropagation`, and the fix is the kind that works until a library
 * version moves.
 *
 * `assignees.tsx` had already solved the same problem for the task page — a
 * Popover, a plain `Input`, and rows that are ordinary buttons — and its
 * comments record the two traps it cost (see `initialFocus` below). This is
 * that pattern, extracted so the dialogs can use it too rather than growing a
 * third variant.
 *
 * ⚠️ IT IS NOT A `Select` AND MUST NOT PRETEND TO BE. No hidden input, no
 * `name`, nothing in FormData. Both dialogs already read the picked ids out of
 * React state in their own `submit` — a `multiple` Select would have emitted
 * one input per value anyway — so the value lives in one place and this only
 * edits it.
 */

export type PickerOption = { id: string; full_name: string };

/**
 * Above this many options, the search box appears.
 *
 * ⚠️ A THRESHOLD RATHER THAN ALWAYS-ON, and it is a deliberate asymmetry. A
 * search box over four names is a control that can only ever be in the way; a
 * list of sixteen with no way to filter is the complaint this was built for. In
 * practice this means the box appears in a collaboration space and nowhere
 * else, which is exactly where it was asked for — without the picker having to
 * know what a collaboration space IS.
 *
 * Eight, because that is roughly where a department stops fitting on screen.
 */
const SEARCH_FROM = 8;

export function PeoplePicker({
  triggerId,
  options,
  value,
  onChange,
  summary,
  multiple = true,
  disabled = false,
  searchLabel = "Search people",
  emptyLabel = "Nobody by that name.",
  className,
}: {
  /** So the `<Label htmlFor>` in the dialog still points at something. */
  triggerId?: string;
  options: PickerOption[];
  value: string[];
  /**
   * ⚠️ NEVER CALLED WITH AN EMPTY ARRAY BY A SINGLE-SELECT PICKER, and callers
   * that need "at least one" must still enforce it themselves — this component
   * does not know what an empty selection would mean for the form behind it.
   * `NewPersonalTaskDialog` puts `MINE` back; that rule is its own.
   */
  onChange: (next: string[]) => void;
  /** The trigger's label. The caller owns the wording — see the dialogs. */
  summary: (value: string[]) => string;
  /** Single-select closes on pick; multi stays open so three clicks add three. */
  multiple?: boolean;
  disabled?: boolean;
  searchLabel?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  /*
   * ⚠️ A `useCallback` REF, NOT AN INLINE ONE. An inline callback ref is torn
   * down and re-run on EVERY render, so it would drag focus back off a row you
   * had tabbed to each time the list re-rendered — `assignees.tsx`'s note, and
   * it applies here for the same reason: typing re-renders this list.
   */
  const focusSearch = useCallback((node: HTMLInputElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  const searchable = options.length >= SEARCH_FROM;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((person) => person.full_name.toLowerCase().includes(needle));
  }, [options, query]);

  function toggle(id: string) {
    if (!multiple) {
      onChange([id]);
      setOpen(false);
      return;
    }
    onChange(value.includes(id) ? value.filter((held) => held !== id) : [...value, id]);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The query is per-opening. A filter still applied the next time the
        // popup opens is a list that looks short for no visible reason.
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <button
            id={triggerId}
            type="button"
            disabled={disabled}
            // Matched to `SelectTrigger` in components/ui/select.tsx so this
            // sits in a form beside real Selects without looking borrowed.
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-input-background px-3 py-2 text-sm",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              className,
            )}
          />
        }
      >
        <span className="min-w-0 truncate text-left">{summary(value)}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>

      {/* ⚠️ `initialFocus={false}` — WE FOCUS THE SEARCH BOX, BASE UI MUST NOT.
          Its default resolves to the first tabbable element in the popup, which
          IS the search box, and it focuses it WITHOUT `preventScroll`. The
          popup is portaled to `<body>`, so the browser scrolls the document to
          wherever it thinks that box is and the control you clicked leaves the
          screen. Verbatim from `assignees.tsx`, which is where this was found. */}
      {/* ⚠️ `min-w-[max(…)]`, NEVER `w-(--anchor-width)` — the lesson written out
          at length in `components/ui/select.tsx`. A hard cap at the trigger's
          width plus the list's own overflow clips rows mid-word, and `cn` is
          tailwind-merge, so two separate `min-w-*` classes would silently keep
          only the last and throw the floor away. One `max()`. */}
      <PopoverContent
        align="start"
        className="min-w-[max(14rem,var(--anchor-width))] max-w-[min(28rem,var(--available-width))] p-0"
        initialFocus={false}
      >
        {searchable ? (
          <div className="border-b p-2">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={focusSearch}
                value={query}
                placeholder={searchLabel}
                aria-label={searchLabel}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
        ) : null}

        <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable={multiple}>
          {visible.length === 0 ? (
            <p className="px-3 py-2 text-2xs text-muted-foreground">{emptyLabel}</p>
          ) : (
            visible.map((person) => {
              const picked = value.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  onClick={() => toggle(person.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                    "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none",
                  )}
                >
                  {/* The tick is reserved space whether or not it is shown, so
                      rows do not shift by 14px as things are picked — and the
                      name is never the only thing carrying the state. */}
                  <Check
                    aria-hidden
                    className={cn("size-4 shrink-0", picked ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0 truncate">{person.full_name}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
