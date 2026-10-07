"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  REQUEST_FIELD_DEFAULT_LABELS,
  REQUEST_FIELD_KEYS,
  type RequestFieldKey,
  type RequestFieldLabels,
  type RequestFieldsShown,
} from "@/lib/schemas/forms";
import { setRequestFieldLabel, setRequestFieldShown } from "@/app/(app)/forms/actions";

import { useSaveStatus } from "./save-status";

const LABEL_DEBOUNCE_MS = 700;

/**
 * P16-04 — a client form's default fields, in the builder's left pane.
 *
 * Name and email are always asked: they are who the request is from and where
 * Gate 3 is sent. Title, description and the ideal finish date start on every
 * form and can be renamed (P15-04) or removed — and added back.
 */
export function DefaultFields({
  formId,
  labels,
  shown,
}: {
  formId: string;
  labels: RequestFieldLabels;
  shown: RequestFieldsShown;
}) {
  return (
    <div className="mb-3 rounded-lg border bg-card px-3 py-2.5">
      <p className="text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">Default fields</p>
      <ul className="mt-2 divide-y">
        <LockedRow label="Your name" />
        <LockedRow label="Your email" />
        {REQUEST_FIELD_KEYS.map((key) => (
          <DefaultRow key={key} formId={formId} fieldKey={key} saved={labels[key]} shown={shown[key]} />
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Rename one by typing over it. A form without a title names each request after itself.
      </p>
    </div>
  );
}

function LockedRow({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
        <Lock aria-hidden className="size-3" />
        Always asked
      </span>
    </li>
  );
}

function DefaultRow({
  formId,
  fieldKey,
  saved,
  shown,
}: {
  formId: string;
  fieldKey: RequestFieldKey;
  saved: string | null;
  shown: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fallback = REQUEST_FIELD_DEFAULT_LABELS[fieldKey];

  function toggle(next: boolean) {
    startTransition(async () => {
      const result = await setRequestFieldShown(formId, { key: fieldKey, shown: next });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex items-center gap-2 py-1">
      {shown ? (
        <LabelInput formId={formId} fieldKey={fieldKey} saved={saved} />
      ) : (
        <span className="min-w-0 flex-1 truncate px-1.5 py-0.5 text-sm text-muted-foreground line-through">
          {saved || fallback}
        </span>
      )}
      {fieldKey === "target_date" && shown ? (
        <span className="text-2xs text-muted-foreground">Optional</span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={pending}
        aria-label={shown ? `Remove ${saved || fallback}` : `Add ${saved || fallback} back`}
        onClick={() => toggle(!shown)}
        className={cn(shown ? "text-muted-foreground hover:text-destructive" : "text-primary")}>
        {shown ? <X /> : <Plus />}
      </Button>
    </li>
  );
}

/** Same save rhythm as `BuilderTitle`: debounced, flushed on blur, Escape abandons. */
function LabelInput({ formId, fieldKey, saved }: { formId: string; fieldKey: RequestFieldKey; saved: string | null }) {
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

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  function save(next: string) {
    const trimmed = next.trim() || fallback;
    if (trimmed === savedRef.current) return;

    void track(async () => {
      // The default is stored as null, so a form left on it follows the default.
      const result = await setRequestFieldLabel(formId, { key: fieldKey, label: trimmed === fallback ? "" : trimmed });
      if (!result.ok) {
        return { outcome: { kind: "failed" as const, message: result.error }, value: undefined };
      }
      savedRef.current = trimmed;
      router.refresh();
      return { outcome: { kind: "saved" as const }, value: undefined };
    }).catch((cause: unknown) => {
      console.error("[P16-04] saving a request field label threw —", cause);
    });
  }

  return (
    <input
      value={value}
      maxLength={120}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => save(next), LABEL_DEBOUNCE_MS);
      }}
      onBlur={() => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        if (abandonRef.current) {
          abandonRef.current = false;
          setValue(savedRef.current);
          return;
        }
        if (value.trim() === "") setValue(fallback);
        save(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          abandonRef.current = true;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          setValue(savedRef.current);
          event.currentTarget.blur();
        }
      }}
      aria-label={`Label for the ${fallback.toLowerCase()} field`}
      placeholder={fallback}
      className="-ml-1.5 min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-sm hover:bg-accent focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-primary"
    />
  );
}
