"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Monitor, Smartphone, TriangleAlert, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { paginateFields, type CanvasField } from "@/lib/form-builder/canvas";
import { FieldPreview, type FormBuilderStore } from "@/lib/form-builder/components";
import {
  REQUEST_FIELD_DEFAULT_LABELS,
  type FormPurpose,
  type RequestFieldKey,
  type RequestFieldLabels,
} from "@/lib/schemas/forms";
import { setRequestFieldLabel } from "@/app/(app)/forms/actions";

import { useSaveStatus } from "./save-status";

/**
 * P7-66 — THE RIGHT PANE: THE FORM ITSELF.
 *
 * ⚠️ THIS PANE IS THE ANSWER TO THREE REJECTED LAYOUTS. An editor expanding
 * inside a row, an Elementor palette-plus-summary-cards, and a Google-Forms
 * two-column canvas were each rejected for the same reason: the middle of the
 * screen showed a DESCRIPTION of the form — "Long text · Required" — rather than
 * the form. Sorting and editing genuinely do need a list and a panel; what was
 * missing was anywhere to see the thing being built. So it gets a pane of its
 * own, permanently, beside the work rather than behind a button.
 *
 * ⚠️ IT IS DRAWN WITH THE COMPONENTS THE RESPONDENT'S BROWSER DRAWS.
 * `FieldPreview` renders through `fieldComponents` — the same map
 * `/request/[slug]` and `/respond/[slug]` render through — so a date picker here
 * is the date picker there, and a choice list here has the options that will be
 * offered there. A hand-drawn approximation would be a fourth description of the
 * form, which is the thing this pane exists to stop.
 *
 * ⚠️ IT IS INERT, AND `FieldRuntimeProvider`'s `builder` mode is what makes it
 * so. Every control renders disabled. That is not a limitation to apologise for:
 * a preview somebody can type into invites them to fill in their own form, and
 * nothing would happen to what they typed.
 *
 * ⚠️ THE FIXED FIELDS ARE SHOWN ON A CLIENT FORM AND NOT ON A STAFF ONE, because
 * that is what is true. `/request/[slug]` collects name, email, title,
 * description and target date on EVERY client form — they are columns on
 * `vizserve_pms_requests`, not questions, so they cannot be moved, renamed or
 * removed. A builder that showed only the custom questions was hiding half of
 * what a client actually sees. `/respond/[slug]` has none of them: the session
 * already says who is answering.
 */

export function RespondentPreview({
  formId,
  requestLabels,
  builderStore,
  purpose,
  isAnonymous,
  formName,
  description,
  active,
}: {
  formId: string;
  requestLabels: RequestFieldLabels;
  builderStore: FormBuilderStore;
  purpose: FormPurpose;
  /** Only meaningful on a staff form — see the notice below. */
  isAnonymous: boolean;
  formName: string;
  description: string;
  /** The questions the form asks, in order. Archived ones render nowhere. */
  active: CanvasField[];
}) {
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const isClient = purpose === "CLIENT_REQUEST";

  /*
   * P7-66 Phase 7 — THE PAGES THIS FORM SPLITS INTO.
   *
   * WARNING: THE SAME `paginateFields` BOTH LIVE FORMS USE. A preview that pages
   * a form differently from the way it pages for the person answering is worse
   * than a preview that does not page at all — it would be confidently wrong
   * about the one thing it exists to show. One function, three callers.
   */
  const pages = useMemo(
    () =>
      paginateFields(
        active,
        (field) => field.entity.type === "section",
        (field) => ({
          title: field.entity.attributes.label,
          blurb: field.entity.attributes.helpText,
        }),
      ),
    [active],
  );

  const [page, setPage] = useState(0);

  /*
   * WARNING: CLAMPED ON RENDER, NOT IN AN EFFECT. Deleting the last page break
   * while looking at the last page drops the page count under the index, and a
   * preview showing nothing at all is indistinguishable from a form with no
   * questions. An effect would repaint the empty state first and correct it
   * after.
   */
  const current = Math.min(page, pages.length - 1);
  const shown = pages[current] ?? pages[0]!;

  /* The fixed five sit on page one — the same rule the public form applies. */
  const onFirstPage = current === 0;
  const onLastPage = current === pages.length - 1;

  /*
     ⚠️ `h-full`, OR THIS IS NOT A SCROLL CONTAINER AND ITS BACKGROUND STOPS
     SHORT.

     `FieldBuilder` puts the grid item — a wrapper carrying the responsive
     `col-span-full` — around this section rather than on it. A grid item
     stretches to its track; a child of one does not. So with `height: auto`
     this section was as tall as its CONTENT, which does two wrong things at
     once: `overflow-y-auto` has no bounded box to scroll inside, so a long
     preview is sheared off by the grid's `overflow-hidden` instead of
     scrolling, and a SHORT preview leaves the rest of the stretched wrapper
     painted in page background — the grey band under the preview.

     `min-[1180px]:grid-rows-1` on the grid is the other half of that band and
     neither half fixes it alone: the row has to be `1fr` for the wrapper to
     be full height, and this has to be `h-full` for the muted surface to
     reach the bottom of it.

     Below 1180px the panes stack and the document scrolls as one, so the
     height goes back to `auto` with it.
   */
  return (
    <section
      aria-label="Respondent view"
      className="h-full min-h-0 overflow-y-auto bg-muted pb-10 max-[1180px]:h-auto max-[1180px]:overflow-visible"
    >
      <div className="sticky top-0 z-5 flex items-center gap-2 border-b bg-muted px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
          <User aria-hidden className="size-4" />
          {/* Whose eyes these are. "Preview" would be true and would not say the
              one thing that matters, which is that a client and a colleague see
              two different forms. */}
          {isClient ? "What the client sees" : "What a colleague sees"}
        </h2>

        <div
          role="group"
          aria-label="Preview width"
          className="ml-auto flex gap-0.5 rounded-lg border bg-card p-[3px]"
        >
          {/*
            ⚠️ A REAL CONCERN, NOT A GADGET. Both routes are reached from a phone
            — a client on a link in an email, a colleague on a survey in Slack —
            and the two-column "Your details" block, the choice lists and the
            date pickers all reflow. Checking that costs one click here and a
            device otherwise.
          */}
          <WidthButton
            active={width === "desktop"}
            label="Desktop width"
            onClick={() => setWidth("desktop")}
          >
            <Monitor className="size-4" />
          </WidthButton>
          <WidthButton
            active={width === "mobile"}
            label="Mobile width"
            onClick={() => setWidth("mobile")}
          >
            <Smartphone className="size-4" />
          </WidthButton>
        </div>
      </div>

      <div className="p-5">
        <div
          className={cn(
            "mx-auto flex flex-col gap-3 transition-[max-width] duration-200",
            width === "mobile" ? "max-w-[390px]" : "max-w-[640px]",
          )}
        >
          <PreviewCard className="rounded-lg border-t-6 border-t-primary px-6 py-5.5">
            <h3 className="text-xl font-semibold tracking-[-0.02em]">
              {formName || "Untitled form"}
            </h3>
            {description ? (
              <p className="mt-1.5 text-sm text-foreground-muted">{description}</p>
            ) : null}
          </PreviewCard>

          {/* The fixed five are page one's, wherever the breaks fall. */}
          {onFirstPage ? (
            isClient ? (
              <ClientFixedFields
                formId={formId}
                labels={requestLabels}
                stacked={width === "mobile"}
              />
            ) : (
              <AnonymityNotice isAnonymous={isAnonymous} />
            )
          ) : null}

          {shown.items.length > 0 ? (
            <PreviewCard className="px-5.5 py-4.5">
              {/*
                WARNING: A PAGE OPENED BY A BREAK IS HEADED BY THAT BREAK, NOT BY
                "About this request". `sectionFieldComponent` draws the title
                from the section row itself — the same component the live form
                uses — so the generic legend would be a second heading over it.
              */}
              {shown.title === "" && current === 0 ? (
                <Legend>{isClient ? "About this request" : "Questions"}</Legend>
              ) : null}
              <div className="grid gap-3.5">
                {shown.items.map((field, index) => (
                  <div key={field.id}>
                    {/*
                      ⚠️ THE NUMBER COMES FROM THIS LIST, NOT FROM THE SCHEMA.
                      Archived questions keep their place in `root` and render
                      nowhere, so counting there would number the visible
                      questions 1, 2, 4 — and the middle pane, which numbers the
                      same list, would disagree with the form.
                    */}
                    {field.entity.type === "section" ? null : (
                      <span className="sr-only">Question {index + 1}. </span>
                    )}
                    <FieldPreview builderStore={builderStore} entityId={field.id} />
                  </div>
                ))}
              </div>
            </PreviewCard>
          ) : null}

          {/*
            WARNING: THE SWITCHER IS THE ONLY LIVE CONTROL IN THIS PANE, and it
            has to be: every other control here is disabled because typing into a
            preview does nothing, but a paged form cannot be previewed at all
            without a way to reach page two. It moves the preview; it changes no
            form data, so there is nothing for it to be a lie about.
          */}
          <div className="flex items-center gap-3 pt-0.5">
            {pages.length > 1 ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={onFirstPage}
                  onClick={() => setPage(Math.max(0, current - 1))}
                >
                  Back
                </Button>
                {onLastPage ? (
                  <Button type="button" size="lg" disabled>
                    {isClient ? "Send request" : "Send answer"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => setPage(Math.min(pages.length - 1, current + 1))}
                  >
                    Continue
                  </Button>
                )}
                <p className="text-xs text-muted-foreground tabular-nums">
                  Page {current + 1} of {pages.length}
                </p>
              </>
            ) : (
              /* Inert, like everything else in the pane — but drawn, because a
                 form with no visible way to send it is not what anybody sees. */
              <Button type="button" size="lg" disabled>
                {isClient ? "Send request" : "Send answer"}
              </Button>
            )}
          </div>

          {onLastPage ? (
            <p className="px-0.5 text-xs text-muted-foreground">
              {isClient
                ? "You will get an email with your reference number."
                : "Once sent, an answer cannot be edited or withdrawn."}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WidthButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "grid place-items-center rounded-md px-2 py-1 text-muted-foreground",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PreviewCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border bg-card grade-surface shadow-raised", className)}>
      {children}
    </div>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-3.5 block border-b pb-2 text-xs font-semibold">{children}</span>
  );
}

/**
 * The five a client answers on every form, whatever its questions are.
 *
 * ⚠️ THEY ARE COLUMNS, NOT QUESTIONS. `requester_name`, `requester_email`,
 * `title`, `description` and `target_date` are fields on
 * `vizserve_pms_requests` — the Gate 1 screen reads them, the acknowledgement
 * email quotes them, the reference number is minted alongside them. So they
 * cannot be reordered, renamed, made optional or removed, and nothing in the
 * builder offers to.
 *
 * Rendered as real, disabled controls rather than a line of text naming them:
 * the point of the pane is that it shows the form, and half the form being a
 * sentence about the form is the failure the layout was rejected for three
 * times.
 */
function ClientFixedFields({
  formId,
  labels,
  stacked,
}: {
  formId: string;
  labels: RequestFieldLabels;
  stacked: boolean;
}) {
  return (
    <>
      <PreviewCard className="px-5.5 py-4.5">
        <Legend>Your details</Legend>
        <div className={cn("grid gap-3.5", stacked ? "grid-cols-1" : "grid-cols-2")}>
          <PreviewField id="preview-name" label="Your name" required />
          <PreviewField id="preview-email" label="Your email" required type="email" />
        </div>
      </PreviewCard>

      <PreviewCard className="px-5.5 py-4.5">
        <Legend>Your request</Legend>
        {/* P15-04 — the fields are fixed, their labels are the form's. */}
        <div className="grid gap-3.5">
          <EditableRequestField formId={formId} fieldKey="title" saved={labels.title} />
          <EditableRequestField formId={formId} fieldKey="description" saved={labels.description} multiline />
          <EditableRequestField formId={formId} fieldKey="target_date" saved={labels.target_date} type="date" />
        </div>
      </PreviewCard>
    </>
  );
}

const LABEL_DEBOUNCE_MS = 700;

/**
 * P15-04 — one fixed request field whose LABEL can be retyped in place.
 *
 * Same save rhythm as `BuilderTitle`: debounced while typing, flushed on blur,
 * Escape abandons. Clearing the label resets it to the default.
 */
function EditableRequestField({
  formId,
  fieldKey,
  saved,
  multiline = false,
  type = "text",
}: {
  formId: string;
  fieldKey: RequestFieldKey;
  saved: string | null;
  multiline?: boolean;
  type?: string;
}) {
  const router = useRouter();
  const { track } = useSaveStatus();
  const fallback = REQUEST_FIELD_DEFAULT_LABELS[fieldKey];

  const [value, setValue] = useState(saved ?? fallback);
  const savedRef = useRef(saved ?? fallback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abandonRef = useRef(false);

  useEffect(() => {
    const next = saved ?? fallback;
    if (next === savedRef.current) return;
    savedRef.current = next;
    setValue(next);
  }, [saved, fallback]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  function save(next: string) {
    const trimmed = next.trim() || fallback;
    if (trimmed === savedRef.current) return;

    void track(async () => {
      // The default is stored as null, so a form left on it follows the default.
      const result = await setRequestFieldLabel(formId, {
        key: fieldKey,
        label: trimmed === fallback ? "" : trimmed,
      });

      if (!result.ok) {
        return { outcome: { kind: "failed" as const, message: result.error }, value: undefined };
      }

      savedRef.current = trimmed;
      router.refresh();
      return { outcome: { kind: "saved" as const }, value: undefined };
    }).catch((cause: unknown) => {
      console.error("[P15-04] saving a request field label threw —", cause);
    });
  }

  function onChange(next: string) {
    setValue(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(next), LABEL_DEBOUNCE_MS);
  }

  function onBlur() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    if (abandonRef.current) {
      abandonRef.current = false;
      setValue(savedRef.current);
      return;
    }

    if (value.trim() === "") setValue(fallback);
    save(value);
  }

  const inputId = `preview-${fieldKey}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-0.5">
        <input
          value={value}
          maxLength={120}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              abandonRef.current = true;
              if (timerRef.current !== null) clearTimeout(timerRef.current);
              setValue(savedRef.current);
              event.currentTarget.blur();
            }
          }}
          aria-label={`Label for the ${REQUEST_FIELD_DEFAULT_LABELS[fieldKey].toLowerCase()} field`}
          placeholder={fallback}
          className="-ml-1.5 min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-sm font-medium hover:bg-accent focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-primary"
        />
        <span aria-hidden className="text-destructive">
          *
        </span>
        <span className="sr-only">(required)</span>
      </div>
      {multiline ? (
        <Textarea id={inputId} rows={3} disabled aria-label={value || fallback} />
      ) : (
        <Input id={inputId} type={type} disabled aria-label={value || fallback} />
      )}
    </div>
  );
}

function PreviewField({
  id,
  label,
  required = false,
  multiline = false,
  type = "text",
}: {
  id: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <>
            <span aria-hidden className="text-destructive">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </Label>
      {multiline ? (
        <Textarea id={id} rows={3} disabled />
      ) : (
        <Input id={id} type={type} disabled />
      )}
    </div>
  );
}

/**
 * ⚠️ WHAT A COLLEAGUE IS TOLD BEFORE THEY ANSWER, SHOWN TO THE PERSON WHO
 * DECIDES IT.
 *
 * `/respond/[slug]` states which kind of form it is, either way, above the
 * questions — a promise that arrives after the fact is not a promise. This is
 * the same sentence, in the same place, so somebody setting the anonymity switch
 * on the Settings tab can see what it actually says to the people answering.
 *
 * It is the ONE piece of this pane that reflects a setting rather than a
 * question, and it earns that: it is the only thing on a staff form that a
 * respondent reads before deciding what to write.
 */
function AnonymityNotice({ isAnonymous }: { isAnonymous: boolean }) {
  return (
    <PreviewCard className="px-5.5 py-4.5">
      <p
        className={cn(
          "flex gap-2.5 rounded-md border px-3 py-2.5 text-xs leading-relaxed",
          isAnonymous
            ? "border-info-border bg-info-subtle text-info"
            : "border-warning-border bg-warning-subtle text-warning",
        )}
      >
        {isAnonymous ? (
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : (
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        )}
        {isAnonymous ? (
          <span>
            <strong className="font-semibold">This form is anonymous.</strong> Your name is not
            recorded with your answer — not hidden, never written.
          </span>
        ) : (
          <span>
            <strong className="font-semibold">This form is not anonymous.</strong> Your answer
            is saved against your name and can be read by the team that owns this form.
          </span>
        )}
      </p>
    </PreviewCard>
  );
}
