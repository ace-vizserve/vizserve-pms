"use client";

import { useMemo, useState, useTransition } from "react";
import { KeyRound, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

      {/* Six columns will not fit a phone. Scrolling the table inside its own
          border keeps the page from scrolling sideways, which is the thing that
          actually breaks a layout. */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Name</th>
              <th className="px-4 py-2.5 text-left font-medium">Role</th>
              <th className="px-4 py-2.5 text-left font-medium">Belongs to</th>
              <th className="px-4 py-2.5 text-left font-medium">Leads</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-xs text-muted-foreground">
                  No users match “{query}”.
                </td>
              </tr>
            ) : (
              filtered.map((user) => (
                <tr key={user.id} className="border-t">
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {user.full_name || <span className="text-muted-foreground">Unnamed</span>}
                      {user.id === currentUserId ? (
                        <span className="ml-2 text-2xs text-muted-foreground">you</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{user.email}</div>
                  </td>

                  <td className="px-4 py-3">{ROLE_LABELS[user.role].label}</td>

                  <td className="px-4 py-3 text-muted-foreground">
                    {user.primary_department_id
                      ? departmentName.get(user.primary_department_id)
                      : "—"}
                  </td>

                  <td className="px-4 py-3">
                    {user.managed_department_ids.length === 0 ? (
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
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {/* State is never conveyed by colour alone — the label carries it. */}
                    {user.is_active ? (
                      <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                        Deactivated
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resetting || !user.is_active}
                        onClick={() => resetPassword(user)}
                        title="Send a password reset link"
                      >
                        <KeyRound />
                        <span className="sr-only">Send password reset to {user.email}</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(user)}>
                        <Pencil />
                        <span className="sr-only">Edit {user.full_name || user.email}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <UserEditor
        departments={departments}
        user={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
    </>
  );
}
