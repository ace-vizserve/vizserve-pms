"use client";

import { useMemo, useState, useTransition } from "react";
import { KeyRound, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ROLE_LABELS } from "@/lib/schemas/users";

import { sendPasswordReset } from "./actions";
import { UserEditor, type Department, type EditableUser } from "./user-editor";

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
  currentUserId,
}: {
  users: EditableUser[];
  departments: Department[];
  currentUserId: string;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditableUser | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [resetting, startReset] = useTransition();

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
        ROLE_LABELS[user.role].label.toLowerCase().includes(needle),
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
            placeholder="Search name, email or role"
            className="pl-8"
            aria-label="Search users"
          />
        </div>
        <Button size="sm" className="shrink-0 sm:ml-auto" onClick={openCreate}>
          <Plus />
          Add user
        </Button>
      </div>

      {/* Six columns will not fit a phone. `DataTable` scrolls inside its own
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
        user={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
    </>
  );
}
