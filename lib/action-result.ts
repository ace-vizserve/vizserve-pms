import type { z } from "zod";

/**
 * P11-02 — the shape every server action returns, and the two helpers around it.
 *
 * ⚠️ THIS WAS COPY-PASTED INTO THIRTEEN ACTION FILES. Byte-identical in all of
 * them, which is the only reason nobody noticed — until `readableError`, which
 * lived in five of them, quietly grew THREE different implementations. That is
 * what duplication does: it holds still until it doesn't, and then the same
 * failure is reported differently depending on which screen you were on.
 *
 * ⚠️ NOTHING HERE IS SERVER-ONLY, deliberately. `ActionResult` is imported by
 * client components to type what they get back, so this module must stay free of
 * Node imports and of the `server-only` marker.
 */

/**
 * Success carries data; failure carries a sentence, and optionally a message per
 * field.
 *
 * `fieldErrors` is what lets a form put a message beside the input that caused
 * it rather than one line at the bottom for all of them. It is optional because
 * plenty of failures are not about a field — a policy refusal, a lost row, a
 * constraint the form could not have known about.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * A zod error, keyed by the field it belongs to.
 *
 * ⚠️ KEYED ON `path[0]` ONLY. A nested issue at `relievers[0].task_ids` reports
 * under `relievers`, which is the field a form actually has a box for. The
 * fallback key is the literal `"form"`, which every dialog renders as a
 * form-level message — a refinement that spans two fields has no single input to
 * point at, and hiding it because of that is how a form refuses to submit while
 * looking perfectly filled in.
 *
 * Every message for a key is kept, not just the first. The renderer decides what
 * to show; throwing them away here would make that decision unreachable.
 */
export function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/**
 * Postgres raises a sentence; PostgREST wraps it. Show the sentence.
 *
 * The rules in this app live in the database — required fields, the resolution
 * gate, `field_key` immutability, the no-hard-delete guard — and each of them
 * raises text written for a person to read. By the time it reaches here it is
 * wearing `ERROR:` on the front and a `CONTEXT:` stack on the back, neither of
 * which is for the reader.
 *
 * The fallback is deliberately vague. If the message is empty there is nothing
 * honest to say, and inventing a cause is worse than admitting there isn't one.
 */
export function readableError(error: { message?: string } | null): string {
  const raw = error?.message ?? "";
  return (
    raw
      .replace(/^.*?(?:ERROR|error):\s*/i, "")
      .replace(/\s*CONTEXT:[\s\S]*$/, "")
      .trim() || "That did not go through. Try again."
  );
}
