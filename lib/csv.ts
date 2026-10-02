/**
 * RFC 4180 quoting and joining. Pure, so a client component can build a file
 * from the rows it already holds (P15-06) without importing the form builder.
 *
 * A free-text cell containing a comma must not become two columns, and one
 * containing a newline must not become two rows.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Rows → a CSV document. CRLF, which is what RFC 4180 says and what Excel on
 * Windows expects.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** `"People", "Design"` → `people-design`. Safe on every platform's filesystem. */
export function slugForFilename(...parts: Array<string | null | undefined>): string {
  return (
    parts
      .filter(Boolean)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "export"
  );
}
