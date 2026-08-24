"use client";

import { useMemo, useState, useTransition } from "react";
import { FileDown, KeyRound, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GENDER_LABELS, ROLE_LABELS } from "@/lib/schemas/users";

import { exportLeaveReportPdf, sendPasswordReset } from "./actions";
import {
  UserEditor,
  type AllocatableLeaveType,
  type Department,
  type EditableUser,
} from "./user-editor";

/**
 * P0-04 — the user list.
 *
 * Filtering is client-side, which is the right call only because this table is
 * bounded: it is the staff of one company, a few dozen rows, all of them already
 * on the page. The moment that stops being true this becomes a URL-driven
 * server-side filter like /requests (P1-13).
 */
export function UsersTable({
  users,
  departments,
  leaveTypes,
  balanceYear,
  currentUserId,
}: {
  users: EditableUser[];
  departments: Department[];
  /** P7-33. Passed straight through to the editor's allocation panel. */
  leaveTypes: AllocatableLeaveType[];
  /** Which year that panel allocates for. Manila's year, from the server. */
  balanceYear: number;
  currentUserId: string;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditableUser | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [resetting, startReset] = useTransition();

  /*
   * P7-34 — the leave audit year.
   *
   * Defaults to the year the allocations panel is editing, which is the current
   * one in Manila. THIS YEAR AND THE TWO BEFORE IT, no further: the report is
   * run in December against the year that is ending, and occasionally against
   * the one before while a query is settled. Offering 2020 would be offering a
   * year whose numbers nobody has looked at since.
   */
  const [reportYear, setReportYear] = useState(balanceYear);
  const [exporting, startExport] = useTransition();

  const reportYears = [balanceYear, balanceYear - 1, balanceYear - 2];
  const reportYearItems = Object.fromEntries(
    reportYears.map((year) => [String(year), String(year)]),
  );

  function downloadLeaveReport() {
    startExport(async () => {
      const result = await exportLeaveReportPdf({ year: reportYear });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      /*
       * Base64 back to bytes. `atob` gives one character per byte with every
       * code point below 256, so charCodeAt is the byte — no TextEncoder, which
       * would re-encode as UTF-8 and double everything above 0x7F.
       */
      const binary = atob(result.data.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

      // Built and revoked in the same tick, as the DTR export does — a blob URL
      // left dangling pins the whole file in memory for the life of the page.
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.data.filename;
      anchor.click();
      URL.revokeObjectURL(url);

      toast.success(`Leave audit for ${reportYear} downloaded.`);
    });
  }

  const departmentName = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) =>
        user.full_name.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        ROLE_LABELS[user.role].label.toLowerCase().includes(needle) ||
        // Gender is searchable so "female" narrows the list, which is the only
        // filtering this column supports — the table has no facets, and a facet
        // for two values would be more chrome than it is worth.
        (user.gender ? GENDER_LABELS[user.gender].toLowerCase().includes(needle) : false),
    );
  }, [users, query]);

  function openCreate() {
    setEditing(undefined);
    setEditorOpen(true);
  }

  function openEdit(user: EditableUser) {
    setEditing(user);
    setEditorOpen(true);
  }

  function resetPassword(user: EditableUser) {
    startReset(async () => {
      const result = await sendPasswordReset(user.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Reset link sent to ${user.email}`);
    });
  }

  const columns: Column<EditableUser>[] = [
    {
      key: "name",
      header: "Name",
      cell: (user) => (
        <>
          <div className="font-medium">
            {user.full_name || <span className="text-muted-foreground">Unnamed</span>}
            {user.id === currentUserId ? (
              <span className="ml-2 text-2xs text-muted-foreground">you</span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (user) => ROLE_LABELS[user.role].label,
    },
    {
      key: "gender",
      header: "Gender",
      className: "hidden lg:table-cell",
      // P7-32. "Not set" rather than an em dash, and the distinction is the
      // point: this column is what gets the pre-existing accounts filled in, and
      // a dash reads as settled emptiness — which is exactly what it means one
      // column along under Leads. The two states must not look alike.
      cell: (user) =>
        user.gender ? (
          GENDER_LABELS[user.gender]
        ) : (
          <span className="text-muted-foreground">Not set</span>
        ),
    },
    {
      key: "belongs",
      header: "Belongs to",
      className: "hidden md:table-cell text-muted-foreground",
      cell: (user) =>
        user.primary_department_id ? departmentName.get(user.primary_department_id) : "—",
    },
    {
      key: "leads",
      header: "Leads",
      className: "hidden lg:table-cell",
      cell: (user) =>
        user.managed_department_ids.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.managed_department_ids.map((id) => (
              <span
                key={id}
                className="rounded-full bg-accent px-2 py-0.5 text-2xs font-medium text-accent-foreground"
              >
                {departmentName.get(id) ?? "Unknown"}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (user) =>
        /* State is never conveyed by colour alone — the label carries it. */
        user.is_active ? (
          <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
            Active
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            Deactivated
          </span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (user) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={resetting || !user.is_active}
            onClick={() => resetPassword(user)}
            title="Send a password reset link"
          >
            <KeyRound />
            <span className="sr-only">Send password reset to {user.email}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => openEdit(user)}>
            <Pencil />
            <span className="sr-only">Edit {user.full_name || user.email}</span>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, role or gender"
            className="pl-8"
            aria-label="Search users"
          />
        </div>
        {/* P7-34. The year sits BESIDE the button rather than inside a dialog:
            it is one choice, it is nearly always the default, and a dialog to
            confirm a download nobody has to configure is a click for nothing.
            The two read as one control because the label says what the year is
            for. */}
        <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
          <Select
            items={reportYearItems}
            value={String(reportYear)}
            onValueChange={(value) => value !== null && setReportYear(Number(value))}
          >
            <SelectTrigger size="sm" aria-label="Leave audit year" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {reportYears.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            variant="outline"
            loading={exporting}
            onClick={downloadLeaveReport}
          >
            <FileDown />
            Leave audit PDF
          </Button>

          <Button size="sm" onClick={openCreate}>
            <Plus />
            Add user
          </Button>
        </div>
      </div>

      {/* Seven columns will not fit a phone. `DataTable` scrolls inside its own
          ring, and the two least-load-bearing columns collapse below `lg` — the
          page itself never scrolls sideways, which is the thing that actually
          breaks a layout. */}
      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(user) => user.id}
        empty={
          <EmptyState
            icon={<Search />}
            title="No users match that search"
            description={`Nothing matches “${query}”. Try a surname, an email domain, or a role name like “Team leader”.`}
          />
        }
      />

      <UserEditor
        departments={departments}
        leaveTypes={leaveTypes}
        balanceYear={balanceYear}
        user={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
    </>
  );
}
