import { z } from "zod";

/**
 * P12-16 CONTRACT — what `/tasks/lists` reads, once the reads are the browser's.
 *
 * The D3a handoff artefact for the list management screen, and a sibling of
 * `lib/schemas/task-list.ts`. Read that file's header first: the short version
 * is that moving a read into the browser does NOT move the generated `Database`
 * types with it — `read()` hands back whatever PostgREST sent, and a column
 * renamed, dropped from a `.select()` string or returned in a shape this deploy
 * does not expect arrives as `undefined` with no type error anywhere.
 *
 * ⚠️ ON THIS SCREEN THAT WOULD BE PARTICULARLY QUIET. Every field here is either
 * a label or a placement — `group_id`, `department_id`, `sort_order` — so an
 * undefined one does not blank the page, it silently reorganises somebody's
 * department: lists jump into the folderless bucket, folders reorder, an
 * archived list stops being marked as one. Parsing is what turns that into a
 * sentence.
 *
 * ⚠️ THE FIELD NAMES ARE THE DATABASE'S, snake_case and unrenamed, because
 * `list-manager.tsx` has taken the row's own names since P3-01 and a mapping
 * layer here would be one more thing to drift.
 */

/**
 * A department list, as the management screen selects it.
 *
 * ⚠️ `is_active` IS A COLUMN HERE AND NOT A FILTER, unlike everywhere else lists
 * are read. This is the only screen from which an archived list can be brought
 * back, so the rows have to include the archived ones and the flag has to
 * survive the parse. `fetchVisibleLists` filters them out for the opposite
 * reason, which is why the two cannot share a cache entry — see `qk.listsManaged`.
 *
 * `description` is NOT NULL in the schema with a `''` default, and it is stated
 * strictly rather than defensively: a null arriving here is a shape fault worth
 * hearing about, not a value to paper over.
 */
export const managedListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  department_id: z.uuid(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  /** P7-18. Null is the top level — a folderless list. */
  group_id: z.uuid().nullable(),
  /** P7-18. Set only on a form's auto-created inbox list. */
  form_id: z.uuid().nullable(),
});

export type ManagedList = z.infer<typeof managedListSchema>;

/**
 * A folder (P7-18).
 *
 * `is_system` is the reserved Client Requests folder, and it is a BOOLEAN rather
 * than a name match on purpose: the name is refused a rename by trigger, but
 * matching on a string would still be matching on a label where a flag exists.
 * The screen uses it three times — to sort the folder last, to withhold the
 * pencil, and to explain why a form's inbox list cannot be moved.
 */
export const managedGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  department_id: z.uuid(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  is_system: z.boolean(),
});

export type ManagedGroup = z.infer<typeof managedGroupSchema>;

/**
 * The one column the open-task count is aggregated from.
 *
 * ⚠️ ROWS, NOT A COUNT, and that is the query this screen has always run. There
 * is no per-list count endpoint, so it selects one column for every open task in
 * scope and tallies them in the browser. See `fetchManagedLists` for what that
 * costs and why it is still the right shape.
 */
export const openTaskListIdSchema = z.object({
  list_id: z.uuid().nullable(),
});
