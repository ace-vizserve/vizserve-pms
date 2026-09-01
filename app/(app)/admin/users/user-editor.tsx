"use client";

import { useEffect, useState, useTransition } from "react";
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
import { TimePicker } from "@/components/ui/time-picker";
import { APP_ACCESS_KEY } from "@/lib/auth/app-access";
import { ROLE_ORDER, type Role } from "@/lib/auth/roles";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { formatDays, leaveTypeApplies } from "@/lib/schemas/leave-balances";
import { GENDER_LABELS, type Gender, ROLE_LABELS } from "@/lib/schemas/users";

import { createUser, readLeaveBalances, setLeaveAllocations, updateUser } from "./actions";

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

/** P7-33 — the pickable leave types, in the list's own `sort_order`. */
export type AllocatableLeaveType = {
  id: string;
  label: string;
  /** P7-45. NULL applies to everyone; a value restricts the type. */
  applies_to_gender: Gender | null;
  /**
   * P7-53. Not used by the allocation panel — a retired type keeps its
   * allocation and must stay editable. It is here for the leave-audit dialog
   * in the toolbar, which marks a retired type so somebody filtering to one
   * knows that is what they picked.
   */
  is_active: boolean;
};

export type EditableUser = {
  id: string;
  email: string;
  full_name: string;
  /** P7-32. NULL on accounts nobody has opened since the column landed. */
  gender: Gender | null;
  role: Role;
  /** P7-52. The HR job, orthogonal to `role` — see D33. */
  is_hr: boolean;
  primary_department_id: string | null;
  is_active: boolean;
  /** Which HFSE applications they may enter. See the access toggle below. */
  app_access: string[];
  /**
   * P7-36. `HH:MM:SS` from Postgres, or null for no fixed schedule. Sliced to
   * `HH:MM` for the time inputs below, which reject the seconds.
   */
  work_start: string | null;
  work_end: string | null;
  managed_department_ids: string[];
  /** P7-33. `leave_type_id` → days allocated for `balanceYear`. Sparse. */
  leave_allocations: Record<string, number>;
};

// Most privileged first — an admin scanning this list is usually looking for
// the exception, not the default.
const ROLE_OPTIONS = [...ROLE_ORDER].reverse();

const GENDER_OPTIONS: Gender[] = ["MALE", "FEMALE"];

const NO_DEPARTMENT = "__none__";

export function UserEditor({
  departments,
  leaveTypes,
  balanceYear,
  user,
  open,
  onOpenChange,
}: {
  departments: Department[];
  leaveTypes: AllocatableLeaveType[];
  /** Which year the allocations below cover. Manila's year, from the server. */
  balanceYear: number;
  /** Absent for create. */
  user?: EditableUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
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
            leaveTypes={leaveTypes}
            balanceYear={balanceYear}
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
  leaveTypes,
  balanceYear,
  user,
  onDone,
}: {
  departments: Department[];
  leaveTypes: AllocatableLeaveType[];
  balanceYear: number;
  user?: EditableUser;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [email, setEmail] = useState(user?.email ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  /*
   * P7-32. Null on an account that predates the column, and left null rather
   * than defaulted to "Male" — a default here would be the app inventing a fact
   * about a colleague, and it would do it silently on every save of an
   * untouched record. The schema refuses null, so the admin has to choose.
   */
  const [gender, setGender] = useState<Gender | null>(user?.gender ?? null);
  const [role, setRole] = useState<Role>(user?.role ?? "member");

  /*
   * value → label maps for the two Selects below.
   *
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. The `<SelectItem>` children populate the POPUP; this map
   * populates the TRIGGER, and supplying only the children means the closed
   * control shows "team_leader" instead of "Team leader", and a bare
   * `a1000000-…` instead of the department name.
   */
  const roleItems = Object.fromEntries(
    ROLE_OPTIONS.map((option) => [option, ROLE_LABELS[option].label]),
  );
  const genderItems = Object.fromEntries(
    GENDER_OPTIONS.map((option) => [option, GENDER_LABELS[option]]),
  );
  const departmentItems = {
    [NO_DEPARTMENT]: "No department",
    ...Object.fromEntries(departments.map((department) => [department.id, department.name])),
  };
  const [primaryDepartmentId, setPrimaryDepartmentId] = useState<string | null>(
    user?.primary_department_id ?? null,
  );
  const [managed, setManaged] = useState<string[]>(
    user?.managed_department_ids ?? [],
  );
  /**
   * P7-36. Sliced to `HH:MM` because `<input type="time">` silently rejects the
   * `HH:MM:SS` Postgres returns — the field renders blank, the admin saves, and
   * a schedule that was set reads as cleared.
   */
  const [workStart, setWorkStart] = useState(user?.work_start?.slice(0, 5) ?? "");
  const [workEnd, setWorkEnd] = useState(user?.work_end?.slice(0, 5) ?? "");
  const [isActive, setIsActive] = useState(user?.is_active ?? true);
  const [isHr, setIsHr] = useState(user?.is_hr ?? false);
  const [hasAppAccess, setHasAppAccess] = useState(
    user ? user.app_access.includes(APP_ACCESS_KEY) : true,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  /*
   * P7-33 — leave allocations, held as STRINGS.
   *
   * A number-typed state would have to decide what "" means on every keystroke,
   * and the honest answer is "the admin is mid-edit", not zero. Kept as typed
   * text and coerced once at submit, where `allocatedDaysSchema` turns a blank
   * or a stray letter into a sentence rather than a silent 0 written over
   * somebody's entitlement.
   *
   * Seeded from props for the same reason everything else here is — see the key
   * on <UserForm>. A type with no allocation row starts blank, not "0", so
   * "nobody has set this" and "deliberately zero" look different on screen.
   */
  /*
   * P7-45 — the types this person is eligible for, derived from the gender
   * SELECTED IN THIS FORM rather than the one on the saved record.
   *
   * That is what makes the list react: switch the picker above from Male to
   * Female and Paternity disappears while Maternity, Special Leave for Women
   * and VAWC appear, before anything is saved. Reading `user.gender` instead
   * would show the previous answer until the dialog was reopened.
   *
   * Rows for types that no longer apply are HIDDEN, not deleted. An allocation
   * already recorded against one stays in the database untouched — see the
   * submit path, which only sends what is on screen.
   */
  const applicableLeaveTypes = leaveTypes.filter(
    (type) =>
      // `is_active` is filtered HERE since P7-53, not in the page query, which
      // now fetches retired types too for the toolbar's audit dialog. A retired
      // type keeps any allocation already recorded against it — the submit path
      // only sends what is on screen — so hiding the row is exactly what the
      // old server-side filter did, and nothing about this panel changes.
      type.is_active && leaveTypeApplies(type.applies_to_gender, gender),
  );

  const [allocations, setAllocations] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      leaveTypes.map((type) => {
        const days = user?.leave_allocations[type.id];
        return [type.id, days === undefined ? "" : String(days)];
      }),
    ),
  );

  /*
   * Used and remaining, fetched when the dialog opens.
   *
   * NOT PART OF THE PAGE QUERY. This is one RPC per person and the page renders
   * the whole staff list; fetching it up front would be a few dozen round trips
   * to fill a panel almost none of which is ever opened.
   *
   * Undefined means "still loading or never asked" and is rendered as such —
   * showing 0 while it arrives would flash a wrong number in the one place a
   * wrong number is most likely to be believed.
   */
  const [summary, setSummary] = useState<LeaveBalanceSummaryRow[] | undefined>();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    let live = true;

    void readLeaveBalances(userId, balanceYear).then((result) => {
      // Guarded because the dialog can close mid-flight. A failure is left as
      // undefined rather than toasted: the allocation inputs above still work,
      // and an error toast about a read-only figure would look like the save
      // failed.
      if (live && result.ok) setSummary(result.data);
    });

    return () => {
      live = false;
    };
  }, [userId, balanceYear]);

  const usedByType = new Map((summary ?? []).map((row) => [row.leave_type_id, row.days_used]));

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
      gender,
      role,
      primary_department_id: primaryDepartmentId,
      managed_department_ids: scopeApplies ? managed : [],
      // In the SHARED payload, not beside `is_active` below: HR is settable on
      // create as well as on edit, unlike the active switch which only makes
      // sense once an account exists.
      is_hr: isHr,
      // The empty string is how a cleared time input reports itself. The schema
      // turns it into null — "no fixed schedule" — rather than a parse error.
      work_start: workStart,
      work_end: workEnd,
    };

    startTransition(async () => {
      // Branched rather than a ternary, so `createUser`'s `{ id }` stays typed.
      // A shared `result` would union it with `updateUser`'s void and need a
      // cast to get the new user's id back out.
      let savedId = user?.id;

      if (user) {
        const result = await updateUser(user.id, {
          ...payload,
          is_active: isActive,
          has_app_access: hasAppAccess,
        });

        if (!result.ok) {
          setFormError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }
      } else {
        const result = await createUser({ ...payload, email });

        if (!result.ok) {
          setFormError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }

        savedId = result.data.id;
      }

      /*
       * P7-33. The profile saved; now the allocations.
       *
       * TWO ACTIONS BEHIND ONE BUTTON, and the order matters: on create there is
       * no user id until `createUser` returns one, so allocations cannot go in
       * the same call without the action learning to provision an auth identity
       * and set entitlements in one transaction — which would put a leave figure
       * on the critical path of "can this person sign in".
       *
       * The cost is a window where the profile saved and the allocations did
       * not. That is reported rather than hidden, and it is recoverable by
       * reopening and saving again: the upsert is idempotent, and the person
       * exists either way. The reverse order would not be recoverable.
       */
      const entered = Object.entries(allocations).filter(([, days]) => days.trim() !== "");

      if (savedId && entered.length > 0) {
        const allocationResult = await setLeaveAllocations({
          user_id: savedId,
          balance_year: balanceYear,
          allocations: entered.map(([leave_type_id, days_allocated]) => ({
            leave_type_id,
            days_allocated,
          })),
        });

        if (!allocationResult.ok) {
          setFormError(
            `${user ? "Details saved" : "User created"}, but the leave allocation did not: ${allocationResult.error}`,
          );
          setFieldErrors(allocationResult.fieldErrors ?? {});
          router.refresh();
          return;
        }
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

        <div className="grid gap-4 sm:grid-cols-2">
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

          <div className="space-y-2">
            <Label htmlFor="gender">Gender</Label>
            {/* P7-32. No placeholder-as-value and no default selection: the
                trigger shows "Choose one…" until an admin picks, so an account
                that predates this column cannot be saved carrying an answer
                nobody gave. The schema refuses null, which is what makes the
                blank state a prompt rather than a permanent gap. */}
            <Select
              items={genderItems}
              value={gender}
              onValueChange={(value) => value !== null && setGender(value as Gender)}
            >
              <SelectTrigger id="gender" aria-invalid={Boolean(fieldErrors.gender)}>
                <SelectValue placeholder="Choose one…" />
              </SelectTrigger>
              <SelectContent>
                {GENDER_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {GENDER_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.gender ? (
              <p className="text-xs text-destructive">{fieldErrors.gender[0]}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {user && !user.gender
                  ? "Not recorded on this account yet — choose one to save."
                  : null}
              </p>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------------------
            P7-36 — the scheduled working day.

            OPTIONAL, and the helper text says so in as many words. This is the
            one field on this form whose blank state is a real answer rather
            than an unfinished record: plenty of people here work no fixed
            hours, and setting a schedule for them would have the DTR start
            judging their punches against a start time nobody agreed.

            Two `TimePicker`s. The value is a wall-clock time with no date
            attached, and the control shows it the way people say it — "9:00 AM"
            — while emitting the 24-hour string the schema and the `time` column
            expect.
            ------------------------------------------------------------------ */}
        <div className="space-y-2">
          <Label htmlFor="work_start">Work hours</Label>
          <div className="flex items-center gap-2">
            <TimePicker
              id="work_start"
              label="Scheduled start"
              value={workStart}
              onChange={(next) => setWorkStart(next ?? "")}
              invalid={Boolean(fieldErrors.work_start || fieldErrors.work_end)}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <TimePicker
              label="Scheduled end"
              value={workEnd}
              onChange={(next) => setWorkEnd(next ?? "")}
              invalid={Boolean(fieldErrors.work_end)}
            />
            {workStart || workEnd ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setWorkStart("");
                  setWorkEnd("");
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          {fieldErrors.work_end ?? fieldErrors.work_start ? (
            <p className="text-xs text-destructive">
              {(fieldErrors.work_end ?? fieldErrors.work_start)?.[0]}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Optional. Leave both blank for no fixed schedule — the DTR then says nothing about
              when this person clocks in or out. With hours set, a punch more than the company
              grace period away from them prompts a correction request.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select
              items={roleItems}
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
              items={departmentItems}
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

        {/*
          P7-33 — LEAVE ALLOCATION, per type, for one year.

          Its own bordered block for the same reason the managed-department set
          has one: it is a different kind of statement from the fields above.
          Those describe who somebody is and what they may reach; this is HR
          policy about them, and it is the only thing on this screen a team
          leader is not allowed to change.

          RENDERED ON CREATE TOO, unlike the Active switch. Setting the year's
          allowance while adding a joiner is the natural moment, and the submit
          path already has the new id by the time it writes them.

          USED AND REMAINING ARE READ-ONLY and arrive separately — see the
          effect above. Nothing here decrements: usage is computed from approved
          requests every time it is read, which is why an admin can change an
          allocation without anything needing to be recalculated.
        */}
        {applicableLeaveTypes.length > 0 ? (
          <div className="space-y-3 rounded-lg border p-4">
            <div>
              <Label>Leave allocation for {balanceYear}</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Days HR allows per type this year. Whole or half days. Blank means nobody has set
                one yet, which reads as zero. This is a record, not a limit — a request that would
                overdraw still submits and can still be approved.
              </p>
            </div>

            <div className="space-y-2">
              {applicableLeaveTypes.map((type) => {
                const entered = allocations[type.id] ?? "";
                const used = usedByType.get(type.id);
                const allocated = Number(entered);
                // Only meaningful once both halves are known. `used` is
                // undefined while the summary is in flight, and an empty box is
                // not a zero allocation — it is an unanswered question.
                const remaining =
                  used === undefined || entered.trim() === "" || Number.isNaN(allocated)
                    ? undefined
                    : allocated - used;

                return (
                  <div key={type.id} className="flex items-center gap-3">
                    {/*
                      THE TEXT IS IN A SPAN, and that is not decoration.

                      `truncate` was on the <Label> itself, and <Label> is
                      `display: flex` (components/ui/label.tsx). Truncation on a
                      FLEX CONTAINER does nothing to its text: the text becomes an
                      anonymous flex item sized to its own content, so the label
                      refused to shrink and pushed the whole row past the edge of
                      the dialog — which is where the horizontal scrollbar came
                      from once P7-41 added a 59-character leave type. Widening
                      the dialog hid it at one size and not at others.

                      `min-w-0 flex-1` on the label lets it shrink; `truncate` on
                      the span is what actually ellipsises. The span shrinks
                      because `overflow: hidden` resolves its automatic minimum
                      size to zero.

                      `title` carries the full text, since P7-41 is longer than
                      this row will ever be — the same reason the holiday name on
                      the shared calendar has one.
                    */}
                    <Label
                      htmlFor={`allocation-${type.id}`}
                      title={type.label}
                      className="min-w-0 flex-1 font-normal"
                    >
                      <span className="truncate">{type.label}</span>
                    </Label>

                    <Input
                      id={`allocation-${type.id}`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="366"
                      // Half days, matching what P7-16 lets a request consume.
                      step="0.5"
                      placeholder="not set"
                      value={entered}
                      onChange={(event) =>
                        setAllocations((current) => ({
                          ...current,
                          [type.id]: event.target.value,
                        }))
                      }
                      className="w-24 text-center tabular-nums"
                    />

                    {/* State is never conveyed by colour alone (a project rule),
                        so an overdraw says "over by" rather than only turning
                        red. Fixed width so the inputs stay in a column. */}
                    <span className="w-32 shrink-0 text-right text-2xs tabular-nums">
                      {used === undefined ? null : remaining === undefined ? (
                        <span className="text-muted-foreground">{formatDays(used)} taken</span>
                      ) : remaining < 0 ? (
                        <span className="font-medium text-destructive">
                          over by {formatDays(-remaining)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{formatDays(remaining)} left</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            {fieldErrors.allocations ? (
              <p className="text-xs text-destructive">{fieldErrors.allocations[0]}</p>
            ) : null}
          </div>
        ) : null}

        {/*
          P7-52 — the HR switch.

          ⚠️ THIS SCREEN IS ADMIN-ONLY AND MUST STAY THAT WAY. It is the only
          place `is_hr` can be set, which is precisely what stops the capability
          escalating itself: an HR person can allocate leave and edit holidays,
          and cannot appoint another HR person or make themselves one.

          Rendered for a NEW user too, unlike Active below — an account can be
          created for somebody who is joining to do the HR job, and making them
          save twice to say so would be pointless.
        */}
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="is_hr">HR</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isHr
                ? "Can set leave balances, edit leave types and holidays, and run the leave report for everyone. Cannot manage users."
                : "Not an HR user. Every admin already has these abilities regardless of this switch."}
            </p>
          </div>
          <Switch id="is_hr" checked={isHr} onCheckedChange={setIsHr} />
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
