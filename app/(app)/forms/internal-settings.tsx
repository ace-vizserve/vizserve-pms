"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_SLA_MINUTES,
  formSettingsSchema,
  type FormAudience,
  type FormSettingsInput,
  type FormSettingsValues,
} from "@/lib/schemas/forms";
import { updateFormSettings } from "./actions";

type Department = { id: string; name: string };

/**
 * P7-66 Phase 4 — SETTINGS FOR AN INTERNAL FORM.
 *
 * ⚠️ A SEPARATE COMPONENT, NOT A BRANCH. This used to be `FormSettings`
 * rendering eleven controls and hiding six of them behind `isClientRequest`,
 * which is how the two kinds of form got blurred in the first place: one card
 * that looked like one product with some fields greyed out, when they are two
 * products that happen to share a builder.
 *
 * What an internal form actually has is FIVE things — a name, a description,
 * an owning department, whether answers carry a name, and whether it is live.
 * There is no slug to publish, no reference prefix to quote, no SLA to meet, no
 * list to file into and no client approval window, because there is no client
 * and no request. Every one of those was on the card, and every one of them was
 * a question about somebody else's product.
 *
 * ⚠️ THE HIDDEN VALUES ARE STILL SENT, AND THEY MUST BE. `formSettingsSchema`
 * DEFAULTS NOTHING (deliberately — six defaults once silently overwrote stored
 * values and one of them published a staff form), so an UPDATE payload must
 * carry every key or the parse fails. They come from `initial` and go back
 * unchanged: this card reads them, it does not decide them.
 *
 * ⚠️ `purpose` IS HARD-CODED RATHER THAN PASSED THROUGH. The builder page picks
 * this component by the form's purpose, so a payload from here can only ever
 * mean INTERNAL — which makes the field whose stray default once put
 * a staff form on the public internet impossible to get wrong from this screen.
 * The same is true in reverse of `ClientFormSettings`.
 *
 * ⚠️ AND THAT IS WHY THERE IS NO LONGER A PURPOSE PICKER. Converting a live form
 * from one product into the other is not a setting; it was only ever legal on a
 * form with no submissions, which is a form it costs nothing to build again. The
 * choice is made once, at /forms/new, where it is the only question asked.
 */
export function InternalSettings({
  departments,
  formId,
  initial,
  audience,
  hasSubmissions = false,
}: {
  departments: Department[];
  formId: string;
  /**
   * The form AS STORED — including the five settings this card never shows.
   * See the note above: they are resent verbatim, not re-derived.
   */
  initial: Partial<FormSettingsInput>;
  /**
   * P7-66 Phase 5 — WHO SHOULD ANSWER, as stored.
   *
   * ⚠️ SEPARATE FROM `initial` BECAUSE IT IS NOT A COLUMN ON THE FORM. It is a
   * flag plus a row per department, and the page reads the two together — see
   * the note on the builder page. Keeping it out of `initial` is what stops it
   * being spread into an `.update()` that has nowhere to put it.
   */
  audience: FormAudience;
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
  } = useForm<FormSettingsValues>({
    // The schema's input type is looser than its output (`sla_minutes` is a
    // string in a form and a number in the database), so the resolver is cast
    // to the parsed shape the form actually works with.
    resolver: zodResolver(formSettingsSchema) as unknown as Resolver<FormSettingsValues>,
    defaultValues: {
      /*
       * ⚠️ NOT `initial.purpose`. See the note above — this card exists only for
       * internal forms, so the value is a constant rather than something a
       * caller could get wrong.
       */
      purpose: "INTERNAL",
      name: initial.name ?? "",
      description: initial.description ?? "",
      department_id: initial.department_id ?? null,
      // P7-66 — false is the safe default and the column's own: a form is
      // ATTRIBUTED unless somebody deliberately says otherwise.
      is_anonymous: initial.is_anonymous ?? false,
      is_active: initial.is_active ?? false,

      /*
       * ⚠️ THE FIVE THAT ARE NEVER RENDERED. Not dead weight — the UPDATE schema
       * requires them, and an internal form does hold values for them because
       * `createForm` derives a slug and a prefix from the name for every form.
       * Resending what is stored is how this card leaves them alone.
       */
      slug: initial.slug ?? "",
      reference_prefix: initial.reference_prefix ?? "",
      requires_attachment: initial.requires_attachment ?? false,
      sla_minutes: initial.sla_minutes ?? DEFAULT_SLA_MINUTES,
      default_list_id: initial.default_list_id ?? null,
      client_approval_days: initial.client_approval_days ?? 3,

      // P7-66 Phase 5 — the one key on this payload that is not a column. It
      // gates a separate, atomic write; see `writeFormAudience`.
      audience,
    },
  });

  const isActive = watch("is_active");
  const isAnonymous = watch("is_anonymous") ?? false;
  const departmentId = watch("department_id");

  /*
   * ⚠️ WATCHED AS A WHOLE OBJECT, NOT AS TWO FIELDS. The flag and the list are
   * one fact — "everyone" versus "these" — and reading them separately is how a
   * screen ends up rendering a narrowed form with no departments ticked, or an
   * open one with some.
   */
  const chosenAudience = watch("audience") ?? audience;
  const targetsEveryone = chosenAudience.is_all_departments;
  const targetedIds = chosenAudience.department_ids;

  const setAudience = (next: FormAudience) => setValue("audience", next, { shouldValidate: true, shouldDirty: true });

  /*
   * ⚠️ TICKING A DEPARTMENT DOES NOT SILENTLY SWITCH THE MODE, and unticking the
   * last one does not silently switch it back. Both would be the screen making a
   * decision on somebody's behalf about who may answer a survey. The radio is
   * the decision; the checkboxes only fill it in, and an empty list under
   * "specific departments" is refused by the schema with a sentence rather than
   * quietly reinterpreted as everyone.
   */
  const toggleDepartment = (departmentIdToToggle: string, checked: boolean) =>
    setAudience({
      is_all_departments: false,
      department_ids: checked
        ? [...targetedIds, departmentIdToToggle]
        : targetedIds.filter((id) => id !== departmentIdToToggle),
    });

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
   * It does not fight somebody typing here: the effect keys on `initial.name` —
   * what the SERVER says — which changes only when a rename lands and the page
   * revalidates.
   */
  useEffect(() => {
    if (initial.name !== undefined) setValue("name", initial.name);
  }, [initial.name, setValue]);

  // value → label map for the Select below. Without it, Base UI's Select.Value
  // falls back to rendering the raw value, which here is a bare UUID.
  const departmentItems = Object.fromEntries(departments.map((d) => [d.id, d.name]));

  /** The keys this card actually draws an input for. */
  const VISIBLE = new Set<keyof FormSettingsValues>([
    "name",
    "description",
    "department_id",
    "is_anonymous",
    "is_active",
    "audience",
  ]);

  const onSubmit = handleSubmit((values) => {
    setFormError(null);

    const showErrors = (error: string, fieldErrors?: Record<string, string[]>) => {
      /*
       * ⚠️ AN ERROR ON A HIDDEN FIELD IS PROMOTED TO THE TOP OF THE CARD RATHER
       * THAN SET ON AN INPUT THAT IS NOT THERE. Five of the keys in this payload
       * have no control on this screen; `setError` on one of them would attach a
       * message to nothing, and the Save would appear to fail for no reason at
       * all. It should not happen — the values came out of the database — but
       * "should not happen" is exactly the case that needs a sentence.
       */
      const hidden = Object.entries(fieldErrors ?? {}).filter(([key]) => !VISIBLE.has(key as keyof FormSettingsValues));

      setFormError(
        hidden.length === 0
          ? error
          : `${error} (${hidden.map(([key, messages]) => `${key}: ${messages[0]}`).join("; ")})`,
      );

      for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
        if (VISIBLE.has(key as keyof FormSettingsValues)) {
          setError(key as keyof FormSettingsValues, { type: "server", message: messages[0] });
        }
      }
    };

    startTransition(async () => {
      const result = await updateFormSettings(formId, values);
      if (!result.ok) return showErrors(result.error, result.fieldErrors);
      toast.success("Settings saved");
      router.refresh();
    });
  });

  return (
    <form onSubmit={onSubmit} className="p-6 bg-card rounded-xl grade-card border space-y-5" noValidate>
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" aria-invalid={Boolean(errors.name)} {...register("name")} />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" rows={2} {...register("description")} />
        <p className="text-xs text-muted-foreground">Shown to colleagues above the questions.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="department">Owning department</Label>
        <Select
          items={departmentItems}
          value={departmentId ?? ""}
          onValueChange={(value) => setValue("department_id", value, { shouldValidate: true })}>
          <SelectTrigger id="department" className="w-full sm:w-1/2" aria-invalid={Boolean(errors.department_id)}>
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
          ⚠️ OWNERSHIP, AND SINCE PHASE 5 THAT IS ALL IT IS.

          The same column means three different things across this app, and this
          is the weakest of the three — which is exactly why the sentence under
          it had to change. On a CLIENT form it is ROUTING: whose Gate 1 queue a
          submission lands in. The new multi-select above is AUDIENCE: who should
          answer. This is neither.

          It used to decide who could READ the answers — `form responses readable
          by the owning department` — and the helper text said so. 20260902140000
          replaced that policy with `form responses readable by admins`, so the
          sentence became a lie the moment Phase 5 landed: a department lead
          cannot read these answers whatever this box says.

          What it still does, and the only honest reason it is a required field:
          `vizserve_pms_forms_active_requires_department` refuses to publish a
          form with no department. It is the organisational owner — who ran this
          survey — and nothing more.
        */}
        <p className="text-xs text-muted-foreground">
          Which department this form belongs to. Required before it can be published.
        </p>
        {errors.department_id ? <p className="text-xs text-destructive">{errors.department_id.message}</p> : null}
      </div>

      {/*
        P7-66 Phase 5 — WHO SHOULD ANSWER.
        ⚠️ NOT THE SAME QUESTION AS THE OWNING DEPARTMENT ABOVE, and the two are
        deliberately adjacent so the difference is visible rather than inferred.
        Ownership is who READS the answers; the audience is who WRITES them. A
        VizBytes-owned survey addressed to the whole company is an ordinary
        thing to want, and the card should not make it look like a mistake.
      */}
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Who should answer</legend>

        {/*
          ⚠️ A RADIO GROUP, NOT A CHECKBOX LIST WITH "none means everyone".
          "Everyone" and "these departments" are two different intentions, and
          collapsing them into the emptiness of a list is exactly the encoding
          `audience_is_all_departments` exists to avoid: it makes a list that
          empties itself — by accident, by a deleted department — a silent
          widening to the whole company. Stating the intent means the same
          accident is a refusal.

          Native inputs rather than a Base UI Radio: two options, no popup, and
          `name` gives arrow-key navigation and a single tab stop for free.
        */}
        <div className="space-y-2.5">
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="radio"
              name="audience-mode"
              className="mt-0.5 size-4 accent-primary"
              checked={targetsEveryone}
              onChange={() =>
                /*
                 * ⚠️ THE TICKED DEPARTMENTS ARE KEPT, not cleared. Somebody
                 * flipping to "everyone" to see what it means and flipping back
                 * should find their list intact — and the list is ignored while
                 * the flag is true, both here and in
                 * `vizserve_pms_set_form_audience`, which writes no rows at all
                 * in that mode. Nothing stale can reach the database.
                 */
                setAudience({ is_all_departments: true, department_ids: targetedIds })
              }
            />
            <span>
              <span className="font-medium">Everyone</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Any signed-in colleague can open and answer it.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="radio"
              name="audience-mode"
              className="mt-0.5 size-4 accent-primary"
              checked={!targetsEveryone}
              onChange={() => setAudience({ is_all_departments: false, department_ids: targetedIds })}
            />
            <span>
              <span className="font-medium">Specific departments</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Nobody else sees the form, and nobody else can answer it.
              </span>
            </span>
          </label>
        </div>

        {targetsEveryone ? null : (
          <div className="space-y-2 border-t pt-3">
            {departments.length === 0 ? (
              <p className="text-xs text-warning">
                No departments to choose from. That is a read failure rather than an empty company — reload the page.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {departments.map((department) => (
                  <label key={department.id} className="flex items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={targetedIds.includes(department.id)}
                      onCheckedChange={(checked) => toggleDepartment(department.id, checked)}
                    />
                    {department.name}
                  </label>
                ))}
              </div>
            )}

            {/*
              ⚠️ THE MEMBERSHIP RULE, SAID OUT LOUD. `vizserve_pms_form_targets_me`
              matches on `primary_department_id` — where somebody WORKS, not what
              they lead (D15) — so a team leader of VizBytes who sits in VizMedia
              answers VizMedia's survey. That is the right rule and it is not
              guessable from a list of tick boxes.
            */}
            <p className="text-xs text-muted-foreground">
              Matched on the department a person works in, not the ones they lead.
            </p>
          </div>
        )}

        {/*
          ⚠️ THE SAVED FORM IS THE ENFORCEMENT, AND THE SENTENCE SAYS SO. Two
          policies read this — what /respond renders and what may be written —
          because a form somebody can no longer SEE is still a form they could
          POST to.
        */}
        {errors.audience ? (
          <p className="text-xs text-destructive">
            {errors.audience.message ??
              (errors.audience as { department_ids?: { message?: string } }).department_ids?.message}
          </p>
        ) : null}
      </fieldset>

      <div className="space-y-3 rounded-lg border p-4">
        {/*
          ⚠️ FIRST IN THIS BOX, ABOVE PUBLISHED. It is the setting that has to be
          right BEFORE the form goes live — the first answer is what makes it
          unchangeable — and a switch found underneath the one that locked it is
          a switch found too late.
        */}
        <div className="flex items-start justify-between gap-4 border-b pb-3">
          <div>
            <Label htmlFor="is_anonymous">Anonymous answers</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {/* "Not recorded" rather than "not shown", in both branches. The
                  difference is the entire feature: an anonymous form writes no
                  name, so there is none to surface later through an export, a
                  new screen or an admin with SQL access. */}
              {isAnonymous
                ? "Nobody's name is recorded — not hidden, never written. You see the answers and when they came in."
                : "Each answer is recorded against the name of whoever wrote it."}
            </p>
            {hasSubmissions ? (
              // Not just disabled — `updateFormSettings` refuses the change and
              // `vizserve_pms_forms_anonymity_lock` refuses it under that. The
              // reason is not "it would be awkward": named→anonymous would label
              // answers that still carry names as anonymous.
              <p className="mt-1 text-xs text-muted-foreground">
                Locked — answers already came in under this promise. Build a new form to change it.
              </p>
            ) : (
              <p className="mt-1 text-xs text-warning">
                Settles when the first answer arrives, and cannot change afterwards.
              </p>
            )}
            {errors.is_anonymous ? (
              <p className="mt-1 text-xs text-destructive">{errors.is_anonymous.message}</p>
            ) : null}
          </div>
          <Switch
            id="is_anonymous"
            checked={isAnonymous}
            disabled={hasSubmissions}
            onCheckedChange={(checked) => setValue("is_anonymous", checked)}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="is_active">Published</Label>
            {/* There is no public link and saying otherwise would be a lie about
                a staff survey — /respond/<slug> refuses anybody without a
                session, whatever this switch says. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isActive
                ? "Live — signed-in staff can fill it in. There is no public link."
                : "Draft — nobody can fill it in yet."}
            </p>
            {isActive && !departmentId ? (
              <p className="mt-1 text-xs text-warning">
                Choose a department first — a form with none cannot be published.
              </p>
            ) : null}
          </div>
          <Switch id="is_active" checked={isActive} onCheckedChange={(checked) => setValue("is_active", checked)} />
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
        Save settings
      </Button>
    </form>
  );
}
