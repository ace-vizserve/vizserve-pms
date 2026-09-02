"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { DataTableColumns } from "@/components/data-table-columns";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The list shell every table in the app sits in.
 *
 * Six pages had grown their own copy of this markup with small divergences —
 * one used `overflow-hidden` where the rest used `overflow-x-auto`, another
 * added a `min-w`. That is the drift this exists to stop.
 *
 * `overflow-hidden` is what keeps the first and last rows from spilling past
 * the rounded corner.
 */
export function DataTableShell({
  className,
  header,
  children,
}: {
  className?: string;
  /**
   * The controls strip, ABOVE the horizontal scroller rather than inside it.
   *
   * ⚠️ THE PLACEMENT IS THE POINT. The rows scroll sideways on a wide table; a
   * search box that scrolled away with them would be a control you have to go
   * looking for. It sits outside the scroller so it stays put.
   */
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg",
        className,
      )}
    >
      {header}
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

/**
 * ⚠️ THIS FILE IS `"use client"`, AND THAT IS THE COST OF THE LIBRARY.
 *
 * It used to be server-safe, so a page could declare its columns inline and
 * hand over `cell` closures. `useReactTable` is a hook, so the table has to run
 * in the browser — and a function cannot cross the RSC boundary. Every page
 * therefore declares its columns in a client component of its own
 * (`*-table.tsx`) and the server page passes it plain, serialisable rows.
 *
 * Six tables were already shaped that way before this change; the rest were
 * moved to match.
 *
 * ⚠️ SORTING IS `manualSorting` WHEREVER THE PAGE DOES NOT HOLD EVERY ROW.
 *
 * TanStack sorts the rows it has been given. `/inbox` and `/admin/audit` hold
 * one page of a `.range()`, `/requests` is capped at 200, `/tasks` and `/dtr`
 * are filtered server-side — so client sorting on any of them would silently
 * reorder the current page and call it a sort. Those pass `urlSort`, the URL
 * stays the source of truth, and Postgres does the ordering. A table that
 * genuinely holds all its rows may leave it off and sort in the browser, which
 * is honest because there is nothing else to see.
 */

export type Column<T> = {
  /** Stable key — also the React key for the cell. */
  key: string;
  header: React.ReactNode;
  /**
   * Cell renderer. Gets the row, its index, and the row's own controls.
   *
   * `controls` is how a cell draws an expand chevron without the call site
   * needing a TanStack row object — see `RowControls`.
   */
  cell: (row: T, index: number, controls: RowControls) => React.ReactNode;
  /** Applied to both the `th` and every `td`, e.g. `hidden sm:table-cell`. */
  className?: string;
  /** Right-align numerics. */
  align?: "start" | "end";
  /**
   * Makes the header a sort control.
   *
   * The value is what goes in `?sort=`, and the server maps it to a LITERAL
   * `.order()` call. Never pass it through to Postgres: an unknown column name
   * arrives as `invalid input value for enum` and 500s the page.
   */
  sortKey?: string;
  /** Offered in the columns menu. A column nobody may hide simply omits it. */
  hideable?: boolean;
  /**
   * Present in the menu but switched OFF until somebody turns it on.
   *
   * For a column that is genuinely useful and genuinely not wanted by default —
   * most of what P7-66 added, which is data these queries were already fetching
   * and throwing away. Widening every table by four columns to surface it would
   * have made the common case worse to fix the uncommon one.
   *
   * ⚠️ MEANINGLESS WITHOUT `hideable`, and unreachable without a menu on the
   * page: a column hidden by default with no way to show it is a column that
   * does not exist.
   */
  defaultHidden?: boolean;
  /**
   * Freeze this column against the left edge while the rest scrolls sideways.
   *
   * ⚠️ ONE COLUMN ONLY, AND IT MUST BE THE FIRST. TanStack can offset a stack of
   * pinned columns, but only from column SIZES — and every width in this app
   * comes from a Tailwind class on `className` (`max-w-xs`, `hidden
   * lg:table-cell`), so there are no sizes to add up. A second pinned column
   * would be positioned at `left: 0` on top of the first. The table honours the
   * first `pin: "left"` it finds and ignores the rest.
   */
  pin?: "left";
  /**
   * What this column sorts BY, when the browser is doing the sorting.
   *
   * ⚠️ WITHOUT AN ACCESSOR A CLIENT-SORTED HEADER DOES NOTHING. `cell` returns
   * a ReactNode, and TanStack sorts on the value an accessor yields rather than
   * on the markup — so a column with neither would return `undefined` for every
   * row, compare equal, and leave the order untouched while the arrow dutifully
   * flipped. The default accessor reads the row's own field of the same name;
   * this is for the columns where that is not the value: a count kept in a
   * lookup, a percentage that is computed, a number nested under `byStatus`.
   *
   * Tables using `urlSort` ignore it — Postgres does their ordering, and the
   * rows arrive already in it.
   */
  sortValue?: (row: T) => string | number | null | undefined;
};

export type SortDirection = "asc" | "desc";

/** What a cell can know about its own row beyond the data in it. */
export type RowControls = {
  /** How deep in the sub-row tree. 0 is a top-level row. */
  depth: number;
  /** This row has children, so a chevron is worth drawing. */
  canExpand: boolean;
  isExpanded: boolean;
  toggleExpanded: () => void;
};

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty,
  footer,
  onRowHref,
  rowClassName,
  bare = false,
  appendRow,
  className,
  urlSort = false,
  defaultSort,
  toolbar,
  count,
  getSubRows,
  columnVisibility,
  onColumnVisibilityChange,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  /**
   * Classes for one row, from the row itself.
   *
   * Deliberately a function of the row rather than a `variant` prop — the table
   * has no business knowing what a client task is, and the next caller that
   * wants to mark a row will want to mark it for a different reason.
   */
  rowClassName?: (row: T) => string | undefined;
  empty?: React.ReactNode;
  /**
   * A totals row, as `<tr>` content. Inside the table rather than under it
   * because a total that sits outside the element it totals is a number a
   * screen reader reads with no relationship to the figures above it.
   */
  footer?: React.ReactNode;
  /** When set, the whole row becomes a link target for pointer users. */
  onRowHref?: (row: T) => string | undefined;
  /**
   * Drop the shell, for a table already inside a bounded surface — the status
   * groups on the task list, where the group IS the panel.
   */
  bare?: boolean;
  /**
   * A `<tr>` appended inside `<tbody>`, after the rows and regardless of how
   * many there are. For the task list's inline composer, which has to line up
   * under the columns.
   */
  appendRow?: React.ReactNode;
  className?: string;
  /**
   * Sorting goes through the URL and the server does the ordering.
   *
   * ⚠️ SET THIS ON ANY TABLE THAT DOES NOT HOLD EVERY ROW — anything paginated,
   * ranged or capped. Left false, TanStack sorts the array it was given, which
   * on a paginated list means reordering the current page and calling it a
   * sort.
   *
   * The current values are read from `?sort=` and `?dir=` here rather than
   * passed in: a callback cannot cross the RSC boundary, and the server page
   * has to read the same two params anyway to build its query. One reader on
   * each side of the wire, no prop to keep in step.
   */
  urlSort?: boolean;
  /**
   * The order the table STARTS IN when the URL names none.
   *
   * ⚠️ IT NEVER REACHES THE QUERY STRING. A first paint still carries no
   * `?sort=`. What it fixes is a header that was lying: `/requests` arrives
   * ordered newest-first, the URL said nothing, so every column drew the
   * neutral two-way glyph — and the first click on that column then asked for
   * the order the rows were ALREADY in, which is why "Submitted at" could not
   * be sorted ascending at all.
   *
   * It means two subtly different things either side of `urlSort`. On a
   * server-sorted table it DESCRIBES an order Postgres already applied, and
   * `?sort=` overrides it. On a browser-sorted one it ASKS for that order:
   * `getSortedRowModel` really does reorder the rows to match, and the first
   * click moves away from it like any other seeded state. Seeding it here used
   * to be forbidden for exactly that reason — the rows would have been PINNED,
   * because every click on a browser table was discarded. They are not any
   * more, so the gate is gone.
   *
   * `key` is a `sortKey` value — what `?sort=` speaks — not a column `key`, the
   * same namespace `Column.sortKey` uses. A server page holds this default too,
   * because it has to build the query; the two are one fact stated on either
   * side of the wire, and they have to be changed together.
   */
  defaultSort?: { key: string; dir: SortDirection };
  /**
   * The search box and filter controls, rendered in the table's own header
   * strip.
   *
   * ⚠️ THEY BELONG TO THE TABLE, so they live inside its border. Every page
   * used to lay its own controls out and the columns menu was rendered
   * separately by the table component, which is exactly how the button ended up
   * stranded on its own row underneath: two owners, one row, no way to align
   * them. One owner now.
   */
  toolbar?: React.ReactNode;
  /** The result count, beside the filters that produced it. */
  count?: React.ReactNode;
  /**
   * The children of a row, if it has any. Supplying it turns on expand/collapse.
   *
   * Expansion state is held HERE rather than in the URL, unlike sorting. Sorting
   * changes which rows exist and has to reach the server; opening a parent
   * changes only what this person is looking at, and putting it in the query
   * string would make every collapse a navigation and every shared link carry
   * somebody else's reading position.
   */
  getSubRows?: (row: T) => T[] | undefined;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (next: VisibilityState) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /* Every parent open on first paint: a subtask hidden by default is a subtask
     nobody discovers, and these lists are short. */
  const [expanded, setExpanded] = useState<ExpandedState>(true);

  const manual = urlSort;

  /*
   * ⚠️ `?sort=` IS ONLY HONOURED WHEN IT NAMES A COLUMN THIS TABLE HAS.
   *
   * Every server page runs its raw `?sort=` past a `SORTS` allowlist and falls
   * back to its own default when the URL names something it does not recognise
   * — see `app/(app)/approvals/page.tsx`, where the `undefined` is explicitly
   * load-bearing because it also decides whether `?dir=` is obeyed. Taking the
   * raw value here meant `/requests?sort=nonsense` ordered by the server's
   * default while the header drew neutral glyphs on every column and set
   * `aria-sort` on none — the header lying about the order on screen, which is
   * the exact state this work exists to remove.
   *
   * `columns` is the allowlist: a `sortKey` is what the URL and the server
   * speak. Unrecognised reads as silence, so `defaultSort` fills it in for both
   * the key and the direction, which is what the server did with the same URL.
   */
  const rawSort = urlSort ? (params.get("sort") ?? undefined) : undefined;
  const sort =
    rawSort && columns.some((column) => column.sortKey === rawSort) ? rawSort : undefined;
  const dir: SortDirection = params.get("dir") === "desc" ? "desc" : "asc";

  /*
   * ⚠️ TWO SORTING MODES, AND THEY MUST NOT SHARE A STORE.
   *
   * A `urlSort` table's order lives in the query string, because the server is
   * what applies it — there is nothing local to hold. A browser-sorted one has
   * no query string to live in and used to have nowhere else either: `sorting`
   * was controlled and permanently `[]`, and `onSortingChange` early-returned,
   * so `getSortedRowModel` read a state that could never change and every
   * header announcing "Click to sort by this column" did nothing at all. This
   * is that missing store, and it exists ONLY for the non-`urlSort` case.
   *
   * Seeded from `defaultSort` once. `keyOf` because the state is keyed by
   * column `key` while `defaultSort` speaks `sortKey`.
   */
  const [localSorting, setLocalSorting] = useState<SortingState>(() =>
    urlSort || !defaultSort
      ? []
      : [{ id: keyOf(columns, defaultSort.key), desc: defaultSort.dir === "desc" }],
  );

  /*
   * What the header draws, as a `sortKey` on both paths so the render below
   * stays one branch.
   *
   * Under `urlSort` the URL wins wherever it speaks and `defaultSort` fills in
   * its silence — seeding it is what makes the first click on a defaulted
   * column REVERSE the order rather than re-request it, since the toggle starts
   * from the direction already on screen. Otherwise the local state IS the
   * answer, read back through the column list because TanStack knows only the
   * `key`.
   */
  const localFirst = localSorting[0];
  const localSortKey = localFirst
    ? columns.find((column) => column.key === localFirst.id)?.sortKey
    : undefined;

  const activeSort = urlSort ? (sort ?? defaultSort?.key) : localSortKey;
  const activeDir: SortDirection = urlSort
    ? sort
      ? dir
      : (defaultSort?.dir ?? dir)
    : localFirst?.desc
      ? "desc"
      : "asc";

  /*
   * Our `Column<T>` mapped onto TanStack's shape rather than replaced by it.
   * The call sites keep the API they had — `key`, `header`, `cell` — and this
   * is the one place that knows about `ColumnDef`, so swapping the engine again
   * would touch this function and nothing else.
   */
  const columnDefs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        /*
         * The value the browser sorts on. Falls back to the row's own field
         * under the same name, which covers the ordinary case (`title`,
         * `created_at`); anything derived supplies `sortValue`.
         */
        accessorFn: (row: T) =>
          column.sortValue
            ? column.sortValue(row)
            : (row as Record<string, unknown>)[column.key],
        enableSorting: Boolean(column.sortKey),
        enableHiding: Boolean(column.hideable),
        header: () => column.header,
        // The row index TanStack hands back is the index within the rendered
        // page, which is what the old signature promised.
        cell: (context) =>
          column.cell(context.row.original, context.row.index, {
            depth: context.row.depth,
            canExpand: context.row.getCanExpand(),
            isExpanded: context.row.getIsExpanded(),
            toggleExpanded: () => context.row.toggleExpanded(),
          }),
        meta: { column },
      })),
    [columns],
  );

  /* The URL-derived pair on one side, the local state verbatim on the other.
     Rebuilding `localSorting` out of `activeSort` would lose the "unsorted"
     third step, which on a browser table is a real state and not an absence. */
  const sorting = useMemo<SortingState>(
    () =>
      urlSort
        ? activeSort
          ? [{ id: keyOf(columns, activeSort), desc: activeDir === "desc" }]
          : []
        : localSorting,
    [urlSort, columns, activeSort, activeDir, localSorting],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getRowId: (row, index) => getRowKey(row, index),
    getCoreRowModel: getCoreRowModel(),
    ...(getSubRows
      ? { getSubRows, getExpandedRowModel: getExpandedRowModel() }
      : {}),
    // Only ask for the sorted row model when the browser is allowed to do the
    // sorting. In manual mode the rows arrive ordered and re-sorting them here
    // would fight the server.
    ...(manual ? {} : { getSortedRowModel: getSortedRowModel() }),
    manualSorting: manual,
    /* ⚠️ THE THIRD CLICK HAS NOWHERE TO GO WHEN THE SERVER SORTS. TanStack's
       default cycle is asc → desc → unsorted, and `onSortingChange` below has
       no way to express "unsorted" — there is no `?sort=` that means "however
       Postgres felt", so it bails and the click does nothing. Two directions
       only here. A browser-sorted table keeps the third step, and it is now a
       REAL one: the local state empties, `getSortedRowModel` stops reordering,
       and the rows fall back to the order the server sent them in — a state
       that table can genuinely be in. */
    enableSortingRemoval: !manual,
    onExpandedChange: setExpanded,
    state: {
      sorting,
      ...(getSubRows ? { expanded } : {}),
      ...(columnVisibility ? { columnVisibility } : {}),
    },
    onColumnVisibilityChange: onColumnVisibilityChange
      ? (updater) =>
          onColumnVisibilityChange(
            typeof updater === "function"
              ? updater(columnVisibility ?? {})
              : updater,
          )
      : undefined,
    onSortingChange: (updater) => {
      // TanStack hands over an updater function OR a value, and both arrive here.
      const next = typeof updater === "function" ? updater(sorting) : updater;

      /* No URL to write to, so the click lands in local state and
         `getSortedRowModel` does the rest. An empty `next` is the cycle's third
         step and is kept rather than discarded. */
      if (!urlSort) {
        setLocalSorting(next);
        return;
      }

      const first = next[0];
      if (!first) return;

      const column = columns.find((candidate) => candidate.key === first.id);
      if (!column?.sortKey) return;

      const query = new URLSearchParams(params.toString());
      query.set("sort", column.sortKey);
      // Ascending is the default, so it stays out of the URL — a link that
      // says `?dir=asc` claims a choice nobody made, the same reasoning the
      // task filters already apply to their default sort.
      if (first.desc) query.set("dir", "desc");
      else query.delete("dir");

      /* ⚠️ RE-SORTING RETURNS YOU TO PAGE ONE. Staying on page 4 of a new
         order shows the fourth page of a list nobody asked for. Every filter
         control in this app deletes `page` for the same reason. */
      query.delete("page");

      const next_query = query.toString();
      router.push(next_query ? `${pathname}?${next_query}` : pathname);
    },
  });

  /*
   * The frozen column, if any. `find` rather than `filter` — see the note on
   * `Column.pin`: a second one would stack at the same offset.
   *
   * `bg-card` rather than `bg-inherit`: a row here has no background of its own
   * (the shell carries it), so an inherited one would be transparent and the
   * scrolled columns would show straight through the frozen cell. The cost is
   * that the pinned column does not take the row's hover tint, which is a
   * fair trade for it being readable at all.
   */
  const pinnedKey = columns.find((column) => column.pin === "left")?.key;
  const pinnedCell = "sticky left-0 z-20 bg-card";
  // The pinned HEADER outranks both the pinned body cells and the other
  // headers, because /dtr also sticks its header row to the top and the two
  // sticky axes meet in this one cell.
  const pinnedHead = "sticky left-0 z-30 bg-background";

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const visibleCount = table.getVisibleLeafColumns().length;

  const body = (
    <Table>
      <TableHeader>
        <TableRow>
          {headers.map((header) => {
            const column = (
              header.column.columnDef.meta as { column: Column<T> }
            ).column;
            const sortable = Boolean(column.sortKey);
            const active = sortable && activeSort === column.sortKey;

            return (
              <TableHead
                key={header.id}
                scope="col"
                // ⚠️ The assistive-tech half of the sort indicator. Without it a
                // screen reader is told only that this is a column heading, and
                // the arrow beside it is decoration it never hears about.
                aria-sort={
                  active
                    ? activeDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={cn(
                  column.align === "end" && "text-right",
                  column.key === pinnedKey && pinnedHead,
                  column.className,
                )}
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={header.column.getToggleSortingHandler()}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-xs font-semibold",
                      "hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2",
                      active ? "text-foreground" : "text-muted-foreground",
                      column.align === "end" && "flex-row-reverse",
                    )}
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                    {/*
                      SHAPE, NOT JUST WEIGHT. An active column is darker AND
                      carries a directional arrow; an inactive one carries the
                      neutral two-way glyph, so the control reads as sortable
                      before anyone clicks it. Greyscale loses nothing.
                    */}
                    {active ? (
                      activeDir === "asc" ? (
                        <ArrowUp aria-hidden className="size-3.5 shrink-0" />
                      ) : (
                        <ArrowDown aria-hidden className="size-3.5 shrink-0" />
                      )
                    ) : (
                      <ChevronsUpDown
                        aria-hidden
                        className="size-3.5 shrink-0 text-foreground-faint"
                      />
                    )}
                    <span className="sr-only">
                      {active
                        ? `Sorted ${activeDir === "asc" ? "ascending" : "descending"}. Click to reverse.`
                        : "Click to sort by this column."}
                    </span>
                  </button>
                ) : (
                  flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>

      <TableBody>
        {/*
          The empty state still renders when there is an `appendRow`, and that is
          the whole point of the pair: an empty stage shows BOTH the sentence
          saying why it is empty AND the control for adding the first task.
        */}
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            {/* `whitespace-normal` undoes TableCell's `whitespace-nowrap`,
                which is right for a time or a reference number and very wrong
                for a paragraph. Without it the empty state's description was
                laid out on a single unbreakable line, which set the table's
                minimum width to the length of that sentence — the header row
                then stretched to match and every empty list grew a horizontal
                scrollbar. */}
            <TableCell colSpan={visibleCount} className="p-0 whitespace-normal">
              {empty ?? <EmptyRow />}
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(
                "align-top",
                onRowHref?.(row.original) && "cursor-pointer",
                rowClassName?.(row.original),
              )}
            >
              {row.getVisibleCells().map((cell) => {
                const column = (
                  cell.column.columnDef.meta as { column: Column<T> }
                ).column;
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      column.align === "end" && "text-right",
                      column.key === pinnedKey && pinnedCell,
                      column.className,
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))
        )}

        {appendRow}
      </TableBody>

      {footer && rows.length > 0 ? <TableFooter>{footer}</TableFooter> : null}
    </Table>
  );

  /*
   * `bare` tables get no strip. They are already inside somebody else's panel —
   * the status groups on /tasks — and that page carries ONE columns menu above
   * all eight of them, so a strip per group would be eight menus disagreeing
   * about the same setting.
   */
  if (bare) return body;

  const hasStrip = Boolean(toolbar || count || onColumnVisibilityChange);

  return (
    <DataTableShell
      className={className}
      header={
        hasStrip ? (
          <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5">
            {toolbar}

            {/* `ml-auto` on the right-hand group rather than a spacer element,
                so the row still collapses sensibly when it wraps narrow. */}
            <div className="ml-auto flex items-center gap-3">
              {count ? (
                <span className="text-xs text-muted-foreground">{count}</span>
              ) : null}

              {onColumnVisibilityChange ? (
                <DataTableColumns
                  columns={columns}
                  visibility={columnVisibility ?? {}}
                  onVisibilityChange={onColumnVisibilityChange}
                />
              ) : null}
            </div>
          </div>
        ) : null
      }
    >
      {body}
    </DataTableShell>
  );
}

/**
 * `sortKey` is what the URL and the server speak; `key` is what TanStack's
 * column is called. They are usually the same string and deliberately allowed
 * to differ — a column headed "Requester" may sort on `requester_name`.
 */
function keyOf<T>(columns: Column<T>[], sortKey: string): string {
  return columns.find((column) => column.sortKey === sortKey)?.key ?? sortKey;
}

function EmptyRow() {
  return (
    <p className="py-9 text-center text-xs text-muted-foreground">
      Nothing to show.
    </p>
  );
}
