/**
 * "This did not load", as distinct from "there is nothing here".
 *
 * Every list page in this app used to read `data ?? []` and render its empty
 * state, which meant a failed query and an empty table looked identical. That
 * is the worst possible tie: the empty states here are written to be reassuring
 * — "days with no punch have no row at all" — so a broken query would actively
 * talk somebody out of reporting it.
 *
 * It also makes the failure unanswerable from the outside. Working out whether
 * one particular empty DTR page meant "no punches" or "the query died" took a
 * service-role query against the database, which is not a support process.
 *
 * The Postgres sentence is shown rather than hidden. This is an internal tool
 * for sixteen colleagues, and `permission denied for table …` tells whoever
 * reads it far more than "something went wrong" — the repo already takes this
 * position in `readableError` on the write path.
 */
export function QueryError({ message, what }: { message?: string; what: string }) {
  return (
    <div
      // A live region, unlike EmptyState: this appears because something went
      // wrong while the person was looking at the screen, and it is worth
      // interrupting for.
      role="alert"
      className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-10 text-center"
    >
      <p className="text-base font-semibold tracking-[-0.014em]">Could not load {what}</p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        This is a fault, not an empty list — nothing here is missing because you have no records.
        Try again, and if it keeps happening give whoever is on support the message below.
      </p>
      {message ? (
        <code className="mt-1 max-w-md overflow-x-auto rounded bg-muted px-2 py-1 text-2xs text-foreground">
          {message}
        </code>
      ) : null}
    </div>
  );
}
