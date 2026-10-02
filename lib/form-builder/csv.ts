import type { FormSchema } from "@/lib/form-builder/builder";
import { answerFor, responseColumns, answeredKeysOf } from "@/lib/form-builder/responses";

/**
 * P7-66 — A STAFF FORM'S ANSWERS, AS A FILE.
 *
 * Pure and separate from the action that serves it, because the two rules that
 * lose or leak data here are both invisible in a spreadsheet:
 *
 *   THE COLUMNS ARE `responseColumns`, so an ARCHIVED question and an ORPHANED
 *   key both get one. An export built from "the questions the form currently
 *   asks" silently drops every answer to a question somebody retired last
 *   month — and the file would look complete, which is the failure mode that
 *   matters: a spreadsheet nobody can tell is missing a column.
 *
 *   A NAME COLUMN EXISTS ONLY ON A NAMED FORM. On an anonymous one there is
 *   nothing to put in it — `submitted_by` is NULL on every row because the
 *   INSERT policy refused to let a name be written — so a "Submitted by" header
 *   over a column of blanks would suggest the names were withheld from the
 *   export rather than never recorded. It is absent instead.
 *
 * ⚠️ THE FILE IS STILL ONE ROW PER SUBMISSION ON AN ANONYMOUS FORM, and that is
 * not an oversight. One response is one `field_values` blob — the grouping IS
 * the row, and the same grouping is on the screen and in the table. What
 * anonymity means here is exactly what the column tells you: no name was ever
 * written. It has never meant that one person's answers cannot be read
 * together, and a file that shuffled them would be a file nobody could analyse
 * while still carrying the timestamp that identifies them anyway.
 */

/*
 * RFC 4180 quoting, CRLF rows. P15-06 moved the rule to `lib/csv.ts` so the
 * report tables can build files in the browser without importing the form
 * builder; re-exported so this module's callers and tests are unchanged. The
 * DTR export keeps its own copy for the reason it always has — it lives in a
 * `"use server"` module.
 */
import { csvCell, toCsv } from "@/lib/csv";

export { csvCell, toCsv };

/** One response, in the shape the export needs. */
export type ExportableResponse = {
  submitted_by: string | null;
  submitted_at: string;
  field_values: unknown;
};

/**
 * The whole answer sheet, as CSV rows.
 *
 * ⚠️ THE FIRST COLUMN IS ALWAYS THE TIMESTAMP, and on a named form the second is
 * the person. The answers follow in the FORM'S OWN ORDER — `responseColumns`
 * walks `root`, which is the order the person answering saw, so reading the file
 * across reads like the form reads down.
 *
 * ⚠️ `names` MAY BE INCOMPLETE ON A NAMED FORM, AND THAT IS NOT AN ERROR. The
 * response policy scopes by the FORM's department and the user policies by the
 * READER's, so a company-wide survey collects answers whose authors this
 * exporter cannot look up. The cell says so rather than being blank — a blank
 * reads as "nobody answered this row".
 */
export function responsesToCsv(
  schema: FormSchema,
  responses: ReadonlyArray<ExportableResponse>,
  {
    isAnonymous,
    names,
    formatTimestamp,
  }: {
    isAnonymous: boolean;
    /** user id → full name, for the rows this reader can resolve. */
    names: Record<string, string>;
    /** Injected so this module never has to know about time zones. */
    formatTimestamp: (value: string) => string;
  },
): string {
  const columns = responseColumns(schema, answeredKeysOf(responses));

  const header = [
    "Submitted at",
    ...(isAnonymous ? [] : ["Submitted by"]),
    ...columns.map((column) => {
      /*
       * The header says WHY a column is here when the reason is not obvious.
       * An archived question and a live one look identical in a spreadsheet
       * otherwise, and somebody reading a column of answers to a question the
       * form no longer asks deserves to know that is what they are reading.
       */
      if (column.origin === "archived") return `${column.label} (archived)`;
      if (column.origin === "orphan") return `${column.label} (removed)`;
      return column.label;
    }),
  ];

  const rows = responses.map((response) => [
    formatTimestamp(response.submitted_at),
    ...(isAnonymous
      ? []
      : [
          response.submitted_by === null
            ? ""
            : (names[response.submitted_by] ?? "Outside your department"),
        ]),
    ...columns.map((column) => answerFor(response.field_values, column.key) ?? ""),
  ]);

  return toCsv([header, ...rows]);
}

/** P15-05 — one client request, as the client-form export writes it. */
export type ExportableRequest = {
  reference_no: string;
  status: string;
  submitted_at: string;
  requester_name: string;
  requester_email: string;
  requester_org: string;
  title: string;
  description: string;
  target_date: string | null;
  field_values: unknown;
};

/**
 * P15-05 — a client form's export. The request's own columns first (reference,
 * status, who sent it and the three fixed request fields under the form's own
 * labels), then every question's answer, archived and removed ones included.
 */
export function requestsToCsv(
  schema: FormSchema,
  requests: ReadonlyArray<ExportableRequest>,
  {
    labels,
    formatTimestamp,
  }: {
    labels: { title: string; description: string; target_date: string };
    formatTimestamp: (value: string) => string;
  },
): string {
  const columns = responseColumns(schema, answeredKeysOf(requests));

  const header = [
    "Reference",
    "Status",
    "Submitted at",
    "Name",
    "Email",
    "Organisation",
    labels.title,
    labels.description,
    labels.target_date,
    ...columns.map((column) => {
      if (column.origin === "archived") return `${column.label} (archived)`;
      if (column.origin === "orphan") return `${column.label} (removed)`;
      return column.label;
    }),
  ];

  const rows = requests.map((request) => [
    request.reference_no,
    request.status,
    formatTimestamp(request.submitted_at),
    request.requester_name,
    request.requester_email,
    request.requester_org,
    request.title,
    request.description,
    request.target_date ?? "",
    ...columns.map((column) => answerFor(request.field_values, column.key) ?? ""),
  ]);

  return toCsv([header, ...rows]);
}

/**
 * A filename somebody can find again.
 *
 * ⚠️ THE FORM'S NAME IS SLUGGED RATHER THAN USED AS TYPED. A name may contain
 * `/`, `:` or a quote, all of which are illegal or hostile in a filename on some
 * platform — and the browser's `download` attribute takes whatever it is given.
 */
export function responsesCsvFilename(formName: string, today: string): string {
  const stem =
    formName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "form";

  return `${stem}-answers-${today}.csv`;
}
