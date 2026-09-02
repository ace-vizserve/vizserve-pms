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
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg",
        className,
      )}
    >
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
  const sort = urlSort ? (params.get("sort") ?? undefined) : undefined;
  const dir: SortDirection = params.get("dir") === "desc" ? "desc" : "asc";

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

  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: keyOf(columns, sort), desc: dir === "desc" }] : []),
    [columns, sort, dir],
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
      if (!urlSort) return;
      const next = typeof updater === "function" ? updater(sorting) : updater;
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
            const active = sortable && sort === column.sortKey;

            return (
              <TableHead
                key={header.id}
                scope="col"
                // ⚠️ The assistive-tech half of the sort indicator. Without it a
                // screen reader is told only that this is a column heading, and
                // the arrow beside it is decoration it never hears about.
                aria-sort={
                  active
                    ? dir === "asc"
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
                      dir === "asc" ? (
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
                        ? `Sorted ${dir === "asc" ? "ascending" : "descending"}. Click to reverse.`
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

  if (bare) return body;

  return <DataTableShell className={className}>{body}</DataTableShell>;
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
