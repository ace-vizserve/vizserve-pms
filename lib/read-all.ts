/**
 * Every row of a query, past PostgREST's 1,000-row cap.
 *
 * The first page asks for `{ count: "exact" }` where the caller can; every
 * remaining range is then fired at once, so the read costs two round trips
 * rather than N. Without a count it walks one range at a time. Each query must
 * be ordered by a unique key, or paging skips and repeats rows.
 *
 * Lifted from `/analytics` (P11-14) for P15-02, which needs it in five places.
 */
export const READ_ALL_PAGE = 1000;

export async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const first = await page(0, READ_ALL_PAGE - 1);
  if (first.error) return { data: [], error: first.error };

  const rows = [...(first.data ?? [])];
  if (rows.length < READ_ALL_PAGE) return { data: rows, error: null };

  const total = first.count ?? null;

  if (total === null) {
    for (let from = READ_ALL_PAGE; ; from += READ_ALL_PAGE) {
      const { data, error } = await page(from, from + READ_ALL_PAGE - 1);
      if (error) return { data: rows, error };
      rows.push(...(data ?? []));
      if (!data || data.length < READ_ALL_PAGE) return { data: rows, error: null };
    }
  }

  const rest = await Promise.all(
    Array.from({ length: Math.ceil(total / READ_ALL_PAGE) - 1 }, (_, index) =>
      page((index + 1) * READ_ALL_PAGE, (index + 2) * READ_ALL_PAGE - 1),
    ),
  );

  for (const result of rest) {
    if (result.error) return { data: rows, error: result.error };
    rows.push(...(result.data ?? []));
  }

  return { data: rows, error: null };
}

/** Splits ids for `.in()` — a few hundred uuids in one URL is past what a proxy carries. */
export function chunked<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
