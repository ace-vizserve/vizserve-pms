/**
 * P6-02c — WHAT ORDER THE TIMESHEET'S ROWS SIT IN.
 *
 * The grid sorted itself alphabetically and nothing else, which is a reasonable
 * default and a poor rule: the week is read down the first column all day, and
 * the order somebody actually wants is their own — the two jobs they are on this
 * week at the top, the standing meeting at the bottom. Alphabetical decides that
 * by the first letter of a title nobody chose for this purpose.
 *
 * ⚠️ THE ORDER IS A VIEW PREFERENCE, NOT DATA. It is one browser's
 * `localStorage`, per week, exactly like the columns menu (P7-65) and the empty
 * rows the picker adds — nothing here is a fact about the business, so nothing
 * here earns a table, a migration or a write. Somebody on a second machine gets
 * the alphabetical default, which is the same thing they had before.
 *
 * The rules live in this file rather than in the grid because they are the only
 * part of dragging a row with a decision in it, and both paths — the drag and
 * the menu that exists for everyone who cannot drag — have to run the SAME one.
 * Two orderings that agree today are two that disagree later.
 */

/**
 * The stored ids, or none.
 *
 * Anything that is not an array of strings is somebody else's key or an older
 * shape: IGNORED rather than trusted, the way the columns menu ignores a
 * non-object. A corrupt preference should cost the preference and nothing else.
 */
export function parseRowOrder(raw: string | null): string[] {
  try {
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Per entry, not per array: one mangled id costs that id, not the order.
    // Deduped, because a repeated id is an ambiguous position.
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))];
  } catch {
    // A blocked or corrupt store. The week still reads, alphabetically.
    return [];
  }
}

/**
 * The rows, in the order they should be drawn.
 *
 * TWO GROUPS, AND THE RULE IS DELIBERATELY BORING: everything the stored order
 * names, in that order, then everything it does not, alphabetically, at the
 * bottom.
 *
 * ⚠️ A ROW THE ORDER DOES NOT NAME GOES LAST, NOT WHERE ITS TITLE WOULD PUT IT.
 * Slotting it in alphabetically would move it the instant its first cell was
 * filled — the same leap under the cursor the original sort comment warns about
 * — because that is when the server starts returning it and the grid rebuilds.
 * Last is a position that does not change when anything else does, and a row
 * that has just been added is the one row somebody is looking straight at.
 *
 * An id in the order that is not on the week is skipped rather than dropped from
 * storage: a task taken off this week and put back on should land where it was.
 */
export function orderRows<Row extends { taskId: string; title: string }>(
  rows: readonly Row[],
  order: readonly string[],
): Row[] {
  const position = new Map(order.map((id, index) => [id, index] as const));

  const placed: Row[] = [];
  const rest: Row[] = [];

  for (const row of rows) (position.has(row.taskId) ? placed : rest).push(row);

  placed.sort((a, b) => position.get(a.taskId)! - position.get(b.taskId)!);
  rest.sort((a, b) => a.title.localeCompare(b.title));

  return [...placed, ...rest];
}

/**
 * A row dropped onto another row.
 *
 * ⚠️ `current` IS THE WHOLE VISIBLE ORDER, not what is in storage. On the first
 * drag storage is EMPTY — the week is alphabetical — so a planner working from
 * storage would have one id in it and every other row would fall back to
 * alphabetical underneath. Handing it what is on screen makes the first drag
 * capture the arrangement it was applied to, which is the only reading of "put
 * this one there" that holds.
 *
 * A drop that names nothing, or names the row it started on, is a gesture
 * somebody abandoned. Returning `current` unchanged is the only correct reading
 * of it — never position zero.
 */
export function planRowDrop(current: readonly string[], activeId: string, overId: string): string[] {
  const from = current.indexOf(activeId);
  const to = current.indexOf(overId);

  if (from < 0 || to < 0 || from === to) return [...current];

  const next = [...current];
  next.splice(from, 1);
  next.splice(to, 0, activeId);

  return next;
}

/** The four things the menu can ask for — see `planRowMove`. */
export type RowMove = "top" | "up" | "down" | "bottom";

/**
 * The same move, asked for without a pointer.
 *
 * ⚠️ DRAG IS AN ENHANCEMENT, NEVER THE ONLY PATH (WCAG 2.2 AA 2.1.1, and 2.5.7
 * on dragging movements) — the rule the form builder's rail already follows.
 * This is the path that works with a keyboard, with a screen reader, and for
 * anybody whose pointer cannot hold a button down and travel at the same time.
 *
 * It runs through the same list and returns the same shape as `planRowDrop`, so
 * a row moved by the menu and a row moved by the hand cannot end up in different
 * places.
 *
 * A move that cannot happen — up from the top, down from the bottom — returns
 * `current` unchanged. The menu disables those items, so this is the second
 * guard rather than the first.
 */
export function planRowMove(current: readonly string[], id: string, move: RowMove): string[] {
  const from = current.indexOf(id);
  if (from < 0) return [...current];

  const to =
    move === "top"
      ? 0
      : move === "bottom"
        ? current.length - 1
        : move === "up"
          ? from - 1
          : from + 1;

  if (to < 0 || to > current.length - 1 || to === from) return [...current];

  const next = [...current];
  next.splice(from, 1);
  next.splice(to, 0, id);

  return next;
}
