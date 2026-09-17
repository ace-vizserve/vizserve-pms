"use client";

import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fieldKey, type ListField } from "@/lib/schemas/list-fields";

/**
 * P7-73 — filtering the list on screen by its custom fields.
 *
 * ONE POPOVER, NOT A CONTROL PER FIELD IN THE BAR. A list can carry a dozen
 * fields, and the filter bar is a single row that already holds five controls.
 * The trigger counts the active ones, so a narrowed list never reads as the
 * whole list.
 *
 * Every value lives in the URL as `cf:<fieldId>`, in the shapes
 * `parseFieldFilter` reads (`lib/schemas/list-fields.ts`). `page.tsx` applies
 * them; this only writes them.
 */

const ANY = "__any__";

export function FieldFilters({
  fields,
  params,
  setParam,
}: {
  fields: ListField[];
  params: URLSearchParams;
  setParam: (key: string, value: string | null) => void;
}) {
  if (fields.length === 0) return null;

  const active = fields.filter((field) => params.get(fieldKey(field.id))).length;

  return (
    <div className="space-y-1.5">
      <span className="block text-xs text-muted-foreground">Custom fields</span>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" className="h-9" />}>
          <SlidersHorizontal />
          {active > 0 ? `${active} active` : "Filter by field"}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3 p-3">
          {fields.map((field) => (
            <FieldFilter
              key={field.id}
              field={field}
              value={params.get(fieldKey(field.id))}
              onChange={(next) => setParam(fieldKey(field.id), next)}
            />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FieldFilter({
  field,
  value,
  onChange,
}: {
  field: ListField;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const id = `filter-${field.id}`;

  if (field.field_type === "DROPDOWN" || field.field_type === "LABELS" || field.field_type === "CHECKBOX") {
    const items: Record<string, string> =
      field.field_type === "CHECKBOX"
        ? { [ANY]: "Any", yes: "Checked", no: "Unchecked" }
        : {
            [ANY]: field.field_type === "LABELS" ? "Any label" : "Any",
            ...Object.fromEntries(field.options.map((option) => [option.id, option.label])),
          };

    return (
      <div className="space-y-1">
        <Label htmlFor={id} className="text-xs">
          {field.name}
        </Label>
        <Select
          items={items}
          value={value && value in items ? value : ANY}
          onValueChange={(next) => onChange(!next || next === ANY ? null : next)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(items).map(([itemValue, label]) => (
              <SelectItem key={itemValue} value={itemValue}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.field_type === "NUMBER" || field.field_type === "DATE") {
    const [low = "", high = ""] = (value ?? "").split("..");
    const write = (nextLow: string, nextHigh: string) =>
      onChange(nextLow.trim() === "" && nextHigh.trim() === "" ? null : `${nextLow.trim()}..${nextHigh.trim()}`);

    return (
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium">{field.name}</legend>
        <div className="grid grid-cols-2 gap-2">
          {field.field_type === "DATE" ? (
            <>
              <DatePicker
                value={low || null}
                onChange={(next) => write(next ?? "", high)}
                max={high || undefined}
                clearable
                placeholder="From"
              />
              <DatePicker
                value={high || null}
                onChange={(next) => write(low, next ?? "")}
                min={low || undefined}
                clearable
                placeholder="To"
              />
            </>
          ) : (
            <>
              {/* Uncontrolled, keyed on the URL value: typing does not navigate on
                  every keystroke, and a change from elsewhere resets the box. */}
              <Input
                key={`min-${low}`}
                aria-label={`${field.name}, at least`}
                placeholder="Min"
                inputMode="decimal"
                defaultValue={low}
                onBlur={(event) => event.target.value !== low && write(event.target.value, high)}
                onKeyDown={(event) => event.key === "Enter" && write(event.currentTarget.value, high)}
              />
              <Input
                key={`max-${high}`}
                aria-label={`${field.name}, at most`}
                placeholder="Max"
                inputMode="decimal"
                defaultValue={high}
                onBlur={(event) => event.target.value !== high && write(low, event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && write(low, event.currentTarget.value)}
              />
            </>
          )}
        </div>
      </fieldset>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {field.name}
      </Label>
      <Input
        id={id}
        key={value ?? ""}
        placeholder="Contains…"
        defaultValue={value ?? ""}
        onBlur={(event) => event.target.value.trim() !== (value ?? "") && onChange(event.target.value.trim() || null)}
        onKeyDown={(event) => event.key === "Enter" && onChange(event.currentTarget.value.trim() || null)}
      />
    </div>
  );
}
