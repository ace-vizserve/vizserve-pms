import { z } from "zod";

import type { Json, VizservePmsListFieldType } from "@/lib/database.types";

/**
 * P7-73 — custom fields on a list. The contract (D3a).
 *
 * ⚠️ THE DATABASE IS THE ENFORCEMENT. `vizserve_pms_list_fields_guard` and
 * `vizserve_pms_tasks_custom_fields_guard`
 * (20260917120000_p7_73_list_custom_fields.sql) refuse every shape this file
 * refuses, and more. What lives here is the same rules in a form a screen can
 * report before a round trip, plus the pure helpers the task list sorts and
 * filters with.
 *
 * Nothing here is server-only: the sort and filter helpers run in `page.tsx`,
 * and the schemas in the field manager.
 */

export type ListFieldType = VizservePmsListFieldType;

/** In the order the type picker shows them — ClickUp's own "popular" order. */
export const LIST_FIELD_TYPES = [
  "DROPDOWN",
  "TEXT",
  "DATE",
  "TEXTAREA",
  "NUMBER",
  "LABELS",
  "CHECKBOX",
] as const satisfies readonly ListFieldType[];

export const LIST_FIELD_TYPE_META: Record<ListFieldType, { label: string; description: string }> = {
  DROPDOWN: {
    label: "Dropdown",
    description: "Create consistency with single select options — for categories, stages or anything with a fixed set of answers.",
  },
  TEXT: { label: "Text", description: "Add important context to any task in just one line." },
  DATE: { label: "Date", description: "Not every date is a due date. Mark the other dates that matter." },
  TEXTAREA: { label: "Text area", description: "Add longer details to a task." },
  NUMBER: { label: "Number", description: "Account for any number associated with a task." },
  LABELS: { label: "Labels", description: "Tag a task with as many options as apply." },
  CHECKBOX: { label: "Checkbox", description: "A yes or a no." },
};

/** Dropdown and Labels carry options; nothing else does. */
export function hasOptions(type: ListFieldType): boolean {
  return type === "DROPDOWN" || type === "LABELS";
}

/**
 * The six chip tones an option may wear. The same set
 * `vizserve_pms_list_fields_guard` accepts — the stage families are left out on
 * purpose, because they mean a position in the task pipeline and nothing else.
 */
export const OPTION_COLORS = ["neutral", "brand", "info", "success", "warning", "danger"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export const TEXT_MAX = 500;
export const TEXTAREA_MAX = 10_000;

export const listFieldOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1, "An option needs a label.").max(80, "Keep an option under 80 characters."),
  color: z.enum(OPTION_COLORS),
  is_active: z.boolean(),
});

export type ListFieldOption = z.infer<typeof listFieldOptionSchema>;

/** A field as the app uses it: options parsed, never raw jsonb. */
export type ListField = {
  id: string;
  list_id: string;
  name: string;
  field_type: ListFieldType;
  options: ListFieldOption[];
  decimals: number | null;
  sort_order: number;
  is_active: boolean;
};

/**
 * From a database row. An option that does not parse is DROPPED rather than
 * failing the whole field — the guard makes that impossible for anything
 * written through it, and one malformed option must not take a list's columns
 * down with it.
 */
export function toListField(row: {
  id: string;
  list_id: string;
  name: string;
  field_type: ListFieldType;
  options: Json;
  decimals: number | null;
  sort_order: number;
  is_active: boolean;
}): ListField {
  const options = Array.isArray(row.options)
    ? row.options.flatMap((option) => {
        const parsed = listFieldOptionSchema.safeParse(option);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

  return { ...row, options };
}

const nameSchema = z
  .string()
  .trim()
  .min(1, "A field needs a name.")
  .max(60, "Keep the name under 60 characters.");

const decimalsSchema = z.number().int().min(0).max(4);

/**
 * The rules a definition must meet, shared by create and update: a choice field
 * needs at least one active option and no two active options with one label;
 * a non-choice field carries none; a Number field says how many places.
 */
function refineDefinition(
  value: { field_type: ListFieldType; options: ListFieldOption[]; decimals: number | null },
  ctx: z.RefinementCtx,
) {
  if (hasOptions(value.field_type)) {
    const active = value.options.filter((option) => option.is_active);
    if (active.length === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least one option." });
    }

    const seen = new Set<string>();
    for (const option of active) {
      const key = option.label.trim().toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["options"], message: `"${option.label}" is listed twice.` });
      }
      seen.add(key);
    }

    const ids = new Set(value.options.map((option) => option.id));
    if (ids.size !== value.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Two options share an id." });
    }
  } else if (value.options.length > 0) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Only a dropdown or labels field has options." });
  }

  if (value.field_type === "NUMBER" && value.decimals === null) {
    ctx.addIssue({ code: "custom", path: ["decimals"], message: "Choose how many decimal places." });
  }
  if (value.field_type !== "NUMBER" && value.decimals !== null) {
    ctx.addIssue({ code: "custom", path: ["decimals"], message: "Only a number field has decimal places." });
  }
}

export const createListFieldSchema = z
  .object({
    list_id: z.uuid(),
    name: nameSchema,
    field_type: z.enum(LIST_FIELD_TYPES),
    options: z.array(listFieldOptionSchema).max(100, "Keep it under 100 options.").default([]),
    decimals: decimalsSchema.nullable().default(null),
  })
  .superRefine(refineDefinition);

export type CreateListFieldInput = z.input<typeof createListFieldSchema>;

/**
 * No `field_type`. The database would refuse a change once any task holds a
 * value, and the field manager does not offer one at all: archiving the field
 * and adding a new one says what actually happened.
 */
export const updateListFieldSchema = z.object({
  id: z.uuid(),
  name: nameSchema,
  options: z.array(listFieldOptionSchema).max(100, "Keep it under 100 options.").default([]),
  decimals: decimalsSchema.nullable().default(null),
});

export type UpdateListFieldInput = z.input<typeof updateListFieldSchema>;

const definitionSchema = z
  .object({
    field_type: z.enum(LIST_FIELD_TYPES),
    options: z.array(listFieldOptionSchema),
    decimals: decimalsSchema.nullable(),
  })
  .superRefine(refineDefinition);

/**
 * An update's options and decimals, checked against the field's STORED type —
 * the update schema cannot know it until the field has been read.
 * Null when it is fine.
 */
export function checkDefinition(
  fieldType: ListFieldType,
  options: ListFieldOption[],
  decimals: number | null,
): z.ZodError | null {
  const result = definitionSchema.safeParse({ field_type: fieldType, options, decimals });
  return result.success ? null : result.error;
}

// ---------------------------------------------------------------------------
// Values.
// ---------------------------------------------------------------------------

export type FieldValue = string | number | boolean | string[];

function activeOptionIds(field: ListField): Set<string> {
  return new Set(field.options.filter((option) => option.is_active).map((option) => option.id));
}

/**
 * What may be WRITTEN to a field. Null clears it. The same shapes
 * `vizserve_pms_tasks_custom_fields_guard` checks.
 */
export function taskFieldValueSchema(field: ListField): z.ZodType<FieldValue | null> {
  const active = activeOptionIds(field);

  switch (field.field_type) {
    case "TEXT":
      return z.string().trim().max(TEXT_MAX, `Keep it under ${TEXT_MAX} characters.`).nullable();
    case "TEXTAREA":
      return z.string().max(TEXTAREA_MAX, "That is too long.").nullable();
    case "NUMBER":
      return z.number({ error: "Enter a number." }).finite("Enter a number.").nullable();
    case "DATE":
      return z.iso.date("Enter a date.").nullable();
    case "CHECKBOX":
      return z.boolean().nullable();
    case "DROPDOWN":
      return z
        .string()
        .refine((id) => active.has(id), "Pick one of the options.")
        .nullable();
    case "LABELS":
      return z
        .array(z.string().refine((id) => active.has(id), "Pick labels from the options."))
        .refine((ids) => new Set(ids).size === ids.length, "Each label once.")
        .nullable();
  }
}

/**
 * What a task HOLDS for a field, read defensively from `custom_fields`. Anything
 * that is not the field's shape reads as empty rather than throwing — the guard
 * prevents it, but a value written before a type existed must not crash a row.
 *
 * Unlike the write schema, an ARCHIVED option still reads: a task that picked it
 * keeps showing it (P7-73's rule that archiving never erases).
 */
export function readFieldValue(field: ListField, customFields: unknown): FieldValue | null {
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) return null;
  const raw = (customFields as Record<string, unknown>)[field.id];

  switch (field.field_type) {
    case "TEXT":
    case "TEXTAREA":
    case "DATE":
    case "DROPDOWN":
      return typeof raw === "string" && raw !== "" ? raw : null;
    case "NUMBER":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    case "CHECKBOX":
      return raw === true ? true : null;
    case "LABELS":
      return Array.isArray(raw) && raw.length > 0 && raw.every((id) => typeof id === "string")
        ? (raw as string[])
        : null;
  }
}

/** The options a Labels value names, in the FIELD's order, not the order picked. */
export function optionsFor(field: ListField, value: FieldValue | null): ListFieldOption[] {
  if (value === null) return [];
  const ids = new Set(Array.isArray(value) ? value : [String(value)]);
  return field.options.filter((option) => ids.has(option.id));
}

/** A number shown to its field's decimal places. */
export function formatFieldNumber(field: ListField, value: number): string {
  const places = field.decimals ?? 0;
  return new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}

// ---------------------------------------------------------------------------
// Sorting.
// ---------------------------------------------------------------------------

/**
 * An option's rank: its position in the field editor. An archived option sorts
 * after every active one, keeping its relative position — it can still be on
 * old tasks, but it is no longer part of the order anybody set.
 */
function optionRank(field: ListField, id: string): number {
  const index = field.options.findIndex((option) => option.id === id);
  if (index === -1) return Number.MAX_SAFE_INTEGER;
  return field.options[index].is_active ? index : field.options.length + index;
}

/**
 * Compares two tasks' values for a field.
 *
 * ⚠️ EMPTY IS LAST IN BOTH DIRECTIONS. Reversing the whole comparison would put
 * every unset task on top of a descending sort, which buries the tasks that
 * actually have a value — the same reason `/tasks` orders with
 * `nullsFirst: false`. Checkbox has no empty: unset IS unchecked.
 *
 * Per type, ascending:
 *   Dropdown  the option order from the field editor
 *   Labels    the task's highest-ranked option, then its next, then fewer first
 *   Checkbox  checked first
 *   Number    numeric
 *   Date      chronological
 *   Text      case-insensitive alphabetical
 */
export function compareFieldValues(
  field: ListField,
  a: FieldValue | null,
  b: FieldValue | null,
  dir: "asc" | "desc" = "asc",
): number {
  if (field.field_type === "CHECKBOX") {
    const rank = (value: FieldValue | null) => (value === true ? 0 : 1);
    const result = rank(a) - rank(b);
    return dir === "asc" ? result : -result;
  }

  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  let result = 0;

  switch (field.field_type) {
    case "NUMBER":
      result = (a as number) - (b as number);
      break;
    case "DATE":
      result = (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
      break;
    case "TEXT":
    case "TEXTAREA":
      result = (a as string).localeCompare(b as string, undefined, { sensitivity: "base" });
      break;
    case "DROPDOWN":
      result = optionRank(field, a as string) - optionRank(field, b as string);
      break;
    case "LABELS": {
      const ranksA = (a as string[]).map((id) => optionRank(field, id)).sort((x, y) => x - y);
      const ranksB = (b as string[]).map((id) => optionRank(field, id)).sort((x, y) => x - y);
      const shared = Math.min(ranksA.length, ranksB.length);
      for (let i = 0; i < shared && result === 0; i += 1) result = ranksA[i] - ranksB[i];
      if (result === 0) result = ranksA.length - ranksB.length;
      break;
    }
  }

  return dir === "asc" ? result : -result;
}

// ---------------------------------------------------------------------------
// Filtering.
// ---------------------------------------------------------------------------

/**
 * The URL parameter a field's filter lives in: `cf:<fieldId>`. The same prefix
 * is the sort key and the column key, so one id names the field everywhere.
 */
export const FIELD_KEY_PREFIX = "cf:";

export function fieldKey(fieldId: string): string {
  return `${FIELD_KEY_PREFIX}${fieldId}`;
}

export function fieldIdFromKey(key: string | null | undefined): string | null {
  return key && key.startsWith(FIELD_KEY_PREFIX) ? key.slice(FIELD_KEY_PREFIX.length) : null;
}

/**
 * A parsed filter.
 *
 *   Dropdown / Labels  `?cf:<id>=<optionId>`  — Labels matches a task holding it
 *   Checkbox           `?cf:<id>=yes|no`
 *   Number             `?cf:<id>=<min>..<max>`, either side optional
 *   Date               `?cf:<id>=<from>..<to>`, either side optional
 *   Text / Text area   `?cf:<id>=<words>`, contains, case-insensitive
 */
export type FieldFilter =
  | { kind: "option"; optionId: string }
  | { kind: "checkbox"; checked: boolean }
  | { kind: "number"; min: number | null; max: number | null }
  | { kind: "date"; from: string | null; to: string | null }
  | { kind: "text"; contains: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Null for anything that does not parse — a bad URL is no filter, not an empty page. */
export function parseFieldFilter(field: ListField, raw: string | null | undefined): FieldFilter | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();

  switch (field.field_type) {
    case "DROPDOWN":
    case "LABELS":
      return field.options.some((option) => option.id === value) ? { kind: "option", optionId: value } : null;
    case "CHECKBOX":
      return value === "yes" ? { kind: "checkbox", checked: true } : value === "no" ? { kind: "checkbox", checked: false } : null;
    case "NUMBER": {
      const [low = "", high = ""] = value.split("..");
      const min = low.trim() === "" ? null : Number(low);
      const max = high.trim() === "" ? null : Number(high);
      if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return null;
      return min === null && max === null ? null : { kind: "number", min, max };
    }
    case "DATE": {
      const [low = "", high = ""] = value.split("..");
      const from = ISO_DATE.test(low.trim()) ? low.trim() : null;
      const to = ISO_DATE.test(high.trim()) ? high.trim() : null;
      return from === null && to === null ? null : { kind: "date", from, to };
    }
    case "TEXT":
    case "TEXTAREA":
      return { kind: "text", contains: value.toLowerCase() };
  }
}

/** A task with no value matches only "Checkbox: no". */
export function matchesFieldFilter(field: ListField, filter: FieldFilter, value: FieldValue | null): boolean {
  switch (filter.kind) {
    case "option":
      return Array.isArray(value) ? value.includes(filter.optionId) : value === filter.optionId;
    case "checkbox":
      return (value === true) === filter.checked;
    case "number":
      return (
        typeof value === "number" &&
        (filter.min === null || value >= filter.min) &&
        (filter.max === null || value <= filter.max)
      );
    case "date":
      return (
        typeof value === "string" &&
        (filter.from === null || value >= filter.from) &&
        (filter.to === null || value <= filter.to)
      );
    case "text":
      return typeof value === "string" && value.toLowerCase().includes(filter.contains);
  }
}
