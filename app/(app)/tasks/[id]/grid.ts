/**
 * P7-55 — the task detail grid template, in one place.
 *
 * `page.tsx` and `loading.tsx` must lay out identically: a skeleton in a
 * different shape from what replaces it is worse than no skeleton, because the
 * content visibly jumps the moment it arrives. Two class strings that have to
 * agree is exactly the drift this codebase keeps documenting, and it nearly
 * happened here — the split went from 7/4 to 8/5 when Comments moved into the
 * rail, and the skeleton would have kept the old ratio.
 *
 * Its own module rather than an export from `page.tsx`: importing from a page
 * pulls the whole page module — every query, every child component — into the
 * loading boundary that exists to render before any of that is ready.
 *
 * 7/6 since P7-57. It was 8/5 while the right-hand column was a thread and a
 * trail; it now carries the ACTIVITY — the comments, the QA returns and the
 * client's replies, which are the entries people actually read on a task that
 * has been round a gate — and a returned QA note in a 5/13 column wrapped to
 * five lines. The left column lost the status row and the promoted move to the
 * header in the same pass, so it needed the width less.
 *
 * `minmax(0,…)` rather than a bare `fr` keeps a long filename or an unbroken URL
 * from blowing the track out past the viewport; `items-start` stops the short
 * column stretching to match the tall one.
 */
export const TASK_DETAIL_GRID =
  "grid gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:items-start";

/**
 * P7-56 — the task detail's ACTION LIST entry, at the foot of the surface.
 *
 * ⚠️ IT LIVES HERE, IN A PLAIN MODULE, and not in `task-surface.tsx` where it
 * is used most. That file is `"use client"`, and every export of a client
 * module becomes a client REFERENCE in the server graph — so `page.tsx`, which
 * is a server component and also needs this string for the "Add a subtask"
 * trigger, would be reading a proxy rather than a class name. Same reason this
 * module exists at all: two files have to agree on one string.
 *
 * Text links, not buttons, and that is the point. "Add subtask" was a bare `+`
 * glyph in one card header, "Upload" a labelled outline button in the next
 * card's header — the same slot, the same job, two treatments — and "Force a
 * different status" a grey link alone in a card footer. Three affordances for
 * "do a thing to this task", in three places. One list, one treatment.
 */
export const ACTION_LINK =
  "inline-flex items-center gap-2 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
