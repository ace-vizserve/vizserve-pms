import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import { directoryPersonSchema, type DirectoryPerson } from "@/lib/schemas/task-list";

/**
 * The narrowest client a task-area fetcher needs. The real browser and server
 * clients both satisfy it; a unit test can hand it an object literal.
 */
export type TaskReadClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

/**
 * `qk.ref("users")` — THE WHOLE DIRECTORY, ACTIVE AND NOT. Reference data, so it
 * inherits `REF_STALE_TIME` by key prefix. See `directoryPersonSchema` for why
 * the inactive are included.
 */
export async function fetchDirectory(client: TaskReadClient): Promise<DirectoryPerson[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id, is_active")
      .order("full_name"),
  );

  return parseAll(directoryPersonSchema, rows, "people");
}
