import "server-only";
import { cache } from "react";

import { toListField, type ListField } from "@/lib/schemas/list-fields";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-73 — a list's custom fields, in the order the field manager set.
 *
 * Read as the CALLER. `list fields readable with their list` decides whether any
 * come back, so a list somebody cannot read has no fields for them — the same
 * answer the list itself gives.
 *
 * `cache()`d per request: `/tasks` needs them for the columns, the sort and the
 * filters, which are three readers of one fact.
 *
 * `includeArchived` is the field manager's; every other screen reads active
 * fields only, because an archived field has left the list.
 */
export const loadListFields = cache(
  async (listId: string, includeArchived = false): Promise<{ fields: ListField[]; error: string | null }> => {
    const supabase = await createClient();

    let query = supabase
      .from("vizserve_pms_list_fields")
      .select("id, list_id, name, field_type, options, decimals, sort_order, is_active")
      .eq("list_id", listId)
      .order("sort_order")
      .order("created_at");

    if (!includeArchived) query = query.eq("is_active", true);

    const { data, error } = await query;

    return { fields: (data ?? []).map(toListField), error: error?.message ?? null };
  },
);
