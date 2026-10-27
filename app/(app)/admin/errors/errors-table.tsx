"use client";

import { useState } from "react";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * P17-05 — the error log's rows. A client component for the same reason the
 * audit trail's is: `cell` is a function and cannot cross the RSC boundary.
 * Every value arrives formatted from the server.
 *
 * `urlSort` is NOT set and there are no sortable headers: the log is newest
 * first and `.range()`d, and a browser-side sort would reorder one page and
 * call it the history.
 */

export type ErrorEntry = {
  id: string;
  when: string;
  /** First line only — the dialog has the rest. */
  headline: string;
  message: string;
  where: string;
  route: string | null;
  method: string | null;
  kind_label: string;
  source: "server" | "client";
  environment_label: string;
  environment: string;
  who: string | null;
  digest: string | null;
  stack: string | null;
  user_agent: string | null;
};

export function ErrorsTable({
  rows,
  empty,
  toolbar,
  count,
}: {
  rows: ErrorEntry[];
  empty: React.ReactNode;
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {
  const columns: Column<ErrorEntry>[] = [
    {
      key: "when",
      header: "When",
      className: "whitespace-nowrap text-xs text-muted-foreground tabular-nums",
      cell: (entry) => entry.when,
    },
    {
      key: "what",
      header: "What failed",
      className: "max-w-md whitespace-normal",
      cell: (entry) => (
        <span className="line-clamp-2 text-sm" title={entry.message}>
          {entry.headline}
        </span>
      ),
    },
    {
      key: "where",
      header: "Where",
      hideable: true,
      className: "max-w-56",
      cell: (entry) => (
        <span className="block truncate font-mono text-xs" title={entry.route ?? entry.where}>
          {entry.method ? <span className="text-muted-foreground">{entry.method} </span> : null}
          {entry.where}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Doing",
      hideable: true,
      className: "whitespace-nowrap",
      cell: (entry) => <Chip tone="neutral" label={entry.kind_label} />,
    },
    {
      key: "who",
      header: "Who",
      hideable: true,
      className: "whitespace-nowrap",
      cell: (entry) =>
        entry.who ? (
          <span className="text-sm">{entry.who}</span>
        ) : (
          // Worded, not a dash: a signed-out visitor or a cron is a fact.
          <span className="text-sm text-muted-foreground italic">Not signed in</span>
        ),
    },
    {
      key: "env",
      header: "Env",
      hideable: true,
      className: "whitespace-nowrap",
      cell: (entry) => (
        <Chip tone={entry.environment === "production" ? "brand" : entry.environment === "preview" ? "info" : "neutral"} label={entry.environment_label} />
      ),
    },
    {
      key: "details",
      header: <span className="sr-only">Details</span>,
      align: "end",
      className: "w-px whitespace-nowrap",
      cell: (entry) => <ErrorDetails entry={entry} />,
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("errors", columns);

  return (
    <DataTable
      columnVisibility={visibility}
      onColumnVisibilityChange={onVisibilityChange}
      columns={columns}
      rows={rows}
      getRowKey={(entry) => entry.id}
      toolbar={toolbar}
      count={count}
      empty={empty}
    />
  );
}

/** Everything recorded for one error. A dialog, like the audit trail's: a stack trace is tall. */
function ErrorDetails({ entry }: { entry: ErrorEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="outline">
        Details
        <span className="sr-only"> for the error at {entry.when}</span>
      </Button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-words">{entry.headline}</DialogTitle>
            <DialogDescription>
              {entry.kind_label} · {entry.environment_label} · {entry.when}
              {entry.who ? ` · ${entry.who}` : ""}
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Page</dt>
            <dd className="font-mono text-xs break-all">
              {entry.method ? `${entry.method} ` : ""}
              {entry.where}
            </dd>
            {entry.route ? (
              <>
                <dt className="text-muted-foreground">Route file</dt>
                <dd className="font-mono text-xs break-all">{entry.route}</dd>
              </>
            ) : null}
            {entry.digest ? (
              <>
                {/* The code the error page shows the person who hit it — when
                    somebody quotes one, it is matched here. */}
                <dt className="text-muted-foreground">Error code</dt>
                <dd className="font-mono text-xs select-all">{entry.digest}</dd>
              </>
            ) : null}
            {entry.user_agent ? (
              <>
                <dt className="text-muted-foreground">Browser</dt>
                <dd className="text-xs break-all text-muted-foreground">{entry.user_agent}</dd>
              </>
            ) : null}
          </dl>

          {entry.message !== entry.headline ? (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Full message</h3>
              <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">{entry.message}</pre>
            </section>
          ) : null}

          <section className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">Stack trace</h3>
            {entry.stack ? (
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted p-3 font-mono text-2xs leading-relaxed">
                {entry.stack}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                None was recorded. React strips the stack from errors it carries out of a server render; the error code
                above matches it to the server&apos;s own log.
              </p>
            )}
          </section>
        </DialogContent>
      </Dialog>
    </>
  );
}
