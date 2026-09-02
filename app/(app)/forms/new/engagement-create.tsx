"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createForm } from "../actions";

/**
 * P7-66 — NAME IT AND START WRITING QUESTIONS.
 *
 * Ace, on seeing the builder: "for client form our current flow is okay but for
 * internal the flow should not be like that, like what i've said google forms."
 *
 * The client-request card asks for six things before the first question, and
 * that is right — a slug becomes the URL a client is sent, a reference prefix
 * goes in their inbox, a department decides which Team Leader is on the hook, an
 * SLA is a promise about turnaround. Every one is a decision somebody has to
 * make on purpose.
 *
 * An engagement form has none of them. No client, no reference series, no queue,
 * no gate. So this asks for a NAME and derives or defaults the rest server-side:
 *
 *   slug             `slugFromName(name)`  — pure, and de-duplicated by retry
 *   reference_prefix `prefixFromName(name)`  in createForm when Postgres says
 *                                            the value is taken
 *   sla_minutes      `DEFAULT_SLA_MINUTES` via `formCreateSchema`
 *   client_approval_days / default_list_id / requires_attachment — schema
 *                                            defaults; never shown again
 *   department_id    decided by the page — see the comment there
 *
 * ⚠️ NO SLUG PREVIEW, DELIBERATELY, unlike the client card. There the preview
 * earns its place because the value becomes a URL somebody pastes into an email.
 * Here it is an internal address nobody types, and putting it on a screen whose
 * whole point is "one box, then questions" would add back exactly what was
 * removed. It stays editable on the settings card afterwards.
 */
export function EngagementCreate({ departmentId }: { departmentId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const trimmed = name.trim();

    /*
     * Checked here as well as in `formCreateSchema`, because this is the ONE
     * field on the screen: a round trip to be told the box is empty says what
     * the page already knew. The schema is still the rule — the front end will
     * be bypassed, and the message is the schema's own so the two cannot drift
     * into saying different things about the same blank.
     */
    if (trimmed === "") {
      setError("Give the form a name.");
      return;
    }

    startTransition(async () => {
      const result = await createForm({
        purpose: "EMPLOYEE_ENGAGEMENT",
        name: trimmed,
        // Blank means "derive it". `createForm` runs `slugFromName` and
        // `prefixFromName` and retries against the two unique indexes.
        slug: "",
        reference_prefix: "",
        department_id: departmentId,
      });

      if (!result.ok) {
        // A field error on the only field there is reads better than the
        // generic "Check the highlighted fields" that carries it.
        setError(result.fieldErrors?.name?.[0] ?? result.error);
        return;
      }

      toast.success("Form created");
      // Straight into the question builder, which is the whole point.
      router.push(`/forms/${result.data.id}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="name">What is this form called?</Label>
        <Input
          id="name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Q3 Pulse Survey"
          aria-invalid={Boolean(error)}
          aria-describedby="engagement-name-hint"
        />
        <p id="engagement-name-hint" className="text-xs text-muted-foreground">
          That is all that is needed. You write the questions next, and the rest
          of the settings are on the same page whenever you want them.
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {departmentId === null ? (
        /*
         * Said out loud rather than left to be found at the Publish switch.
         * `vizserve_pms_forms_active_requires_department` refuses a live form
         * with no department, so this person WILL be stopped later — and being
         * told now, on the screen that could not answer it for them, is the
         * difference between a known next step and a switch that quietly
         * refuses to stay on.
         */
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
          This form starts unassigned, because there is no single department it
          obviously belongs to. Choose its owning department in Settings before
          you publish it.
        </p>
      ) : null}

      {/* Not disabled on an empty name: a disabled button that never says why
          is the one anti-pattern §4.2 names outright. It submits, and the box
          says what is missing. */}
      <Button type="submit" loading={pending}>
        Create and add questions
      </Button>
    </form>
  );
}
