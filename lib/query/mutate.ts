/**
 * The write path: Server Actions, called from `useMutation`.
 *
 * ⚠️ WRITES DO NOT GO BROWSER → POSTGREST, AND THAT IS DELIBERATE. The actions
 * hold the zod contracts from `lib/schemas/`, `sanitizeRichText`, the
 * notification drain, the Resend sends, and the calls into
 * `vizserve_pms_transition_task` where the state machine and the audit write
 * live. `status` is not even in the column grant for `authenticated`, so a
 * browser write could not move a task if it tried.
 *
 * Nothing about that is visible to the user: a `useMutation` calling a Server
 * Action behaves exactly like one calling `fetch`, optimistic updates and all.
 *
 * ⚠️ READS MUST NOT USE THIS ROUTE. Next serialises Server Action requests — they
 * are POSTs that queue one at a time per client — so a cache firing six parallel
 * reads on mount would run them end to end. Reads go through `read.ts` and the
 * browser Supabase client.
 */
import type { ActionResult } from "@/lib/action-result";

/**
 * A refused write.
 *
 * `fieldErrors` rides along so a form can put the message beside the input that
 * caused it — the reason `ActionResult` carries them in the first place. Read it
 * off `mutation.error` and hand it straight to `<FieldError messages={…} />`.
 */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Wraps a Server Action so TanStack sees an ordinary promise.
 *
 * ⚠️ THE ENVELOPE STAYS AS IT IS. `ActionResult` is returned by all twenty
 * action files and is imported by client components to type what they get back;
 * it is not being replaced. TanStack simply drives `onError`/`onSuccess` off a
 * rejection rather than a discriminated union, so the boundary is converted here
 * once instead of in every call site.
 */
export function fromAction<Args extends unknown[], T>(
  action: (...args: Args) => Promise<ActionResult<T>>,
): (...args: Args) => Promise<T> {
  return async (...args: Args) => {
    const result = await action(...args);

    if (!result.ok) {
      throw new ActionError(result.error, result.fieldErrors);
    }

    return result.data;
  };
}

/** Field messages off whatever `useMutation` put in `error`, or nothing. */
export function fieldErrorsOf(error: unknown): Record<string, string[]> | undefined {
  return error instanceof ActionError ? error.fieldErrors : undefined;
}
