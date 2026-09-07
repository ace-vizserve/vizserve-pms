import { cn } from "@/lib/utils";

/**
 * The validation messages for one field.
 *
 * ⚠️ IT RENDERS ALL OF THEM, AND IT DID NOT USED TO. Both copies of this
 * component showed `messages[0]` and dropped the rest, while `flattenIssues`
 * carefully collected every issue per key. A field that fails two rules at once
 * — too short AND containing something it may not — reported one, the person
 * fixed it, submitted again, and met the second. Two round trips to learn what
 * was already known on the first.
 *
 * ⚠️ `role="alert"` IS LOAD-BEARING. These appear after a submit that was
 * refused, so a screen-reader user has already moved focus away from the field.
 * Without the live region the form simply goes quiet and looks like it did
 * nothing. That is also why this is NOT the same component as
 * `CharacterCount` — a running count is `aria-live="polite"` state, an error is
 * an interruption, and collapsing the two would make one of them wrong.
 */
export function FieldError({
  messages,
  className,
}: {
  /** From `ActionResult.fieldErrors[name]`. Absent and empty both render nothing. */
  messages?: string[];
  className?: string;
}) {
  if (!messages?.length) return null;

  return (
    <div role="alert" className={cn("space-y-0.5", className)}>
      {messages.map((message) => (
        <p key={message} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </div>
  );
}
