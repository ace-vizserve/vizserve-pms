import "server-only";

import {
  loadLoggableTaskLists as loadLoggableTaskListsWith,
  loadLoggableTasks as loadLoggableTasksWith,
  type LoggableTaskFilters,
} from "@/lib/timesheet-tasks";
import { createClient } from "@/utils/supabase/server";

/**
 * P12-23 — THE SERVER HALF, AND NOW ONLY THE CLIENT.
 *
 * ------------------------------------------------------------------------
 * ⚠️ EVERY QUERY THAT USED TO LIVE HERE IS IN `lib/timesheet-tasks.ts`, and the
 * reason is `npm run build` rather than tidiness. The timesheet picker reads its
 * first page from the browser now (`qk.loggableTasks()`), and a `"use client"`
 * module importing this file would have pulled `@/utils/supabase/server` — and
 * therefore `next/headers` — into the browser bundle. That passes `tsc`, eslint
 * AND vitest and fails only in the Next compiler, which is the exact break
 * Phase 3b shipped to a browser with a green toolchain.
 *
 * So the SCOPE RULE moved and the CLIENT stayed. This file is the two-line
 * wrapper that keeps `searchLoggableTasks` in `app/(app)/timesheet/actions.ts`
 * reading the way it always did, and it is the only thing left here that is
 * genuinely about being on the server.
 *
 * ⚠️ THE TYPES ARE RE-EXPORTED RATHER THAN RESTATED. `LoggableTask` is imported
 * by the action file to type its `ActionResult`, and a second declaration of it
 * would be a shape that can drift from the rows the queries actually return.
 * ------------------------------------------------------------------------
 */

export {
  LOGGABLE_SEARCH_LIMIT,
  LOGGABLE_TASK_LIMIT,
  type LoggableTask,
  type LoggableTaskFilters,
} from "@/lib/timesheet-tasks";

/** The browser fetcher's twin: same scoping, a server client instead. */
export async function loadLoggableTasks(userId: string, filters: LoggableTaskFilters = {}) {
  return loadLoggableTasksWith(await createClient(), userId, filters);
}

/** As above. Drives the picker's List filter. */
export async function loadLoggableTaskLists(userId: string): Promise<string[]> {
  return loadLoggableTaskListsWith(await createClient(), userId);
}
