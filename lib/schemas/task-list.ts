import { z } from "zod";

/**
 * `qk.ref("users")` — one person in the directory, ACTIVE AND NOT.
 *
 * `is_active` rides along rather than being filtered in SQL: history and
 * comments must still name somebody who has left, so a caller offering a seat
 * (an assignee, a filter option) tests `is_active` itself.
 */
export const directoryPersonSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  primary_department_id: z.uuid().nullable(),
  is_active: z.boolean(),
});

export type DirectoryPerson = z.infer<typeof directoryPersonSchema>;

/**
 * `qk.listsVisible()` — one list the reader may see, across departments. A
 * superset shape, shared by every task surface that names or offers a list.
 */
export const visibleListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  group_id: z.uuid().nullable(),
  owner_id: z.uuid().nullable(),
  department_id: z.uuid(),
});

export type VisibleList = z.infer<typeof visibleListSchema>;
