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
 * The ring rather than a border is the template's card boundary; `overflow-hidden`
 * is what keeps the first and last rows from spilling past the rounded corner.
 *
 * Deliberately not built on @tanstack/react-table. The template does its
 * filtering and sorting with plain state, our filters already live in the URL
 * so the server does the work, and a headless table library earns its place at
 * column virtualisation and pinning — neither of which we need. It was removed
 * from package.json for the same reason.
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

export type Column<T> = {
  /** Stable key — also the React key for the cell. */
  key: string;
  header: React.ReactNode;
  /** Cell renderer. Gets the row and its index. */
  cell: (row: T, index: number) => React.ReactNode;
  /** Applied to both the `th` and every `td`, e.g. `hidden sm:table-cell`. */
  className?: string;
  /** Right-align numerics. */
  align?: "start" | "end";
};

/**
 * A declarative table for the common case: columns in, rows out.
 *
 * `empty` renders inside the shell as a full-width row rather than replacing
 * it, so a filtered-to-nothing list keeps its header and the person can see
 * which filter to loosen.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty,
  footer,
  onRowHref,
  bare = false,
  appendRow,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  empty?: React.ReactNode;
  /**
   * A totals row, as `<tr>` content. Inside the table rather than under it
   * because a total that sits outside the element it totals is a number a
   * screen reader reads with no relationship to the figures above it.
   * Hidden when there are no rows — a total of nothing is noise.
   */
  footer?: React.ReactNode;
  /** When set, the whole row becomes a link target for pointer users. */
  onRowHref?: (row: T) => string | undefined;
  /**
   * Drop the shell.
   *
   * For a table that is already inside a bounded surface — the status groups on
   * the task list, where the group IS the panel. Nesting DataTableShell inside
   * one draws a second border a hairline in from the first, which reads as a
   * rendering fault rather than as structure.
   */
  bare?: boolean;
  /**
   * A `<tr>` appended inside `<tbody>`, after the rows and regardless of how many
   * there are.
   *
   * For the task list's inline composer, which has to line up under the columns
   * — a form rendered in a div beneath the table cannot, because it has no way to
   * know the column widths the browser just computed. `footer` is not the same
   * thing: it lands in `<tfoot>` and is suppressed when the list is empty, which
   * is exactly when somebody most wants to add the first row.
   */
  appendRow?: React.ReactNode;
  className?: string;
}) {
  const table = (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead
              key={column.key}
              scope="col"
              className={cn(column.align === "end" && "text-right", column.className)}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>

      <TableBody>
        {/*
          The empty state still renders when there is an `appendRow`, and that is
          the whole point of the pair: an empty stage shows BOTH the sentence
          saying why it is empty AND the control for adding the first task. An
          earlier cut suppressed the sentence whenever a composer was present,
          which silently removed "Nothing at this stage" from seven of the eight
          groups on the task list.
        */}
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            {/* `whitespace-normal` undoes TableCell's `whitespace-nowrap`,
                  which is right for a time or a reference number and very wrong
                  for a paragraph. Without it the empty state's description was
                  laid out on a single unbreakable line, which set the table's
                  minimum width to the length of that sentence — the header row
                  then stretched to match, the first column scrolled out of
                  view, and every empty list in the app grew a horizontal
                  scrollbar. EmptyState's own `max-w-xs` could not fight it:
                  a max-width cannot shrink content that refuses to wrap. */}
            <TableCell colSpan={columns.length} className="p-0 whitespace-normal">
              {empty ?? <EmptyRow />}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, index) => (
            <TableRow
              key={getRowKey(row, index)}
              className={cn("align-top", onRowHref?.(row) && "cursor-pointer")}
            >
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(column.align === "end" && "text-right", column.className)}
                >
                  {column.cell(row, index)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}

        {appendRow}
      </TableBody>

      {footer && rows.length > 0 ? <TableFooter>{footer}</TableFooter> : null}
    </Table>
  );

  if (bare) return table;

  return <DataTableShell className={className}>{table}</DataTableShell>;
}

function EmptyRow() {
  return <p className="py-9 text-center text-xs text-muted-foreground">Nothing to show.</p>;
}
