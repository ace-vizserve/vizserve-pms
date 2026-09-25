/**
 * THE ID AN OPTIMISTIC ROW CARRIES BEFORE THE SERVER GIVES IT ONE.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS IS `lib/query/task-cache.ts`'S PLACEHOLDER SECTION, EXTRACTED IN
 * P12-23, NOT A SECOND COPY OF IT. That file re-exports both functions, so its
 * five existing readers — `task-composer.tsx`, `comment-thread.tsx`,
 * `tasks-table.tsx` and the two in the cache itself — did not move. Phase 5
 * needs exactly the same thing for a timesheet entry that does not exist yet,
 * and a second `optimistic-` prefix is two prefixes that can drift into
 * agreeing with each other by accident.
 *
 * `write-cache.ts` and `parse.ts` were extracted from the same file for the
 * same reason, and both say so at greater length.
 *
 * ⚠️ THE COUNTER IS SHARED ON PURPOSE. An id has to be unique across everything
 * a tab is optimistically holding, not merely within one domain — the whole
 * point of the prefix is that nothing anywhere can mistake it for a real uuid,
 * and one sequence is the only way to be sure two domains cannot mint the same
 * string in the same tick.
 * ------------------------------------------------------------------------
 */

/*
 * THE PLACEHOLDER PREFIX — AND WHY IT IS NOT A UUID.
 *
 * An optimistic row stands for something the server has not created yet, so it
 * has no id to carry. React still needs a key, and the key has to be one nothing
 * can mistake for a real id.
 *
 * ⚠️ THE MISTAKE IT GUARDS AGAINST IS REAL AND WAS SHIPPED: the placeholder task
 * row rendered the ordinary task row, link and all, and
 * `<HoverPrefetchLink href={`/tasks/optimistic-0`}>` fetched that page on hover
 * — which reached Postgres and came back `invalid input syntax for type uuid:
 * "optimistic-0"`. Every control on that row had the same hole: a priority, a
 * date or a delete pressed before the server answered would have sent this
 * string to an action typed `uuid`.
 *
 * So the rule is: a placeholder row is INERT. It shows what was typed and says
 * it is still going in. `isPlaceholder` is how every renderer asks.
 */
const PLACEHOLDER_PREFIX = "optimistic-";

/**
 * A counter rather than the array length it used to be.
 *
 * ⚠️ THE LENGTH WAS ONLY EVER UNIQUE BECAUSE `useOptimistic` THREW THE ROW AWAY
 * A MOMENT LATER. The cache keeps it until the refetch replaces it, so two rows
 * typed in quick succession would both be `optimistic-0` and React would warn
 * about a duplicate key — and, worse, the code that removes one would take the
 * wrong one.
 */
let placeholderSeq = 0;

/** The key for the next pending row. Never reaches the database. */
export function placeholderId(): string {
  placeholderSeq += 1;
  return `${PLACEHOLDER_PREFIX}${placeholderSeq}`;
}

/** True for a row that exists only in this browser. Nothing may be sent about it. */
export function isPlaceholder(id: string): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX);
}
