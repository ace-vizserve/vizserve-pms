"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Columns3 } from "lucide-react";
import type { VisibilityState } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
/**
 * Only the three fields the menu reads. `Column<T>` satisfies it, and so does a
 * bare list of headings — which is what `/tasks` passes, because its columns are
 * built per status group and there is one menu above all eight of them.
 */
export type HideableColumn = {
  key: string;
  header: React.ReactNode;
  hideable?: boolean;
  /** Starts switched off, until somebody says otherwise. See the merge below. */
  defaultHidden?: boolean;
};

/**
 * P7-65 — WHICH COLUMNS ARE ON SCREEN, DECIDED BY THE PERSON READING.
 *
 * Until now the only thing that hid a column was a breakpoint: `hidden
 * lg:table-cell` on `Column.className`. That is a reasonable default and a poor
 * rule — a lead on a 13" laptop cannot see the estimate column at all, and
 * somebody on a 27" monitor is made to look at eight columns they never use.
 * The breakpoints stay as the DEFAULT; this lets a person override them.
 *
 * ⚠️ A COLUMN OPTS IN WITH `hideable`. Anything without it is structural — the
 * selection checkbox, the title, the status a group is keyed on — and hiding it
 * would leave a table nobody can read or act on. The menu simply does not list
 * them, rather than listing them disabled, because a control you may never use
 * is not a control.
 */

/**
 * Remembered per table, per browser.
 *
 * ⚠️ EVERY ACCESS IS WRAPPED. `localStorage` is not merely empty in a private
 * window — reading it THROWS in a few contexts (site data blocked, some
 * embedded webviews), and an unguarded read at module scope would take the
 * whole table down with it. A person who cannot store a preference should see
 * the default columns, not an error page.
 */
function parse(raw: string | null): VisibilityState | null {
  try {
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Anything but an object means somebody else wrote this key, or a previous
    // version of it. Ignore rather than trust.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as VisibilityState;
  } catch {
    return null;
  }
}

/**
 * P7-66 — THE STORED CHOICE WINS, KEY BY KEY.
 *
 * `defaultHidden` seeds the columns nobody has expressed an opinion about. It
 * must not be layered on top of the stored object, or a column somebody
 * deliberately switched ON would be switched off again on their next visit —
 * which reads as the preference not saving at all.
 *
 * So a default fills only the keys storage does not mention. A key present in
 * storage is a decision; a key absent from it is not.
 *
 * Exported, and pure, because this is the one piece of the columns menu with a
 * rule in it worth a test — `tests/unit/column-visibility.test.ts`.
 */
export function resolveVisibility(
  raw: string | null,
  defaultHiddenKeys: string[],
): VisibilityState {
  const stored = parse(raw) ?? {};
  const seeded: VisibilityState = {};

  for (const key of defaultHiddenKeys) {
    if (!(key in stored)) seeded[key] = false;
  }

  return { ...seeded, ...stored };
}

function write(key: string, value: VisibilityState) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A preference that cannot be saved is not worth a toast. The table is
    // still correct for this visit.
  }
}

/**
 * P7-65 — THE STORED PREFERENCE IS THE STATE, READ THROUGH
 * `useSyncExternalStore`.
 *
 * The obvious shape — `useState({})` plus an effect that reads storage and sets
 * it — is wrong twice. React's compiler lint rejects it outright ("calling
 * setState synchronously within an effect can trigger cascading renders"), and
 * it renders one frame of the wrong columns before correcting itself.
 *
 * `useSyncExternalStore` is built for exactly this: an external mutable source
 * read consistently on both sides of hydration. `getServerSnapshot` returns
 * null so the server renders the defaults, and the browser swaps to the stored
 * value during hydration rather than after it.
 *
 * ⚠️ THE SNAPSHOT IS THE RAW STRING, NOT THE PARSED OBJECT. `getSnapshot` must
 * return something referentially stable — parsing on every call would hand back
 * a new object each time, which React reads as "changed again" and loops
 * forever. The parse happens once, in the `useMemo` below.
 */
const CHANGED = "vizserve-pms:columns";

function subscribe(onChange: () => void) {
  // `storage` covers another tab; the custom event covers this one, which
  // `storage` deliberately does not fire for.
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

export function useColumnVisibility(
  tableId: string,
  columns?: HideableColumn[],
) {
  const storageKey = `vizserve-pms.columns.${tableId}`;

  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(storageKey);
      } catch {
        return null;
      }
    },
    // Server render: nobody has a preference yet, so the defaults stand.
    () => null,
  );

  /*
   * ⚠️ KEYED ON THE STRING, NOT THE ARRAY. Every caller builds its `columns`
   * inline, so the array is a new reference on every render and depending on it
   * would rebuild `visibility` each time — handing `DataTable` a fresh state
   * object on every pass for a value that almost never changes.
   */
  const defaults = (columns ?? [])
    .filter((column) => column.defaultHidden)
    .map((column) => column.key)
    .sort()
    .join(",");

  const visibility = useMemo<VisibilityState>(
    () => resolveVisibility(raw, defaults ? defaults.split(",") : []),
    [raw, defaults],
  );

  const onVisibilityChange = useCallback(
    (next: VisibilityState) => {
      write(storageKey, next);
      // Tell this tab. Without it the menu would only update on a reload.
      window.dispatchEvent(new Event(CHANGED));
    },
    [storageKey],
  );

  return { visibility, onVisibilityChange };
}

export function DataTableColumns({
  columns,
  visibility,
  onVisibilityChange,
  className,
}: {
  columns: HideableColumn[];
  visibility: VisibilityState;
  onVisibilityChange: (next: VisibilityState) => void;
  className?: string;
}) {
  const hideable = columns.filter((column) => column.hideable);
  // Nothing to offer, so no control. A menu with no items is worse than no menu.
  if (hideable.length === 0) return null;

  const hiddenCount = hideable.filter(
    (column) => visibility[column.key] === false,
  ).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className={className}>
            <Columns3 />
            Columns
            {/* The count is the only thing that says a table is not showing
                everything it has. Without it somebody who hid a column last
                week reads an incomplete table as the whole truth. */}
            {hiddenCount > 0 ? (
              <span className="text-muted-foreground tabular-nums">
                {hiddenCount} hidden
              </span>
            ) : null}
          </Button>
        }
      />

      <DropdownMenuContent align="end" className="w-52">
        {/*
          ⚠️ THE GROUP IS REQUIRED, NOT DECORATION. `DropdownMenuLabel` is Base
          UI's `Menu.GroupLabel` and `DropdownMenuCheckboxItem` its
          `Menu.CheckboxItem`; both read `MenuGroupContext`, so outside a
          `Menu.Group` they throw "MenuGroupContext is missing" and take the
          whole page down with them. Radix tolerated a bare label — this is one
          of the places the two libraries genuinely differ.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {hideable.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.key}
              checked={visibility[column.key] !== false}
              onCheckedChange={(checked) =>
                onVisibilityChange({
                  ...visibility,
                  [column.key]: Boolean(checked),
                })
              }
            >
              {/* `header` is a ReactNode and is usually a plain string; anything
                  richer would not belong in a menu row, so it is rendered as-is
                  and the column is expected to keep its heading readable. */}
              {column.header}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
