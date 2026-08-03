"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ROLE_ORDER, type Role } from "@/lib/auth/roles";
import { ROLE_LABELS } from "@/lib/schemas/users";

import { createUser, updateUser } from "./actions";

/**
 * P0-04 — the create/edit dialog.
 *
 * The two things this screen has to make obvious, because getting either wrong
 * is a silent authorization bug:
 *
 *   1. A ROLE IS NOT A SCOPE. Holding `team_leader` grants nothing on its own —
 *      the ticked departments below are what decide which queues this person
 *      sees (D15). The copy says so, next to the checkboxes, because "why can
 *      Kurt not see VizMedia's requests" is otherwise a support conversation.
 *   2. Email is editable on create and absent on edit. It is the identity that
 *      links Entra SSO and password login to one profile.
 */

export type Department = { id: string; name: string };

export type EditableUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  primary_department_id: string | null;
  is_active: boolean;
  managed_department_ids: string[];
};

// Most privileged first — an admin scanning this list is usually looking for
// the exception, not the default.
const ROLE_OPTIONS = [...ROLE_ORDER].reverse();

const NO_DEPARTMENT = "__none__";

export function UserEditor({
  departments,
  user,
  open,
  onOpenChange,
}: {
  departments: Department[];
  /** Absent for create. */
  user?: EditableUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        {/*
          Keyed on who is being edited, and unmounted while closed, so the form
          state is SEEDED rather than SYNCED. An effect that copies props into
          state on open is the version of this that goes wrong: editing Ryza and
          then Lloyd leaves Ryza's role selected for a frame, and the stale value
          is what gets submitted if the admin saves immediately.
        */}
        {open ? (
          <UserForm
            key={user?.id ?? "new"}
            departments={departments}
            user={user}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UserForm({
  departments,
  user,
  onDone,
}: {
  departments: Department[];
  user?: EditableUser;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [email, setEmail] = useState(user?.email ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "member");
  const [primaryDepartmentId, setPrimaryDepartmentId] = useState<string | null>(
    user?.primary_department_id ?? null,
  );
  const [managed, setManaged] = useState<string[]>(
    user?.managed_department_ids ?? [],
  );
  const [isActive, setIsActive] = useState(user?.is_active ?? true);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // A member holds scope over nothing by definition, so the checkboxes are not
  // merely hidden — the values are dropped, and the server drops them again.
  const scopeApplies = role !== "member";

  function toggleDepartment(id: string, checked: boolean) {
    setManaged((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    );
  }

  function submit() {
    setFormError(null);
    setFieldErrors({});

    const payload = {
      full_name: fullName,
      role,
      primary_department_id: primaryDepartmentId,
      managed_department_ids: scopeApplies ? managed : [],
    };

    startTransition(async () => {
      const result = user
        ? await updateUser(user.id, { ...payload, is_active: isActive })
        : await createUser({ ...payload, email });

      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      toast.success(user ? "User updated" : "User created");
      onDone();
      router.refresh();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{user ? "Edit user" : "Add a user"}</DialogTitle>
        <DialogDescription>
          {user
            ? "Changes are written to the audit log with before and after values."
            : "The account is created confirmed. Send them a password reset from the list to let them in."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {user ? (
          <div className="space-y-1">
            <Label>Email</Label>
            <p className="text-sm">{user.email}</p>
            {/* Not an oversight — see lib/schemas/users.ts. */}
            <p className="text-xs text-muted-foreground">
              Not editable. This address is the identity that links SSO and
              password sign-in to one profile — changing it would detach them
              from their own login.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
            />
            {fieldErrors.email ? (
              <p className="text-xs text-destructive">{fieldErrors.email[0]}</p>
            ) : null}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            aria-invalid={Boolean(fieldErrors.full_name)}
          />
          {fieldErrors.full_name ? (
            <p className="text-xs text-destructive">
              {fieldErrors.full_name[0]}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as Role)}
            >
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ROLE_LABELS[option].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ROLE_LABELS[role].hint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="primary_department">Belongs to</Label>
            <Select
              value={primaryDepartmentId ?? NO_DEPARTMENT}
              onValueChange={(value) =>
                setPrimaryDepartmentId(value === NO_DEPARTMENT ? null : value)
              }
            >
              <SelectTrigger id="primary_department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Their own team. Not the same as what they lead.
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border p-4">
          <div>
            <Label>Leads these departments</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {scopeApplies
                ? "This — not the role — decides which requests, forms and queues they can reach. A Team Leader with nothing ticked leads nothing."
                : "Members have no department scope. Choose Team Leader or above to assign one."}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {departments.map((department) => (
              <label
                key={department.id}
                className="flex items-center gap-2 text-sm data-[disabled=true]:opacity-50"
                data-disabled={!scopeApplies}
              >
                <Checkbox
                  checked={managed.includes(department.id)}
                  disabled={!scopeApplies}
                  onCheckedChange={(checked) =>
                    toggleDepartment(department.id, checked === true)
                  }
                />
                {department.name}
              </label>
            ))}
          </div>
        </div>

        {user ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <Label htmlFor="is_active">Active</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isActive
                  ? "Can sign in."
                  : "Cannot sign in, and every query they make returns nothing. Their history is kept."}
              </p>
            </div>
            <Switch
              id="is_active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          </div>
        ) : null}

        {formError ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {formError}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending}>
          {user ? "Save changes" : "Create user"}
        </Button>
      </DialogFooter>
    </>
  );
}
