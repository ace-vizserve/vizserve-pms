"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import type { FormPurpose } from "@/lib/schemas/forms";

import { createDraftForm } from "./actions";

/** P17-15. Straight to the builder. The name, and everything else, is set there. */
export function NewFormButton({ purpose }: { purpose: FormPurpose }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      loading={pending}
      data-tour="new-form"
      onClick={() =>
        startTransition(async () => {
          const result = await createDraftForm(purpose);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          router.push(`/forms/${result.data.id}`);
        })
      }
    >
      <Plus />
      New form
    </Button>
  );
}
