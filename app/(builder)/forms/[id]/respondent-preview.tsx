"use client";

import { useState } from "react";
import { Info, Monitor, Smartphone, TriangleAlert, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CanvasField } from "@/lib/form-builder/canvas";
import { FieldPreview, type FormBuilderStore } from "@/lib/form-builder/components";
import type { FormPurpose } from "@/lib/schemas/forms";

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
  builderStore,
  purpose,
  isAnonymous,
  formName,
  description,
  active,
}: {
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

  return (
    <section aria-label="Respondent view" className="overflow-y-auto bg-muted pb-10">
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

          {isClient ? (
            <ClientFixedFields stacked={width === "mobile"} />
          ) : (
            <AnonymityNotice isAnonymous={isAnonymous} />
          )}

          {active.length > 0 ? (
            <PreviewCard className="px-5.5 py-4.5">
              <Legend>{isClient ? "About this request" : "Questions"}</Legend>
              <div className="grid gap-3.5">
                {active.map((field, index) => (
                  <div key={field.id}>
                    {/*
                      ⚠️ THE NUMBER COMES FROM THIS LIST, NOT FROM THE SCHEMA.
                      Archived questions keep their place in `root` and render
                      nowhere, so counting there would number the visible
                      questions 1, 2, 4 — and the middle pane, which numbers the
                      same list, would disagree with the form.
                    */}
                    <span className="sr-only">Question {index + 1}. </span>
                    <FieldPreview builderStore={builderStore} entityId={field.id} />
                  </div>
                ))}
              </div>
            </PreviewCard>
          ) : null}

          <div className="flex items-center gap-3 pt-0.5">
            {/* Inert, like everything else in the pane — but drawn, because a
                form with no visible way to send it is not what anybody sees. */}
            <Button type="button" size="lg" disabled>
              {isClient ? "Send request" : "Send answer"}
            </Button>
          </div>

          <p className="px-0.5 text-xs text-muted-foreground">
            {isClient
              ? "You will get an email with your reference number."
              : "Once sent, an answer cannot be edited or withdrawn."}
          </p>
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
function ClientFixedFields({ stacked }: { stacked: boolean }) {
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
        <div className="grid gap-3.5">
          <PreviewField id="preview-title" label="What do you need?" required />
          <PreviewField id="preview-desc" label="Tell us more" required multiline />
          <PreviewField id="preview-date" label="When do you need it?" type="date" />
        </div>
      </PreviewCard>
    </>
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
