"use client";

import { Inbox } from "lucide-react";

import { Monogram } from "@/app/(app)/tasks/assignees";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import type { Json } from "@/lib/database.types";
import { formatDateTime } from "@/lib/dates";
import {
  answerColumnId,
  answerFor,
  RESPONSE_IDENTITY_COLUMN_IDS,
  type ResponseColumn,
} from "@/lib/form-builder/responses";

/**
 * P7-66 Phase 4b — CLICK THE FORM, SEE THE SUBMISSIONS.
 *
 * Google-Forms-shaped on purpose: one row per answer, one column per question,
 * newest first, and no interpretation. There is no chart, no aggregation and no
 * per-question summary, because none of that was asked for and every one of
 * them is a decision about what the numbers MEAN. The table is the raw record;
 * anything above it is a later ticket.
 *
 * A client component because `DataTable` is one — `useReactTable` is a hook and
 * a `cell` closure cannot cross the RSC boundary — so the server section holds
 * the query and hands over plain rows.
 *
 * ⚠️ NO `sortKey` ON ANY COLUMN, AND NO `urlSort`. The list is PAGED, and
 * TanStack sorts only the rows it was given: a sortable header here would
 * reorder the current page and call it a sort. Ordering is Postgres's,
 * `submitted_at desc`, and it is the only order this screen offers. Making a
 * column sortable means adding `?sort=` with a literal allowlist server-side —
 * and the columns here are per-form, so that allowlist is not a fixed list. It
 * is a real piece of work rather than a prop, which is why it is absent rather
 * than half-done.
 */

export type ResponseRow = {
  id: string;
  submitted_by: string;
  /**
   * Null when the reader cannot see that person's user row.
   *
   * A real state rather than a defensive nicety: the response SELECT policy is
   * "the lead of the department that owns the FORM", while the users policies
   * are scoped to the reader's own department. A company-wide survey owned by
   * VizMedia collects answers from VizBytes, and VizMedia's lead may read those
   * answers without being able to read the names attached to them. Said out
   * loud in the cell rather than papered over with a blank.
   */
  submitter_name: string | null;
  submitted_at: string;
  field_values: Json;
};

export function ResponsesTable({
  rows,
  fields,
}: {
  rows: ResponseRow[];
  /** One per field, in the form's own order. See `responseColumns`. */
  fields: ResponseColumn[];
}) {
  const columns: Column<ResponseRow>[] = [
    {
      // The two fixed ids, named once in `lib/form-builder/responses.ts` so the
      // answer columns below can be proved disjoint from them in a test rather
      // than by reading this file.
      key: RESPONSE_IDENTITY_COLUMN_IDS[0],
      header: "Submitted by",
      /*
       * ⚠️ PINNED, and it is the first column so it may be. The answer columns
       * are per-form and there can be a dozen of them, so this table scrolls
       * sideways as a matter of course — and a row whose identity has scrolled
       * off the left edge is a row you cannot attribute.
       */
      pin: "left",
      className: "max-w-[14rem]",
      cell: (row) =>
        row.submitter_name ? (
          <span className="flex min-w-0 items-center gap-2">
            <Monogram id={row.submitted_by} name={row.submitter_name} />
            <span className="truncate">{row.submitter_name}</span>
          </span>
        ) : (
          // Never the UUID (§6: no table name, no enum, no id in front of a
          // person) and never a blank, which reads as "nobody".
          <span className="text-xs text-muted-foreground">Outside your department</span>
        ),
    },
    {
      key: RESPONSE_IDENTITY_COLUMN_IDS[1],
      header: "When",
      className: "max-w-[12rem]",
      cell: (row) => <span className="whitespace-nowrap">{formatDateTime(row.submitted_at)}</span>,
    },
    ...fields.map(
      (field): Column<ResponseRow> => ({
        /*
         * ⚠️ NAMESPACED, NOT THE RAW `field_key`. `FIELD_KEY_PATTERN` permits
         * `submitted_by` and `submitted_at`, and this key is both the TanStack
         * column id and the React key — so a question keyed `submitted_by`
         * used to collide with the pinned identity column above and get
         * painted `sticky left-0` over it. See `answerColumnId`.
         */
        key: answerColumnId(field.key),
        header: (
          <span className="flex items-center gap-1.5">
            <span>{field.label}</span>
            {/*
              ⚠️ THE STATE IS IN THE WORD, NOT IN A COLOUR. A muted parenthetical
              survives greyscale, a printed queue and a screenshot — and these
              two columns look identical to a live one otherwise, which is
              exactly the confusion worth spending eight characters on.
            */}
            {field.origin === "archived" ? (
              <span className="text-2xs font-normal text-muted-foreground">(archived)</span>
            ) : null}
            {field.origin === "orphan" ? (
              <span className="text-2xs font-normal text-muted-foreground">(removed)</span>
            ) : null}
          </span>
        ),
        className: "max-w-xs",
        cell: (row) => {
          const answer = answerFor(row.field_values, field.key);

          // An em-dash for "not answered", in the tertiary grey that is
          // non-text only — which it is: the dash is decoration standing in for
          // an absent value, and it carries `sr-only` words for anyone who
          // cannot see it.
          if (answer === null) {
            return (
              <span className="text-foreground-faint">
                <span aria-hidden>—</span>
                <span className="sr-only">Not answered</span>
              </span>
            );
          }

          // `title` as well as `truncate`: a long answer must stay reachable,
          // and there is no detail page for a response to link to.
          return (
            <p className="truncate" title={answer}>
              {answer}
            </p>
          );
        },
      }),
    ),
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={
        <EmptyState
          icon={<Inbox />}
          title="No answers yet"
          description="Answers appear here as soon as somebody fills the form in. Staff reach it from Fill a form in the sidebar — it has to be published first."
        />
      }
    />
  );
}
