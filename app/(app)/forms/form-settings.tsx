"use client";

import { useEffect, useState, useTransition } from "react";
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
import {
  DEFAULT_SLA_MINUTES,
  FORM_PURPOSES,
  FORM_PURPOSE_LABELS,
  formCreateSchema,
  formSettingsSchema,
  prefixFromName,
  slugFromName,
  type FormPurpose,
  type FormSettingsInput,
  type FormSettingsValues,
} from "@/lib/schemas/forms";
import { formatSlaDuration } from "@/lib/schemas/duration";
import { createForm, updateFormSettings } from "./actions";

type Department = { id: string; name: string };
type List = { id: string; name: string; department_id: string; form_id?: string | null };

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
    resolver: zodResolver(
      formId ? formSettingsSchema : formCreateSchema,
    ) as unknown as Resolver<FormSettingsValues>,
    defaultValues: {
      // P7-66. First in the object as it is first on screen: everything under
      // it means something different depending on this one value.
      purpose: initial?.purpose ?? "CLIENT_REQUEST",
      name: initial?.name ?? "",
      slug: initial?.slug ?? "",
      description: initial?.description ?? "",
      department_id: initial?.department_id ?? null,
      reference_prefix: initial?.reference_prefix ?? "",
      // P7-66 — false is the safe default and the column's own: a form is
      // ATTRIBUTED unless somebody deliberately says otherwise.
      is_anonymous: initial?.is_anonymous ?? false,
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
   * ⚠️ P7-66 — THE NAME IS NOW EDITED IN TWO PLACES, AND THIS CARD IS THE ONE
   * THAT CAN OVERWRITE THE OTHER.
   *
   * The builder's top bar renames the form in place (`BuilderTitle`), and the
   * builder keeps all three tabs MOUNTED so the question canvas survives a tab
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
   * P7-66 — the four controls an engagement form has no use for.
   *
   * A reference prefix mints `COL-2026-0142` for a client to quote, an SLA is a
   * turnaround standard on client work, a default list is where an APPROVED
   * request files, and the client approval window is Gate 3. None of the four
   * exists on a form staff fill in, so none of them is shown.
   *
   * HIDDEN, NOT UNREGISTERED. react-hook-form keeps a field's value when its
   * input unmounts (`shouldUnregister` defaults to false), which is what this
   * relies on: `formSettingsSchema` still demands a legal prefix and a legal
   * SLA on every UPDATE, and they are supplied by the values the form loaded
   * with. Switching to `shouldUnregister: true` would make this card
   * unsaveable on an engagement form, with the error landing on a field nobody
   * can see.
   */
  const purpose = watch("purpose") ?? "CLIENT_REQUEST";
  const isClientRequest = purpose === "CLIENT_REQUEST";
  const isAnonymous = watch("is_anonymous") ?? false;

  /*
   * ⚠️ P7-66 — CHANGING THE PURPOSE TO CLIENT MUST CLEAR THIS, and that is
   * exactly because of the "HIDDEN, NOT UNREGISTERED" note above.
   *
   * react-hook-form keeps a field's value when its input unmounts, which is what
   * makes the four hidden client-only settings saveable. The same behaviour on
   * `is_anonymous` is a bug: mark a draft anonymous, then switch it to a client
   * form, and the card sends `{ purpose: CLIENT_REQUEST, is_anonymous: true }`
   * — refused by `vizserve_pms_forms_anonymous_is_internal`, on a control that
   * is no longer on screen to explain itself. So the value is cleared with the
   * switch that set it, and `updateFormSettings` still refuses the pair for
   * anybody who bypasses this card.
   */
  const setPurpose = (value: FormPurpose) => {
    setValue("purpose", value, { shouldValidate: true });
    if (value === "CLIENT_REQUEST") setValue("is_anonymous", false);
  };

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

  const ownListLabel = (list: List) =>
    list.form_id === formId ? `${list.name} — this form's list` : list.name;

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
  const purposeItems = Object.fromEntries(
    FORM_PURPOSES.map((value) => [value, FORM_PURPOSE_LABELS[value].label]),
  );
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
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {/* P7-66 — FIRST, above the name, because it changes what every control
          below it means. `items` is not optional here: without it Base UI's
          Select.Value renders the raw enum, and "EMPLOYEE_ENGAGEMENT" on a
          screen is the exact thing check:select-items exists to fail. */}
      <div className="space-y-2">
        <Label htmlFor="purpose">Purpose</Label>
        <Select
          items={purposeItems}
          value={purpose}
          onValueChange={(value) => setPurpose(value as FormPurpose)}
          disabled={hasSubmissions}
        >
          <SelectTrigger id="purpose" className="w-full sm:w-1/2" aria-invalid={Boolean(errors.purpose)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* The label goes in BOTH the items map and the children — Base UI
                reads the map for the trigger and the children for the popup. */}
            {FORM_PURPOSES.map((value) => (
              <SelectItem key={value} value={value}>
                {FORM_PURPOSE_LABELS[value].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {hasSubmissions
            ? // Not just disabled — `updateFormSettings` refuses the change too.
              // Flipping this on a live form would either strand its requests
              // off the Gate 1 route or put a staff form on the open internet.
              `Locked — ${FORM_PURPOSE_LABELS[purpose].label.toLowerCase()}, with submissions already through it.`
            : FORM_PURPOSE_LABELS[purpose].hint}
        </p>
        {errors.purpose ? (
          <p className="text-xs text-destructive">{errors.purpose.message}</p>
        ) : null}
      </div>

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
            {/* An engagement form is not at /request/… — that route is the
                public one and refuses anything `is_public` is false on. It gets
                a slug all the same, because it is the form's address wherever
                staff open it from; promising a URL this phase has not built
                would be worse than naming none. */}
            {isClientRequest
              ? `Public at /request/${shownSlug || "…"}. `
              : `Its address is /${shownSlug || "…"}. Staff open it signed in, not from a public link. `}
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

      <div className={isClientRequest ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>
        <div className="space-y-2">
          <Label htmlFor="department">Owning department</Label>
          {/* `items` is what makes the trigger show "VizBytes" instead of the
              department's UUID. Base UI's Select.Value renders the raw value
              unless the Root is handed a value→label map. */}
          <Select
            items={departmentItems}
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
          {/* On a client form this decides which Team Leader the request lands
              on. On an engagement form nothing is routed anywhere — but the
              department is still what RLS scopes the form by, and publishing is
              refused without one (vizserve_pms_forms_active_requires_
              department), so the field is asked for either way. */}
          <p className="text-xs text-muted-foreground">
            {isClientRequest
              ? "Routes submissions to this department's TL."
              : "Who owns the form. Required before it can be published."}
          </p>
          {errors.department_id ? (
            <p className="text-xs text-destructive">{errors.department_id.message}</p>
          ) : null}
        </div>

        {isClientRequest ? (
          <>
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
            Turnaround standard for this form&rsquo;s work. 1d = 8 working hours. Internal
            &mdash; the client never sees it.
          </p>
          {errors.sla_minutes ? (
            <p className="text-xs text-destructive">{errors.sla_minutes.message}</p>
          ) : null}

        </div>
          </>
        ) : null}
      </div>

      {isClientRequest ? (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="default_list">Default list</Label>
          <Select
            items={listItems}
            value={watch("default_list_id") ?? NO_LIST}
            onValueChange={(value) => setValue("default_list_id", value === NO_LIST ? null : value)}
            disabled={departmentLists.length === 0}
          >
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
              Requests from this form do <strong>not</strong> go to its own list
              (&ldquo;{ownList.name}&rdquo;), which will stay empty.{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => setValue("default_list_id", ownList.id, { shouldDirty: true })}
              >
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
          <p className="text-xs text-muted-foreground">
            Working days a client gets before the request auto-completes.
          </p>
          {errors.client_approval_days ? (
            <p className="text-xs text-destructive">{errors.client_approval_days.message}</p>
          ) : null}
        </div>
      </div>
      ) : null}

      <div className="space-y-3 rounded-lg border p-4">
        {/*
          ⚠️ P7-66 — ENGAGEMENT FORMS ONLY, AND NOT MERELY BECAUSE IT WOULD BE
          USELESS ON A CLIENT FORM.

          /request/<slug> has no session at all: a client TYPES their own name
          and email into the form, and those are ordinary answers on the
          request. There is no identity the platform captured and therefore
          nothing to withhold — an "anonymous" client form would promise
          something it does not deliver, with the name sitting in
          `requester_name` the whole time. `vizserve_pms_forms_anonymous_is_
          internal` refuses that row; this is why the control is not there to
          try it.

          ⚠️ FIRST IN THIS BOX, ABOVE PUBLISHED. It is the setting that has to be
          right BEFORE the form goes live — publishing is what makes it
          unchangeable, and a switch found underneath the one that locked it is
          a switch found too late.
        */}
        {isClientRequest ? null : (
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
                // Not just disabled — `updateFormSettings` refuses the change
                // and `vizserve_pms_forms_anonymity_lock` refuses it under that.
                // The reason is not "it would be awkward": named→anonymous would
                // label answers that still carry names as anonymous.
                <p className="mt-1 text-xs text-muted-foreground">
                  Locked — answers already came in under this promise. Build a new form to change
                  it.
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
        )}

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
            {/* P7-66 — "anyone with the URL, no login" is TRUE of a client form
                and would be a lie about an engagement one. The whole point of
                the purpose column is that these are two different promises, so
                the sentence that describes publishing has to be two sentences. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isClientRequest
                ? isActive
                  ? "Live — anyone with the URL can submit, no login."
                  : "Draft — the public URL returns not found."
                : isActive
                  ? "Live — signed-in staff can fill it in. There is no public link."
                  : "Draft — nobody can fill it in yet."}
            </p>
            {isActive && !departmentId ? (
              <p className="mt-1 text-xs text-warning">
                {isClientRequest
                  ? "Choose a department first, or submissions have nowhere to go."
                  : "Choose a department first — a form with none cannot be published."}
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
