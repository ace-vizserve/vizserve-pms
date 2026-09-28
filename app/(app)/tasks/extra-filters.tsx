"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth/client-auth";
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
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const auth = useAuth();

  function setParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === ANY) next.delete(key);
      else next.set(key, value);
    }
    router.push(`${pathname}?${next.toString()}`);
  }

  // ── search ──────────────────────────────────────────────────────────────────
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

  // ── person ──────────────────────────────────────────────────────────────────
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

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="task-search" className="text-xs text-muted-foreground">
          Search
        </Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="task-search"
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Task name"
            className="w-52 pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task-person" className="text-xs text-muted-foreground">
          Person
        </Label>
        <Select
          items={personItems}
          value={person ?? ANY}
          // Choosing nobody drops the role too — it only means something with a person.
          onValueChange={(value) => setParams({ person: value, ...(value === ANY || !value ? { role: null } : {}) })}
        >
          <SelectTrigger id="task-person" className="w-48">
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
      </div>

      {person ? (
        <div className="space-y-1.5">
          <Label htmlFor="task-role" className="text-xs text-muted-foreground">
            As
          </Label>
          <Select
            items={roleItems}
            value={params.get("role") ?? "any"}
            onValueChange={(value) => setParams({ role: value === "any" ? null : value })}
          >
            <SelectTrigger id="task-role" className="w-44">
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
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="task-due" className="text-xs text-muted-foreground">
          Due
        </Label>
        <Select
          items={dueItems}
          value={params.get("due") ?? ANY}
          onValueChange={(value) => setParams({ due: value })}
        >
          <SelectTrigger id="task-due" className="w-40">
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
      </div>
    </>
  );
}
