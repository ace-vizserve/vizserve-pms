"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FilterX } from "lucide-react";

import { NOTIFICATION_TYPE_LABELS, NOTIFICATION_TYPES, type ReadFilter } from "@/lib/notifications";
import type { VizservePmsNotificationType } from "@/lib/database.types";
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

/**
 * `items` on the Root is not optional decoration.
 *
 * Base UI's `Select.Value` renders the RAW VALUE unless the Root is given an
 * items map (or Value is given a formatter). Without it the trigger showed
 * literally "__all__" and "all" instead of the labels — and every other select
 * in the app has the same gap, so the requests filter shows "PENDING_REVIEW"
 * and the DTR person picker shows a UUID.
 */
const TYPE_ITEMS: Record<string, string> = {
  [ALL]: "All types",
  ...Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, NOTIFICATION_TYPE_LABELS[type]])),
};

const READ_ITEMS: Record<string, string> = {
  all: "All",
  unread: "Unread",
  read: "Read",
};

/**
 * Type and read/unread filters for the inbox.
 *
 * Returns a FRAGMENT, not a wrapper — the caller lays these out in the same
 * flex row as the search box, and an extra div here would break that onto its
 * own line.
 *
 * URL-driven like `RequestFilters`, so a view survives a refresh and can be
 * sent to someone. Every change drops `page`: filtering from page 6 into a
 * two-page result set otherwise lands on an empty list that reads as a bug.
 */
export function InboxFilters({
  type,
  read,
}: {
  type: VizservePmsNotificationType | null;
  read: ReadFilter;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI's Select emits `string | null` on clear; the falsy branch covers
  // both that and the sentinel.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    next.delete("page");

    const query = next.toString();
    router.push(query ? `/inbox?${query}` : "/inbox");
  }

  const hasFilters = Boolean(type) || read !== "all";

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="inbox-type" className="text-xs text-muted-foreground">
          Type
        </Label>
        <Select
          items={TYPE_ITEMS}
          value={type ?? ALL}
          onValueChange={(value) => setParam("type", value)}
        >
          <SelectTrigger id="inbox-type" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {NOTIFICATION_TYPES.map((option) => (
              <SelectItem key={option} value={option}>
                {NOTIFICATION_TYPE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="inbox-read" className="text-xs text-muted-foreground">
          Status
        </Label>
        <Select items={READ_ITEMS} value={read} onValueChange={(value) => setParam("read", value)}>
          <SelectTrigger id="inbox-read" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="read">Read</SelectItem>
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
            next.delete("type");
            next.delete("read");
            next.delete("page");
            const query = next.toString();
            router.push(query ? `/inbox?${query}` : "/inbox");
          }}
        >
          {/* FilterX, not a bare X: this clears the two dropdowns, not the whole
              toolbar, and a lone cross next to a search box reads as "clear the
              search" — which is the one thing it deliberately leaves alone. */}
          <FilterX />
          Clear
        </Button>
      ) : null}
    </>
  );
}
