"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth/client-auth";
import { cn } from "@/lib/utils";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDirectory } from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import {
  DUE_FILTER_LABELS,
  DUE_FILTERS,
  PERSON_ROLE_LABELS,
  PERSON_ROLES,
} from "@/lib/task-extra-filters";

const ANY = "__any__";

/**
 * P12 — search, person and due date, shared by the list and the board.
 *
 * URL params like every other task filter (see `lib/task-extra-filters.ts`),
 * pushed to whichever of the two views is open, so switching between List and
 * Board keeps them.
 *
 * The search box writes `?q=` a moment after typing stops rather than on every
 * key, so each keystroke is not a navigation.
 */
export function TaskExtraFilters() {
  return (
    <>
      <TaskSearch />
      <TaskPersonDueFilters />
    </>
  );
}

/** Push a set of param changes to whichever view is open. */
function useSetParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === ANY) next.delete(key);
      else next.set(key, value);
    }
    router.push(`${pathname}?${next.toString()}`);
  };
}

/**
 * The title search. `bare` drops the visible label for a toolbar where the
 * placeholder and the icon already say what the box is — the label stays for
 * assistive tech.
 */
export function TaskSearch({ bare = false, className }: { bare?: boolean; className?: string }) {
  const params = useSearchParams();
  const setParams = useSetParams();

  const urlQuery = params.get("q") ?? "";
  const [draft, setDraft] = useState(urlQuery);
  const lastPushed = useRef(urlQuery);

  // The URL moved on its own (Clear, Back): follow it.
  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery;
      setDraft(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === lastPushed.current) return;
    const timer = window.setTimeout(() => {
      lastPushed.current = trimmed;
      setParams({ q: trimmed || null });
    }, 350);
    return () => window.clearTimeout(timer);
    // `setParams` reads the current URL when it runs; only the draft triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <div className={cn(!bare && "space-y-1.5", className)}>
      <Label htmlFor="task-search" className={cn("text-xs text-muted-foreground", bare && "sr-only")}>
        Search
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="task-search"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={bare ? "Search tasks" : "Task name"}
          className={cn("pl-8", bare ? "h-9 w-full" : "w-52")}
        />
      </div>
    </div>
  );
}

/**
 * Person, role and due date. `stacked` lays each as a label/control pair in a
 * parent two-column grid (the filter popover) instead of a labelled column in
 * a wrapping bar (the board).
 */
export function TaskPersonDueFilters({ stacked = false }: { stacked?: boolean }) {
  const params = useSearchParams();
  const auth = useAuth();
  const setParams = useSetParams();

  const people = useQuery({ queryKey: qk.ref("users"), queryFn: () => fetchDirectory(browserClient()) });
  const person = params.get("person");
  const personItems: Record<string, string> = {
    [ANY]: "Anyone",
    me: "Me",
    ...Object.fromEntries(
      (people.data ?? [])
        .filter((row) => row.is_active && row.id !== auth.userId)
        .map((row) => [row.id, row.full_name]),
    ),
  };

  const roleItems: Record<string, string> = Object.fromEntries(
    PERSON_ROLES.map((role) => [role, PERSON_ROLE_LABELS[role]]),
  );

  const dueItems: Record<string, string> = {
    [ANY]: "Any due date",
    ...Object.fromEntries(DUE_FILTERS.map((due) => [due, DUE_FILTER_LABELS[due]])),
  };

  const Field = stacked ? StackedField : InlineField;

  return (
    <>
      <Field id="task-person" label="Person">
        <Select
          items={personItems}
          value={person ?? ANY}
          // Choosing nobody drops the role too — it only means something with a person.
          onValueChange={(value) => setParams({ person: value, ...(value === ANY || !value ? { role: null } : {}) })}
        >
          <SelectTrigger id="task-person" className={stacked ? "w-full" : "w-48"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(personItems).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {person ? (
        <Field id="task-role" label="As">
          <Select
            items={roleItems}
            value={params.get("role") ?? "any"}
            onValueChange={(value) => setParams({ role: value === "any" ? null : value })}
          >
            <SelectTrigger id="task-role" className={stacked ? "w-full" : "w-44"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERSON_ROLES.map((role) => (
                <SelectItem key={role} value={role}>
                  {PERSON_ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <Field id="task-due" label="Due">
        <Select
          items={dueItems}
          value={params.get("due") ?? ANY}
          onValueChange={(value) => setParams({ due: value })}
        >
          <SelectTrigger id="task-due" className={stacked ? "w-full" : "w-40"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(dueItems).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

type FieldProps = { id: string; label: string; children: ReactNode };

function InlineField({ id, label, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Two cells of the popover's label/control grid. */
export function StackedField({ id, label, children }: FieldProps) {
  return (
    <>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </>
  );
}
