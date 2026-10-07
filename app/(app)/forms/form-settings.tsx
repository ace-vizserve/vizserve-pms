"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatSlaDuration } from "@/lib/schemas/duration";
import {
  formCreateSchema,
  formSettingsSchema,
  slugFromName,
  type FormSettingsInput,
  type FormSettingsValues,
} from "@/lib/schemas/forms";
import { createForm, updateFormSettings } from "./actions";
import { useUnpublishConfirm } from "./form-lifecycle";

type Department = { id: string; name: string };

/**
 * P7-66 Phase 4 — SETTINGS FOR A CLIENT REQUEST FORM.
 *
 * ⚠️ CLIENT FORMS ONLY. This card used to serve both purposes and hide half of
 * itself behind `isClientRequest`, which is how the two kinds of form got
 * blurred: one screen that looked like one product with some fields absent, when
 * they are two products that happen to share a builder. `InternalSettings` is
 * the other half, and it is a different five questions rather than a subset of
 * these.
 *
 * What is here is everything a form the OUTSIDE fills in needs: a public URL, a
 * reference the client quotes back, a turnaround standard, a queue to route to,
 * a list to file into and a Gate 3 window. None of it means anything on a form a
 * colleague answers while signed in.
 *
 * ⚠️ `purpose` IS HARD-CODED RATHER THAN ASKED FOR OR PASSED THROUGH.
 *
 * The picker is gone. Converting a live form from one product into the other is
 * not a setting; it was only ever legal on a form with no submissions, which is
 * a form it costs nothing to build again. The choice is made once, at
 * /forms/new, where it is the only question asked.
 *
 * What the constant buys is stronger than tidiness. `purpose` is the field whose
 * stray `.default("CLIENT_REQUEST")` once flipped a published STAFF form and let
 * the CHECK `is_public = (purpose = 'CLIENT_REQUEST')` put it on the open
 * internet. A payload from this card can now only ever mean CLIENT_REQUEST, and
 * one from `InternalSettings` can only ever mean INTERNAL, because
 * the page picks the component by the form's own purpose.
 *
 * ⚠️ SO IS `is_anonymous`, AT FALSE. `vizserve_pms_forms_anonymous_is_internal`
 * refuses the pair, and the reason is not arbitrary: /request/<slug> has no
 * session at all, so a client TYPES their own name and email and those are
 * ordinary answers on the request. There is no identity the platform captured
 * and therefore nothing to withhold. The switch is not hidden here — there is
 * nothing for it to mean.
 */
export function ClientFormSettings({
  departments,
  formId,
  initial,
  isArchived = false,
}: {
  departments: Department[];
  /** Absent while creating. */
  formId?: string;
  initial?: Partial<FormSettingsInput>;
  hasSubmissions?: boolean;
  /** P7-72. Its Published switch is locked until the form is restored. */
  isArchived?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { confirm, dialog } = useUnpublishConfirm(formId);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    setError,
    formState: { errors },
  } = useForm<FormSettingsValues>({
    /*
     * The schema's input type is looser than its output (zod defaults make
     * several keys optional before parsing), so the resolver is cast to the
     * parsed shape the form actually works with.
     *
     * P7-29 — CREATING AND EDITING VALIDATE DIFFERENTLY. A blank slug means
     * "derive one from the name" on a form that does not exist yet, and would
     * mean "take away the URL somebody has shared" on one that does. The
     * server draws the same distinction; this is only so the client stops
     * reporting a required field the create path is happy to fill in itself.
     */
    resolver: zodResolver(formId ? formSettingsSchema : formCreateSchema) as unknown as Resolver<FormSettingsValues>,
    defaultValues: {
      // See the note above: a constant, not a control and not a pass-through.
      purpose: "CLIENT_REQUEST",
      is_anonymous: false,
      /*
       * P7-66 Phase 8 — A CONSTANT, NOT A CONTROL AND NOT A PASS-THROUGH.
       * `vizserve_pms_forms_quiz_is_internal` refuses a quiz on a client form,
       * so the only value this card can honestly send is `false` — and
       * `formSettingsSchema` requires the key, so omitting it would fail the
       * parse on every save from this screen rather than defaulting quietly.
       */
      is_quiz: false,
      name: initial?.name ?? "",
      slug: initial?.slug ?? "",
      description: initial?.description ?? "",
      department_id: initial?.department_id ?? null,
      reference_prefix: initial?.reference_prefix ?? "",
      is_active: initial?.is_active ?? false,
      requires_attachment: initial?.requires_attachment ?? false,
      requires_approval: initial?.requires_approval ?? true,
      urgent_days: initial?.urgent_days ?? 3,
      normal_days: initial?.normal_days ?? 5,
      sla_minutes: initial?.sla_minutes !== undefined ? formatSlaDuration(initial.sla_minutes) : "5d",
      default_list_id: initial?.default_list_id ?? null,
      client_approval_days: initial?.client_approval_days ?? 3,
    },
  });

  const isActive = watch("is_active");
  const requiresApproval = watch("requires_approval");
  const departmentId = watch("department_id");

  /*
   * ⚠️ P7-66 — THE NAME IS EDITED IN TWO PLACES, AND THIS CARD IS THE ONE THAT
   * CAN OVERWRITE THE OTHER.
   *
   * The builder's top bar renames the form in place (`BuilderTitle`), and the
   * builder keeps every tab MOUNTED so the question canvas survives a tab
   * change. `defaultValues` is read ONCE, at mount — so after a rename this card
   * is still holding the name the page loaded with, and the next Save posts it
   * back over the new one. A settings save that silently undoes a rename made
   * thirty seconds ago is the kind of bug nobody attributes to the right screen.
   *
   * ⚠️ IT DOES NOT FIGHT SOMEBODY TYPING HERE. The effect keys on
   * `initial?.name` — what the SERVER says — which does not change while this
   * input is being edited; it changes only when a rename lands and the page
   * revalidates. So the sequence it corrects is the real one, and the ordinary
   * one is untouched.
   *
   * A name typed here and left unsaved IS discarded by a top-bar rename, which
   * is correct: the rename is the later explicit instruction.
   *
   * `shouldDirty` is deliberately absent. This is not the person's edit, it is
   * the card catching up with a change that has already been saved.
   */
  useEffect(() => {
    if (initial?.name !== undefined) setValue("name", initial.name);
  }, [initial?.name, setValue]);

  /*
   * P7-29 — what the server will fill in if the slug is left blank.
   *
   * Shown rather than silently applied, and only while creating. The same
   * pure function runs here and in `createForm`, so the preview is the value —
   * not an approximation of it that drifts the first time either changes.
   */
  const creating = !formId;
  const name = watch("name") ?? "";
  const slug = watch("slug") ?? "";

  const willDeriveSlug = creating && slug === "" && name.trim() !== "";

  const shownSlug = slug || (willDeriveSlug ? slugFromName(name) : "");


  // value → label maps for the two Selects below. Without these, Base UI's
  // Select.Value falls back to rendering the raw value, and these two are the
  // worst case of that: a bare UUID and the literal string "__none__".
  const departmentItems = Object.fromEntries(departments.map((d) => [d.id, d.name]));


  const onSubmit = handleSubmit((values) => {
    setFormError(null);

    const showErrors = (error: string, fieldErrors?: Record<string, string[]>) => {
      setFormError(error);
      for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
        setError(key as keyof FormSettingsValues, { type: "server", message: messages[0] });
      }
    };

    /*
     * P7-72 — UNPUBLISHING FROM HERE ASKS FIRST, THE SAME AS THE HEADER SWITCH.
     * Two controls over one column; a confirmation on only one of them would
     * make the other the quiet way round it.
     */
    if (formId && initial?.is_active && !values.is_active) {
      void confirm(() =>
        startTransition(async () => {
          const result = await updateFormSettings(formId, values);
          if (!result.ok) return showErrors(result.error, result.fieldErrors);
          toast.success("Settings saved");
        }),
      );
      return;
    }

    startTransition(async () => {
      // Branched rather than ternary so the create path keeps its `{ id }`
      // payload instead of collapsing into the shared void result.
      if (formId) {
        const result = await updateFormSettings(formId, values);
        if (!result.ok) return showErrors(result.error, result.fieldErrors);
        toast.success("Settings saved");
        return;
      }

      const result = await createForm(values);
      if (!result.ok) return showErrors(result.error, result.fieldErrors);
      toast.success("Form created");
      router.push(`/forms/${result.data.id}`);
    });
  });

  return (
    <form onSubmit={onSubmit} className="p-6 bg-card rounded-xl grade-card border space-y-5" noValidate>
      {dialog}
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
            placeholder={willDeriveSlug ? slugFromName(name) : "collateral-request"}
            aria-invalid={Boolean(errors.slug)}
            {...register("slug")}
          />
          <p className="text-xs text-muted-foreground">
            Public at /request/{shownSlug || "…"}.{" "}
            {willDeriveSlug ? "Derived from the name — type your own to change it." : null}
          </p>
          {errors.slug ? <p className="text-xs text-destructive">{errors.slug.message}</p> : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" rows={2} {...register("description")} />
        <p className="text-xs text-muted-foreground">Shown to the client above the fields.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="department">Routing department</Label>
          {/* `items` is what makes the trigger show "VizBytes" instead of the
              department's UUID. Base UI's Select.Value renders the raw value
              unless the Root is handed a value→label map. */}
          <Select
            items={departmentItems}
            value={departmentId ?? ""}
            onValueChange={(value) => setValue("department_id", value, { shouldValidate: true })}>
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
          {/*
            ⚠️ ROUTING, NOT OWNERSHIP. The same column means something different
            on an internal form, where nothing is routed and it decides who
            READS the answers. Here it decides whose Gate 1 queue a submission
            lands in, which is the first thing that happens to a client request
            and the one nobody can undo from the outside.
          */}
          <p className="text-xs text-muted-foreground">Routes submissions to this department&rsquo;s TL.</p>
          {errors.department_id ? <p className="text-xs text-destructive">{errors.department_id.message}</p> : null}
        </div>

        {/* The reference prefix is not a control: `createForm` derives it from
            the name, and an edit leaves it alone — a reference already quoted
            to a client is rebuilt from it. It rides along in the form state. */}

        {/* P16-05 — the Team Leader picks Urgent or Non-urgent at Gate 1;
            these are the working days each one gives. */}
        {requiresApproval ? (
        <div className="space-y-2">
          <Label htmlFor="urgent_days">SLA in working days</Label>
          <div className="flex items-center gap-2">
            <div className="flex-1 space-y-1">
              <Input
                id="urgent_days"
                type="number"
                min={1}
                max={60}
                aria-label="Urgent — working days"
                aria-invalid={Boolean(errors.urgent_days)}
                {...register("urgent_days")}
              />
              <p className="text-2xs text-muted-foreground">Urgent</p>
            </div>
            <div className="flex-1 space-y-1">
              <Input
                id="normal_days"
                type="number"
                min={1}
                max={60}
                aria-label="Non-urgent — working days"
                aria-invalid={Boolean(errors.normal_days)}
                {...register("normal_days")}
              />
              <p className="text-2xs text-muted-foreground">Non-urgent</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The Team Leader marks each request Urgent or Non-urgent; its due date is this many working days after approval.
          </p>
          {errors.urgent_days || errors.normal_days ? (
            <p className="text-xs text-destructive">{(errors.urgent_days ?? errors.normal_days)?.message}</p>
          ) : null}
        </div>
        ) : null}
      </div>

      {/* P16-01 — urgency, list and the Gate 3 window mean nothing on a form
          that only collects answers. Hidden, not cleared: switching approval
          back on finds them as they were. */}
      {requiresApproval ? (
      <div className="grid gap-4 sm:grid-cols-2">
        {/* P16-02 — no list picker. A client form always files into its own
            list in Client Requests, created on first publish. */}
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
          <p className="text-xs text-muted-foreground">Working days a client gets before the request auto-completes.</p>
          {errors.client_approval_days ? (
            <p className="text-xs text-destructive">{errors.client_approval_days.message}</p>
          ) : null}
        </div>
      </div>
      ) : null}

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="requires_approval">Needs approval</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {requiresApproval
                ? "Each submission goes to the department’s Team Leader and becomes a task once approved."
                : "Answers are only collected — read them on the Responses tab. No approval, no task."}
            </p>
          </div>
          <Switch
            id="requires_approval"
            checked={requiresApproval}
            onCheckedChange={(checked) => setValue("requires_approval", checked, { shouldDirty: true })}
          />
        </div>
      </div>

      {/*
        ⚠️ NO "REQUIRE AN ATTACHMENT" TOGGLE — THE BUILDER ASKS THE QUESTION NOW.

        The form-level flag predates dynamic fields (D20). With a File upload
        question on the canvas it says the same thing twice, from two screens,
        and the two can disagree: a form could require a file with nothing on the
        page to attach one, which is the hole `needsOwnAttachment` in
        `app/request/[slug]/public-form.tsx` exists to paper over.

        A required File upload question says it once, in the place the question
        is asked, and the database is satisfied either way — `submit_request`
        counts ATTACHMENTS, not which field they arrived from, so a file picked
        in a `file` field discharges the flag exactly as the form-level slot did.
        See the note above the total in `public-form.tsx`.

        ⚠️ THE VALUE IS STILL SENT, UNCHANGED. `formSettingsSchema` defaults
        nothing — deliberately, after six fields once silently overwrote stored
        values — so `requires_attachment` stays in `defaultValues` and the save
        resends what is stored. Dropping it from the payload would fail the parse;
        hard-coding `false` would turn the flag off behind the back of anybody who
        opens this card to change the SLA.

        ⚠️ SO A FORM ALREADY SET TO `true` CANNOT BE UNSET FROM HERE. Nothing
        breaks — such a form keeps requiring a file, and gets a slot to attach one
        — but retiring the column for real needs a migration, and that is Ace's to
        write and apply. `P7-31` in docs/10-open-questions.md is where that lives.
      */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="is_active">Published</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isArchived
                ? "Archived — restore it from the forms list before publishing it again."
                : isActive
                  ? "Live — anyone with the URL can submit, no login."
                  : "Draft — the public URL returns not found."}
            </p>
            {isActive && !departmentId ? (
              <p className="mt-1 text-xs text-warning">Choose a department first, or submissions have nowhere to go.</p>
            ) : null}
          </div>
          <Switch
            id="is_active"
            disabled={isArchived}
            checked={isActive}
            onCheckedChange={(checked) => setValue("is_active", checked)}
          />
        </div>
      </div>

      {formError ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {formError}
        </p>
      ) : null}

      <Button type="submit" loading={pending}>
        {formId ? "Save settings" : "Create form"}
      </Button>
    </form>
  );
}
