import type { Json } from "@/lib/database.types";
import { schemaFromFields, type FormFieldRow } from "@/lib/form-builder/schema";
import type { FieldType } from "@/lib/schemas/forms";
import type { createClient } from "@/utils/supabase/server";

/**
 * P7-66 Phase 1 — ⚠️ THROWAWAY. PHASE 2 DELETES THIS FILE.
 *
 * The migration 20260901150000_p7_66_form_schema.sql added
 * `vizserve_pms_forms.schema` and backfilled it, but the three legacy builder
 * actions in ./actions.ts still write `vizserve_pms_form_fields` rows and know
 * nothing about the blob. That leaves a SECOND SOURCE OF TRUTH WITH NO WRITER:
 * any form edited through /forms after the migration carries a stale blob, and
 * the migration's re-run guard cannot repair it — it only fills forms whose
 * schema is still the default `{"entities":{},"root":[]}`.
 *
 * Phase 2's first `vizserve_pms_save_form_schema` would then project that stale
 * blob back over the rows and DELETE every field it omits: silent loss of
 * historical answers, or — once the field has submissions and the R5 trigger
 * refuses the delete — a form nobody can save again.
 *
 * So the three actions dual-write. This is the second half of that: after their
 * row write lands, the blob is RE-DERIVED FROM THE ROWS and stored.
 *
 * Phase 2 replaces all three actions with one `saveSchema` calling
 * `vizserve_pms_save_form_schema`, and this file goes with them. Do not build on
 * it, and do not preserve it.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * ⚠️ `created_at` IS LOAD-BEARING, NOT PADDING.
 *
 * `schemaFromFields` orders `sort_order, created_at, id` because the migration's
 * backfill does, and live forms share `sort_order` values (see the note in
 * `moveField`). Drop the column from this select and `FormFieldRow` no longer
 * type-checks — which is exactly why the type requires it — but if it ever were
 * defaulted away, the blob would order tied fields differently from the SQL twin
 * that produced the backfill, on precisely the oldest forms and silently.
 */
const BLOB_COLUMNS =
  "id, field_key, label, field_type, help_text, options, is_required, is_active, sort_order, created_at";

/**
 * Re-derives `vizserve_pms_forms.schema` from the form's rows and stores it.
 *
 * FULL RE-DERIVATION, NEVER AN INCREMENTAL PATCH. The rows are the source of
 * truth for the whole of Phase 1, so re-reading them and projecting the lot
 * cannot drift from what they say — whereas a patch applied to the previous blob
 * inherits every earlier mistake and every write this process did not see.
 *
 * ⚠️ IT WRITES THE COLUMN DIRECTLY, and must not call
 * `vizserve_pms_save_form_schema`. That function runs the projection the other
 * way — schema → rows — so calling it here would have it overwrite the row the
 * action just wrote with whatever the caller's blob happened to say.
 *
 * ⚠️ IT NEVER THROWS AND NEVER REPORTS FAILURE, DELIBERATELY. It is called after
 * a row write that has already succeeded, and nothing reads the blob yet
 * (Phase 1 wires it to no reader). Turning a failed blob refresh into a failed
 * save would take a cosmetic problem and make it a broken form builder in
 * production; the next save on this form re-derives the blob from scratch
 * anyway. Hence: log, and return.
 *
 * ⚠️ THAT SELF-HEALING IS PARTIAL, AND THE GAP IS NAMED AT THE CATCH SITE
 * BELOW rather than left implied by this paragraph. A form whose LAST save
 * before publication is the one that failed never gets a next save.
 */
export async function syncFormSchemaBlob(supabase: Supabase, formId: string): Promise<void> {
  try {
    const { data: rows, error: readError } = await supabase
      .from("vizserve_pms_form_fields")
      .select(BLOB_COLUMNS)
      .eq("form_id", formId);

    if (readError || !rows) {
      console.error("[P7-66] could not reload fields to re-derive form schema", {
        formId,
        error: readError?.message,
      });
      return;
    }

    // `options` is `Json` on the row type and `string[]` in the projection, and
    // the CHECK constraint behind the column already guarantees an array of
    // non-empty strings. Narrowed rather than asserted so a row that somehow
    // holds something else yields an empty option list instead of a crash on the
    // spread inside `schemaFromFields`.
    const fields: FormFieldRow[] = rows.map((row) => ({
      id: row.id,
      field_key: row.field_key,
      label: row.label,
      field_type: row.field_type as FieldType,
      help_text: row.help_text,
      options: Array.isArray(row.options)
        ? row.options.filter((option): option is string => typeof option === "string")
        : [],
      is_required: row.is_required,
      is_active: row.is_active,
      sort_order: row.sort_order,
      created_at: row.created_at,
    }));

    const { error: writeError } = await supabase
      .from("vizserve_pms_forms")
      // Cast because `schemaFromFields` returns a branded `FormSchema` and the
      // column is typed `Json`. The value is plain data — records, strings,
      // booleans and arrays — so it serialises to jsonb unchanged; the brand is
      // a phantom type and exists only in the compiler.
      .update({ schema: schemaFromFields(fields) as unknown as Json })
      .eq("id", formId);

    /*
     * ⚠️ KNOWN GAP, NOT A HANDLED ERROR — PHASE 2 CLOSES IT.
     *
     * "Self-heals on the next save" is true and is not enough: the save that
     * matters is the LAST one before a form is published and then left alone
     * for months. If the blob write fails on exactly that save, nothing comes
     * along to re-derive it, and the form sits with a stale `schema` until
     * Phase 2's first `vizserve_pms_save_form_schema` projects it back over the
     * rows and deletes whatever it omits — which is the failure this whole file
     * exists to prevent.
     *
     * It is logged and dropped anyway because the alternative available HERE is
     * worse: the row write has already committed, there is no transaction to
     * roll it back into, and failing the action would report a save that
     * happened as a save that did not. The real fix is a READER that reconciles
     * — Phase 2's loader compares the blob against the rows and re-derives when
     * they disagree, rather than trusting a write that may never have landed.
     * Until then this line is a warning in the log, not a repair.
     */
    if (writeError) {
      console.error("[P7-66] could not store re-derived form schema", {
        formId,
        error: writeError.message,
      });
    }
  } catch (cause) {
    // Same gap, same reason — see the note above. Nothing here can repair a
    // blob that never landed; Phase 2's loader is what will.
    console.error("[P7-66] form schema re-derivation threw", { formId, cause });
  }
}
