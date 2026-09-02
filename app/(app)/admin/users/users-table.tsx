"use client";

import { useMemo, useState, useTransition } from "react";
import { FileDown, KeyRound, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { ReportBuilder } from "@/app/(app)/hr/reports/report-builder";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import { Chip } from "@/components/status-badge";
import { formatAppTime } from "@/lib/dates";
import { GENDER_LABELS, ROLE_LABELS } from "@/lib/schemas/users";

import { sendPasswordReset } from "./actions";
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
  today,
  currentUserId,
}: {
  users: EditableUser[];
  departments: Department[];
  /** P7-33. Passed straight through to the editor's allocation panel. */
  leaveTypes: AllocatableLeaveType[];
  /** Which year that panel allocates for. Manila's year, from the server. */
  balanceYear: number;
  /** Manila's date, for the audit dialog's default period. Server-supplied. */
  today: string;
  currentUserId: string;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditableUser | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [resetting, startReset] = useTransition();

  /**
   * P7-53 — the leave audit dialog.
   *
   * No year state here any more: the builder owns every choice, so this screen
   * holds only whether the dialog is open. The old three-year picker is gone
   * with it — the builder bounds the year itself (2020–2100 via
   * `balanceYearSchema`) rather than offering three and calling it a rule.
   */
  const [reportOpen, setReportOpen] = useState(false);

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
      sortKey: "name",
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
      sortKey: "role",
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
            {/* A LABEL, NOT A STATE — hence `Badge`, not `Chip`. A department
                name has no status to carry, so it gets no dot; what it needs is
                the brand tint that separates "leads these" from the plain text
                in the column beside it. */}
            {user.managed_department_ids.map((id) => (
              <Badge key={id} variant="accent">
                {departmentName.get(id) ?? "Unknown"}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      /*
       * P7-66 — THREE FIELDS THIS QUERY ALREADY FETCHED AND NEVER SHOWED.
       *
       * `app_access`, `is_hr` and the work schedule were all in the `.select()`
       * and rendered nowhere, so the only way to see whether somebody could
       * actually sign in was to open the editor on them one at a time.
       *
       * Hidden by default: seven columns already do not fit a phone, and these
       * answer occasional questions rather than everyday ones.
       */
      key: "access",
      header: "App access",
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell",
      // The words matter more than usual here. "No access" is a deliberate
      // setting, not a missing value — an account can be active and still be
      // barred from the app.
      cell: (user) =>
        user.app_access ? (
          <Chip tone="success" label="Can sign in" />
        ) : (
          <Chip tone="neutral" label="No access" />
        ),
    },
    {
      key: "hr",
      header: "HR",
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell",
      // P7-52 made HR a capability rather than a role, which means it is
      // invisible in the Role column — this is the only place it can be read.
      cell: (user) =>
        user.is_hr ? (
          <Chip tone="brand" label="HR" />
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "schedule",
      header: "Schedule",
      hideable: true,
      defaultHidden: true,
      className: "hidden 2xl:table-cell whitespace-nowrap text-muted-foreground tabular-nums",
      /*
       * What the DTR measures lateness against. A blank one is why somebody's
       * attendance row reads as unscheduled with every count at zero, and that
       * connection is impossible to make from the attendance page alone.
       */
      cell: (user) =>
        user.work_start && user.work_end ? (
          `${formatAppTime(user.work_start)} – ${formatAppTime(user.work_end)}`
        ) : (
          <span className="text-warning">Not set</span>
        ),
    },
    {
      key: "status",
      sortKey: "status",
      header: "Status",
      /*
       * `Chip`, not a hand-rolled span. This is a real state, so it goes through
       * the one component that owns tone→colour — and it picks up the second
       * non-colour carrier for free: every chip has its label AND its dot, so
       * "Active" and "Deactivated" stay distinguishable in greyscale, in a
       * screenshot and on a printed staff list.
       *
       * The pair here were the last two flat `rounded-full` pills in the app,
       * a different height and radius from every chip in the product.
       */
      cell: (user) =>
        user.is_active ? (
          <Chip tone="success" label="Active" />
        ) : (
          <Chip tone="neutral" label="Deactivated" />
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
            title="Send a password reset link">
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

  const { visibility, onVisibilityChange } = useColumnVisibility("admin-users", columns);

  return (
    <>
      {/* The two buttons are PAGE actions, not table controls — they create and
          export rather than narrow what is on screen — so they stay out here.
          The search belongs to the table and has moved into its header strip. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
          {/* P7-53. This WAS a year picker beside a one-click download, on the
              argument that a dialog to confirm a download nobody configures is
              a click for nothing. That argument died when the report gained a
              second mode and four filters: there is now something to configure,
              so the button opens the same builder /hr/reports uses rather than
              a second, lesser copy of it. */}
          <Button size="sm" variant="outline" onClick={() => setReportOpen(true)}>
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
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        columns={columns}
        rows={filtered}
        getRowKey={(user) => user.id}
        toolbar={
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email, role or gender"
              className="h-9 pl-8"
              aria-label="Search users"
            />
          </div>
        }
        count={
          <>
            <span className="tabular-nums">{filtered.length}</span>{" "}
            {filtered.length === 1 ? "user" : "users"}
          </>
        }
        empty={
          <EmptyState
            icon={<Search />}
            title="No users match that search"
            description={`Nothing matches “${query}”. Try a surname, an email domain, or a role name like “Team leader”.`}
          />
        }
      />

      {/*
        The SAME builder /hr/reports renders, in a dialog. Not a cut-down copy:
        a second implementation of the filter payload is a second chance to send
        `[]` where the schema wants `undefined`, which renders an empty PDF that
        reads as a broken export.
      */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Leave audit</DialogTitle>
            <DialogDescription>
              Pick a document and narrow it however you need. The PDF prints every filter it
              applied, so a filtered copy is never mistaken for a full one.
            </DialogDescription>
          </DialogHeader>

          {reportOpen ? (
            <ReportBuilder
              // The dialog draws its own header and box — see `chrome` there.
              chrome="bare"
              currentYear={balanceYear}
              today={today}
              people={users}
              departments={departments}
              leaveTypes={leaveTypes}
            />
          ) : null}
        </DialogContent>
      </Dialog>

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
