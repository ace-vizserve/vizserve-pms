"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Hash,
  ListPlus,
  Pencil,
  Plus,
  Tags,
  Text,
  TextCursorInput,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ComponentType } from "react";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import {
  LIST_FIELD_TYPE_META,
  LIST_FIELD_TYPES,
  OPTION_COLORS,
  hasOptions,
  type ListField,
  type ListFieldOption,
  type ListFieldType,
  type OptionColor,
} from "@/lib/schemas/list-fields";
import { cn } from "@/lib/utils";

import {
  createListField,
  moveListField,
  setListFieldArchived,
  updateListField,
} from "./field-actions";

/**
 * P7-73 — the field manager for one list.
 *
 * Rendered by `/tasks` only when a list is selected AND
 * `vizserve_pms_can_manage_list` says the viewer may manage it — any member of
 * the list's department, or a personal list's owner. The policies behind the
 * actions are the enforcement; this only decides whether to offer the button.
 *
 * ADDING A FIELD IS TWO STEPS, the ClickUp shape Ace described: pick a type,
 * then name it and configure what that type needs — options for a dropdown or
 * labels, decimal places for a number.
 *
 * ⚠️ THE TYPE CANNOT BE CHANGED AFTERWARDS, and the editor does not offer it.
 * The database refuses once any task holds a value; archiving the field and
 * adding a new one says what actually happened. Options are archived rather
 * than removed for the same reason — a task holds the option's id.
 */

const TYPE_ICON: Record<ListFieldType, ComponentType<{ className?: string }>> = {
  DROPDOWN: ChevronDown,
  TEXT: TextCursorInput,
  DATE: CalendarDays,
  TEXTAREA: Text,
  NUMBER: Hash,
  LABELS: Tags,
  CHECKBOX: CheckSquare,
};

const COLOR_LABEL: Record<OptionColor, string> = {
  neutral: "Grey",
  brand: "Brand",
  info: "Blue",
  success: "Green",
  warning: "Amber",
  danger: "Red",
};

type View =
  | { kind: "list" }
  | { kind: "pick" }
  | { kind: "create"; type: ListFieldType }
  | { kind: "edit"; field: ListField };

export function ListFieldsSheet({ listId, fields }: { listId: string; fields: ListField[] }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView({ kind: "list" });
      }}>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <ListPlus />
        Custom fields
      </SheetTrigger>

      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {view.kind === "list"
              ? "Custom fields"
              : view.kind === "pick"
                ? "Add a field"
                : view.kind === "create"
                  ? `New ${LIST_FIELD_TYPE_META[view.type].label.toLowerCase()} field`
                  : `Edit ${view.field.name}`}
          </SheetTitle>
          <SheetDescription>
            {view.kind === "pick"
              ? "Choose what kind of value this field holds. It cannot be changed later."
              : "Fields belong to this list. Every task in it can hold a value, shown as a column you can sort and filter by."}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6">
          {view.kind === "list" ? (
            <FieldList fields={fields} onAdd={() => setView({ kind: "pick" })} onEdit={(field) => setView({ kind: "edit", field })} />
          ) : view.kind === "pick" ? (
            <TypePicker onBack={() => setView({ kind: "list" })} onPick={(type) => setView({ kind: "create", type })} />
          ) : (
            <FieldForm
              listId={listId}
              type={view.kind === "create" ? view.type : view.field.field_type}
              field={view.kind === "edit" ? view.field : null}
              onDone={() => setView({ kind: "list" })}
              onBack={() => setView(view.kind === "create" ? { kind: "pick" } : { kind: "list" })}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FieldList({
  fields,
  onAdd,
  onEdit,
}: {
  fields: ListField[];
  onAdd: () => void;
  onEdit: (field: ListField) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showArchived, setShowArchived] = useState(false);

  const active = fields.filter((field) => field.is_active);
  const archived = fields.filter((field) => !field.is_active);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "That did not save.");
        return;
      }
      if (success) toast.success(success);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">This list has no custom fields yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {active.map((field, index) => {
            const Icon = TYPE_ICON[field.field_type];
            return (
              <li key={field.id} className="flex items-center gap-2 px-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{field.name}</p>
                  <p className="text-2xs text-muted-foreground">{LIST_FIELD_TYPE_META[field.field_type].label}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending || index === 0}
                  aria-label={`Move ${field.name} up`}
                  onClick={() => run(() => moveListField(field.id, "up"))}>
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending || index === active.length - 1}
                  aria-label={`Move ${field.name} down`}
                  onClick={() => run(() => moveListField(field.id, "down"))}>
                  <ArrowDown />
                </Button>
                <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={`Edit ${field.name}`} onClick={() => onEdit(field)}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending}
                  aria-label={`Archive ${field.name}`}
                  onClick={() =>
                    run(
                      () => setListFieldArchived(field.id, true),
                      `${field.name} archived. Its values are kept and come back if you restore it.`,
                    )
                  }>
                  <Archive />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button onClick={onAdd} size="sm">
        <Plus />
        Add a field
      </Button>

      {archived.length > 0 ? (
        <div className="space-y-2 border-t pt-4">
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </Button>
          {showArchived ? (
            <ul className="divide-y rounded-lg border">
              {archived.map((field) => (
                <li key={field.id} className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate text-sm">{field.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => setListFieldArchived(field.id, false), `${field.name} restored.`)}>
                    <ArchiveRestore />
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TypePicker({ onPick, onBack }: { onPick: (type: ListFieldType) => void; onBack: () => void }) {
  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>
      <ul className="grid gap-2">
        {LIST_FIELD_TYPES.map((type) => {
          const Icon = TYPE_ICON[type];
          return (
            <li key={type}>
              <button
                type="button"
                onClick={() => onPick(type)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left",
                  "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="block text-sm font-medium">{LIST_FIELD_TYPE_META[type].label}</span>
                  <span className="block text-xs text-muted-foreground">{LIST_FIELD_TYPE_META[type].description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function newOption(): ListFieldOption {
  return { id: crypto.randomUUID(), label: "", color: "neutral", is_active: true };
}

function FieldForm({
  listId,
  type,
  field,
  onDone,
  onBack,
}: {
  listId: string;
  type: ListFieldType;
  /** Null while creating. */
  field: ListField | null;
  onDone: () => void;
  onBack: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(field?.name ?? "");
  const [options, setOptions] = useState<ListFieldOption[]>(
    field?.options ?? (hasOptions(type) ? [newOption(), newOption()] : []),
  );
  const [decimals, setDecimals] = useState<number>(field?.decimals ?? 0);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  // Options that already exist on the server are archived, never removed; a
  // row added in this form and not yet saved can simply be dropped.
  const savedIds = new Set((field?.options ?? []).map((option) => option.id));

  function patchOption(id: string, patch: Partial<ListFieldOption>) {
    setOptions((current) => current.map((option) => (option.id === id ? { ...option, ...patch } : option)));
  }

  function moveOption(index: number, by: -1 | 1) {
    setOptions((current) => {
      const next = [...current];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function save() {
    setErrors({});
    // A blank row that was never saved is an unfinished thought, not an option.
    const cleaned = options.filter((option) => savedIds.has(option.id) || option.label.trim() !== "");
    const payload = {
      name,
      options: hasOptions(type) ? cleaned : [],
      decimals: type === "NUMBER" ? decimals : null,
    };

    startTransition(async () => {
      const result = field
        ? await updateListField({ ...payload, id: field.id })
        : await createListField({ ...payload, list_id: listId, field_type: type });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success(field ? "Field saved." : `${name.trim()} added to this list.`);
      router.refresh();
      onDone();
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}>
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>

      <div className="space-y-1.5">
        <Label htmlFor="field-name">Name</Label>
        <Input id="field-name" autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
        {errors.name ? <p className="text-xs text-destructive">{errors.name[0]}</p> : null}
      </div>

      {type === "NUMBER" ? (
        <div className="space-y-1.5">
          <Label htmlFor="field-decimals">Decimal places</Label>
          <Select
            items={{ "0": "None — 12", "1": "1 — 12.5", "2": "2 — 12.50", "3": "3 — 12.500", "4": "4 — 12.5000" }}
            value={String(decimals)}
            onValueChange={(value) => setDecimals(Number(value ?? 0))}>
            <SelectTrigger id="field-decimals" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0, 1, 2, 3, 4].map((places) => (
                <SelectItem key={places} value={String(places)}>
                  {places === 0 ? "None — 12" : `${places} — ${(12.5).toFixed(places)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {hasOptions(type) ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Options</legend>
          <p className="text-xs text-muted-foreground">
            The order here is the order the column sorts in.
          </p>
          <ul className="space-y-2">
            {options.map((option, index) => (
              <li key={option.id} className={cn("flex items-center gap-1.5", !option.is_active && "opacity-60")}>
                <Input
                  aria-label={`Option ${index + 1}`}
                  placeholder={`Option ${index + 1}`}
                  maxLength={80}
                  value={option.label}
                  disabled={!option.is_active}
                  onChange={(event) => patchOption(option.id, { label: event.target.value })}
                />
                <Select
                  items={COLOR_LABEL}
                  value={option.color}
                  disabled={!option.is_active}
                  onValueChange={(value) => value && patchOption(option.id, { color: value as OptionColor })}>
                  <SelectTrigger aria-label={`Colour for option ${index + 1}`} className="w-28 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPTION_COLORS.map((color) => (
                      <SelectItem key={color} value={color}>
                        <Chip tone={color} label={COLOR_LABEL[color]} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Move up" disabled={index === 0} onClick={() => moveOption(index, -1)}>
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Move down"
                  disabled={index === options.length - 1}
                  onClick={() => moveOption(index, 1)}>
                  <ArrowDown />
                </Button>
                {savedIds.has(option.id) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={option.is_active ? `Archive ${option.label}` : `Restore ${option.label}`}
                    onClick={() => patchOption(option.id, { is_active: !option.is_active })}>
                    {option.is_active ? <Archive /> : <ArchiveRestore />}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove this option"
                    onClick={() => setOptions((current) => current.filter((item) => item.id !== option.id))}>
                    <span aria-hidden>×</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" size="sm" onClick={() => setOptions((current) => [...current, newOption()])}>
            <Plus />
            Add an option
          </Button>
          {errors.options ? <p className="text-xs text-destructive">{errors.options[0]}</p> : null}
        </fieldset>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {field ? "Save" : "Add field"}
        </Button>
      </div>
    </form>
  );
}
