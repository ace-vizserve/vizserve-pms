import { z } from "zod";

/**
 * P12-01 CONTRACT — what `vizserve_pms_sidebar_snapshot()` returns.
 *
 * The D3a handoff artefact for the rail: the migration builds this object with
 * `jsonb_build_object`, and this file is the only description of it the browser
 * has. Nine queries used to arrive as nine typed PostgREST results; one RPC
 * arrives as `Json`, which is `unknown` wearing a nicer name.
 *
 * ⚠️ THIS IS PARSED, NOT CAST, AND THAT IS THE POINT OF PHASE 1. A cast on an
 * RPC payload is the same bug the whole phase exists to kill: if the function
 * were absent, renamed, or pasted at an older version than the deploy expects,
 * `data as SidebarSnapshot` would hand the components `undefined.spaces` — or,
 * worse, a partially-shaped object that renders as an EMPTY PROJECT TREE with
 * every count at zero, which is exactly what a person with a full backlog would
 * be looking at while nothing on screen said anything was wrong.
 *
 * Migrations here are pasted by hand AFTER the code deploys (CLAUDE.md), so the
 * window where the function does not yet exist is real and routinely open. A
 * parse failure throws, `read()`'s contract puts it in `isError`, and the rail
 * can say it could not load instead of lying with a zero.
 *
 * ⚠️ THE KEYS ARE THE COMPONENT PROPS, DELIBERATELY. `spaces` matches
 * `ProjectSpace`, its folders match `ProjectFolder`, its lists match
 * `ProjectList` and `personal` matches `PersonalList` — all four in
 * `components/app-shell/`. Nothing is renamed on the way through, so there is no
 * mapping layer to fall out of step with the SQL. The two top-level counts are
 * snake_case because that is what the migration emits; everything nested is
 * camelCase because that is what the props are. The inconsistency is the seam,
 * and it is at the top level where it is visible rather than buried per-field.
 */

/** One list row in the tree, with both of its counts already summed in SQL. */
const projectListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Excludes COMPLETED and COMPLETED_NO_RESPONSE — see rule (a) in the migration. */
  openTasks: z.number().int().nonnegative(),
  /** P7-26. Client requests at Gate 1 that will land in this list. */
  pendingRequests: z.number().int().nonnegative(),
});

/** One folder (P7-18), carrying its lists and the same two counts rolled up. */
const projectFolderSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The reserved "Client Requests" folder. Sorted last, dropped while empty. */
  isSystem: z.boolean(),
  lists: z.array(projectListSchema),
  openTasks: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
});

/** A department, with its folderless lists kept apart from its folders. */
const projectSpaceSchema = z.object({
  departmentId: z.uuid(),
  departmentName: z.string(),
  /** Folderless lists — rendered ABOVE the folders. Rule (c). */
  lists: z.array(projectListSchema),
  folders: z.array(projectFolderSchema),
});

/**
 * One of the reader's own lists.
 *
 * ⚠️ `isActive` IS CARRIED RATHER THAN FILTERED ON. The snapshot deliberately
 * returns archived personal lists (rule (g)), because the only other screen that
 * could un-archive one refuses a plain member — filtering them out anywhere in
 * this chain makes archiving a one-way door. `NavPersonal` splits the set.
 */
const personalListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isActive: z.boolean(),
});

export const sidebarSnapshotSchema = z.object({
  /** Unread notifications. Scoped by policy, not by a filter. */
  unread: z.number().int().nonnegative(),
  /** P7-50. Requests sitting at Gate 1. Scoped by policy, not by a filter. */
  awaiting_review: z.number().int().nonnegative(),
  spaces: z.array(projectSpaceSchema),
  personal: z.array(personalListSchema),
});

export type SidebarSnapshot = z.infer<typeof sidebarSnapshotSchema>;
