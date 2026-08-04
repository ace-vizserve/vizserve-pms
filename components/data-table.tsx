import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
export function DataTableShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl ring-1 ring-foreground/10", className)}>
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
  onRowHref,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  empty?: React.ReactNode;
  /** When set, the whole row becomes a link target for pointer users. */
  onRowHref?: (row: T) => string | undefined;
  className?: string;
}) {
  return (
    <DataTableShell className={className}>
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
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
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
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

function EmptyRow() {
  return <p className="py-10 text-center text-xs text-muted-foreground">Nothing to show.</p>;
}
