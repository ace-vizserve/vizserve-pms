"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, CopyPlus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/data-table";
import { leaveTypeApplies } from "@/lib/schemas/leave-balances";
import type { Gender } from "@/lib/schemas/users";

import { setLeaveAllocationsBulk } from "./actions";

export type BalancePerson = {
  id: string;
  full_name: string;
  email: string;
  gender: Gender | null;
  is_active: boolean;
  primary_department_id: string | null;
};

export type BalanceLeaveType = {
  id: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  applies_to_gender: Gender | null;
};

const ALL_DEPARTMENTS = "__ALL__";

/**
 * `12` not `12.0`, and `""` for nothing set.
 *
 * ⚠️ BLANK IS NOT ZERO, and this is the trap the whole component is built
 * around. `Number("")` is 0, so a cleared box read naively becomes a deliberate
 * "no days this year" written over somebody's entitlement — a wrong figure that
 * looks like a decision. Every cell is held as a STRING from here to submit,
 * blanks are dropped rather than coerced, and `blankToNaN` in
 * `lib/schemas/leave-balances.ts` is the wall behind that.
 */
function cellValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function BalancesGrid({
  year,
  currentYear,
  people,
  leaveTypes,
  departments,
  allocations,
}: {
  year: number;
  currentYear: number;
  people: BalancePerson[];
  leaveTypes: BalanceLeaveType[];
  departments: { id: string; name: string }[];
  allocations: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [department, setDepartment] = useState<string>(ALL_DEPARTMENTS);
  const [query, setQuery] = useState("");

  /**
   * The edit buffer, keyed `userId:typeId`, seeded from the server rows.
   *
   * Seeded ONCE per mount. A `useEffect` resyncing it from props would discard
   * whatever HR had half-typed the moment any parent re-render happened, which
   * on a grid this size is the difference between a tool and a hazard. The year
   * navigation is a full page load, so there is no stale-year case to handle.
   */
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {};
    for (const person of people) {
      for (const type of leaveTypes) {
        const key = `${person.id}:${type.id}`;
        seeded[key] = cellValue(allocations[key]);
      }
    }
    return seeded;
  });

  /**
   * Types worth a column.
   *
   * A retired type is kept ONLY where somebody already holds an allocation
   * under it — dropping the column would hide a number that is still real and
   * still counted by the audit report, and there would be no way to correct it.
   * A retired type nobody holds is just noise.
   */
  const columnsTypes = useMemo(
    () =>
      leaveTypes.filter(
        (type) =>
          type.is_active ||
          people.some((person) => allocations[`${person.id}:${type.id}`] !== undefined),
      ),
    [leaveTypes, people, allocations],
  );

  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => {
      if (department !== ALL_DEPARTMENTS && person.primary_department_id !== department) {
        return false;
      }
      if (!needle) return true;
      return (
        person.full_name.toLowerCase().includes(needle) ||
        person.email.toLowerCase().includes(needle)
      );
    });
  }, [people, department, query]);

  /** Cells whose value differs from what the server sent. */
  const changedKeys = useMemo(
    () =>
      Object.keys(draft).filter((key) => draft[key] !== cellValue(allocations[key])),
    [draft, allocations],
  );

  function setCell(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  /**
   * "Give everyone shown the same number."
   *
   * ⚠️ THIS PRE-FILLS AND DOES NOT SAVE. Nothing is written until Save, so the
   * figures stay HR's to look at and change first. That matters more than it
   * looks: D27 puts CARRY-OVER explicitly out of scope — nothing in this app
   * rolls an unused day into the next year — and any button that WROTE a column
   * of numbers on its own would be carry-over with a friendly label, invisible
   * as such a year later.
   *
   * ⚠️ IT IS NOT "COPY LAST YEAR", which the plan floated and which is NOT
   * built. That version would read one year to seed another, which is precisely
   * the shape D27 rules out, and the honest way to do it is to open last year
   * in the year navigator and read it. This fills a column with a number a
   * person typed, which is the actual January chore: "everybody gets 15 days".
   *
   * Applies only to the VISIBLE people, so the department filter doubles as the
   * scope of the fill — "everyone in VizMedia gets 15" is one selection and one
   * number rather than fifteen boxes.
   */
  function fillColumn(typeId: string, value: string) {
    if (value.trim() === "") return;
    setDraft((current) => {
      const next = { ...current };
      for (const person of visiblePeople) {
        if (!leaveTypeApplies(typeFor(typeId)?.applies_to_gender ?? null, person.gender)) continue;
        next[`${person.id}:${typeId}`] = value;
      }
      return next;
    });
  }

  function typeFor(id: string) {
    return columnsTypes.find((type) => type.id === id);
  }

  function save() {
    if (changedKeys.length === 0) return;

    // Grouped by person, because that is the shape the action and the audit row
    // both take: one log entry per person per save, not one per cell.
    const touched = new Set(changedKeys.map((key) => key.split(":")[0]));

    const payload = [...touched].map((userId) => ({
      user_id: userId,
      balance_year: year,
      // Every type this person has a value for, not only the changed ones — the
      // action upserts what it is given, and sending a partial set would be
      // fine but makes the audit row's before/after read as though the omitted
      // types had been cleared.
      allocations: columnsTypes
        .map((type) => ({
          leave_type_id: type.id,
          days_allocated: draft[`${userId}:${type.id}`] ?? "",
        }))
        // Blanks are DROPPED, never coerced. See `cellValue`.
        .filter((allocation) => allocation.days_allocated.trim() !== ""),
    }));

    startTransition(async () => {
      const result = await setLeaveAllocationsBulk(payload);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(
        `Saved ${result.data.saved} ${result.data.saved === 1 ? "person" : "people"}.`,
      );
      router.refresh();
    });
  }

  const columns: Column<BalancePerson>[] = [
    {
      key: "person",
      header: "Employee",
      className: "min-w-[200px]",
      cell: (person) => (
        <div className="flex flex-col">
          <span className="font-medium">{person.full_name}</span>
          {!person.is_active ? (
            <Badge variant="outline" className="mt-0.5 w-fit">
              No longer active
            </Badge>
          ) : null}
        </div>
      ),
    },
    ...columnsTypes.map(
      (type): Column<BalancePerson> => ({
        key: type.id,
        header: (
          <div className="flex flex-col items-end gap-1">
            <span>{type.label}</span>
            {!type.is_active ? (
              <span className="text-[10px] font-normal text-muted-foreground">retired</span>
            ) : null}
          </div>
        ),
        align: "end",
        cell: (person) => {
          const key = `${person.id}:${type.id}`;

          // P7-45. A type restricted by gender is not merely hidden from this
          // person's picker — the database REFUSES a request filed against it —
          // so an allocation here would be days they can never spend.
          if (!leaveTypeApplies(type.applies_to_gender, person.gender)) {
            return (
              <span className="text-xs text-muted-foreground" title="Does not apply to this person">
                —
              </span>
            );
          }

          const changed = draft[key] !== cellValue(allocations[key]);

          return (
            <Input
              type="number"
              min={0}
              max={366}
              step={0.5}
              inputMode="decimal"
              aria-label={`${type.label} for ${person.full_name}`}
              value={draft[key] ?? ""}
              onChange={(event) => setCell(key, event.target.value)}
              className={`h-8 w-20 text-right tabular-nums ${changed ? "border-primary" : ""}`}
            />
          );
        },
      }),
    ),
  ];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {/* The year, in the URL. Plain links rather than a picker so the view
              is shareable and the back button does the obvious thing. */}
          <div className="flex items-center gap-1">
            <Link
              href={`/hr/balances?year=${year - 1}`}
              aria-label={`Go to ${year - 1}`}
              className={buttonVariants({ variant: "outline", size: "icon-sm" })}
            >
              <ChevronLeft />
            </Link>
            <span className="min-w-16 text-center text-sm font-medium tabular-nums">{year}</span>
            <Link
              href={`/hr/balances?year=${year + 1}`}
              aria-label={`Go to ${year + 1}`}
              className={buttonVariants({ variant: "outline", size: "icon-sm" })}
            >
              <ChevronRight />
            </Link>
            {year !== currentYear ? (
              <Badge variant="outline" className="ml-1">
                Not the current year
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="department" className="text-xs">
              Department
            </Label>
            <Select
              value={department}
              onValueChange={(value) => setDepartment(value ?? ALL_DEPARTMENTS)}
            >
              <SelectTrigger id="department" className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>
                {departments.map((dept) => (
                  <SelectItem key={dept.id} value={dept.id}>
                    {dept.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="search" className="text-xs">
              Find someone
            </Label>
            <Input
              id="search"
              value={query}
              placeholder="Name or email"
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-56"
            />
          </div>
        </div>

        <Button onClick={save} disabled={pending || changedKeys.length === 0}>
          {pending
            ? "Saving…"
            : changedKeys.length === 0
              ? "No changes"
              : `Save ${changedKeys.length} ${changedKeys.length === 1 ? "change" : "changes"}`}
        </Button>
      </div>

      {/* Fill-a-column, one button per type. Sits above the table rather than in
          the header cell so the header stays a label and the action stays
          obviously an action. */}
      {columnsTypes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CopyPlus className="size-3.5" aria-hidden />
            Give everyone shown the same number:
          </span>
          {columnsTypes.map((type) => (
            <FillColumnButton
              key={type.id}
              label={type.label}
              onFill={(value) => fillColumn(type.id, value)}
            />
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          rows={visiblePeople}
          getRowKey={(person) => person.id}
          rowClassName={(person) => (person.is_active ? undefined : "opacity-60")}
          empty="Nobody matches these filters."
        />
      </div>
    </>
  );
}

/** A number box and a button, so filling a column takes one decision. */
function FillColumnButton({
  label,
  onFill,
}: {
  label: string;
  onFill: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <span className="inline-flex items-center gap-1">
      <Input
        type="number"
        min={0}
        max={366}
        step={0.5}
        value={value}
        aria-label={`Days to give everyone for ${label}`}
        onChange={(event) => setValue(event.target.value)}
        className="h-7 w-16 text-right tabular-nums"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-7"
        disabled={value.trim() === ""}
        onClick={() => {
          onFill(value);
          setValue("");
        }}
      >
        {label}
      </Button>
    </span>
  );
}
