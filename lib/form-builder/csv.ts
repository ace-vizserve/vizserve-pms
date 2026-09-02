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

/**
 * RFC 4180 quoting. A free-text answer containing a comma must not become two
 * columns, and one containing a newline must not become two rows.
 *
 * The same rule as `csvCell` in the DTR export. Stated twice rather than shared,
 * because that one lives in a `"use server"` module and importing it here would
 * pull a server action's whole graph into a pure helper — but it is four lines
 * and both are pinned by tests.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows → a CSV document. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  /*
   * ⚠️ CRLF, WHICH IS WHAT RFC 4180 SAYS AND WHAT EXCEL ON WINDOWS EXPECTS. A
   * lone `\n` opens fine in most tools and is exactly the kind of thing that
   * turns out to matter on the one machine the file is actually opened on.
   */
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

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
