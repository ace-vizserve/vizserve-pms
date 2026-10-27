"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FilterX } from "lucide-react";

import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_PERIOD,
  ENVIRONMENT_LABELS,
  ERROR_ENVIRONMENTS,
  type ErrorEnvironment,
  type ErrorPeriod,
} from "@/lib/error-log";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The error log's filters, shaped like the audit trail's: each one writes the
 * URL, and the server page reads it back. Defaults stay out of the URL, so the
 * everyday link is just /admin/errors.
 */

const ALL = "__all__";


const PERIOD_ITEMS: Record<ErrorPeriod, string> = { "1": "Last 24 hours", "7": "Last 7 days", "30": "Last 30 days" };
const ENVIRONMENT_ITEMS: Record<string, string> = { [ALL]: "Everywhere", ...ENVIRONMENT_LABELS };
const SOURCE_ITEMS: Record<string, string> = { [ALL]: "Server and browser", server: "Server", client: "Browser" };

export function ErrorFilters({
  period,
  environment,
  source,
}: {
  period: ErrorPeriod;
  /** Null is "everywhere". */
  environment: ErrorEnvironment | null;
  source: "server" | "client" | null;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function setParam(key: string, value: string | null, fallback: string | null = null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    const query = next.toString();
    router.push(query ? `/admin/errors?${query}` : "/admin/errors");
  }

  const hasFilters = period !== DEFAULT_PERIOD || environment !== DEFAULT_ENVIRONMENT || source !== null;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="errors-environment" className="text-xs text-muted-foreground">
          Where
        </Label>
        <Select
          items={ENVIRONMENT_ITEMS}
          value={environment ?? ALL}
          // "Everywhere" is the one that needs a value in the URL — the default
          // is Live, so leaving the key out would mean Live.
          onValueChange={(value) => setParam("env", value === ALL ? "all" : value, DEFAULT_ENVIRONMENT)}
        >
          <SelectTrigger id="errors-environment" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everywhere</SelectItem>
            {ERROR_ENVIRONMENTS.map((option) => (
              <SelectItem key={option} value={option}>
                {ENVIRONMENT_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="errors-source" className="text-xs text-muted-foreground">
          Caught in
        </Label>
        <Select items={SOURCE_ITEMS} value={source ?? ALL} onValueChange={(value) => setParam("source", value, ALL)}>
          <SelectTrigger id="errors-source" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SOURCE_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="errors-period" className="text-xs text-muted-foreground">
          Period
        </Label>
        <Select items={PERIOD_ITEMS} value={period} onValueChange={(value) => setParam("period", value, DEFAULT_PERIOD)}>
          <SelectTrigger id="errors-period" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PERIOD_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters ? (
        <Button className="self-end" onClick={() => router.push("/admin/errors")} size="sm" variant="ghost">
          <FilterX />
          Reset
        </Button>
      ) : null}
    </>
  );
}
