"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { Chip } from "@/components/status-badge";
import { auditActionTone, auditEntityHref, auditEntityLabel } from "@/lib/audit";
import { AuditDetails, type AuditEntry } from "./audit-details";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary. The server
 * page keeps the auth, the query, the searchParams narrowing and the paginator.
 *
 * ⚠️ `urlSort` IS SET. The trail is `.range()`d one page at a time, so sorting
 * in the browser would reorder the visible 20 and present it as an ordering of
 * the whole history — on the one page in this app people read for
 * accountability.
 */
export function AuditTable({
  rows,
  empty,
  toolbar,
  count,
}: {
  rows: AuditEntry[];
  empty: React.ReactNode;
  /** Search and filters, for the table's own header strip. */
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {

  const columns: Column<AuditEntry>[] = [
    {
      key: "when",
      header: "When",
      sortKey: "when",
      className: "whitespace-nowrap text-xs text-muted-foreground tabular-nums",
      cell: (entry) => entry.when,
    },
    {
      key: "who",
      hideable: true,
      header: "Who",
      className: "whitespace-nowrap",
      cell: (entry) =>
        entry.actor_name ? (
          <span className="text-sm">{entry.actor_name}</span>
        ) : (
          // Italic AND worded, not a grey dash: an entry with no actor is a
          // statement (the cron did this), not a missing value, and the two must
          // not look the same on a page people read for accountability.
          <span className="text-sm text-muted-foreground italic">System</span>
        ),
    },
    {
      key: "action",
      header: "Action",
      sortKey: "action",
      cell: (entry) => <Chip tone={auditActionTone(entry.action)} label={entry.action_label} />,
    },
    {
      key: "record",
      hideable: true,
      header: "Record",
      className: "whitespace-nowrap",
      cell: (entry) => {
        const href = auditEntityHref(entry.entity_type, entry.entity_id);
        const label = auditEntityLabel(entry.entity_type);

        // Linked only where a detail route exists. A link to a page that does
        // not exist is worse than plain text, and the map in lib/audit.ts is
        // the one place to extend when a route lands.
        return href ? (
          <Link href={href} className="text-sm text-primary hover:underline">
            {label}
          </Link>
        ) : (
          <span className="text-sm">{label}</span>
        );
      },
    },
    {
      key: "changes",
      hideable: true,
      header: "Changed",
      className: "hidden lg:table-cell max-w-xs whitespace-normal text-xs text-muted-foreground",
      cell: (entry) => {
        // The LEAF names, so a leave allocation change reads "Vacation Leave"
        // rather than "Allocations" — the field that moved, not the container
        // it moved inside. The group is on the dialog's rows, where there is
        // room for it.
        const names = entry.fields.filter((field) => field.changed).map((field) => field.label);
        if (names.length === 0) return <span className="text-foreground-faint">—</span>;

        // Three then a count. The user editor writes eight fields and the leave
        // allocation one writes nine — listing all of them turns a scannable
        // column into a paragraph, and the dialog is one click away.
        const shown = names.slice(0, 3).join(", ");
        return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
      },
    },
    {
      key: "details",
      header: <span className="sr-only">Details</span>,
      align: "end",
      className: "w-px whitespace-nowrap",
      cell: (entry) => <AuditDetails entry={entry} />,
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("audit", columns);

  return (
    <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
      columns={columns}
      rows={rows}
      getRowKey={(entry) => entry.id}
      toolbar={toolbar}
      count={count}
      urlSort
      empty={empty}
      />
  );
}
