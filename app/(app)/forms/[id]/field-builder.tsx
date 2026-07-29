"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, ChevronDown, ChevronUp, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FIELD_TYPES, suggestFieldKey, type FieldType } from "@/lib/schemas/forms";
import { moveField, saveField, setFieldActive } from "../actions";

export type FieldRow = {
  id: string;
  label: string;
  field_key: string;
  field_type: FieldType;
  help_text: string;
  options: string[];
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
};

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  date: "Date",
  select: "Choose one",
  multiselect: "Choose many",
  file: "File upload",
  email: "Email",
  number: "Number",
};

function FieldForm({
  formId,
  field,
  onDone,
}: {
  formId: string;
  field?: FieldRow;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState(field?.label ?? "");
  const [fieldKey, setFieldKey] = useState(field?.field_key ?? "");
  const [fieldType, setFieldType] = useState<FieldType>(field?.field_type ?? "text");
  const [helpText, setHelpText] = useState(field?.help_text ?? "");
  const [options, setOptions] = useState((field?.options ?? []).join("\n"));
  const [isRequired, setIsRequired] = useState(field?.is_required ?? true);

  const needsOptions = fieldType === "select" || fieldType === "multiselect";
  const isEditing = Boolean(field);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveField(formId, {
        id: field?.id,
        label,
        field_key: isEditing ? field!.field_key : fieldKey || suggestFieldKey(label),
        field_type: fieldType,
        help_text: helpText,
        options: needsOptions
          ? options
              .split("\n")
              .map((o) => o.trim())
              .filter(Boolean)
          : [],
        is_required: isRequired,
        is_active: field?.is_active ?? true,
        sort_order: field?.sort_order ?? 999,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(isEditing ? "Field saved" : "Field added");
      onDone();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="f-label">Label</Label>
          <Input
            id="f-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!isEditing) setFieldKey(suggestFieldKey(e.target.value));
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="f-type">Type</Label>
          <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
            <SelectTrigger id="f-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="f-key">Field key</Label>
        <Input id="f-key" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} disabled={isEditing} />
        {/* The key is the contract behind every historical answer and the task
            column mapping, so it is fixed once the field exists (D20/R5).
            Renaming the label is always safe. */}
        <p className="text-xs text-muted-foreground">
          {isEditing
            ? "Fixed — existing requests store their answers under this key."
            : "Used to store answers. Cannot be changed later."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="f-help">Helper text</Label>
        <Input id="f-help" value={helpText} onChange={(e) => setHelpText(e.target.value)} />
      </div>

      {needsOptions ? (
        <div className="space-y-2">
          <Label htmlFor="f-options">Options</Label>
          <Textarea
            id="f-options"
            rows={4}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder={"Poster\nBanner\nSocial media set"}
          />
          <p className="text-xs text-muted-foreground">One per line.</p>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-sm border bg-background p-3">
        <div>
          <Label htmlFor="f-required">Required</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Required is the default. Every optional field is a question the team will end up
            chasing.
          </p>
        </div>
        <Switch id="f-required" checked={isRequired} onCheckedChange={setIsRequired} />
      </div>

      {error ? (
        <p role="alert" className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} loading={pending}>
          {isEditing ? "Save field" : "Add field"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} type="button">
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function FieldBuilder({ formId, fields }: { formId: string; fields: FieldRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [, startTransition] = useTransition();

  const active = fields.filter((f) => f.is_active);
  const archived = fields.filter((f) => !f.is_active);

  function move(fieldId: string, direction: "up" | "down") {
    startTransition(async () => {
      await moveField(formId, fieldId, direction);
      router.refresh();
    });
  }

  function toggleActive(fieldId: string, isActive: boolean) {
    startTransition(async () => {
      const result = await setFieldActive(formId, fieldId, isActive);
      if (result.ok) {
        toast.success(isActive ? "Field restored" : "Field archived");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      {active.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No fields yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Name, email, title, description and target date are collected on every form
            automatically. Add what is specific to this request type.
          </p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {active.map((field, index) => (
          <li key={field.id} className="rounded-lg border">
            <div className="flex items-center gap-3 p-3">
              <div className="flex flex-col">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${field.label} up`}
                  disabled={index === 0}
                  onClick={() => move(field.id, "up")}
                >
                  <ChevronUp />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${field.label} down`}
                  disabled={index === active.length - 1}
                  onClick={() => move(field.id, "down")}
                >
                  <ChevronDown />
                </Button>
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {field.label}
                  {field.is_required ? (
                    <span className="ml-1.5 text-destructive" aria-label="required">
                      *
                    </span>
                  ) : (
                    <span className="ml-1.5 text-2xs font-normal text-muted-foreground">
                      optional
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {TYPE_LABELS[field.field_type]} · {field.field_key}
                </p>
              </div>

              <Button size="sm" variant="ghost" onClick={() => setEditingId(editingId === field.id ? null : field.id)}>
                {editingId === field.id ? "Close" : "Edit"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => toggleActive(field.id, false)}>
                Archive
              </Button>
            </div>

            {editingId === field.id ? (
              <div className="border-t p-3">
                <FieldForm formId={formId} field={field} onDone={() => setEditingId(null)} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {adding ? (
        <FieldForm formId={formId} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          Add field
        </Button>
      )}

      {archived.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <p className="text-xs font-medium text-muted-foreground">
            Archived ({archived.length})
          </p>
          {/* Archived rather than deleted: historical requests still store
              answers under these keys, so removing them would orphan data. */}
          <p className="text-xs text-muted-foreground">
            Hidden from the form. Kept because existing requests answered them.
          </p>
          <ul className="space-y-1.5 pt-1">
            {archived.map((field) => (
              <li key={field.id} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {field.label} · {field.field_key}
                </span>
                <Button size="sm" variant="ghost" onClick={() => toggleActive(field.id, true)}>
                  <ArchiveRestore />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
