"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createDraftForm } from "@/app/(app)/forms/actions";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * ⚠️ IN AN EFFECT, NOT IN THE PAGE. A sidebar link is prefetched, and a page that wrote
 * while rendering would make a form when somebody merely hovered over it. An effect only
 * runs once they are really here. `replace`, so Back from the builder does not land here
 * and open another one.
 */
export function OpenNewForm() {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void createDraftForm("CLIENT_REQUEST")
      .then((result) => {
        if (result.ok) router.replace(`/forms/${result.data.id}`);
        else setError(result.error);
      })
      .catch(() => setError("The form could not be created. Check your connection and try again."));
  }, [router]);

  return (
    <PageShell>
      {error ? (
        <QueryError what="a new form" message={error} />
      ) : (
        <div role="status" aria-busy="true">
          <span className="sr-only">Opening a new form…</span>
          <Skeleton className="h-[40svh] w-full" aria-hidden />
        </div>
      )}
    </PageShell>
  );
}
