"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { formSettingsSchema, type FormSettingsInput } from "@/lib/schemas/forms";
import { createForm, updateFormSettings } from "./actions";

type Department = { id: string; name: string };
type List = { id: string; name: string; department_id: string };

const NO_LIST = "__none__";

export function FormSettings({
  departments,
  lists = [],
  formId,
  initial,
  hasSubmissions = false,
}: {
  departments: Department[];
  /** P2-06 — where approved requests from this form land. */
  lists?: List[];
  formId?: string;
  initial?: Partial<FormSettingsInput>;
  hasSubmissions?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    setError,
    formState: { errors },
  } = useForm<FormSettingsInput>({
    // The schema's input type is looser than its output (zod defaults make
    // several keys optional before parsing), so the resolver is cast to the
    // parsed shape the form actually works with.
    resolver: zodResolver(formSettingsSchema) as unknown as Resolver<FormSettingsInput>,
    defaultValues: {
      name: initial?.name ?? "",
      slug: initial?.slug ?? "",
      description: initial?.description ?? "",
      department_id: initial?.department_id ?? null,
      reference_prefix: initial?.reference_prefix ?? "",
      is_public: initial?.is_public ?? true,
      is_active: initial?.is_active ?? false,
      requires_attachment: initial?.requires_attachment ?? false,
      sla_days: initial?.sla_days ?? 5,
      default_list_id: initial?.default_list_id ?? null,
      client_approval_days: initial?.client_approval_days ?? 3,
    },
  });

  const isActive = watch("is_active");
  const departmentId = watch("department_id");

  // A list belongs to one department, so offering another department's would be
  // offering a guaranteed rejection from the database.
  const departmentLists = lists.filter((list) => list.department_id === departmentId);

  const onSubmit = handleSubmit((values) => {
    setFormError(null);

    const showErrors = (error: string, fieldErrors?: Record<string, string[]>) => {
      setFormError(error);
      for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
        setError(key as keyof FormSettingsInput, { type: "server", message: messages[0] });
      }
    };

    startTransition(async () => {
      // Branched rather than ternary so the create path keeps its `{ id }`
      // payload instead of collapsing into the shared void result.
      if (formId) {
        const result = await updateFormSettings(formId, values);
        if (!result.ok) return showErrors(result.error, result.fieldErrors);
        toast.success("Settings saved");
        router.refresh();
        return;
      }

      const result = await createForm(values);
      if (!result.ok) return showErrors(result.error, result.fieldErrors);
      toast.success("Form created");
      router.push(`/forms/${result.data.id}`);
    });
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" aria-invalid={Boolean(errors.name)} {...register("name")} />
          {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="slug">URL slug</Label>
          <Input
            id="slug"
            placeholder="collateral-request"
            aria-invalid={Boolean(errors.slug)}
            {...register("slug")}
          />
          <p className="text-xs text-muted-foreground">Public at /f/{watch("slug") || "…"}</p>
          {errors.slug ? <p className="text-xs text-destructive">{errors.slug.message}</p> : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" rows={2} {...register("description")} />
        <p className="text-xs text-muted-foreground">Shown to the client above the fields.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="department">Owning department</Label>
          <Select
            value={departmentId ?? ""}
            onValueChange={(value) => setValue("department_id", value, { shouldValidate: true })}
          >
            <SelectTrigger id="department" aria-invalid={Boolean(errors.department_id)}>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* This is what decides which Team Leader the request lands on. */}
          <p className="text-xs text-muted-foreground">Routes submissions to this department&apos;s TL.</p>
          {errors.department_id ? (
            <p className="text-xs text-destructive">{errors.department_id.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="reference_prefix">Reference prefix</Label>
          <Input
            id="reference_prefix"
            placeholder="COL"
            className="uppercase"
            aria-invalid={Boolean(errors.reference_prefix)}
            disabled={hasSubmissions}
            {...register("reference_prefix")}
          />
          <p className="text-xs text-muted-foreground">
            {hasSubmissions ? "Locked — requests already quote it." : "e.g. COL-2026-0142"}
          </p>
          {errors.reference_prefix ? (
            <p className="text-xs text-destructive">{errors.reference_prefix.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="sla_days">SLA (days)</Label>
          <Input
            id="sla_days"
            type="number"
            min={1}
            aria-invalid={Boolean(errors.sla_days)}
            {...register("sla_days")}
          />
          {errors.sla_days ? (
            <p className="text-xs text-destructive">{errors.sla_days.message}</p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="default_list">Default list</Label>
          <Select
            value={watch("default_list_id") ?? NO_LIST}
            onValueChange={(value) =>
              setValue("default_list_id", value === NO_LIST ? null : value)
            }
            disabled={departmentLists.length === 0}
          >
            <SelectTrigger id="default_list">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_LIST}>No list</SelectItem>
              {departmentLists.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* P2-06. Pre-fills the review screen; the TL can still override it
              per request. */}
          <p className="text-xs text-muted-foreground">
            {departmentLists.length === 0
              ? "This department has no lists yet."
              : "Where approved requests land. The reviewer can change it."}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="client_approval_days">Client approval window</Label>
          <Input
            id="client_approval_days"
            type="number"
            min={1}
            max={30}
            aria-invalid={Boolean(errors.client_approval_days)}
            {...register("client_approval_days")}
          />
          {/* Q6 — BUSINESS days. On calendar days, work sent Friday afternoon
              closes itself on Monday having given the client one working day. */}
          <p className="text-xs text-muted-foreground">
            Working days a client gets before the request auto-completes.
          </p>
          {errors.client_approval_days ? (
            <p className="text-xs text-destructive">{errors.client_approval_days.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="requires_attachment">Require an attachment</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Submissions without a file are rejected.
            </p>
          </div>
          <Switch
            id="requires_attachment"
            checked={watch("requires_attachment")}
            onCheckedChange={(checked) => setValue("requires_attachment", checked)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t pt-3">
          <div>
            <Label htmlFor="is_active">Published</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isActive
                ? "Live — anyone with the URL can submit, no login."
                : "Draft — the public URL returns not found."}
            </p>
            {isActive && !departmentId ? (
              <p className="mt-1 text-xs text-warning">
                Choose a department first, or submissions have nowhere to go.
              </p>
            ) : null}
          </div>
          <Switch
            id="is_active"
            checked={isActive}
            onCheckedChange={(checked) => setValue("is_active", checked)}
          />
        </div>
      </div>

      {formError ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <Button type="submit" loading={pending}>
        {formId ? "Save settings" : "Create form"}
      </Button>
    </form>
  );
}
