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
  DEFAULT_SLA_MINUTES,
  formCreateSchema,
  formSettingsSchema,
  prefixFromName,
  slugFromName,
  type FormSettingsInput,
  type FormSettingsValues,
} from "@/lib/schemas/forms";
import { createForm, updateFormSettings } from "./actions";

type Department = { id: string; name: string };
type List = { id: string; name: string; department_id: string; form_id?: string | null };

const NO_LIST = "__none__";

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
  lists = [],
  formId,
  initial,
  hasSubmissions = false,
}: {
  departments: Department[];
  /** P2-06 — where approved requests from this form land. */
  lists?: List[];
  /** Absent while creating. */
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
      sla_minutes: formatSlaDuration(initial?.sla_minutes ?? DEFAULT_SLA_MINUTES),
      default_list_id: initial?.default_list_id ?? null,
      client_approval_days: initial?.client_approval_days ?? 3,
    },
  });

  const isActive = watch("is_active");
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
   * P7-29 — what the server will fill in if these are left blank.
   *
   * Shown rather than silently applied, and only while creating. The same two
   * pure functions run here and in `createForm`, so the preview is the value —
   * not an approximation of it that drifts the first time either changes.
   */
  const creating = !formId;
  const name = watch("name") ?? "";
  const slug = watch("slug") ?? "";
  const prefix = watch("reference_prefix") ?? "";

  const willDeriveSlug = creating && slug === "" && name.trim() !== "";
  const willDerivePrefix = creating && prefix === "" && name.trim() !== "";

  const shownSlug = slug || (willDeriveSlug ? slugFromName(name) : "");
  const shownPrefix = prefix || (willDerivePrefix ? prefixFromName(name) : "");

  // A list belongs to one department, so offering another department's would be
  // offering a guaranteed rejection from the database.
  const departmentLists = lists
    .filter((list) => list.department_id === departmentId)
    /*
     * P7-18 — this form's OWN inbox list sorts to the front.
     *
     * Every form now gets one, created by a trigger and living in the
     * department's Client Requests folder, and `default_list_id` is pointed at
     * it automatically. So this Select is no longer choosing between equals:
     * one of these is where the form already files, and it should not be buried
     * alphabetically among lists that have nothing to do with it.
     *
     * The control STAYS, deliberately. The migration sets `default_list_id`
     * only when it is null, precisely so a lead's explicit choice survives —
     * removing the picker would take away a decision the database goes out of
     * its way to preserve.
     */
    .sort((a, b) => Number(b.form_id === formId) - Number(a.form_id === formId));

  const ownListLabel = (list: List) => (list.form_id === formId ? `${list.name} — this form's list` : list.name);

  /*
   * P7-24 — SAY WHERE REQUESTS ACTUALLY LAND.
   *
   * The bug this exists to stop repeating: a form's own inbox list sat empty in
   * Client Requests while every approved request went to a different list, and
   * nothing on any screen said so. It took an afternoon to work out from the
   * outside, because the list was correctly named and correctly filed — it was
   * simply not the one being used.
   *
   * P7-24 repairs the case that is never intentional (a default pointing at
   * ANOTHER form's inbox). This covers the case that IS legitimate and still
   * surprising: routing to an ordinary project list, which leaves this form's
   * own list permanently empty.
   */
  const ownList = departmentLists.find((list) => list.form_id === formId) ?? null;
  const chosenListId = watch("default_list_id") ?? null;
  const routedElsewhere = Boolean(ownList && chosenListId && chosenListId !== ownList.id);

  // value → label maps for the two Selects below. Without these, Base UI's
  // Select.Value falls back to rendering the raw value, and these two are the
  // worst case of that: a bare UUID and the literal string "__none__".
  const departmentItems = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const listItems = {
    [NO_LIST]: "No list",
    ...Object.fromEntries(departmentLists.map((list) => [list.id, ownListLabel(list)])),
  };

  const onSubmit = handleSubmit((values) => {
    setFormError(null);

    const showErrors = (error: string, fieldErrors?: Record<string, string[]>) => {
      setFormError(error);
      for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
        setError(key as keyof FormSettingsValues, { type: "server", message: messages[0] });
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
    <form onSubmit={onSubmit} className="p-6 bg-card rounded-xl grade-card border space-y-5" noValidate>
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

      <div className="grid gap-4 sm:grid-cols-3">
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

        <div className="space-y-2">
          <Label htmlFor="reference_prefix">Reference prefix</Label>
          <Input
            id="reference_prefix"
            placeholder={willDerivePrefix ? prefixFromName(name) : "COL"}
            className="uppercase"
            aria-invalid={Boolean(errors.reference_prefix)}
            disabled={hasSubmissions}
            {...register("reference_prefix")}
          />
          <p className="text-xs text-muted-foreground">
            {hasSubmissions
              ? // P7-29. Not just disabled — the server refuses the change too,
                // because a reference already in a client's inbox is
                // reconstructed from this and stops matching if it moves.
                "Locked — requests already quote it."
              : `e.g. ${shownPrefix || "COL"}-2026-0142${willDerivePrefix ? ", from the name" : ""}`}
          </p>
          {errors.reference_prefix ? (
            <p className="text-xs text-destructive">{errors.reference_prefix.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="sla_minutes">SLA</Label>
          {/* P7-31 — a duration, not a count of days, so a form whose work
              turns around in half a day can say so. TEXT, not type="number":
              the value is `2d 4h`, which a number input would refuse to hold. */}
          <Input
            id="sla_minutes"
            placeholder="e.g. 5d, 8h, 2d 4h"
            aria-invalid={Boolean(errors.sla_minutes)}
            {...register("sla_minutes")}
          />
          <p className="text-xs text-muted-foreground">
            Turnaround standard for this form&rsquo;s work. 1d = 8 working hours. Internal &mdash; the client never sees
            it.
          </p>
          {errors.sla_minutes ? <p className="text-xs text-destructive">{errors.sla_minutes.message}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="default_list">Default list</Label>
          <Select
            items={listItems}
            value={watch("default_list_id") ?? NO_LIST}
            onValueChange={(value) => setValue("default_list_id", value === NO_LIST ? null : value)}
            disabled={departmentLists.length === 0}>
            <SelectTrigger id="default_list">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_LIST}>No list</SelectItem>
              {/* The label goes in BOTH the items map and the children — Base UI
                  reads the map for the trigger and the children for the popup,
                  and labelling only one is how they drift. */}
              {departmentLists.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {ownListLabel(list)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* P2-06. Pre-fills the review screen; the TL can still override it
              per request. */}
          <p className="text-xs text-muted-foreground">
            {departmentLists.length === 0
              ? "This department has no lists yet."
              : "Where approved requests land. This form has a list of its own in Client Requests; pick another only if you want them filed elsewhere. The reviewer can still change it per request."}
          </p>

          {/* Stated out loud, with the way back. A form routed away from its own
              list is a legitimate choice — but it leaves that list empty
              forever, and somebody opening it and finding nothing has no way to
              tell that from a bug. */}
          {routedElsewhere && ownList ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
              Requests from this form do <strong>not</strong> go to its own list (&ldquo;{ownList.name}&rdquo;), which
              will stay empty.{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => setValue("default_list_id", ownList.id, { shouldDirty: true })}>
                Send them there instead
              </button>
            </p>
          ) : null}
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
          <p className="text-xs text-muted-foreground">Working days a client gets before the request auto-completes.</p>
          {errors.client_approval_days ? (
            <p className="text-xs text-destructive">{errors.client_approval_days.message}</p>
          ) : null}
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
              {isActive
                ? "Live — anyone with the URL can submit, no login."
                : "Draft — the public URL returns not found."}
            </p>
            {isActive && !departmentId ? (
              <p className="mt-1 text-xs text-warning">Choose a department first, or submissions have nowhere to go.</p>
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
        {formId ? "Save settings" : "Create form"}
      </Button>
    </form>
  );
}
