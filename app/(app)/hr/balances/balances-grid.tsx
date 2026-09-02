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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { leaveTypeApplies } from "@/lib/schemas/leave-balances";
import { cn } from "@/lib/utils";
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
          people.some(
            (person) => allocations[`${person.id}:${type.id}`] !== undefined,
          ),
      ),
    [leaveTypes, people, allocations],
  );

  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => {
      if (
        department !== ALL_DEPARTMENTS &&
        person.primary_department_id !== department
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        person.full_name.toLowerCase().includes(needle) ||
        person.email.toLowerCase().includes(needle)
      );
    });
  }, [people, department, query]);

  /*
   * ⚠️ BASE UI PRINTS THE RAW VALUE IN <SelectValue> UNLESS THE ROOT IS HANDED
   * AN `items` MAP. Without it the closed trigger showed the "__ALL__" sentinel
   * while the open list showed "All departments" — the same control saying two
   * different things depending on whether you were looking at it.
   */
  const departmentItems: Record<string, string> = {
    [ALL_DEPARTMENTS]: "All departments",
    ...Object.fromEntries(departments.map((dept) => [dept.id, dept.name])),
  };

  /** Cells whose value differs from what the server sent. */
  const changedKeys = useMemo(
    () =>
      Object.keys(draft).filter(
        (key) => draft[key] !== cellValue(allocations[key]),
      ),
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
        if (
          !leaveTypeApplies(
            typeFor(typeId)?.applies_to_gender ?? null,
            person.gender,
          )
        )
          continue;
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
      sortKey: "person",
      header: "Employee",
      /* One column per leave type means this grid scrolls sideways on any real
         data set. Freezing the name is what keeps a row identifiable once the
         numbers have scrolled past it. */
      pin: "left",
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
    {
      /*
       * P7-66. `primary_department_id` is on every row and `departments` is
       * already a prop — the grid simply never showed which team a person is
       * on, which is the first thing somebody allocating leave wants to group
       * by.
       */
      key: "department",
      sortKey: "department",
      header: "Department",
      hideable: true,
      defaultHidden: true,
      className: "hidden lg:table-cell whitespace-nowrap text-muted-foreground",
      cell: (person) =>
        person.primary_department_id ? (
          (departments.find((d) => d.id === person.primary_department_id)
            ?.name ?? "—")
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "allocated",
      sortKey: "allocated",
      header: "Total",
      hideable: true,
      defaultHidden: true,
      align: "end",
      className: "hidden xl:table-cell tabular-nums font-medium",
      /*
       * The sum of the row, so the per-type columns have something to be read
       * against. It reads the DRAFT, not the saved allocations, so an edit in
       * progress is reflected — a total that disagrees with the numbers beside
       * it would be worse than no total.
       */
      cell: (person) => {
        const total = columnsTypes.reduce((sum, type) => {
          const raw =
            draft[`${person.id}:${type.id}`] ??
            cellValue(allocations[`${person.id}:${type.id}`]);
          const days = Number(raw);
          return sum + (Number.isFinite(days) ? days : 0);
        }, 0);

        return total === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          total
        );
      },
    },
    ...columnsTypes.map((type): Column<BalancePerson> => ({
      key: type.id,
      header: (
        /*
          TWO LINES, HARD.

          TableHead is nowrap, and "Anti-Violence Against Women and Their
          Children (VAWC) Leave" on one unbreakable line set the minimum width
          of the whole table to that sentence. Letting it wrap freely was worse:
          in a 96px column it became a seven-line tower and every other header
          inherited that row height.

          `line-clamp-2` caps it, `title` keeps the full name reachable (Section 4.3),
          and `break-words` stops a single long word forcing the column wider.
        */
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span
            title={type.label}
            className="line-clamp-2 break-words whitespace-normal"
          >
            {type.label}
          </span>
          {!type.is_active ? (
            <span className="text-2xs font-normal text-muted-foreground">
              retired
            </span>
          ) : null}
        </div>
      ),
      align: "end",
      className: "w-24",
      cell: (person) => {
        const key = `${person.id}:${type.id}`;

        // P7-45. A type restricted by gender is not merely hidden from this
        // person's picker — the database REFUSES a request filed against it —
        // so an allocation here would be days they can never spend.
        if (!leaveTypeApplies(type.applies_to_gender, person.gender)) {
          return (
            <span
              className="text-xs text-foreground-faint"
              title="Does not apply to this person"
            >
              —
            </span>
          );
        }

        const value = draft[key] ?? "";
        const changed = value !== cellValue(allocations[key]);

        return (
          <Input
            type="number"
            min={0}
            max={366}
            step={0.5}
            inputMode="decimal"
            placeholder="—"
            aria-label={`${type.label} for ${person.full_name}`}
            value={value}
            onChange={(event) => setCell(key, event.target.value)}
            className={cn(
              "h-8 w-16 text-right tabular-nums transition-colors",
              /*
                ⚠️ AN UNSET CELL RECEDES, and this is the single change that
                makes the screen readable.
                
                Every cell rendered a filled, bordered box whether or not it
                held anything, so a company of sixteen people across nine leave
                types drew about a hundred and fifty identical grey rectangles.
                The four or five rows that actually had numbers in them were
                invisible inside that, and the page read as a form nobody had
                filled in rather than as a table with some values in it.

                Empty cells keep the placeholder dash — so the cell is still
                obviously there and still obviously typeable — and take their
                border and fill back on hover and focus. It is still a real
                `<input>` at rest: tabbable, typeable, announced identically.
                Only the paint changes.
              */
              !value &&
                !changed &&
                "border-transparent bg-transparent shadow-none hover:border-input hover:bg-card focus:border-input focus:bg-card",
              value && "font-medium text-foreground",
              // Unsaved. Never colour alone — the Save button counts them too.
              changed && "border-primary bg-accent/50 font-medium",
            )}
          />
        );
      },
    })),
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility(
    "hr-balances",
    columns,
  );

  return (
    <>
      {/*
        ONE BAR, NOT THREE FLOATING GROUPS. The year navigator, the two filters
        and Save were laid out directly on the page ground beside a separate
        dashed panel of fill controls, so the screen opened with three unrelated
        clusters above a table and nothing said which of them was the toolbar.
      */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 rounded-lg border bg-card grade-surface p-3 shadow-raised">
        <div className="flex flex-wrap items-end gap-3">
          {/* The year, in the URL. Plain links rather than a picker so the view
              is shareable and the back button does the obvious thing. */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Year</Label>
            <div className="flex items-center gap-1">
              <Link
                href={`/hr/balances?year=${year - 1}`}
                aria-label={`Go to ${year - 1}`}
                className={buttonVariants({
                  variant: "outline",
                  size: "icon-sm",
                })}
              >
                <ChevronLeft />
              </Link>
              <span className="min-w-14 text-center text-sm font-medium tabular-nums">
                {year}
              </span>
              <Link
                href={`/hr/balances?year=${year + 1}`}
                aria-label={`Go to ${year + 1}`}
                className={buttonVariants({
                  variant: "outline",
                  size: "icon-sm",
                })}
              >
                <ChevronRight />
              </Link>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="department" className="text-xs">
              Department
            </Label>
            <Select
              items={departmentItems}
              value={department}
              onValueChange={(value) => setDepartment(value ?? ALL_DEPARTMENTS)}
            >
              <SelectTrigger id="department" className="h-9 w-44">
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

          {/* Nine [box][button] pairs, wrapping onto two lines, for a job done
              once each January. One control now — see `FillColumn`. */}
          {columnsTypes.length > 0 ? (
            <FillColumn
              types={columnsTypes}
              people={visiblePeople.length}
              onFill={fillColumn}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          {year !== currentYear ? (
            <Badge variant="outline">Not the current year</Badge>
          ) : null}
          {/*
            OUTLINE UNTIL THERE IS SOMETHING TO SAVE. A disabled PRIMARY button
            is a brand-filled rectangle at half opacity, and that is this page's
            resting state — so the loudest control on the screen spent almost
            all of its life looking broken. Outline is the honest drawing of
            "nothing to do yet"; it becomes the primary the moment a cell
            changes, which is the moment it means something.
          */}
          <Button
            variant={changedKeys.length === 0 ? "outline" : "default"}
            onClick={save}
            loading={pending}
            disabled={changedKeys.length === 0}
          >
            {changedKeys.length === 0
              ? "No changes"
              : `Save ${changedKeys.length} ${changedKeys.length === 1 ? "change" : "changes"}`}
          </Button>
        </div>
      </div>

      {/* No wrapper: `DataTable` renders inside `DataTableShell`, which is
          already the bordered panel AND the horizontal scroll container. */}

      <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        columns={columns}
        rows={visiblePeople}
        getRowKey={(person) => person.id}
        /* The department Select stays in the page row above: it narrows who is
           ELIGIBLE and pairs with the Fill control that acts on that scope. The
           name search narrows what is on screen, so it belongs to the table. */
        toolbar={
          <Input
            id="search"
            value={query}
            placeholder="Find someone by name or email"
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full sm:w-64"
            aria-label="Find someone"
          />
        }
        count={
          <>
            <span className="tabular-nums">{visiblePeople.length}</span>{" "}
            {visiblePeople.length === 1 ? "person" : "people"}
          </>
        }
        rowClassName={(person) => (person.is_active ? undefined : "opacity-60")}
        empty="Nobody matches these filters."
      />
    </>
  );
}

/**
 * "Give everyone shown the same number", as ONE control.
 *
 * ⚠️ IT WAS NINE OF THEM. Every leave type had its own number box and its own
 * button, in a dashed panel above the table — eighteen controls wrapping onto
 * two lines, permanently on screen, for a chore done once each January. It was
 * the largest and loudest thing on the page and the least used.
 *
 * A popover trades one extra click for the whole block. It also gets to say
 * something the row of buttons could not: how many people it is about to touch.
 * That count is the department filter's doing — "everyone in VizMedia gets 15"
 * is one selection and one number — and it was invisible before, so the scope
 * of a fill had to be inferred from a control somewhere else on the screen.
 *
 * Still PRE-FILLS AND DOES NOT SAVE, which is the property that matters most
 * here; see `fillColumn`.
 */
function FillColumn({
  types,
  people,
  onFill,
}: {
  types: BalanceLeaveType[];
  /** How many rows the fill will reach, after the filters. */
  people: number;
  onFill: (typeId: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState<string>(types[0]?.id ?? "");
  const [value, setValue] = useState("");

  // Without this the trigger showed the leave type's UUID. See the note beside
  // `departmentItems`.
  const typeItems = Object.fromEntries(
    types.map((type) => [type.id, type.label]),
  );

  const ready = typeId !== "" && value.trim() !== "" && people > 0;

  function apply() {
    if (!ready) return;
    onFill(typeId, value);
    setValue("");
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setValue("");
      }}
    >
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "h-9 gap-1.5",
        )}
      >
        <CopyPlus className="size-3.5" aria-hidden />
        Fill a column
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-3">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fill-type">Leave type</Label>
            <Select
              items={typeItems}
              value={typeId}
              onValueChange={(next) => setTypeId(next ?? "")}
            >
              <SelectTrigger id="fill-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fill-days">Days each</Label>
            <Input
              id="fill-days"
              type="number"
              min={0}
              max={366}
              step={0.5}
              inputMode="decimal"
              value={value}
              placeholder="e.g. 15"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") apply();
              }}
              className="tabular-nums"
            />
          </div>

          {/* Says WHAT IT WILL DO before it does it, including the scope the
              department filter is silently setting. */}
          <p className="text-2xs text-muted-foreground">
            {people === 0
              ? "No rows match the current filters, so there is nothing to fill."
              : `Fills this column for the ${people} ${people === 1 ? "person" : "people"} shown. Nothing is saved until you press Save.`}
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!ready} onClick={apply}>
              Fill
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
