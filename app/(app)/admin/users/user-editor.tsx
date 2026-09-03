"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";

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
import { type Role } from "@/lib/auth/roles";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { formatDays, leaveTypeApplies } from "@/lib/schemas/leave-balances";
import { GENDER_LABELS, type Gender, ROLE_LABELS } from "@/lib/schemas/users";

import { createUser, readLeaveBalances, setLeaveAllocations, updateUser } from "./actions";
import {
  offeredRank,
  rankBelow,
  rankImplied,
  rankLocked,
  rankTicked,
  RANK_LADDER,
} from "./rank-ladder";

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
  /** P8-01. The department-admin tick, orthogonal to `role` — see D33. */
  is_dept_admin: boolean;
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
  /**
   * P8-05. This person's unpaid break, in minutes, or NULL to inherit the
   * company figure from /admin/settings. NULL is the normal state and is NOT
   * zero — held as a string in the form below for exactly that reason.
   */
  break_minutes: number | null;
  managed_department_ids: string[];
  /** P7-33. `leave_type_id` → days allocated for `balanceYear`. Sparse. */
  leave_allocations: Record<string, number>;
};

const GENDER_OPTIONS: Gender[] = ["MALE", "FEMALE"];

const NO_DEPARTMENT = "__none__";

export function UserEditor({
  departments,
  leaveTypes,
  balanceYear,
  user,
  viewerIsOwner,
  open,
  onOpenChange,
  onIssued,
}: {
  departments: Department[];
  leaveTypes: AllocatableLeaveType[];
  /** Which year the allocations below cover. Manila's year, from the server. */
  balanceYear: number;
  /** Absent for create. */
  user?: EditableUser;
  /**
   * P8-01. Whether the person filling this form holds the top rung.
   *
   * ⚠️ ONLY AN OWNER MAY GRANT OWNER, ADMIN OR HR, and this is what the form
   * reads to say so. It is NOT the enforcement — `/admin/users` is
   * `requireRole("owner")` and the server actions re-check on every call. This
   * exists so the UI AGREES with that gate rather than offering a control whose
   * only possible answer is a refusal.
   */
  viewerIsOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * P8-11. Called with the temporary password a newly created account was given.
   *
   * The dialog that SHOWS it belongs to the table, not to this form, for one
   * reason: this form unmounts the moment the account is created (`onDone`
   * closes it and the content is conditional on `open`). A password rendered
   * inside a component that is about to disappear is a password nobody reads.
   */
  onIssued: (issued: { email: string; password: string }) => void;
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
            viewerIsOwner={viewerIsOwner}
            onDone={() => onOpenChange(false)}
            onIssued={onIssued}
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
  viewerIsOwner,
  onDone,
  onIssued,
}: {
  departments: Department[];
  leaveTypes: AllocatableLeaveType[];
  balanceYear: number;
  user?: EditableUser;
  /** P8-01. See `UserEditor`. Only an owner may grant Owner, Admin or HR. */
  viewerIsOwner: boolean;
  onDone: () => void;
  /** P8-11. See `UserEditor`. */
  onIssued: (issued: { email: string; password: string }) => void;
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
  /*
   * ⚠️ SEEDED THROUGH `offeredRank`, SO WHAT THE FORM SHOWS IS WHAT IT SAVES.
   *
   * A row still holding the dead `admin` rung opens as `manager` — which is
   * already the rank the ticks displayed, because `roleAtLeast("admin",
   * "manager")` is true. Without this the dialog showed "Manager", saved
   * `admin`, and could only ever be promoted: every offered rank was strictly
   * below the stored one, so every one of them was locked. Normalising here
   * makes the record demotable AND stops an owner who opened it to change a
   * phone number from silently re-confirming a rank that grants nothing.
   *
   * A no-op for every rank the form offers — `offeredRank(x) === x` for all
   * four of them.
   */
  const [role, setRole] = useState<Role>(offeredRank(user?.role ?? "member"));

  /*
   * value → label maps for the Selects below.
   *
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. The `<SelectItem>` children populate the POPUP; this map
   * populates the TRIGGER, and supplying only the children means the closed
   * control shows "team_leader" instead of "Team leader", and a bare
   * `a1000000-…` instead of the department name.
   *
   * P8-01 removed the ROLE map: the role picker is no longer a Select. See the
   * rank ladder below.
   */
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
  /**
   * P8-05 — the break override, HELD AS A STRING, like every other numeric cell
   * on this screen.
   *
   * `user.break_minutes ?? ""` and not `?? "60"`: a blank field is what "no
   * override, use the company break" looks like, and seeding it with the
   * company figure would turn every save into an explicit override that then
   * stops following the company setting. The `== null` test rather than a
   * falsy one is the whole point — `0` is a real answer and must render as "0".
   */
  const [breakMinutes, setBreakMinutes] = useState(
    user?.break_minutes == null ? "" : String(user.break_minutes),
  );
  const [isActive, setIsActive] = useState(user?.is_active ?? true);
  const [isHr, setIsHr] = useState(user?.is_hr ?? false);
  const [isDeptAdmin, setIsDeptAdmin] = useState(user?.is_dept_admin ?? false);
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

  /**
   * P8-01 — THE RANK LADDER, as ticks rather than a dropdown.
   *
   * The app has always enforced inclusion — `roleAtLeast` is `>=`, never `===`,
   * and the Postgres enum's declaration order is the ladder — but a Select made
   * it invisible: picking "Manager" said nothing about the fact that a manager
   * IS a team leader and IS a member. Ticking a rank and watching every rank
   * below it tick and lock is that same rule, shown.
   *
   * A rank is TICKED when the stored role is at least that rank, and LOCKED when
   * it is strictly below it — unticking something the rank above already implies
   * is not a decision anybody can make. Member is therefore always ticked and
   * always locked: everyone is at least a member.
   *
   * The stored value is the HIGHEST ticked rank, which is what makes this a
   * ladder rather than a set of independent flags. `owner` additionally needs
   * `viewerIsOwner` — see the tick column in the JSX.
   *
   * The rules themselves live in `./rank-ladder`, which is plain TypeScript and
   * therefore assertable. Both of the bugs they now carry warnings about — the
   * always-enabled Member checkbox and the undemotable legacy `admin` row — were
   * invisible in review and are one `expect` each in `tests/unit/rank-ladder`.
   */
  function toggleRank(rank: Role, checked: boolean) {
    if (checked) {
      setRole(rank);
      return;
    }

    setRole(rankBelow(rank));
  }

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
      // P8-01. In the SHARED payload for the same reason `is_hr` is: an account
      // can be created for somebody joining to administer their department, and
      // making an owner save twice to say so would be pointless.
      is_dept_admin: isDeptAdmin,
      // The empty string is how a cleared time input reports itself. The schema
      // turns it into null — "no fixed schedule" — rather than a parse error.
      work_start: workStart,
      work_end: workEnd,
      // The empty string again, and here it means INHERIT rather than "none".
      // Sent as typed so the schema — not this component — decides that blank
      // is null and "0" is zero. See `breakMinutesSchema`.
      break_minutes: breakMinutes,
    };

    startTransition(async () => {
      // Branched rather than a ternary, so `createUser`'s `{ id }` stays typed.
      // A shared `result` would union it with `updateUser`'s void and need a
      // cast to get the new user's id back out.
      let savedId = user?.id;
      /*
       * P8-11. The temporary password `createUser` now issues, on its way to
       * the one-time dialog the table owns. Held in a local rather than put in
       * a toast: a credential for somebody else's account belongs on screen
       * once, deliberately, and never in a message that stacks with others.
       */
      let issuedPassword: { email: string; password: string } | null = null;

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
        issuedPassword = { email: result.data.email, password: result.data.password };
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

      /*
       * ⚠️ NO "USER CREATED" TOAST WHEN A PASSWORD WAS ISSUED. The dialog that
       * follows says the account was created AND carries the one thing that
       * has to be read before anything else is clicked; a toast underneath it
       * is a second, quieter claim about the same event, and the risk is
       * somebody reading the toast and dismissing the dialog.
       */
      if (issuedPassword) onIssued(issuedPassword);
      else toast.success(user ? "User updated" : "User created");

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

        {/* ------------------------------------------------------------------
            P8-05 — the break inside those hours.

            Directly under the schedule, because it only means anything next to
            it: the hours above are a SPAN and this is what comes out of it, so
            09:00–18:00 with 60 here is the eight-hour day the timesheet is
            measured against.

            ⚠️ BLANK IS NOT ZERO. Blank inherits the company break; a typed 0
            says this person takes none, which raises what their week has to
            reach by an hour a day. Both are legitimate answers and the helper
            text has to keep them apart, because the failure is silent in one
            direction — somebody who genuinely takes no break, left blank, is
            simply never asked for the hour.
            ------------------------------------------------------------------ */}
        <div className="space-y-2">
          <Label htmlFor="break_minutes">Unpaid break</Label>
          <div className="flex items-center gap-2">
            <Input
              id="break_minutes"
              name="break_minutes"
              type="number"
              inputMode="numeric"
              min={0}
              max={480}
              step={5}
              placeholder="Company"
              className="w-28 tabular-nums"
              value={breakMinutes}
              onChange={(event) => setBreakMinutes(event.target.value)}
              aria-invalid={Boolean(fieldErrors.break_minutes)}
              aria-describedby="break_minutes_hint"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
            {breakMinutes ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setBreakMinutes("")}>
                Use company break
              </Button>
            ) : null}
          </div>
          {fieldErrors.break_minutes ? (
            <p className="text-xs text-destructive">{fieldErrors.break_minutes[0]}</p>
          ) : (
            <p id="break_minutes_hint" className="text-xs text-muted-foreground">
              Leave blank to use the company break set in Settings — that is the usual answer.
              Fill it in only for someone whose break differs, and type 0 for someone who takes
              none. The hours above less this break is the day a timesheet week is measured
              against, so a week short of it cannot be handed in.
            </p>
          )}
        </div>

        {/*
          P8-01 — THE RANK LADDER.

          Was a dropdown, which hid the one thing about roles that is actually
          confusing: they are INCLUSIVE. A manager is a team leader is a member
          (D15), the enum's declaration order is that ladder, and every check in
          the app and the database compares it with `>=`. A dropdown showing one
          value said none of that. Ticking a rank and watching everything under
          it tick and lock says all of it, in the control itself.

          Senior first, so "everything below" is literally below.
        */}
        <div className="space-y-3 rounded-lg border p-4">
          <div>
            <Label>Rank</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ranks are inclusive — ticking one ticks everything under it, and
              those stay ticked because they are not separate choices. What is
              stored is the highest tick.
            </p>
          </div>

          <div className="space-y-2">
            {RANK_LADDER.map((rank) => {
              const ticked = rankTicked(role, rank);
              /*
                ⚠️ ONLY AN OWNER MAY GRANT OWNER. The same rule the HR switch
                below has carried since P7-52, and it is what stops the ladder
                escalating itself. `/admin/users` is `requireRole("owner")` and
                `updateUser` re-checks on every call — that is the real gate;
                this only makes the form agree with it rather than offering a
                control that can only be refused.
              */
              const ownerBlocked = rank === "owner" && !viewerIsOwner;
              /*
                Two different facts, deliberately not one. `rankImplied` is what
                the "Included in …" hint asserts; `rankLocked` is what disables
                the control, and it is WIDER — the bottom rung is locked without
                being implied by anything above it, because everyone is at least
                a member. Collapsing them is how the Member checkbox came to
                render enabled and snap back when unticked.
              */
              const implied = rankImplied(role, rank);
              const locked = rankLocked(role, rank) || ownerBlocked;

              return (
                <label
                  key={rank}
                  className="flex items-start gap-3 text-sm data-[disabled=true]:opacity-50"
                  data-disabled={locked}>
                  <Checkbox
                    className="mt-0.5"
                    checked={ticked}
                    disabled={locked}
                    onCheckedChange={(checked) => toggleRank(rank, checked === true)}
                  />
                  <span>
                    <span className="font-medium">{ROLE_LABELS[rank].label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {implied
                        ? `Included in ${ROLE_LABELS[role].label}.`
                        : ownerBlocked
                          ? "Only an owner can grant this."
                          : ROLE_LABELS[rank].hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="primary_department">Belongs to</Label>
            <Select
              items={departmentItems}
              value={primaryDepartmentId ?? NO_DEPARTMENT}
              onValueChange={(value) => {
                const next = value === NO_DEPARTMENT ? null : value;
                setPrimaryDepartmentId(next);
                /* ⚠️ CLEAR THE ADMIN TICK WITH IT, or the two diverge and the
                   record cannot be saved OR corrected. The switch below draws
                   from `isDeptAdmin && primaryDepartmentId` and is DISABLED
                   without a department, so leaving the raw state set gives an
                   owner a control that already looks off, cannot be toggled,
                   and still submits `true` — which the schema then refuses,
                   with the explanation landing in a `fieldErrors` key this
                   block does not render. Resetting here is what keeps what is
                   on screen and what gets sent the same value. */
                if (!next) setIsDeptAdmin(false);
              }}
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
          P7-52 and P8-01 — THE CAPABILITY SWITCHES, which sit below the rank
          ladder because they are a different kind of statement. The ladder says
          where somebody sits; these say what job they hold while sitting there.

          ⚠️ NEITHER IS A RUNG, and that is the whole design (D33). The role enum
          is a total order compared with `>=` in SQL and `indexOf` in TS, so
          every value must sit somewhere on member→owner. "HR" and "department
          admin" sit nowhere on it — a member can hold either — and wedging one
          in would silently grant or revoke everything above or below the slot.

          ⚠️ ONLY AN OWNER MAY GRANT EITHER, and this screen is
          `requireRole("owner")`, which is what makes that true. It is the only
          place these can be set, and that is precisely what stops a capability
          escalating itself: an HR person cannot appoint another HR person, and a
          department admin cannot appoint another department admin or widen their
          own scope. The `disabled` below only makes the form agree with the gate.

          Rendered for a NEW user too, unlike Active below — an account can be
          created for somebody joining to do one of these jobs, and making an
          owner save twice to say so would be pointless.
        */}
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="is_dept_admin">Admin</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {!viewerIsOwner
                ? "Only an owner can grant this."
                : /* ⚠️ THE TICK IS SCOPED TO A DEPARTMENT, SO IT NEEDS ONE.
                     `vizserve_pms_is_dept_admin` compares its argument with the
                     holder's `primary_department_id`; with none set the tick
                     saves and grants nothing, and this copy would be claiming a
                     capability nobody has. The schema refuses the combination
                     too — that half is the enforcement, this half is the
                     explanation. */
                  !primaryDepartmentId
                  ? "Choose the department this person belongs to first — this tick only covers their own department."
                  : isDeptAdmin
                    ? "Administrative capability over their own department — the one under “Belongs to” above, not the ones they lead. Their rank is unchanged, so they still report to their Team Leader and approve nothing."
                    : "Not a department admin. Every owner already administers every department regardless of this switch."}
            </p>
          </div>
          <Switch
            id="is_dept_admin"
            /* `isDeptAdmin` alone: the reset above guarantees it is already
               false whenever there is no department, so a second guard here
               would only hide a divergence rather than prevent one. */
            checked={isDeptAdmin}
            disabled={!viewerIsOwner || !primaryDepartmentId}
            onCheckedChange={setIsDeptAdmin}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="is_hr">HR</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {!viewerIsOwner
                ? "Only an owner can grant this."
                : isHr
                  ? "Can set leave balances, edit leave types and holidays, and run the leave report for everyone. Cannot manage users."
                  : "Not an HR user. Every owner already has these abilities regardless of this switch."}
            </p>
          </div>
          <Switch
            id="is_hr"
            checked={isHr}
            disabled={!viewerIsOwner}
            onCheckedChange={setIsHr}
          />
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
