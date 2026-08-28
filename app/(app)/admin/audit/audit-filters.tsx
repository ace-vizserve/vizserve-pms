"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FilterX } from "lucide-react";

import {
  AUDIT_ENTITY_LABELS,
  AUDIT_ENTITY_TYPES,
  AUDIT_PERIOD_LABELS,
  AUDIT_PERIODS,
  type AuditEntityType,
  type AuditPeriod,
} from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "__all__";

/** The sentinel for "written by no account" — the cron, or a client token. */
export const SYSTEM_ACTOR = "system";

/**
 * `items` on the Root is not optional decoration.
 *
 * Base UI's `Select.Value` renders the RAW VALUE unless the Root is given an
 * items map (or Value is given a formatter). Without it the trigger shows
 * literally "__all__" instead of the label — the same trap the inbox filters
 * document.
 */
const ENTITY_ITEMS: Record<string, string> = {
  [ALL]: "All records",
  ...Object.fromEntries(AUDIT_ENTITY_TYPES.map((type) => [type, AUDIT_ENTITY_LABELS[type]])),
};

const PERIOD_ITEMS: Record<string, string> = Object.fromEntries(
  AUDIT_PERIODS.map((period) => [period, AUDIT_PERIOD_LABELS[period]]),
);

/**
 * Record-type, actor and period filters for the audit trail.
 *
 * Returns a FRAGMENT, not a wrapper — the caller lays these out in the same
 * flex row as the search box, and an extra div here would break that onto its
 * own line.
 *
 * URL-driven like the inbox and request filters, so a view survives a refresh
 * and can be pasted to someone else. Every change drops `page`: filtering from
 * page 6 into a two-page result set otherwise lands on an empty list that reads
 * as a bug.
 */
export function AuditFilters({
  entity,
  actor,
  period,
  actors,
}: {
  entity: AuditEntityType | null;
  /** A user id, `system`, or null for everyone. */
  actor: string | null;
  period: AuditPeriod;
  actors: { id: string; full_name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  // The system option is in the list rather than a separate toggle: "who did
  // this" has exactly one answer per row, and an actor that is nobody is one of
  // the answers. A cron auto-completing a request is the case people come
  // looking for, so it must be selectable, not only stumbled upon.
  const ACTOR_ITEMS: Record<string, string> = {
    [ALL]: "Anyone",
    [SYSTEM_ACTOR]: "System",
    ...Object.fromEntries(actors.map((person) => [person.id, person.full_name])),
  };

  // Base UI's Select emits `string | null` on clear; the falsy branch covers
  // both that and the sentinel.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    next.delete("page");

    const query = next.toString();
    router.push(query ? `/admin/audit?${query}` : "/admin/audit");
  }

  const hasFilters = Boolean(entity) || Boolean(actor) || period !== "30";

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="audit-entity" className="text-xs text-muted-foreground">
          Record
        </Label>
        <Select
          items={ENTITY_ITEMS}
          value={entity ?? ALL}
          onValueChange={(value) => setParam("entity", value)}
        >
          <SelectTrigger id="audit-entity" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All records</SelectItem>
            {AUDIT_ENTITY_TYPES.map((option) => (
              <SelectItem key={option} value={option}>
                {AUDIT_ENTITY_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="audit-actor" className="text-xs text-muted-foreground">
          Who
        </Label>
        <Select
          items={ACTOR_ITEMS}
          value={actor ?? ALL}
          onValueChange={(value) => setParam("actor", value)}
        >
          <SelectTrigger id="audit-actor" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Anyone</SelectItem>
            <SelectItem value={SYSTEM_ACTOR}>System</SelectItem>
            {actors.map((person) => (
              <SelectItem key={person.id} value={person.id}>
                {person.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="audit-period" className="text-xs text-muted-foreground">
          Period
        </Label>
        <Select
          items={PERIOD_ITEMS}
          value={period}
          onValueChange={(value) => setParam("period", value)}
        >
          <SelectTrigger id="audit-period" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUDIT_PERIODS.map((option) => (
              <SelectItem key={option} value={option}>
                {AUDIT_PERIOD_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters ? (
        <Button
          variant="ghost"
          onClick={() => {
            // Keeps the search term — clearing the dropdowns should not also
            // throw away what someone typed.
            const next = new URLSearchParams(params.toString());
            next.delete("entity");
            next.delete("actor");
            next.delete("period");
            next.delete("page");
            const query = next.toString();
            router.push(query ? `/admin/audit?${query}` : "/admin/audit");
          }}
        >
          {/* FilterX, not a bare X: this clears the three dropdowns, not the
              whole toolbar, and a lone cross next to a search box reads as
              "clear the search" — which is the one thing it leaves alone. */}
          <FilterX />
          Clear
        </Button>
      ) : null}
    </>
  );
}
